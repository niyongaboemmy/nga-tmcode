/**
 * The classes and enums of the `vscode` module, with VS Code's semantics
 * (vs/workbench/api/common/extHostTypes.ts): immutable Position/Range with
 * the same validation and normalisation, WorkspaceEdit, Diagnostic, …
 * Enum values match VS Code's, since extensions hard-code them.
 */

import { Uri } from "./uri";

function illegalArgument(name: string) {
  return new Error(`Illegal argument: ${name}`);
}

export class Disposable {
  static from(...items: { dispose(): unknown }[]): Disposable {
    let list: { dispose(): unknown }[] | undefined = items;
    return new Disposable(() => {
      if (list) for (const d of list) if (d && typeof d.dispose === "function") d.dispose();
      list = undefined;
    });
  }
  #fn: (() => unknown) | undefined;
  constructor(callOnDispose: () => unknown) {
    this.#fn = callOnDispose;
  }
  dispose(): unknown {
    const fn = this.#fn;
    this.#fn = undefined;
    return fn?.();
  }
}

export class Position {
  static isPosition(other: unknown): other is Position {
    if (other instanceof Position) return true;
    if (!other || typeof other !== "object") return false;
    const o = other as Position;
    return typeof o.line === "number" && typeof o.character === "number";
  }
  static Min(...positions: Position[]): Position {
    if (!positions.length) throw new TypeError();
    return positions.reduce((a, b) => (b.isBefore(a) ? b : a));
  }
  static Max(...positions: Position[]): Position {
    if (!positions.length) throw new TypeError();
    return positions.reduce((a, b) => (b.isAfter(a) ? b : a));
  }
  readonly #line: number;
  readonly #character: number;
  get line() {
    return this.#line;
  }
  get character() {
    return this.#character;
  }
  constructor(line: number, character: number) {
    if (line < 0) throw illegalArgument("line must be non-negative");
    if (character < 0) throw illegalArgument("character must be non-negative");
    this.#line = line;
    this.#character = character;
  }
  isBefore(other: Position) {
    return this.#line < other.line || (this.#line === other.line && this.#character < other.character);
  }
  isBeforeOrEqual(other: Position) {
    return this.#line < other.line || (this.#line === other.line && this.#character <= other.character);
  }
  isAfter(other: Position) {
    return !this.isBeforeOrEqual(other);
  }
  isAfterOrEqual(other: Position) {
    return !this.isBefore(other);
  }
  isEqual(other: Position) {
    return this.#line === other.line && this.#character === other.character;
  }
  compareTo(other: Position) {
    if (this.#line < other.line) return -1;
    if (this.#line > other.line) return 1;
    return this.#character < other.character ? -1 : this.#character > other.character ? 1 : 0;
  }
  translate(lineDelta?: number | { lineDelta?: number; characterDelta?: number }, characterDelta = 0): Position {
    if (lineDelta === null || characterDelta === null) throw illegalArgument("translate");
    let ld: number;
    if (typeof lineDelta === "undefined") ld = 0;
    else if (typeof lineDelta === "number") ld = lineDelta;
    else {
      ld = typeof lineDelta.lineDelta === "number" ? lineDelta.lineDelta : 0;
      characterDelta = typeof lineDelta.characterDelta === "number" ? lineDelta.characterDelta : 0;
    }
    if (ld === 0 && characterDelta === 0) return this;
    return new Position(this.line + ld, this.character + characterDelta);
  }
  with(line?: number | { line?: number; character?: number }, character: number = this.character): Position {
    let l: number;
    if (typeof line === "undefined") l = this.line;
    else if (typeof line === "number") l = line;
    else {
      l = typeof line.line === "number" ? line.line : this.line;
      character = typeof line.character === "number" ? line.character : this.character;
    }
    if (l === this.line && character === this.character) return this;
    return new Position(l, character);
  }
  toJSON() {
    return { line: this.line, character: this.character };
  }
}

export class Range {
  static isRange(thing: unknown): thing is Range {
    if (thing instanceof Range) return true;
    if (!thing || typeof thing !== "object") return false;
    const t = thing as Range;
    return Position.isPosition(t.start) && Position.isPosition(t.end);
  }
  protected _start: Position;
  protected _end: Position;
  get start() {
    return this._start;
  }
  get end() {
    return this._end;
  }
  constructor(start: Position, end: Position);
  constructor(startLine: number, startColumn: number, endLine: number, endColumn: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    let start: Position | undefined;
    let end: Position | undefined;
    if (typeof a === "number" && typeof b === "number" && typeof c === "number" && typeof d === "number") {
      start = new Position(a, b);
      end = new Position(c, d);
    } else if (Position.isPosition(a) && Position.isPosition(b)) {
      start = a instanceof Position ? a : new Position((a as Position).line, (a as Position).character);
      end = b instanceof Position ? b : new Position((b as Position).line, (b as Position).character);
    }
    if (!start || !end) throw new Error("Invalid arguments");
    if (start.isBeforeOrEqual(end)) {
      this._start = start;
      this._end = end;
    } else {
      this._start = end;
      this._end = start;
    }
  }
  contains(posOrRange: Position | Range): boolean {
    if (Range.isRange(posOrRange)) return this.contains(posOrRange.start) && this.contains(posOrRange.end);
    if (Position.isPosition(posOrRange)) {
      if (posOrRange.isBefore(this._start) && !posOrRange.isEqual(this._start)) return false;
      if (this._end.isBefore(posOrRange)) return false;
      return true;
    }
    return false;
  }
  isEqual(other: Range) {
    return this._start.isEqual(other.start) && this._end.isEqual(other.end);
  }
  intersection(other: Range): Range | undefined {
    const start = Position.Max(other.start, this._start);
    const end = Position.Min(other.end, this._end);
    if (start.isAfter(end)) return undefined;
    return new Range(start, end);
  }
  union(other: Range): Range {
    if (this.contains(other)) return this;
    if (other.contains(this)) return other;
    return new Range(Position.Min(other.start, this._start), Position.Max(other.end, this.end));
  }
  get isEmpty() {
    return this._start.isEqual(this._end);
  }
  get isSingleLine() {
    return this._start.line === this._end.line;
  }
  with(start?: Position | { start?: Position; end?: Position }, end: Position = this.end): Range {
    let s: Position;
    if (!start) s = this.start;
    else if (Position.isPosition(start)) s = start;
    else {
      s = start.start || this.start;
      end = start.end || this.end;
    }
    if (s.isEqual(this._start) && end.isEqual(this.end)) return this;
    return new Range(s, end);
  }
  toJSON(): unknown {
    return [this.start, this.end];
  }
}

export class Selection extends Range {
  static isSelection(thing: unknown): thing is Selection {
    if (thing instanceof Selection) return true;
    if (!thing || typeof thing !== "object") return false;
    const t = thing as Selection;
    return Range.isRange(t) && Position.isPosition(t.anchor) && Position.isPosition(t.active) && typeof t.isReversed === "boolean";
  }
  #anchor: Position;
  #active: Position;
  get anchor() {
    return this.#anchor;
  }
  get active() {
    return this.#active;
  }
  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorColumn: number, activeLine: number, activeColumn: number);
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    let anchor: Position | undefined;
    let active: Position | undefined;
    if (typeof a === "number" && typeof b === "number" && typeof c === "number" && typeof d === "number") {
      anchor = new Position(a, b);
      active = new Position(c, d);
    } else if (Position.isPosition(a) && Position.isPosition(b)) {
      anchor = a instanceof Position ? a : new Position((a as Position).line, (a as Position).character);
      active = b instanceof Position ? b : new Position((b as Position).line, (b as Position).character);
    }
    if (!anchor || !active) throw new Error("Invalid arguments");
    super(anchor, active);
    this.#anchor = anchor;
    this.#active = active;
  }
  get isReversed() {
    return this.#anchor === this._end;
  }
  override toJSON() {
    return { start: this.start, end: this.end, active: this.active, anchor: this.anchor };
  }
}

export enum EndOfLine {
  LF = 1,
  CRLF = 2,
}

export class TextEdit {
  static isTextEdit(thing: unknown): thing is TextEdit {
    if (thing instanceof TextEdit) return true;
    if (!thing || typeof thing !== "object") return false;
    return Range.isRange((thing as TextEdit).range) && typeof (thing as TextEdit).newText === "string";
  }
  static replace(range: Range, newText: string) {
    return new TextEdit(range, newText);
  }
  static insert(position: Position, newText: string) {
    return TextEdit.replace(new Range(position, position), newText);
  }
  static delete(range: Range) {
    return TextEdit.replace(range, "");
  }
  static setEndOfLine(eol: EndOfLine) {
    const e = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), "");
    e.newEol = eol;
    return e;
  }
  range: Range;
  newText: string;
  newEol?: EndOfLine;
  constructor(range: Range, newText: string | null) {
    this.range = range;
    this.newText = newText ?? "";
  }
}

export class SnippetString {
  static isSnippetString(thing: unknown): thing is SnippetString {
    if (thing instanceof SnippetString) return true;
    return !!thing && typeof (thing as SnippetString).value === "string" && typeof (thing as SnippetString).appendText === "function";
  }
  private static _escape(value: string) {
    return value.replace(/\$|}|\\/g, "\\$&");
  }
  private _tabstop = 1;
  value: string;
  constructor(value?: string) {
    this.value = value || "";
  }
  appendText(text: string) {
    this.value += SnippetString._escape(text);
    return this;
  }
  appendTabstop(number: number = this._tabstop++) {
    this.value += `$${number}`;
    return this;
  }
  appendPlaceholder(value: string | ((s: SnippetString) => unknown), number: number = this._tabstop++) {
    if (typeof value === "function") {
      const nested = new SnippetString();
      nested._tabstop = this._tabstop;
      value(nested);
      this._tabstop = nested._tabstop;
      value = nested.value;
    } else value = SnippetString._escape(value);
    this.value += `\${${number}:${value}}`;
    return this;
  }
  appendChoice(values: string[], number: number = this._tabstop++) {
    const v = values.map((s) => s.replace(/\$|}|\\|,/g, "\\$&")).join(",");
    this.value += `\${${number}|${v}|}`;
    return this;
  }
  appendVariable(name: string, defaultValue?: string | ((s: SnippetString) => unknown)) {
    if (typeof defaultValue === "function") {
      const nested = new SnippetString();
      nested._tabstop = this._tabstop;
      defaultValue(nested);
      this._tabstop = nested._tabstop;
      defaultValue = nested.value;
    } else if (typeof defaultValue === "string") defaultValue = defaultValue.replace(/\$|}/g, "\\$&");
    this.value += "${" + name + (defaultValue ? ":" + defaultValue : "") + "}";
    return this;
  }
}

export interface WorkspaceEditEntry {
  kind: "text" | "create" | "delete" | "rename";
  uri: Uri;
  edit?: TextEdit | SnippetTextEdit;
  to?: Uri;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean; ignoreIfNotExists?: boolean; recursive?: boolean; contents?: Uint8Array };
  metadata?: unknown;
}

export class SnippetTextEdit {
  static isSnippetTextEdit(thing: unknown): thing is SnippetTextEdit {
    return thing instanceof SnippetTextEdit || (!!thing && Range.isRange((thing as SnippetTextEdit).range) && SnippetString.isSnippetString((thing as SnippetTextEdit).snippet));
  }
  static replace(range: Range, snippet: SnippetString) {
    return new SnippetTextEdit(range, snippet);
  }
  static insert(position: Position, snippet: SnippetString) {
    return new SnippetTextEdit(new Range(position, position), snippet);
  }
  constructor(
    public range: Range,
    public snippet: SnippetString,
  ) {}
}

export class WorkspaceEdit {
  readonly #edits: WorkspaceEditEntry[] = [];
  _allEntries(): readonly WorkspaceEditEntry[] {
    return this.#edits;
  }
  renameFile(from: Uri, to: Uri, options?: WorkspaceEditEntry["options"], metadata?: unknown) {
    this.#edits.push({ kind: "rename", uri: from, to, options, metadata });
  }
  createFile(uri: Uri, options?: WorkspaceEditEntry["options"], metadata?: unknown) {
    this.#edits.push({ kind: "create", uri, options, metadata });
  }
  deleteFile(uri: Uri, options?: WorkspaceEditEntry["options"], metadata?: unknown) {
    this.#edits.push({ kind: "delete", uri, options, metadata });
  }
  replace(uri: Uri, range: Range, newText: string, metadata?: unknown) {
    this.#edits.push({ kind: "text", uri, edit: new TextEdit(range, newText), metadata });
  }
  insert(resource: Uri, position: Position, newText: string, metadata?: unknown) {
    this.replace(resource, new Range(position, position), newText, metadata);
  }
  delete(resource: Uri, range: Range, metadata?: unknown) {
    this.replace(resource, range, "", metadata);
  }
  has(uri: Uri) {
    return this.#edits.some((e) => e.kind === "text" && e.uri.toString() === uri.toString());
  }
  set(uri: Uri, edits: readonly (TextEdit | SnippetTextEdit | [TextEdit | SnippetTextEdit, unknown])[] | null | undefined) {
    // Replaces every text edit of `uri`.
    for (let i = this.#edits.length - 1; i >= 0; i--) {
      const e = this.#edits[i];
      if (e.kind === "text" && e.uri.toString() === uri.toString()) this.#edits.splice(i, 1);
    }
    for (const item of edits ?? []) {
      const [edit, metadata] = Array.isArray(item) ? item : [item, undefined];
      if (edit) this.#edits.push({ kind: "text", uri, edit, metadata });
    }
  }
  get(uri: Uri): TextEdit[] {
    return this.#edits.filter((e) => e.kind === "text" && e.uri.toString() === uri.toString()).map((e) => (e.edit instanceof TextEdit ? e.edit : new TextEdit(e.edit!.range, (e.edit as SnippetTextEdit).snippet.value)));
  }
  entries(): [Uri, TextEdit[]][] {
    const map = new Map<string, [Uri, TextEdit[]]>();
    for (const e of this.#edits) {
      if (e.kind !== "text") continue;
      const k = e.uri.toString();
      if (!map.has(k)) map.set(k, [e.uri, []]);
      map.get(k)![1].push(e.edit instanceof TextEdit ? e.edit : new TextEdit(e.edit!.range, (e.edit as SnippetTextEdit).snippet.value));
    }
    return [...map.values()];
  }
  get size() {
    return this.entries().length;
  }
  toJSON() {
    return this.entries();
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

export class Location {
  static isLocation(thing: unknown): thing is Location {
    if (thing instanceof Location) return true;
    if (!thing || typeof thing !== "object") return false;
    return Range.isRange((thing as Location).range) && Uri.isUri((thing as Location).uri);
  }
  uri: Uri;
  range: Range;
  constructor(uri: Uri, rangeOrPosition: Range | Position) {
    this.uri = uri;
    if (rangeOrPosition instanceof Range || Range.isRange(rangeOrPosition)) this.range = rangeOrPosition as Range;
    else if (Position.isPosition(rangeOrPosition)) this.range = new Range(rangeOrPosition, rangeOrPosition);
    else throw new Error("Illegal argument");
  }
}

export class DiagnosticRelatedInformation {
  constructor(
    public location: Location,
    public message: string,
  ) {}
}

export class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number | { value: string | number; target: Uri };
  relatedInformation?: DiagnosticRelatedInformation[];
  tags?: DiagnosticTag[];
  constructor(range: Range, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error) {
    if (!Range.isRange(range)) throw new TypeError("range must be set");
    if (!message) throw new TypeError("message must be set");
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}

export class Hover {
  contents: (MarkdownString | string | { language: string; value: string })[];
  range?: Range;
  constructor(contents: MarkdownString | string | { language: string; value: string } | (MarkdownString | string | { language: string; value: string })[], range?: Range) {
    if (!contents) throw illegalArgument("contents must be defined");
    this.contents = Array.isArray(contents) ? contents : [contents];
    this.range = range;
  }
}

export class MarkdownString {
  static isMarkdownString(thing: unknown): thing is MarkdownString {
    if (thing instanceof MarkdownString) return true;
    return !!thing && typeof thing === "object" && typeof (thing as MarkdownString).value === "string" && typeof (thing as MarkdownString).appendMarkdown === "function";
  }
  value: string;
  isTrusted?: boolean | { enabledCommands: string[] };
  supportThemeIcons?: boolean;
  supportHtml?: boolean;
  baseUri?: Uri;
  constructor(value = "", supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendText(value: string) {
    // Escape markdown syntax (VS Code's escapeMarkdownSyntaxTokens) and keep line breaks.
    this.value += value.replace(/[\\`*_{}[\]()#+\-!~|<>]/g, "\\$&").replace(/([ \t]+)/g, (_m, g1: string) => "&nbsp;".repeat(g1.length)).replace(/^>/gm, "\\>").replace(/\n/g, "\n\n");
    return this;
  }
  appendMarkdown(value: string) {
    this.value += value;
    return this;
  }
  appendCodeblock(code: string, language = "") {
    this.value += "\n```" + language + "\n" + code + "\n```\n";
    return this;
  }
}

export enum CompletionItemKind {
  Text = 0,
  Method = 1,
  Function = 2,
  Constructor = 3,
  Field = 4,
  Variable = 5,
  Class = 6,
  Interface = 7,
  Module = 8,
  Property = 9,
  Unit = 10,
  Value = 11,
  Enum = 12,
  Keyword = 13,
  Snippet = 14,
  Color = 15,
  File = 16,
  Reference = 17,
  Folder = 18,
  EnumMember = 19,
  Constant = 20,
  Struct = 21,
  Event = 22,
  Operator = 23,
  TypeParameter = 24,
  User = 25,
  Issue = 26,
}

export enum CompletionItemTag {
  Deprecated = 1,
}

export enum CompletionTriggerKind {
  Invoke = 0,
  TriggerCharacter = 1,
  TriggerForIncompleteCompletions = 2,
}

export interface CompletionItemLabel {
  label: string;
  detail?: string;
  description?: string;
}

export class CompletionItem {
  label: string | CompletionItemLabel;
  kind?: CompletionItemKind;
  tags?: CompletionItemTag[];
  detail?: string;
  documentation?: string | MarkdownString;
  sortText?: string;
  filterText?: string;
  preselect?: boolean;
  insertText?: string | SnippetString;
  keepWhitespace?: boolean;
  range?: Range | { inserting: Range; replacing: Range };
  commitCharacters?: string[];
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  command?: Command;
  constructor(label: string | CompletionItemLabel, kind?: CompletionItemKind) {
    this.label = label;
    this.kind = kind;
  }
}

export class CompletionList {
  isIncomplete?: boolean;
  items: CompletionItem[];
  constructor(items: CompletionItem[] = [], isIncomplete = false) {
    this.items = items;
    this.isIncomplete = isIncomplete;
  }
}

export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

export class CodeActionKind {
  private static readonly sep = ".";
  static Empty: CodeActionKind;
  static QuickFix: CodeActionKind;
  static Refactor: CodeActionKind;
  static RefactorExtract: CodeActionKind;
  static RefactorInline: CodeActionKind;
  static RefactorMove: CodeActionKind;
  static RefactorRewrite: CodeActionKind;
  static Source: CodeActionKind;
  static SourceOrganizeImports: CodeActionKind;
  static SourceFixAll: CodeActionKind;
  static Notebook: CodeActionKind;
  constructor(readonly value: string) {}
  append(parts: string) {
    return new CodeActionKind(this.value ? this.value + CodeActionKind.sep + parts : parts);
  }
  intersects(other: CodeActionKind) {
    return this.contains(other) || other.contains(this);
  }
  contains(other: CodeActionKind) {
    return this.value === other.value || other.value.startsWith(this.value + CodeActionKind.sep) || this.value === "";
  }
}
CodeActionKind.Empty = new CodeActionKind("");
CodeActionKind.QuickFix = CodeActionKind.Empty.append("quickfix");
CodeActionKind.Refactor = CodeActionKind.Empty.append("refactor");
CodeActionKind.RefactorExtract = CodeActionKind.Refactor.append("extract");
CodeActionKind.RefactorInline = CodeActionKind.Refactor.append("inline");
CodeActionKind.RefactorMove = CodeActionKind.Refactor.append("move");
CodeActionKind.RefactorRewrite = CodeActionKind.Refactor.append("rewrite");
CodeActionKind.Source = CodeActionKind.Empty.append("source");
CodeActionKind.SourceOrganizeImports = CodeActionKind.Source.append("organizeImports");
CodeActionKind.SourceFixAll = CodeActionKind.Source.append("fixAll");
CodeActionKind.Notebook = CodeActionKind.Empty.append("notebook");

export enum CodeActionTriggerKind {
  Invoke = 1,
  Automatic = 2,
}

export class CodeAction {
  title: string;
  edit?: WorkspaceEdit;
  diagnostics?: Diagnostic[];
  command?: Command;
  kind?: CodeActionKind;
  isPreferred?: boolean;
  disabled?: { reason: string };
  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

export enum SymbolKind {
  File = 0,
  Module = 1,
  Namespace = 2,
  Package = 3,
  Class = 4,
  Method = 5,
  Property = 6,
  Field = 7,
  Constructor = 8,
  Enum = 9,
  Interface = 10,
  Function = 11,
  Variable = 12,
  Constant = 13,
  String = 14,
  Number = 15,
  Boolean = 16,
  Array = 17,
  Object = 18,
  Key = 19,
  Null = 20,
  EnumMember = 21,
  Struct = 22,
  Event = 23,
  Operator = 24,
  TypeParameter = 25,
}

export enum SymbolTag {
  Deprecated = 1,
}

export class SymbolInformation {
  name: string;
  location: Location;
  kind: SymbolKind;
  tags?: SymbolTag[];
  containerName: string | undefined;
  constructor(name: string, kind: SymbolKind, containerOrRange: string | Range | undefined, locationOrUri?: Location | Uri, containerName?: string) {
    this.name = name;
    this.kind = kind;
    this.containerName = containerName;
    if (typeof containerOrRange === "string") this.containerName = containerOrRange;
    if (locationOrUri instanceof Location) this.location = locationOrUri;
    else if (containerOrRange instanceof Range && locationOrUri) this.location = new Location(locationOrUri as Uri, containerOrRange);
    else this.location = locationOrUri as unknown as Location;
  }
}

export class DocumentSymbol {
  name: string;
  detail: string;
  kind: SymbolKind;
  tags?: SymbolTag[];
  range: Range;
  selectionRange: Range;
  children: DocumentSymbol[] = [];
  constructor(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.range = range;
    this.selectionRange = selectionRange;
  }
}

export class Color {
  constructor(
    readonly red: number,
    readonly green: number,
    readonly blue: number,
    readonly alpha: number,
  ) {}
}

export class ColorInformation {
  constructor(
    public range: Range,
    public color: Color,
  ) {}
}

export class ColorPresentation {
  label: string;
  textEdit?: TextEdit;
  additionalTextEdits?: TextEdit[];
  constructor(label: string) {
    this.label = label;
  }
}

export class DocumentLink {
  range: Range;
  target?: Uri;
  tooltip?: string;
  constructor(range: Range, target?: Uri) {
    this.range = range;
    this.target = target;
  }
}

export enum DocumentHighlightKind {
  Text = 0,
  Read = 1,
  Write = 2,
}

export class DocumentHighlight {
  constructor(
    public range: Range,
    public kind: DocumentHighlightKind = DocumentHighlightKind.Text,
  ) {}
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: FoldingRangeKind,
  ) {}
}

export enum FoldingRangeKind {
  Comment = 1,
  Imports = 2,
  Region = 3,
}

export class ParameterInformation {
  constructor(
    public label: string | [number, number],
    public documentation?: string | MarkdownString,
  ) {}
}

export class SignatureInformation {
  parameters: ParameterInformation[] = [];
  activeParameter?: number;
  constructor(
    public label: string,
    public documentation?: string | MarkdownString,
  ) {}
}

export class SignatureHelp {
  signatures: SignatureInformation[] = [];
  activeSignature = 0;
  activeParameter = 0;
}

export enum SignatureHelpTriggerKind {
  Invoke = 1,
  TriggerCharacter = 2,
  ContentChange = 3,
}

export class SelectionRange {
  constructor(
    public range: Range,
    public parent?: SelectionRange,
  ) {}
}

export class InlayHint {
  label: string;
  position: Position;
  kind?: InlayHintKind;
  tooltip?: string | MarkdownString;
  paddingLeft?: boolean;
  paddingRight?: boolean;
  constructor(position: Position, label: string, kind?: InlayHintKind) {
    this.position = position;
    this.label = label;
    this.kind = kind;
  }
}

export enum InlayHintKind {
  Type = 1,
  Parameter = 2,
}

export class CodeLens {
  range: Range;
  command?: Command;
  constructor(range: Range, command?: Command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() {
    return !!this.command;
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  static File = new ThemeIcon("file");
  static Folder = new ThemeIcon("folder");
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15,
}

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3,
  Four = 4,
  Five = 5,
  Six = 6,
  Seven = 7,
  Eight = 8,
  Nine = 9,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3,
}

export enum TextEditorLineNumbersStyle {
  Off = 0,
  On = 1,
  Relative = 2,
}

export enum TextEditorCursorStyle {
  Line = 1,
  Block = 2,
  Underline = 3,
  LineThin = 4,
  BlockOutline = 5,
  UnderlineThin = 6,
}

export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

export enum DecorationRangeBehavior {
  OpenOpen = 0,
  ClosedClosed = 1,
  OpenClosed = 2,
  ClosedOpen = 3,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum TextDocumentSaveReason {
  Manual = 1,
  AfterDelay = 2,
  FocusOut = 3,
}

export enum TextDocumentChangeReason {
  Undo = 1,
  Redo = 2,
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FilePermission {
  Readonly = 1,
}

export class FileSystemError extends Error {
  static FileExists(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "EntryExists");
  }
  static FileNotFound(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "EntryNotFound");
  }
  static FileNotADirectory(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "EntryNotADirectory");
  }
  static FileIsADirectory(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "EntryIsADirectory");
  }
  static NoPermissions(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "NoPermissions");
  }
  static Unavailable(messageOrUri?: string | Uri) {
    return new FileSystemError(messageOrUri, "Unavailable");
  }
  readonly code: string;
  constructor(uriOrMessage?: string | Uri, code = "Unknown") {
    super(Uri.isUri(uriOrMessage) ? uriOrMessage.toString(true) : uriOrMessage);
    this.code = code;
    this.name = code ? `${code} (FileSystemError)` : "FileSystemError";
  }
}

export enum ExtensionMode {
  Production = 1,
  Development = 2,
  Test = 3,
}

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export enum UIKind {
  Desktop = 1,
  Web = 2,
}

export enum LogLevel {
  Off = 0,
  Trace = 1,
  Debug = 2,
  Info = 3,
  Warning = 4,
  Error = 5,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export enum IndentAction {
  None = 0,
  Indent = 1,
  IndentOutdent = 2,
  Outdent = 3,
}

export enum LanguageStatusSeverity {
  Information = 0,
  Warning = 1,
  Error = 2,
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  label?: string | { label: string };
  id?: string;
  iconPath?: unknown;
  description?: string | boolean;
  resourceUri?: Uri;
  tooltip?: string | MarkdownString;
  command?: Command;
  contextValue?: string;
  collapsibleState?: TreeItemCollapsibleState;
  constructor(labelOrUri: string | { label: string } | Uri, collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    if (Uri.isUri(labelOrUri)) this.resourceUri = labelOrUri;
    else this.label = labelOrUri;
    this.collapsibleState = collapsibleState;
  }
}

export class RelativePattern {
  baseUri: Uri;
  base: string;
  pattern: string;
  constructor(base: Uri | string | { uri: Uri }, pattern: string) {
    if (typeof base === "string") this.baseUri = Uri.file(base);
    else if (Uri.isUri(base)) this.baseUri = base;
    else this.baseUri = base.uri;
    this.base = this.baseUri.fsPath;
    this.pattern = pattern;
  }
}

export class CancellationError extends Error {
  constructor() {
    super("Canceled");
    this.name = "Canceled";
  }
}

export class TabInputText {
  constructor(readonly uri: Uri) {}
}

export enum EnvironmentVariableMutatorType {
  Replace = 1,
  Append = 2,
  Prepend = 3,
}

export class SemanticTokensLegend {
  constructor(
    readonly tokenTypes: string[],
    readonly tokenModifiers: string[] = [],
  ) {}
}

export class SemanticTokens {
  constructor(
    readonly data: Uint32Array,
    readonly resultId?: string,
  ) {}
}

export class SemanticTokensBuilder {
  private _data: number[] = [];
  private _prevLine = 0;
  private _prevChar = 0;
  constructor(readonly legend?: SemanticTokensLegend) {}
  push(line: number | Range, char: number | string, length?: number | string[], tokenType?: number, tokenModifiers = 0) {
    if (typeof line === "number") {
      const pushLine = line - this._prevLine;
      const pushChar = pushLine === 0 ? (char as number) - this._prevChar : (char as number);
      this._data.push(pushLine, pushChar, length as number, tokenType ?? 0, tokenModifiers);
      this._prevLine = line;
      this._prevChar = char as number;
    }
  }
  build(resultId?: string) {
    return new SemanticTokens(new Uint32Array(this._data), resultId);
  }
}

export class LinkedEditingRanges {
  constructor(
    readonly ranges: Range[],
    readonly wordPattern?: RegExp,
  ) {}
}

export class InlineCompletionItem {
  constructor(
    public insertText: string | SnippetString,
    public range?: Range,
    public command?: Command,
  ) {}
}
