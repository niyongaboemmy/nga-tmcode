import type {
  CodeActionDTO,
  CommandDTO,
  CompletionItemDTO,
  CompletionListDTO,
  DocumentSymbolDTO,
  HoverDTO,
  LocationDTO,
  MarkdownDTO,
  ProviderKind,
  ProviderMeta,
  RangeDTO,
  SelectorDTO,
  SignatureHelpDTO,
  TextEditDTO,
  WorkspaceEditDTO,
} from "@tmcode/exthost";
import { monaco, setupMonaco } from "../monaco/setup";
import { ensureDocument, pathOfUri, uriFor } from "../monaco/documents";
import { installNavigation } from "../monaco/navigation";
import { log } from "../state/store";
import { fromRange, toRange } from "./documentSync";
import { withFormatterId } from "../monaco/formatters";
import type { HostKind } from "./state";

/**
 * Language features registered by extensions (`vscode.languages.register*Provider`)
 * become Monaco providers that call back into the extension host, and are
 * disposed with the registration (or when the host stops). Results come back
 * as DTOs (packages/exthost/src/protocol.ts) and are converted here.
 */

export interface HostLink {
  kind: HostKind;
  request<T>(method: string, params: unknown[], token?: monaco.CancellationToken): Promise<T>;
  notify(method: string, params: unknown[]): void;
}

const links = new Map<HostKind, HostLink>();
const registrations = new Map<string, monaco.IDisposable>();

/** Runs a command an extension attached to a completion, code lens… */
export const EXT_COMMAND = "_tmcode.exthost.command";
const EXT_CODE_ACTION = "_tmcode.exthost.codeAction";

/** Applies a WorkspaceEdit DTO (set by hostService to mainThread's implementation). */
export const editApplier: { apply: (edit: WorkspaceEditDTO) => Promise<boolean> } = { apply: async () => false };

let wired = false;
function wireOnce() {
  if (wired) return;
  wired = true;
  setupMonaco();
  monaco.editor.registerCommand(EXT_COMMAND, (_accessor, host: HostKind, ref: number) => runCachedCommand(host, ref));
  monaco.editor.registerCommand(EXT_CODE_ACTION, (_accessor, host: HostKind, edit: WorkspaceEditDTO | null, ref: number | null) => {
    void (async () => {
      if (edit) await editApplier.apply(edit);
      if (ref !== null && ref !== undefined) await links.get(host)?.request("$executeCachedCommand", [ref]);
    })().catch((e) => log("Extension Host", `Code action failed: ${String((e as Error)?.message ?? e)}`, "error"));
  });
  // The editor and link openers are registered at startup (monaco/navigation.ts).
  installNavigation();
}

/** Runs a command an extension handed over (status bar item, completion…) by its cache reference. */
export function runCachedCommand(host: HostKind, ref: number) {
  void links.get(host)?.request("$executeCachedCommand", [ref]).catch((e) => log("Extension Host", `Command failed: ${String((e as Error)?.message ?? e)}`, "error"));
}

export function setHostLink(link: HostLink | null, kind: HostKind) {
  if (link) links.set(kind, link);
  else links.delete(kind);
}

const FILE_SCHEMES = ["file", "untitled", "vscode-vfs", "vscode-remote", "tmcode", "vscode-userdata"];

/** A vscode DocumentSelector → Monaco's: file-like schemes are TMCode's documents; other schemes never match. */
export function toMonacoSelector(sel: SelectorDTO[]): monaco.languages.LanguageFilter[] {
  const out: monaco.languages.LanguageFilter[] = [];
  for (const f of sel) {
    if (f.notebookType) continue;
    if (f.scheme && f.scheme !== "*" && !FILE_SCHEMES.includes(f.scheme)) continue;
    const filter: { language?: string; scheme?: string; pattern?: string } = {};
    if (f.language) filter.language = f.language;
    if (f.pattern) filter.pattern = f.pattern.startsWith("**") || f.pattern.startsWith("/") ? f.pattern : `**/${f.pattern}`;
    if (f.scheme && f.scheme !== "*") filter.scheme = "tmcode";
    if (!filter.language && !filter.pattern && !filter.scheme) filter.language = "*";
    out.push(filter);
  }
  return out;
}

const VS_KIND = ["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter", "User", "Issue"];

/** vscode.CompletionItemKind → Monaco's (the enums are numbered differently). */
export function completionKind(k: number | undefined): monaco.languages.CompletionItemKind {
  const name = VS_KIND[k ?? 9] ?? "Property";
  return (monaco.languages.CompletionItemKind as unknown as Record<string, number>)[name] ?? monaco.languages.CompletionItemKind.Property;
}

function md(v: MarkdownDTO | string | undefined): string | monaco.IMarkdownString | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v;
  return { value: v.value, isTrusted: !!v.isTrusted, supportThemeIcons: !!v.supportThemeIcons, supportHtml: !!v.supportHtml };
}

function command(host: HostKind, c: CommandDTO | undefined): monaco.languages.Command | undefined {
  return c ? { id: EXT_COMMAND, title: c.title, tooltip: c.tooltip, arguments: [host, c.ref] } : undefined;
}

export function textEdits(list: TextEditDTO[] | undefined): monaco.languages.TextEdit[] {
  return (list ?? []).map((e) => ({ range: fromRange(e.range), text: e.text, ...(e.eol ? { eol: (e.eol - 1) as monaco.editor.EndOfLineSequence } : {}) }));
}

function locations(list: LocationDTO[] | null): monaco.languages.LocationLink[] {
  return (list ?? [])
    .filter((l) => l.path !== null)
    .map((l) => ({
      uri: uriFor(l.path!),
      range: fromRange(l.range),
      ...(l.targetSelectionRange ? { targetSelectionRange: fromRange(l.targetSelectionRange) } : {}),
      ...(l.originSelectionRange ? { originSelectionRange: fromRange(l.originSelectionRange) } : {}),
    }));
}

function symbols(list: DocumentSymbolDTO[]): monaco.languages.DocumentSymbol[] {
  return list.map((s) => ({ name: s.name || " ", detail: s.detail, kind: s.kind as monaco.languages.SymbolKind, tags: (s.tags ?? []) as monaco.languages.SymbolTag[], range: fromRange(s.range), selectionRange: fromRange(s.selectionRange), containerName: s.containerName, children: symbols(s.children ?? []) }));
}

const MONACO_TO_VS_SEVERITY: Record<number, number> = { 8: 0, 4: 1, 2: 2, 1: 3 };

async function workspaceEdit(dto: WorkspaceEditDTO | null): Promise<monaco.languages.WorkspaceEdit> {
  const edits: monaco.languages.IWorkspaceTextEdit[] = [];
  for (const e of dto?.entries ?? []) {
    if (e.kind !== "text") continue;
    await ensureDocument(e.path).catch(() => null);
    edits.push({ resource: uriFor(e.path), textEdit: { range: fromRange(e.edit.range), text: e.edit.text }, versionId: undefined });
  }
  return { edits };
}

function convertCompletion(host: HostKind, it: CompletionItemDTO, model: monaco.editor.ITextModel, position: monaco.Position, cacheId: number): monaco.languages.CompletionItem {
  const word = model.getWordUntilPosition(position);
  const end = model.getWordAtPosition(position)?.endColumn ?? position.column;
  let range: monaco.languages.CompletionItem["range"] = { insert: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column), replace: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, end) };
  if (Array.isArray(it.range)) range = fromRange(it.range);
  else if (it.range) range = { insert: monaco.Range.lift(fromRange(it.range.insert)), replace: monaco.Range.lift(fromRange(it.range.replace)) };
  const rules = it.snippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : it.keepWhitespace ? monaco.languages.CompletionItemInsertTextRule.KeepWhitespace : undefined;
  return Object.assign(
    {
      label: it.label,
      kind: completionKind(it.kind),
      tags: it.tags as monaco.languages.CompletionItemTag[] | undefined,
      detail: it.detail,
      documentation: md(it.documentation),
      sortText: it.sortText,
      filterText: it.filterText,
      preselect: it.preselect,
      insertText: it.insertText,
      insertTextRules: rules,
      range,
      commitCharacters: it.commitCharacters,
      additionalTextEdits: it.additionalTextEdits ? textEdits(it.additionalTextEdits) : undefined,
      command: command(host, it.command),
    },
    { _tm: { cacheId, i: it.i } },
  );
}

function createProvider(host: HostKind, handle: number, kind: ProviderKind, selector: monaco.languages.LanguageSelector, meta: ProviderMeta): monaco.IDisposable | null {
  const call = <T,>(method: string, args: unknown[], token?: monaco.CancellationToken) => {
    const l = links.get(host);
    if (!l) return Promise.reject(new Error("The extension host is not running"));
    return l.request<T>("$provide", [handle, method, args], token);
  };
  const path = (m: monaco.editor.ITextModel) => pathOfUri(m.uri);
  const pos = (p: monaco.IPosition) => [p.lineNumber - 1, p.column - 1];
  const fmt = (o: monaco.languages.FormattingOptions) => ({ tabSize: o.tabSize, insertSpaces: o.insertSpaces });
  const L = monaco.languages;
  switch (kind) {
    case "completion":
      return L.registerCompletionItemProvider(selector, {
        triggerCharacters: meta.triggerCharacters,
        async provideCompletionItems(model, position, context, token) {
          const res = await call<CompletionListDTO | null>("provideCompletionItems", [path(model), pos(position), { triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter }], token);
          if (!res) return { suggestions: [] };
          return {
            suggestions: res.items.map((it) => convertCompletion(host, it, model, position, res.cacheId)),
            incomplete: res.incomplete,
            dispose: () => links.get(host)?.notify("$releaseCache", ["completion", res.cacheId]),
          };
        },
        async resolveCompletionItem(item, token) {
          const tm = (item as { _tm?: { cacheId: number; i: number } })._tm;
          if (!tm) return item;
          const r = await call<CompletionItemDTO | null>("resolveCompletionItem", [tm.cacheId, tm.i], token).catch(() => null);
          if (!r) return item;
          return { ...item, detail: r.detail ?? item.detail, documentation: md(r.documentation) ?? item.documentation, additionalTextEdits: r.additionalTextEdits ? textEdits(r.additionalTextEdits) : item.additionalTextEdits, command: command(host, r.command) ?? item.command };
        },
      });
    case "hover":
      return L.registerHoverProvider(selector, {
        async provideHover(model, position, token) {
          const h = await call<HoverDTO | null>("provideHover", [path(model), pos(position)], token);
          return h ? { contents: h.contents.map((c) => md(c) as monaco.IMarkdownString), range: h.range ? fromRange(h.range) : undefined } : null;
        },
      });
    case "definition":
      return L.registerDefinitionProvider(selector, { provideDefinition: async (m, p, t) => locations(await call<LocationDTO[]>("provideDefinition", [path(m), pos(p)], t)) });
    case "declaration":
      return L.registerDeclarationProvider(selector, { provideDeclaration: async (m, p, t) => locations(await call<LocationDTO[]>("provideDeclaration", [path(m), pos(p)], t)) });
    case "typeDefinition":
      return L.registerTypeDefinitionProvider(selector, { provideTypeDefinition: async (m, p, t) => locations(await call<LocationDTO[]>("provideTypeDefinition", [path(m), pos(p)], t)) });
    case "implementation":
      return L.registerImplementationProvider(selector, { provideImplementation: async (m, p, t) => locations(await call<LocationDTO[]>("provideImplementation", [path(m), pos(p)], t)) });
    case "references":
      return L.registerReferenceProvider(selector, { provideReferences: async (m, p, ctx, t) => locations(await call<LocationDTO[]>("provideReferences", [path(m), pos(p), ctx.includeDeclaration], t)) });
    case "documentSymbol":
      return L.registerDocumentSymbolProvider(selector, { displayName: meta.displayName, provideDocumentSymbols: async (m, t) => symbols((await call<DocumentSymbolDTO[]>("provideDocumentSymbols", [path(m)], t)) ?? []) });
    case "codeAction":
      return L.registerCodeActionProvider(
        selector,
        {
          async provideCodeActions(model, range, context, token) {
            const diagnostics = context.markers.map((m) => ({ range: toRange(m), message: m.message, severity: MONACO_TO_VS_SEVERITY[m.severity] ?? 0, source: m.source, code: typeof m.code === "string" ? m.code : m.code?.value }));
            const res = await call<CodeActionDTO[]>("provideCodeActions", [path(model), toRange(range), { diagnostics, only: context.only, triggerKind: context.trigger === monaco.languages.CodeActionTriggerType.Invoke ? 1 : 2 }], token);
            const actions: monaco.languages.CodeAction[] = (res ?? []).map((a) => ({
              title: a.title,
              kind: a.kind,
              isPreferred: a.isPreferred,
              disabled: a.disabled,
              diagnostics: context.markers.filter((m) => a.diagnostics?.some((d) => d.message === m.message)),
              // Edits and commands go through TMCode (an edit may touch files that are not open).
              command: a.edit || a.command ? { id: EXT_CODE_ACTION, title: a.title, arguments: [host, a.edit ?? null, a.command?.ref ?? null] } : undefined,
            }));
            return { actions, dispose() {} };
          },
        },
        { providedCodeActionKinds: meta.providedCodeActionKinds },
      );
    case "formatting":
      return L.registerDocumentFormattingEditProvider(
        selector,
        withFormatterId(
          {
            displayName: meta.displayName,
            provideDocumentFormattingEdits: async (m: monaco.editor.ITextModel, o: monaco.languages.FormattingOptions, t: monaco.CancellationToken) => textEdits(await call<TextEditDTO[]>("provideDocumentFormattingEdits", [path(m), fmt(o)], t)),
          },
          meta.extensionId,
        ),
      );
    case "rangeFormatting":
      return L.registerDocumentRangeFormattingEditProvider(
        selector,
        withFormatterId(
          {
            displayName: meta.displayName,
            provideDocumentRangeFormattingEdits: async (m: monaco.editor.ITextModel, r: monaco.IRange, o: monaco.languages.FormattingOptions, t: monaco.CancellationToken) => textEdits(await call<TextEditDTO[]>("provideDocumentRangeFormattingEdits", [path(m), toRange(r), fmt(o)], t)),
          },
          meta.extensionId,
        ),
      );
    case "onTypeFormatting":
      if (!meta.moreTriggerCharacters?.length) return null;
      return L.registerOnTypeFormattingEditProvider(selector, {
        autoFormatTriggerCharacters: meta.moreTriggerCharacters,
        provideOnTypeFormattingEdits: async (m, p, ch, o, t) => textEdits(await call<TextEditDTO[]>("provideOnTypeFormattingEdits", [path(m), pos(p), ch, fmt(o)], t)),
      });
    case "color":
      return L.registerColorProvider(selector, {
        async provideDocumentColors(m, t) {
          const res = await call<{ range: RangeDTO; color: [number, number, number, number] }[]>("provideDocumentColors", [path(m)], t);
          return (res ?? []).map((c) => ({ range: fromRange(c.range), color: { red: c.color[0], green: c.color[1], blue: c.color[2], alpha: c.color[3] } }));
        },
        async provideColorPresentations(m, info, t) {
          const c = info.color;
          const res = await call<{ label: string; textEdit?: TextEditDTO; additionalTextEdits?: TextEditDTO[] }[]>("provideColorPresentations", [path(m), [c.red, c.green, c.blue, c.alpha], toRange(info.range)], t);
          return (res ?? []).map((p) => ({ label: p.label, textEdit: p.textEdit ? textEdits([p.textEdit])[0] : undefined, additionalTextEdits: p.additionalTextEdits ? textEdits(p.additionalTextEdits) : undefined }));
        },
      });
    case "documentHighlight":
      return L.registerDocumentHighlightProvider(selector, {
        provideDocumentHighlights: async (m, p, t) => ((await call<{ range: RangeDTO; kind: number }[]>("provideDocumentHighlights", [path(m), pos(p)], t)) ?? []).map((h) => ({ range: fromRange(h.range), kind: h.kind as monaco.languages.DocumentHighlightKind })),
      });
    case "documentLink":
      return L.registerLinkProvider(selector, {
        async provideLinks(m, t) {
          const res = await call<{ range: RangeDTO; target?: { path?: string; uri?: string }; tooltip?: string }[]>("provideDocumentLinks", [path(m)], t);
          return { links: (res ?? []).map((l) => ({ range: fromRange(l.range), url: l.target?.path !== undefined ? uriFor(l.target.path) : l.target?.uri, tooltip: l.tooltip })) };
        },
      });
    case "foldingRange":
      return L.registerFoldingRangeProvider(selector, {
        async provideFoldingRanges(m, _ctx, t) {
          const kinds = [undefined, L.FoldingRangeKind.Comment, L.FoldingRangeKind.Imports, L.FoldingRangeKind.Region];
          return ((await call<{ start: number; end: number; kind?: number }[]>("provideFoldingRanges", [path(m)], t)) ?? []).map((f) => ({ start: f.start + 1, end: f.end + 1, kind: f.kind ? kinds[f.kind] : undefined }));
        },
      });
    case "signatureHelp":
      return L.registerSignatureHelpProvider(selector, {
        signatureHelpTriggerCharacters: meta.triggerCharacters,
        signatureHelpRetriggerCharacters: meta.retriggerCharacters,
        async provideSignatureHelp(m, p, t, ctx) {
          const h = await call<SignatureHelpDTO | null>("provideSignatureHelp", [path(m), pos(p), { triggerKind: ctx.triggerKind, triggerCharacter: ctx.triggerCharacter, isRetrigger: ctx.isRetrigger }], t);
          if (!h) return null;
          return {
            value: {
              activeSignature: h.activeSignature,
              activeParameter: h.activeParameter,
              signatures: h.signatures.map((s) => ({ label: s.label, documentation: md(s.documentation), activeParameter: s.activeParameter, parameters: s.parameters.map((p2) => ({ label: p2.label, documentation: md(p2.documentation) })) })),
            },
            dispose() {},
          };
        },
      });
    case "rename":
      return L.registerRenameProvider(selector, {
        provideRenameEdits: async (m, p, newName, t) => workspaceEdit(await call<WorkspaceEditDTO | null>("provideRenameEdits", [path(m), pos(p), newName], t)),
        async resolveRenameLocation(m, p, t) {
          const r = await call<{ range: RangeDTO; placeholder?: string } | null>("prepareRename", [path(m), pos(p)], t).catch(() => null);
          if (!r) {
            const w = m.getWordAtPosition(p);
            return w ? { range: new monaco.Range(p.lineNumber, w.startColumn, p.lineNumber, w.endColumn), text: w.word } : { range: new monaco.Range(p.lineNumber, p.column, p.lineNumber, p.column), text: "", rejectReason: "Cannot rename here" };
          }
          const range = fromRange(r.range);
          return { range, text: r.placeholder ?? m.getValueInRange(range) };
        },
      });
    case "inlayHints":
      return L.registerInlayHintsProvider(selector, {
        async provideInlayHints(m, range, t) {
          const res = await call<{ position: [number, number]; label: string; kind?: number; tooltip?: MarkdownDTO | string; paddingLeft?: boolean; paddingRight?: boolean }[]>("provideInlayHints", [path(m), toRange(range)], t);
          return { hints: (res ?? []).map((h) => ({ label: h.label, position: { lineNumber: h.position[0] + 1, column: h.position[1] + 1 }, kind: h.kind as monaco.languages.InlayHintKind | undefined, tooltip: md(h.tooltip), paddingLeft: h.paddingLeft, paddingRight: h.paddingRight })), dispose() {} };
        },
      });
    case "codeLens":
      return L.registerCodeLensProvider(selector, {
        async provideCodeLenses(m, t) {
          const res = await call<{ cacheId: number; lenses: { i: number; range: RangeDTO; command?: CommandDTO }[] } | null>("provideCodeLenses", [path(m)], t);
          if (!res) return { lenses: [], dispose() {} };
          return {
            lenses: res.lenses.map((l) => ({ range: fromRange(l.range), id: `${res.cacheId}:${l.i}`, command: command(host, l.command) })),
            dispose: () => links.get(host)?.notify("$releaseCache", ["codeLens", res.cacheId]),
          };
        },
        resolveCodeLens: meta.resolve
          ? async (_m, lens, t) => {
              const [cacheId, i] = String(lens.id).split(":").map(Number);
              const r = await call<{ range: RangeDTO; command?: CommandDTO } | null>("resolveCodeLens", [cacheId, i], t).catch(() => null);
              return r ? { ...lens, command: command(host, r.command) } : lens;
            }
          : undefined,
      });
    case "linkedEditing":
      return L.registerLinkedEditingRangeProvider(selector, {
        async provideLinkedEditingRanges(m, p, t) {
          const r = await call<{ ranges: RangeDTO[]; wordPattern?: { source: string; flags: string } } | null>("provideLinkedEditingRanges", [path(m), pos(p)], t);
          return r ? { ranges: r.ranges.map(fromRange), wordPattern: r.wordPattern ? new RegExp(r.wordPattern.source, r.wordPattern.flags) : undefined } : null;
        },
      });
    case "selectionRange":
      return L.registerSelectionRangeProvider(selector, {
        provideSelectionRanges: async (m, positions, t) => ((await call<RangeDTO[][]>("provideSelectionRanges", [path(m), positions.map(pos)], t)) ?? []).map((chain) => chain.map((r) => ({ range: fromRange(r) }))),
      });
  }
  return null;
}

export function registerProvider(host: HostKind, handle: number, kind: ProviderKind, selector: SelectorDTO[], meta: ProviderMeta) {
  wireOnce();
  const sel = toMonacoSelector(selector);
  if (!sel.length) return;
  try {
    const d = createProvider(host, handle, kind, sel, meta);
    if (d) registrations.set(`${host}:${handle}`, d);
  } catch (e) {
    log("Extension Host", `${meta.extensionId}: could not register a ${kind} provider: ${String((e as Error)?.message ?? e)}`, "warn");
  }
}

export function unregisterProvider(host: HostKind, handle: number) {
  const key = `${host}:${handle}`;
  registrations.get(key)?.dispose();
  registrations.delete(key);
}

/** The host stopped: every provider it registered goes away. */
export function disposeProviders(host: HostKind) {
  for (const [key, d] of [...registrations]) {
    if (!key.startsWith(`${host}:`)) continue;
    d.dispose();
    registrations.delete(key);
  }
}
