import { monaco } from "../monaco/setup";
import { ensureDocument, onDocumentSaved, pathOfUri, uriFor } from "../monaco/documents";
import { completionKind } from "../exthost/languageBridge";
import { beginActivity } from "../state/activity";
import { log, notify } from "../state/store";
import { registerWorkspaceSymbolProvider, type WorkspaceSymbol } from "../commands/symbols";
import { isCancellation, RpcConnection, type RpcTransport } from "./jsonrpc";
import { configurationSection } from "./manifest";
import { fileUri, pathOfFileUri, rootUri } from "./uri";

/**
 * A Language Server Protocol client for Monaco: keeps the server's view of
 * TMCode's documents in sync and turns its answers into Monaco providers
 * (completion, hover, signature help, definition, references, highlights,
 * symbols, rename, code actions and quick fixes, formatting, inlay hints,
 * code lens, semantic tokens, folding, selection ranges, document links,
 * workspace symbols) and markers. Used for the built-in servers (Pyright).
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

export interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}
export interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  data?: unknown;
}
export interface LspInlayHint {
  position: LspPosition;
  label: string | { value: string; tooltip?: string | MarkupContent }[];
  kind?: number;
  tooltip?: string | MarkupContent;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}
interface LspCodeLens {
  range: LspRange;
  command?: LspCommand;
  data?: unknown;
}

/** The semantic token types and modifiers TMCode understands (LSP's standard set). */
export const SEMANTIC_TOKEN_TYPES = [
  "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember",
  "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
];
export const SEMANTIC_TOKEN_MODIFIERS = ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"];

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

/** An inlay hint's label: plain text, or its parts joined. */
export function inlayLabel(label: LspInlayHint["label"]): string {
  return typeof label === "string" ? label : label.map((p) => p.value).join("");
}

/** LSP InlayHintKind (1 Type, 2 Parameter) → Monaco's (1 Type, 2 Parameter). */
export function toInlayHint(h: LspInlayHint): monaco.languages.InlayHint {
  const tooltip = toMarkdown(h.tooltip)[0];
  return {
    label: inlayLabel(h.label),
    position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
    kind: h.kind === 1 ? monaco.languages.InlayHintKind.Type : h.kind === 2 ? monaco.languages.InlayHintKind.Parameter : undefined,
    tooltip,
    paddingLeft: h.paddingLeft,
    paddingRight: h.paddingRight,
  };
}

/** LSP selection ranges (each with its parent) → Monaco's lists, innermost first. */
export function toSelectionRanges(list: ({ range: LspRange; parent?: unknown } | null)[] | null): monaco.languages.SelectionRange[][] {
  return (list ?? []).map((r) => {
    const out: monaco.languages.SelectionRange[] = [];
    let cur = r as { range: LspRange; parent?: unknown } | undefined | null;
    while (cur) {
      out.push({ range: toMonacoRange(cur.range) });
      cur = cur.parent as typeof cur;
    }
    return out;
  });
}

/** LSP folding ranges (0-based lines) → Monaco's (1-based), with region/comment/imports kinds. */
export function toFoldingRanges(list: { startLine: number; endLine: number; kind?: string }[] | null): monaco.languages.FoldingRange[] {
  return (list ?? []).map((r) => ({
    start: r.startLine + 1,
    end: r.endLine + 1,
    kind: r.kind === "comment" ? monaco.languages.FoldingRangeKind.Comment : r.kind === "imports" ? monaco.languages.FoldingRangeKind.Imports : r.kind === "region" ? monaco.languages.FoldingRangeKind.Region : undefined,
  }));
}

/** Diagnostics sent back with a code action request: the server's own markers in that range. */
export function markersAsDiagnostics(markers: monaco.editor.IMarker[]): LspDiagnostic[] {
  const severity: Record<number, number> = { 8: 1, 4: 2, 2: 3, 1: 4 };
  return markers.map((m) => ({
    range: { start: { line: m.startLineNumber - 1, character: m.startColumn - 1 }, end: { line: m.endLineNumber - 1, character: m.endColumn - 1 } },
    severity: severity[m.severity] ?? 1,
    message: m.message,
    source: m.source,
    code: typeof m.code === "string" ? m.code : m.code?.value,
  }));
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

let clientSeq = 0;

export class LanguageClient {
  readonly rpc: RpcConnection;
  private disposables: monaco.IDisposable[] = [];
  private synced = new Map<string, { version: number; listeners: monaco.IDisposable[] }>();
  private progress = new Map<string | number, () => void>();
  capabilities: Record<string, unknown> = {};
  private stopped = false;
  /** Paths with markers from this server. */
  private marked = new Set<string>();
  private refresh = { inlay: new monaco.Emitter<void>(), lens: new monaco.Emitter<void>(), tokens: new monaco.Emitter<void>() };
  /** Monaco command that runs a server command (code actions and code lenses name them). */
  readonly commandId: string;

  constructor(
    readonly options: ClientOptions,
    transport: RpcTransport,
  ) {
    this.rpc = new RpcConnection(transport);
    this.commandId = `tmcode.lsp.${options.id}.${++clientSeq}.executeCommand`;
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
    // The server's results changed (a file saved elsewhere): Monaco asks again.
    rpc.onRequest("workspace/inlayHint/refresh", () => (this.refresh.inlay.fire(), null));
    rpc.onRequest("workspace/codeLens/refresh", () => (this.refresh.lens.fire(), null));
    rpc.onRequest("workspace/semanticTokens/refresh", () => (this.refresh.tokens.fire(), null));
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
        workspace: {
          configuration: true,
          workspaceFolders: true,
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
          didChangeConfiguration: { dynamicRegistration: true },
          executeCommand: {},
          symbol: { symbolKind: { valueSet: Array.from({ length: 26 }, (_, i) => i + 1) } },
          inlayHint: { refreshSupport: true },
          codeLens: { refreshSupport: true },
          semanticTokens: { refreshSupport: true },
        },
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
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] } },
            isPreferredSupport: true,
            disabledSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ["edit"] },
          },
          formatting: {},
          rangeFormatting: {},
          inlayHint: {},
          codeLens: {},
          foldingRange: { lineFoldingOnly: true },
          selectionRange: {},
          documentLink: { tooltipSupport: true },
          semanticTokens: {
            requests: { full: true, range: false },
            tokenTypes: SEMANTIC_TOKEN_TYPES,
            tokenModifiers: SEMANTIC_TOKEN_MODIFIERS,
            formats: ["relative"],
            overlappingTokenSupport: false,
            multilineTokenSupport: false,
          },
        },
      },
    });
    this.capabilities = init?.capabilities ?? {};
    rpc.notify("initialized", {});
    rpc.notify("workspace/didChangeConfiguration", { settings: options.settings });
    this.wireDocuments();
    this.registerProviders();
    this.registerMoreProviders();
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

  /** Code actions and quick fixes for a range, with this server's markers there. */
  async provideCodeActions(model: monaco.editor.ITextModel, range: monaco.IRange, only?: string, token?: monaco.CancellationToken): Promise<monaco.languages.CodeAction[]> {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri, owner: this.options.id }).filter((m) => monaco.Range.areIntersectingOrTouching(m, range));
    const res = await this.ask<(LspCodeAction | LspCommand)[]>(
      "textDocument/codeAction",
      { ...this.doc(model), range: { start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }), end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }) }, context: { diagnostics: markersAsDiagnostics(markers), ...(only ? { only: [only] } : {}), triggerKind: 1 } },
      token,
    );
    const out: monaco.languages.CodeAction[] = [];
    for (const a of res ?? []) {
      // A bare Command (older servers).
      if (typeof (a as LspCommand).command === "string") {
        const c = a as LspCommand;
        out.push({ title: c.title, command: { id: this.commandId, title: c.title, arguments: [c] } });
        continue;
      }
      const action = a as LspCodeAction;
      out.push(Object.assign(
        {
          title: action.title,
          kind: action.kind,
          isPreferred: action.isPreferred,
          disabled: action.disabled?.reason,
          diagnostics: action.diagnostics?.length ? markers.filter((m) => action.diagnostics!.some((d) => d.message === m.message)) : undefined,
          edit: action.edit ? await this.toMonacoEdit(action.edit) : undefined,
          command: action.command ? { id: this.commandId, title: action.command.title, arguments: [action.command] } : undefined,
        },
        { __lsp: action },
      ));
    }
    return out;
  }

  /** A code action's edit, asked for when it is picked (servers that resolve lazily). */
  async resolveCodeAction(action: monaco.languages.CodeAction, token?: monaco.CancellationToken): Promise<monaco.languages.CodeAction> {
    const lsp = (action as { __lsp?: LspCodeAction }).__lsp;
    if (!lsp || action.edit) return action;
    const r = await this.ask<LspCodeAction>("codeAction/resolve", lsp, token);
    return r?.edit ? { ...action, edit: await this.toMonacoEdit(r.edit) } : action;
  }

  async provideFormatting(model: monaco.editor.ITextModel, options: monaco.languages.FormattingOptions, range?: monaco.IRange, token?: monaco.CancellationToken): Promise<monaco.languages.TextEdit[]> {
    const lspOptions = { tabSize: options.tabSize, insertSpaces: options.insertSpaces, trimTrailingWhitespace: true, insertFinalNewline: true };
    const edits = range
      ? await this.ask<LspTextEdit[]>("textDocument/rangeFormatting", { ...this.doc(model), range: { start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }), end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }) }, options: lspOptions }, token)
      : await this.ask<LspTextEdit[]>("textDocument/formatting", { ...this.doc(model), options: lspOptions }, token);
    return (edits ?? []).map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
  }

  async provideInlayHints(model: monaco.editor.ITextModel, range: monaco.IRange, token?: monaco.CancellationToken): Promise<monaco.languages.InlayHint[]> {
    const res = await this.ask<LspInlayHint[]>(
      "textDocument/inlayHint",
      { ...this.doc(model), range: { start: toLspPosition({ lineNumber: range.startLineNumber, column: range.startColumn }), end: toLspPosition({ lineNumber: range.endLineNumber, column: range.endColumn }) } },
      token,
    );
    return (res ?? []).map(toInlayHint);
  }

  async provideCodeLenses(model: monaco.editor.ITextModel, token?: monaco.CancellationToken): Promise<monaco.languages.CodeLens[]> {
    const res = await this.ask<LspCodeLens[]>("textDocument/codeLens", this.doc(model), token);
    return (res ?? []).map((l) => Object.assign({ range: toMonacoRange(l.range), command: l.command ? { id: this.commandId, title: l.command.title, arguments: [l.command] } : undefined }, { __lsp: l }));
  }

  async resolveCodeLens(lens: monaco.languages.CodeLens, token?: monaco.CancellationToken): Promise<monaco.languages.CodeLens> {
    const lsp = (lens as { __lsp?: LspCodeLens }).__lsp;
    if (!lsp || lens.command) return lens;
    const r = await this.ask<LspCodeLens>("codeLens/resolve", lsp, token);
    return r?.command ? { ...lens, command: { id: this.commandId, title: r.command.title, arguments: [r.command] } } : lens;
  }

  async provideSemanticTokens(model: monaco.editor.ITextModel, token?: monaco.CancellationToken): Promise<monaco.languages.SemanticTokens | null> {
    const r = await this.ask<{ resultId?: string; data: number[] }>("textDocument/semanticTokens/full", this.doc(model), token);
    return r ? { resultId: r.resultId, data: new Uint32Array(r.data) } : null;
  }

  async provideWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    const res = await this.ask<LspSymbolInformation[]>("workspace/symbol", { query });
    const out: WorkspaceSymbol[] = [];
    for (const s of res ?? []) {
      if (!s.location?.uri) continue;
      const path = this.pathOf(s.location.uri);
      if (path === null || path === "") continue;
      out.push({ name: s.name, kind: toSymbolKind(s.kind), path, line: s.location.range.start.line + 1, column: s.location.range.start.character + 1, container: s.containerName });
    }
    return out;
  }

  /** Runs a command the server named (from a code action or a code lens). */
  async executeCommand(command: LspCommand) {
    await this.ask("workspace/executeCommand", { command: command.command, arguments: command.arguments ?? [] });
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

  private registerMoreProviders() {
    const L = monaco.languages;
    const caps = this.capabilities as Record<string, unknown>;
    const has = (k: string) => !!caps[k];
    const sel = this.options.languages.map((language) => ({ language, scheme: "tmcode" }));
    const reg = (d: monaco.IDisposable) => this.disposables.push(d);
    const label = this.options.label;

    reg(monaco.editor.registerCommand(this.commandId, (_accessor, command: LspCommand) => void this.executeCommand(command)));

    if (has("codeActionProvider")) {
      const cp = caps.codeActionProvider as { codeActionKinds?: string[]; resolveProvider?: boolean } | boolean;
      reg(
        L.registerCodeActionProvider(
          sel,
          {
            provideCodeActions: async (model, range, context, token) => ({ actions: await this.provideCodeActions(model, range, context.only, token), dispose() {} }),
            resolveCodeAction: typeof cp === "object" && cp.resolveProvider ? (action, token) => this.resolveCodeAction(action, token) : undefined,
          },
          typeof cp === "object" && cp.codeActionKinds ? { providedCodeActionKinds: cp.codeActionKinds } : undefined,
        ),
      );
    }
    if (has("documentFormattingProvider")) {
      reg(L.registerDocumentFormattingEditProvider(sel, { displayName: label, provideDocumentFormattingEdits: (m, o, t) => this.provideFormatting(m, o, undefined, t) }));
    }
    if (has("documentRangeFormattingProvider")) {
      reg(L.registerDocumentRangeFormattingEditProvider(sel, { displayName: label, provideDocumentRangeFormattingEdits: (m, r, o, t) => this.provideFormatting(m, o, r, t) }));
    }
    if (has("inlayHintProvider")) {
      reg(L.registerInlayHintsProvider(sel, { displayName: label, onDidChangeInlayHints: this.refresh.inlay.event, provideInlayHints: async (m, r, t) => ({ hints: await this.provideInlayHints(m, r, t), dispose() {} }) }));
    }
    if (has("codeLensProvider")) {
      const resolve = !!(caps.codeLensProvider as { resolveProvider?: boolean }).resolveProvider;
      reg(
        L.registerCodeLensProvider(sel, {
          onDidChange: this.refresh.lens.event as unknown as monaco.IEvent<monaco.languages.CodeLensProvider>,
          provideCodeLenses: async (m, t) => ({ lenses: await this.provideCodeLenses(m, t), dispose() {} }),
          resolveCodeLens: resolve ? (_m, lens, t) => this.resolveCodeLens(lens, t) : undefined,
        }),
      );
    }
    const st = caps.semanticTokensProvider as { legend?: monaco.languages.SemanticTokensLegend; full?: boolean | object } | undefined;
    if (st?.legend && st.full) {
      reg(
        L.registerDocumentSemanticTokensProvider(sel, {
          onDidChange: this.refresh.tokens.event,
          getLegend: () => st.legend!,
          provideDocumentSemanticTokens: (m, _last, t) => this.provideSemanticTokens(m, t),
          releaseDocumentSemanticTokens: () => {},
        }),
      );
    }
    if (has("foldingRangeProvider")) {
      reg(L.registerFoldingRangeProvider(sel, { provideFoldingRanges: async (m, _c, t) => toFoldingRanges(await this.ask("textDocument/foldingRange", this.doc(m), t)) }));
    }
    if (has("selectionRangeProvider")) {
      reg(
        L.registerSelectionRangeProvider(sel, {
          provideSelectionRanges: async (m, positions, t) => toSelectionRanges(await this.ask("textDocument/selectionRange", { ...this.doc(m), positions: positions.map(toLspPosition) }, t)),
        }),
      );
    }
    if (has("documentLinkProvider")) {
      reg(
        L.registerLinkProvider(sel, {
          provideLinks: async (m, t) => {
            const links = (await this.ask<{ range: LspRange; target?: string; tooltip?: string }[]>("textDocument/documentLink", this.doc(m), t)) ?? [];
            return {
              links: links.map((l) => {
                // A link to a file in the folder opens it in TMCode.
                const path = l.target ? this.pathOf(l.target) : null;
                return { range: toMonacoRange(l.range), url: path ? uriFor(path).toString() : l.target, tooltip: l.tooltip };
              }),
            };
          },
        }),
      );
    }
    if (has("workspaceSymbolProvider")) {
      const off = registerWorkspaceSymbolProvider((q) => this.provideWorkspaceSymbols(q));
      reg({ dispose: () => void off() });
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
