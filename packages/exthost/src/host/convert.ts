/**
 * vscode API values → wire DTOs (and back), the host half of VS Code's
 * extHostTypeConverters. Anything malformed an extension returns is dropped
 * rather than failing the whole result.
 */

import * as T from "../api/types";
import { Uri } from "../api/uri";
import type {
  CodeActionDTO,
  CommandDTO,
  CompletionItemDTO,
  DiagnosticDTO,
  DocumentSymbolDTO,
  HoverDTO,
  LocationDTO,
  MarkdownDTO,
  PositionDTO,
  RangeDTO,
  SelectionDTO,
  SignatureHelpDTO,
  TextEditDTO,
  WorkspaceEditDTO,
  WorkspaceEditEntryDTO,
} from "../protocol";

export interface PathMapper {
  /** Workspace-relative path of a URI, or null when it is outside the workspace. */
  toPath(uri: Uri): string | null;
  toUri(path: string): Uri;
}

export interface CommandCache {
  /** Keeps a command (with its live arguments) and returns a reference to it. */
  add(cmd: T.Command): number;
}

export const range = {
  from(r: T.Range): RangeDTO {
    return [r.start.line, r.start.character, r.end.line, r.end.character];
  },
  to(r: RangeDTO): T.Range {
    return new T.Range(r[0], r[1], r[2], r[3]);
  },
};

export const position = {
  from(p: T.Position): PositionDTO {
    return [p.line, p.character];
  },
  to(p: PositionDTO): T.Position {
    return new T.Position(p[0], p[1]);
  },
};

export const selection = {
  from(s: T.Selection): SelectionDTO {
    return { anchor: position.from(s.anchor), active: position.from(s.active) };
  },
  to(s: SelectionDTO): T.Selection {
    return new T.Selection(position.to(s.anchor), position.to(s.active));
  },
};

export function markdown(v: unknown): MarkdownDTO | undefined {
  if (typeof v === "string") return { value: v };
  if (T.MarkdownString.isMarkdownString(v)) return { value: v.value, isTrusted: !!v.isTrusted, supportThemeIcons: !!v.supportThemeIcons, supportHtml: !!v.supportHtml };
  if (v && typeof v === "object" && typeof (v as { value?: unknown }).value === "string") {
    const ms = v as { language?: string; value: string };
    // MarkedString {language, value} → a fenced code block.
    if (typeof ms.language === "string") return { value: "```" + ms.language + "\n" + ms.value + "\n```" };
    return { value: ms.value };
  }
  return undefined;
}

/** Plain strings stay plain (no markdown rendering), as in VS Code's completion documentation. */
export function documentation(v: unknown): MarkdownDTO | string | undefined {
  if (typeof v === "string") return v;
  return markdown(v);
}

export function textEdit(e: T.TextEdit | T.SnippetTextEdit): TextEditDTO {
  if (T.SnippetTextEdit.isSnippetTextEdit(e)) return { range: range.from(e.range), text: e.snippet.value, snippet: true };
  const out: TextEditDTO = { range: range.from(e.range), text: e.newText ?? "" };
  if (e.newEol) out.eol = e.newEol as 1 | 2;
  return out;
}

export function textEdits(list: unknown): TextEditDTO[] {
  if (!Array.isArray(list)) return [];
  return list.filter((e) => T.TextEdit.isTextEdit(e) || T.SnippetTextEdit.isSnippetTextEdit(e)).map(textEdit);
}

export function command(cmd: T.Command | undefined | null, cache: CommandCache): CommandDTO | undefined {
  if (!cmd || typeof cmd.command !== "string") return undefined;
  return { command: cmd.command, title: cmd.title ?? "", tooltip: cmd.tooltip, ref: cache.add(cmd) };
}

export function diagnostic(d: T.Diagnostic, paths: PathMapper): DiagnosticDTO {
  const code = d.code;
  const out: DiagnosticDTO = { range: range.from(d.range), message: String(d.message ?? ""), severity: typeof d.severity === "number" ? d.severity : 0 };
  if (d.source) out.source = String(d.source);
  if (typeof code === "string" || typeof code === "number") out.code = code;
  else if (code && typeof code === "object") {
    out.code = code.value;
    out.codeTarget = Uri.isUri(code.target) ? code.target.toString() : undefined;
  }
  if (d.tags?.length) out.tags = [...d.tags];
  if (d.relatedInformation?.length) out.related = d.relatedInformation.map((r) => ({ path: paths.toPath(r.location.uri), range: range.from(r.location.range), message: r.message }));
  return out;
}

export function location(v: unknown, paths: PathMapper): LocationDTO | undefined {
  if (!v || typeof v !== "object") return undefined;
  const loc = v as { uri?: Uri; range?: T.Range; targetUri?: Uri; targetRange?: T.Range; targetSelectionRange?: T.Range; originSelectionRange?: T.Range };
  if (loc.targetUri && loc.targetRange) {
    const uri = Uri.revive(loc.targetUri);
    return {
      path: paths.toPath(uri),
      uri: uri.toString(),
      range: range.from(loc.targetRange),
      targetSelectionRange: loc.targetSelectionRange ? range.from(loc.targetSelectionRange) : undefined,
      originSelectionRange: loc.originSelectionRange ? range.from(loc.originSelectionRange) : undefined,
    };
  }
  if (loc.uri && loc.range && T.Range.isRange(loc.range)) {
    const uri = Uri.revive(loc.uri);
    return { path: paths.toPath(uri), uri: uri.toString(), range: range.from(loc.range) };
  }
  return undefined;
}

export function locations(v: unknown, paths: PathMapper): LocationDTO[] {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.map((l) => location(l, paths)).filter((x): x is LocationDTO => !!x);
}

export function workspaceEdit(edit: T.WorkspaceEdit, paths: PathMapper): WorkspaceEditDTO {
  const entries: WorkspaceEditEntryDTO[] = [];
  const all = typeof (edit as T.WorkspaceEdit)._allEntries === "function" ? edit._allEntries() : [];
  for (const e of all) {
    const path = paths.toPath(e.uri);
    if (path === null) continue;
    if (e.kind === "text" && e.edit) entries.push({ kind: "text", path, edit: textEdit(e.edit) });
    else if (e.kind === "create") entries.push({ kind: "create", path, options: { overwrite: e.options?.overwrite, ignoreIfExists: e.options?.ignoreIfExists }, contents: e.options?.contents ? new TextDecoder().decode(e.options.contents) : undefined });
    else if (e.kind === "delete") entries.push({ kind: "delete", path, options: { recursive: e.options?.recursive, ignoreIfNotExists: e.options?.ignoreIfNotExists } });
    else if (e.kind === "rename" && e.to) {
      const to = paths.toPath(e.to);
      if (to !== null) entries.push({ kind: "rename", path, to, options: { overwrite: e.options?.overwrite, ignoreIfExists: e.options?.ignoreIfExists } });
    }
  }
  return { entries };
}

export function completionItem(item: T.CompletionItem, i: number, cache: CommandCache): CompletionItemDTO | undefined {
  if (!item || (typeof item.label !== "string" && typeof (item.label as T.CompletionItemLabel)?.label !== "string")) return undefined;
  const labelText = typeof item.label === "string" ? item.label : item.label.label;
  let insertText = labelText;
  let snippet = false;
  let r: CompletionItemDTO["range"];
  if (item.textEdit && T.TextEdit.isTextEdit(item.textEdit)) {
    insertText = item.textEdit.newText;
    r = range.from(item.textEdit.range);
  } else if (typeof item.insertText === "string") insertText = item.insertText;
  else if (T.SnippetString.isSnippetString(item.insertText)) {
    insertText = item.insertText.value;
    snippet = true;
  }
  if (!r && item.range) {
    if (T.Range.isRange(item.range)) r = range.from(item.range);
    else if (T.Range.isRange((item.range as { inserting: T.Range }).inserting)) {
      const ir = item.range as { inserting: T.Range; replacing: T.Range };
      r = { insert: range.from(ir.inserting), replace: range.from(ir.replacing) };
    }
  }
  const out: CompletionItemDTO = { i, label: typeof item.label === "string" ? item.label : { label: item.label.label, detail: item.label.detail, description: item.label.description }, insertText };
  if (typeof item.kind === "number") out.kind = item.kind;
  if (item.tags?.length) out.tags = [...item.tags];
  if (item.detail) out.detail = String(item.detail);
  const doc = documentation(item.documentation);
  if (doc) out.documentation = doc;
  if (item.sortText) out.sortText = item.sortText;
  if (item.filterText) out.filterText = item.filterText;
  if (item.preselect) out.preselect = true;
  if (snippet) out.snippet = true;
  if (item.keepWhitespace) out.keepWhitespace = true;
  if (r) out.range = r;
  if (item.commitCharacters?.length) out.commitCharacters = [...item.commitCharacters];
  if (item.additionalTextEdits?.length) out.additionalTextEdits = textEdits(item.additionalTextEdits);
  const c = command(item.command, cache);
  if (c) out.command = c;
  return out;
}

export function hover(h: T.Hover | undefined | null): HoverDTO | undefined {
  if (!h || !h.contents) return undefined;
  const list = Array.isArray(h.contents) ? h.contents : [h.contents];
  const contents = list.map(markdown).filter((x): x is MarkdownDTO => !!x && !!x.value);
  if (!contents.length) return undefined;
  return { contents, range: h.range && T.Range.isRange(h.range) ? range.from(h.range) : undefined };
}

export function documentSymbols(v: unknown, paths: PathMapper): DocumentSymbolDTO[] {
  if (!Array.isArray(v)) return [];
  const conv = (s: unknown): DocumentSymbolDTO | undefined => {
    if (!s || typeof s !== "object") return undefined;
    const x = s as Partial<T.DocumentSymbol & T.SymbolInformation>;
    if (x.location && T.Range.isRange(x.location.range)) {
      // SymbolInformation: a flat entry (only symbols of this document are useful here).
      void paths;
      const r = range.from(x.location.range);
      return { name: String(x.name ?? ""), detail: "", kind: x.kind ?? 0, tags: x.tags, range: r, selectionRange: r, containerName: x.containerName };
    }
    if (!T.Range.isRange(x.range)) return undefined;
    const children = Array.isArray(x.children) ? x.children.map(conv).filter((c): c is DocumentSymbolDTO => !!c) : [];
    return {
      name: String(x.name ?? ""),
      detail: String(x.detail ?? ""),
      kind: x.kind ?? 0,
      tags: x.tags,
      range: range.from(x.range),
      selectionRange: T.Range.isRange(x.selectionRange) ? range.from(x.selectionRange) : range.from(x.range),
      children,
    };
  };
  return v.map(conv).filter((x): x is DocumentSymbolDTO => !!x);
}

export function codeAction(a: T.CodeAction | T.Command, paths: PathMapper, cache: CommandCache): CodeActionDTO | undefined {
  if (!a || typeof a.title !== "string") return undefined;
  if (typeof (a as T.Command).command === "string") {
    // A bare Command.
    return { title: a.title, command: command(a as T.Command, cache) };
  }
  const ca = a as T.CodeAction;
  const out: CodeActionDTO = { title: ca.title };
  if (ca.kind) out.kind = ca.kind.value;
  if (ca.isPreferred) out.isPreferred = true;
  if (ca.disabled?.reason) out.disabled = ca.disabled.reason;
  if (ca.diagnostics?.length) out.diagnostics = ca.diagnostics.map((d) => diagnostic(d, paths));
  if (ca.edit) out.edit = workspaceEdit(ca.edit, paths);
  const c = command(ca.command, cache);
  if (c) out.command = c;
  return out;
}

export function signatureHelp(h: T.SignatureHelp | undefined | null): SignatureHelpDTO | undefined {
  if (!h || !Array.isArray(h.signatures)) return undefined;
  return {
    activeSignature: h.activeSignature ?? 0,
    activeParameter: h.activeParameter ?? 0,
    signatures: h.signatures.map((s) => ({
      label: s.label,
      documentation: documentation(s.documentation),
      activeParameter: s.activeParameter,
      parameters: (s.parameters ?? []).map((p) => ({ label: p.label, documentation: documentation(p.documentation) })),
    })),
  };
}

/** Normalises a DocumentSelector to a list of filters. */
export function selector(sel: unknown): { language?: string; scheme?: string; pattern?: string; notebookType?: string }[] {
  const list = Array.isArray(sel) ? sel : [sel];
  const out: { language?: string; scheme?: string; pattern?: string; notebookType?: string }[] = [];
  for (const s of list) {
    if (typeof s === "string") out.push({ language: s });
    else if (s && typeof s === "object") {
      const f = s as { language?: string; scheme?: string; pattern?: string | T.RelativePattern; notebookType?: string };
      const pattern = typeof f.pattern === "string" ? f.pattern : f.pattern && typeof f.pattern === "object" ? `**/${f.pattern.pattern}` : undefined;
      out.push({ language: f.language, scheme: f.scheme, pattern, notebookType: f.notebookType });
    }
  }
  return out;
}
