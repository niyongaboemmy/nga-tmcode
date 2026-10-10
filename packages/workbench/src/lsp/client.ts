import { monaco } from "../monaco/setup";
import { ensureDocument, onDocumentSaved, pathOfUri, uriFor } from "../monaco/documents";
import { completionKind } from "../exthost/languageBridge";
import { beginActivity } from "../state/activity";
import { log, notify } from "../state/store";
import { isCancellation, RpcConnection, type RpcTransport } from "./jsonrpc";
import { configurationSection } from "./manifest";
import { fileUri, pathOfFileUri, rootUri } from "./uri";

/**
 * A Language Server Protocol client for Monaco: keeps the server's view of
 * TMCode's documents in sync and turns its answers into Monaco providers
 * (completion, hover, signature help, definition, references, highlights,
 * symbols, rename) and markers. Used for the built-in servers (Pyright).
 */

// ───────────────────────── LSP shapes (the parts used) ─────────────────────────

export interface LspPosition {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
export interface LspLocation {
  uri: string;
  range: LspRange;
}
export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
  originSelectionRange?: LspRange;
}
type MarkupContent = { kind: "markdown" | "plaintext"; value: string };
type MarkedString = string | { language: string; value: string };
export interface LspTextEdit {
  range: LspRange;
  newText: string;
}
export interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: ({ textDocument: { uri: string }; edits: LspTextEdit[] } | { kind: string })[];
}
export interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: string | number | { value: string | number };
  source?: string;
  message: string;
  tags?: number[];
}
interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | MarkupContent;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit | { newText: string; insert: LspRange; replace: LspRange };
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  preselect?: boolean;
  tags?: number[];
  labelDetails?: { detail?: string; description?: string };
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: unknown;
}
interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}
interface LspSymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: LspLocation;
}

// ───────────────────────── conversions ─────────────────────────

export const toLspPosition = (p: monaco.IPosition): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const toMonacoRange = (r: LspRange): monaco.IRange => ({ startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 });

export function toMarkdown(c: string | MarkupContent | MarkedString | MarkedString[] | undefined | null): monaco.IMarkdownString[] {
  if (c === undefined || c === null) return [];
  if (Array.isArray(c)) return c.flatMap((x) => toMarkdown(x));
  if (typeof c === "string") return c ? [{ value: c }] : [];
  if ("kind" in c) return c.value ? [{ value: c.kind === "plaintext" ? c.value.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&") : c.value }] : [];
  return [{ value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` }];
}

const SEVERITY: Record<number, monaco.MarkerSeverity> = { 1: 8, 2: 4, 3: 2, 4: 1 };

export function toMarker(d: LspDiagnostic, owner: string): monaco.editor.IMarkerData {
  const code = typeof d.code === "object" && d.code ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined;
  return {
    ...toMonacoRange(d.range),
    severity: SEVERITY[d.severity ?? 1] ?? 8,
    message: d.message,
    source: d.source ?? owner,
    code,
    tags: d.tags?.filter((t) => t === 1 || t === 2) as monaco.MarkerTag[] | undefined,
  };
}

/** LSP CompletionItemKind (1 = Text) → Monaco's, through the VS Code enum (0 = Text) the extension bridge maps. */
export const toCompletionKind = (k: number | undefined) => completionKind(k ? k - 1 : 9);

/** LSP SymbolKind (1 = File) → Monaco's (0 = File). */
export const toSymbolKind = (k: number) => Math.max(0, k - 1) as monaco.languages.SymbolKind;

export function toCompletion(item: LspCompletionItem, wordRange: monaco.IRange): monaco.languages.CompletionItem & { __lsp: LspCompletionItem } {
  let range: monaco.IRange | monaco.languages.CompletionItemRanges = wordRange;
  let insertText = item.insertText ?? item.label;
  if (item.textEdit) {
    insertText = item.textEdit.newText;
    range = "range" in item.textEdit ? toMonacoRange(item.textEdit.range) : { insert: toMonacoRange(item.textEdit.insert), replace: toMonacoRange(item.textEdit.replace) };
  }
  const snippet = item.insertTextFormat === 2;
  return {
    label: item.labelDetails ? { label: item.label, detail: item.labelDetails.detail, description: item.labelDetails.description } : item.label,
    kind: toCompletionKind(item.kind),
    detail: item.detail,
    documentation: toMarkdown(item.documentation)[0],
    sortText: item.sortText,
    filterText: item.filterText,
    insertText,
    insertTextRules: snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    range,
    additionalTextEdits: item.additionalTextEdits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
    commitCharacters: item.commitCharacters,
    preselect: item.preselect,
    tags: item.tags?.includes(1) ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
    // Pyright asks for parameter hints after completing a function name.
    command: item.command?.command === "editor.action.triggerParameterHints" ? { id: "editor.action.triggerParameterHints", title: item.command.title } : undefined,
    __lsp: item,
  };
}

export function toDocumentSymbols(result: (LspDocumentSymbol | LspSymbolInformation)[] | null): monaco.languages.DocumentSymbol[] {
  if (!result) return [];
  const one = (s: LspDocumentSymbol): monaco.languages.DocumentSymbol => ({
    name: s.name,
    detail: s.detail ?? "",
    kind: toSymbolKind(s.kind),
    tags: s.tags?.includes(1) ? [monaco.languages.SymbolTag.Deprecated] : [],
    range: toMonacoRange(s.range),
    selectionRange: toMonacoRange(s.selectionRange),
    children: s.children?.map(one),
  });
  return result.map((s) =>
    "location" in s
      ? { name: s.name, detail: "", kind: toSymbolKind(s.kind), tags: [], containerName: s.containerName, range: toMonacoRange(s.location.range), selectionRange: toMonacoRange(s.location.range) }
      : one(s),
  );
}

/** The text edits of a WorkspaceEdit by document URI (file creates/renames are not applied). */
export function workspaceEditChanges(edit: LspWorkspaceEdit | null): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>();
  if (!edit) return out;
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) out.set(uri, [...(out.get(uri) ?? []), ...edits]);
  for (const dc of edit.documentChanges ?? []) {
    if (!("textDocument" in dc)) continue;
    out.set(dc.textDocument.uri, [...(out.get(dc.textDocument.uri) ?? []), ...dc.edits]);
  }
  return out;
}

// ───────────────────────── the client ─────────────────────────

export interface ClientOptions {
  /** Server name for logs and markers ("pyright"). */
  id: string;
  label: string;
  languages: string[];
  /** The folder's absolute path. */
  root: string;
  /** Answers to `workspace/configuration`. */
  settings: Record<string, unknown>;
}

/** Results naming more files than this don't get models loaded for them. */
const MAX_LOADED_FILES = 200;

export class LanguageClient {
  readonly rpc: RpcConnection;
  private disposables: monaco.IDisposable[] = [];
  private synced = new Map<string, { version: number; listeners: monaco.IDisposable[] }>();
  private progress = new Map<string | number, () => void>();
  capabilities: Record<string, unknown> = {};
  private stopped = false;
  /** Paths with markers from this server. */
  private marked = new Set<string>();

  constructor(
    readonly options: ClientOptions,
    transport: RpcTransport,
  ) {
    this.rpc = new RpcConnection(transport);
    this.rpc.onUnhandled = (m) => log(options.label, `Ignored ${m} from the server.`);
  }

  /** A message from the server (JSON text). */
  receive(text: string) {
    this.rpc.receive(text);
  }

  private uri(path: string) {
    return fileUri(this.options.root, path);
  }

  private pathOf(uri: string) {
    return pathOfFileUri(this.options.root, uri);
  }

  private handles(model: monaco.editor.ITextModel) {
    return !model.isDisposed() && model.uri.scheme === "tmcode" && this.options.languages.includes(model.getLanguageId());
  }

  async start(): Promise<void> {
    const { rpc, options } = this;
    rpc.onRequest("workspace/configuration", (p) => ((p as { items: { section?: string }[] }).items ?? []).map((i) => configurationSection(options.settings, i.section)));
    rpc.onRequest("workspace/workspaceFolders", () => [{ uri: rootUri(options.root), name: options.root.split(/[\\/]/).pop() ?? "folder" }]);
    rpc.onRequest("client/registerCapability", () => null);
    rpc.onRequest("client/unregisterCapability", () => null);
    rpc.onRequest("window/workDoneProgress/create", () => null);
    rpc.onRequest("workspace/applyEdit", async (p) => ({ applied: await this.applyWorkspaceEdit((p as { edit: LspWorkspaceEdit }).edit) }));
    rpc.onRequest("window/showMessageRequest", (p) => {
      const m = p as { type: number; message: string };
      notify(m.type === 1 ? "error" : m.type === 2 ? "warning" : "info", `${options.label}: ${m.message}`);
      return null;
    });
    rpc.onNotification("window/showMessage", (p) => {
      const m = p as { type: number; message: string };
      if (m.type <= 2) notify(m.type === 1 ? "error" : "warning", `${options.label}: ${m.message}`);
      else log(options.label, m.message);
    });
    rpc.onNotification("window/logMessage", (p) => {
      const m = p as { type: number; message: string };
      log(options.label, m.message, m.type === 1 ? "error" : m.type === 2 ? "warn" : "info");
    });
    rpc.onNotification("textDocument/publishDiagnostics", (p) => this.publishDiagnostics(p as { uri: string; diagnostics: LspDiagnostic[] }));
    rpc.onNotification("$/progress", (p) => this.onProgress(p as { token: string | number; value: { kind: string; title?: string } }));
    rpc.onNotification("telemetry/event", () => {});

    const init = await rpc.request<{ capabilities: Record<string, unknown> }>("initialize", {
      processId: null,
      clientInfo: { name: "TMCode" },
      locale: "en",
      rootUri: rootUri(options.root),
      rootPath: options.root,
      workspaceFolders: [{ uri: rootUri(options.root), name: options.root.split(/[\\/]/).pop() ?? "folder" }],
      initializationOptions: {},
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true, applyEdit: true, workspaceEdit: { documentChanges: true }, didChangeConfiguration: { dynamicRegistration: true } },
        window: { workDoneProgress: true, showMessage: {} },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: true },
          publishDiagnostics: { relatedInformation: false, tagSupport: { valueSet: [1, 2] }, versionSupport: false },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], deprecatedSupport: true, tagSupport: { valueSet: [1] }, insertReplaceSupport: true, labelDetailsSupport: true, resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] } },
            contextSupport: true,
          },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true }, contextSupport: true },
          definition: { linkSupport: true },
          declaration: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true, symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
          rename: { prepareSupport: true },
        },
      },
    });
    this.capabilities = init?.capabilities ?? {};
    rpc.notify("initialized", {});
    rpc.notify("workspace/didChangeConfiguration", { settings: options.settings });
    this.wireDocuments();
    this.registerProviders();
  }

  // ── documents ──

  private wireDocuments() {
    const open = (model: monaco.editor.ITextModel) => {
      if (!this.handles(model) || this.synced.has(model.uri.toString())) return;
      const key = model.uri.toString();
      const path = pathOfUri(model.uri);
      const state = { version: 1, listeners: [] as monaco.IDisposable[] };
      this.synced.set(key, state);
      this.rpc.notify("textDocument/didOpen", { textDocument: { uri: this.uri(path), languageId: model.getLanguageId(), version: state.version, text: model.getValue() } });
      // Whole-text sync: student files are small, and it can never drift.
      state.listeners.push(
        model.onDidChangeContent(() => {
          state.version++;
          this.rpc.notify("textDocument/didChange", { textDocument: { uri: this.uri(path), version: state.version }, contentChanges: [{ text: model.getValue() }] });
        }),
        model.onWillDispose(() => close(model)),
      );
    };
    const close = (model: monaco.editor.ITextModel) => {
      const key = model.uri.toString();
      const state = this.synced.get(key);
      if (!state) return;
      state.listeners.forEach((d) => d.dispose());
      this.synced.delete(key);
      this.rpc.notify("textDocument/didClose", { textDocument: { uri: this.uri(pathOfUri(model.uri)) } });
      monaco.editor.setModelMarkers(model, this.options.id, []);
    };
    for (const m of monaco.editor.getModels()) open(m);
    this.disposables.push(
      monaco.editor.onDidCreateModel(open),
      monaco.editor.onDidChangeModelLanguage((e) => {
        close(e.model);
        open(e.model);
      }),
      { dispose: () => monaco.editor.getModels().forEach(close) },
    );
    const offSave = onDocumentSaved((path) => {
      if (this.synced.has(uriFor(path).toString())) this.rpc.notify("textDocument/didSave", { textDocument: { uri: this.uri(path) } });
    });
    this.disposables.push({ dispose: offSave });
  }

  publishDiagnostics(p: { uri: string; diagnostics: LspDiagnostic[] }) {
    const path = this.pathOf(p.uri);
    if (path === null) return;
    const model = monaco.editor.getModel(uriFor(path));
    if (!model) return;
    this.marked.add(path);
    monaco.editor.setModelMarkers(model, this.options.id, p.diagnostics.map((d) => toMarker(d, this.options.label)));
  }

  private onProgress(p: { token: string | number; value: { kind: string; title?: string; message?: string } }) {
    if (p.value.kind === "begin") {
      this.progress.get(p.token)?.();
      this.progress.set(p.token, beginActivity(`${this.options.label}: ${p.value.title ?? "Working"}…`));
    } else if (p.value.kind === "end") {
      this.progress.get(p.token)?.();
      this.progress.delete(p.token);
    }
  }

  // ── results that name other files ──

  /** Loads models for workspace files in a result (Peek and the references list need them). */
  private async modelsFor(uris: string[]) {
    const paths = [...new Set(uris.map((u) => this.pathOf(u)).filter((p): p is string => p !== null && p !== ""))].slice(0, MAX_LOADED_FILES);
    await Promise.all(paths.map((p) => (monaco.editor.getModel(uriFor(p)) ? null : ensureDocument(p, { background: true }).catch(() => null))));
  }

  async toLocations(result: LspLocation | LspLocation[] | LspLocationLink[] | null): Promise<monaco.languages.LocationLink[]> {
    if (!result) return [];
    const list = Array.isArray(result) ? result : [result];
    await this.modelsFor(list.map((l) => ("targetUri" in l ? l.targetUri : l.uri)));
    const out: monaco.languages.LocationLink[] = [];
    for (const l of list) {
      const uri = "targetUri" in l ? l.targetUri : l.uri;
      const path = this.pathOf(uri);
      // Library and stub files (typeshed, site-packages) are outside the folder: TMCode does not open them.
      if (path === null) continue;
      if ("targetUri" in l) {
        out.push({ uri: uriFor(path), range: toMonacoRange(l.targetRange), targetSelectionRange: toMonacoRange(l.targetSelectionRange), originSelectionRange: l.originSelectionRange ? toMonacoRange(l.originSelectionRange) : undefined });
      } else out.push({ uri: uriFor(path), range: toMonacoRange(l.range) });
    }
    return out;
  }

  /** A WorkspaceEdit as Monaco's (rename): files no editor shows are loaded as background documents, saved once edited. */
  async toMonacoEdit(edit: LspWorkspaceEdit | null): Promise<monaco.languages.WorkspaceEdit> {
    const changes = workspaceEditChanges(edit);
    await this.modelsFor([...changes.keys()]);
    const edits: monaco.languages.IWorkspaceTextEdit[] = [];
    for (const [uri, list] of changes) {
      const path = this.pathOf(uri);
      if (path === null) continue;
      for (const e of list) edits.push({ resource: uriFor(path), textEdit: { range: toMonacoRange(e.range), text: e.newText }, versionId: undefined });
    }
    return { edits };
  }

  private async applyWorkspaceEdit(edit: LspWorkspaceEdit): Promise<boolean> {
    const changes = workspaceEditChanges(edit);
    await this.modelsFor([...changes.keys()]);
    for (const [uri, list] of changes) {
      const path = this.pathOf(uri);
      const model = path === null ? null : monaco.editor.getModel(uriFor(path));
      if (!model) return false;
      model.pushEditOperations([], list.map((e) => ({ range: toMonacoRange(e.range) as monaco.Range, text: e.newText })), () => null);
    }
    return true;
  }

  // ── requests ──

  private async ask<T>(method: string, params: unknown, token?: monaco.CancellationToken): Promise<T | null> {
    if (this.stopped) return null;
    try {
      return await this.rpc.request<T>(method, params, token);
    } catch (e) {
      if (!isCancellation(e) && !this.stopped) log(this.options.label, `${method} failed: ${String((e as Error)?.message ?? e)}`, "warn");
      return null;
    }
  }

  private doc(model: monaco.editor.ITextModel, position?: monaco.IPosition) {
    const textDocument = { uri: this.uri(pathOfUri(model.uri)) };
    return position ? { textDocument, position: toLspPosition(position) } : { textDocument };
  }

  async provideDefinition(kind: "definition" | "declaration" | "typeDefinition", model: monaco.editor.ITextModel, position: monaco.IPosition, token?: monaco.CancellationToken) {
    return this.toLocations(await this.ask<LspLocation[] | LspLocationLink[]>(`textDocument/${kind}`, this.doc(model, position), token));
  }

  async provideReferences(model: monaco.editor.ITextModel, position: monaco.IPosition, context: { includeDeclaration: boolean }, token?: monaco.CancellationToken) {
    const links = await this.toLocations(await this.ask<LspLocation[]>("textDocument/references", { ...this.doc(model, position), context }, token));
    return links.map((l) => ({ uri: l.uri, range: l.range }));
  }

  async provideRenameEdits(model: monaco.editor.ITextModel, position: monaco.IPosition, newName: string, token?: monaco.CancellationToken) {
    return this.toMonacoEdit(await this.ask<LspWorkspaceEdit>("textDocument/rename", { ...this.doc(model, position), newName }, token));
  }

  private registerProviders() {
    const L = monaco.languages;
    const caps = this.capabilities as Record<string, { triggerCharacters?: string[]; retriggerCharacters?: string[]; resolveProvider?: boolean; prepareProvider?: boolean } | boolean | undefined>;
    const has = (k: string) => !!caps[k];
    const sel = this.options.languages.map((language) => ({ language, scheme: "tmcode" }));
    const reg = (d: monaco.IDisposable) => this.disposables.push(d);

    if (has("completionProvider")) {
      const cp = caps.completionProvider as { triggerCharacters?: string[]; resolveProvider?: boolean };
      reg(
        L.registerCompletionItemProvider(sel, {
          triggerCharacters: cp.triggerCharacters,
          provideCompletionItems: async (model, position, context, token) => {
            const res = await this.ask<LspCompletionItem[] | { isIncomplete: boolean; items: LspCompletionItem[] }>(
              "textDocument/completion",
              { ...this.doc(model, position), context: { triggerKind: context.triggerKind + 1, triggerCharacter: context.triggerCharacter } },
              token,
            );
            if (!res) return { suggestions: [] };
            const word = model.getWordUntilPosition(position);
            const range = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: position.column };
            const items = Array.isArray(res) ? res : res.items;
            return { suggestions: items.map((i) => toCompletion(i, range)), incomplete: !Array.isArray(res) && res.isIncomplete };
          },
          resolveCompletionItem: cp.resolveProvider
            ? async (item, token) => {
                const lsp = (item as { __lsp?: LspCompletionItem }).__lsp;
                if (!lsp) return item;
                const r = await this.ask<LspCompletionItem>("completionItem/resolve", lsp, token);
                if (!r) return item;
                return {
                  ...item,
                  detail: r.detail ?? item.detail,
                  documentation: toMarkdown(r.documentation)[0] ?? item.documentation,
                  additionalTextEdits: r.additionalTextEdits?.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })) ?? item.additionalTextEdits,
                };
              }
            : undefined,
        }),
      );
    }
    if (has("hoverProvider")) {
      reg(
        L.registerHoverProvider(sel, {
          provideHover: async (model, position, token) => {
            const r = await this.ask<{ contents: MarkupContent | MarkedString | MarkedString[]; range?: LspRange }>("textDocument/hover", this.doc(model, position), token);
            if (!r) return null;
            const contents = toMarkdown(r.contents);
            return contents.length ? { contents, range: r.range ? toMonacoRange(r.range) : undefined } : null;
          },
        }),
      );
    }
    if (has("signatureHelpProvider")) {
      const sp = caps.signatureHelpProvider as { triggerCharacters?: string[]; retriggerCharacters?: string[] };
      reg(
        L.registerSignatureHelpProvider(sel, {
          signatureHelpTriggerCharacters: sp.triggerCharacters,
          signatureHelpRetriggerCharacters: sp.retriggerCharacters,
          provideSignatureHelp: async (model, position, token, context) => {
            type Sig = { label: string; documentation?: string | MarkupContent; parameters?: { label: string | [number, number]; documentation?: string | MarkupContent }[]; activeParameter?: number };
            const r = await this.ask<{ signatures: Sig[]; activeSignature?: number; activeParameter?: number }>(
              "textDocument/signatureHelp",
              { ...this.doc(model, position), context: { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter, isRetrigger: context.isRetrigger } },
              token,
            );
            if (!r?.signatures?.length) return null;
            return {
              value: {
                activeSignature: r.activeSignature ?? 0,
                activeParameter: r.activeParameter ?? 0,
                signatures: r.signatures.map((s) => ({
                  label: s.label,
                  documentation: toMarkdown(s.documentation)[0],
                  activeParameter: s.activeParameter,
                  parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: toMarkdown(p.documentation)[0] })),
                })),
              },
              dispose() {},
            };
          },
        }),
      );
    }
    if (has("definitionProvider")) reg(L.registerDefinitionProvider(sel, { provideDefinition: (m, p, t) => this.provideDefinition("definition", m, p, t) }));
    if (has("declarationProvider")) reg(L.registerDeclarationProvider(sel, { provideDeclaration: (m, p, t) => this.provideDefinition("declaration", m, p, t) }));
    if (has("typeDefinitionProvider")) reg(L.registerTypeDefinitionProvider(sel, { provideTypeDefinition: (m, p, t) => this.provideDefinition("typeDefinition", m, p, t) }));
    if (has("referencesProvider")) reg(L.registerReferenceProvider(sel, { provideReferences: (m, p, c, t) => this.provideReferences(m, p, c, t) }));
    if (has("documentHighlightProvider")) {
      reg(
        L.registerDocumentHighlightProvider(sel, {
          provideDocumentHighlights: async (model, position, token) =>
            ((await this.ask<{ range: LspRange; kind?: number }[]>("textDocument/documentHighlight", this.doc(model, position), token)) ?? []).map((h) => ({ range: toMonacoRange(h.range), kind: ((h.kind ?? 1) - 1) as monaco.languages.DocumentHighlightKind })),
        }),
      );
    }
    if (has("documentSymbolProvider")) {
      reg(
        L.registerDocumentSymbolProvider(sel, {
          displayName: this.options.label,
          provideDocumentSymbols: async (model, token) => toDocumentSymbols(await this.ask("textDocument/documentSymbol", this.doc(model), token)),
        }),
      );
    }
    if (has("renameProvider")) {
      const prepare = typeof caps.renameProvider === "object" && !!(caps.renameProvider as { prepareProvider?: boolean }).prepareProvider;
      reg(
        L.registerRenameProvider(sel, {
          provideRenameEdits: (m, p, n, t) => this.provideRenameEdits(m, p, n, t),
          resolveRenameLocation: prepare
            ? async (model, position, token) => {
                const r = await this.ask<LspRange | { range: LspRange; placeholder: string } | { defaultBehavior: boolean }>("textDocument/prepareRename", this.doc(model, position), token);
                if (!r) return { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "You cannot rename this element." };
                if ("defaultBehavior" in r) {
                  const w = model.getWordAtPosition(position);
                  return w ? { range: new monaco.Range(position.lineNumber, w.startColumn, position.lineNumber, w.endColumn), text: w.word } : { range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column), text: "", rejectReason: "You cannot rename this element." };
                }
                const range = "range" in r ? r.range : r;
                return { range: toMonacoRange(range), text: "placeholder" in r ? r.placeholder : model.getValueInRange(toMonacoRange(range)) };
              }
            : undefined,
        }),
      );
    }
  }

  /** Stops the server politely (shutdown + exit), then clears everything it registered. */
  async dispose(opts: { graceful?: boolean } = {}) {
    if (this.stopped) return;
    if (opts.graceful !== false) {
      await Promise.race([this.rpc.request("shutdown", null).catch(() => null), new Promise((r) => setTimeout(r, 1500))]);
      this.rpc.notify("exit", null);
    }
    this.stopped = true;
    this.rpc.close();
    this.disposables.splice(0).forEach((d) => d.dispose());
    this.progress.forEach((end) => end());
    this.progress.clear();
    for (const path of this.marked) {
      const model = monaco.editor.getModel(uriFor(path));
      if (model) monaco.editor.setModelMarkers(model, this.options.id, []);
    }
    this.marked.clear();
  }
}
