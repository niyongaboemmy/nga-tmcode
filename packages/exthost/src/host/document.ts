import { EndOfLine, Position, Range } from "../api/types";
import type { Uri } from "../api/uri";

/** VS Code's default word definition (vs/editor/common/core/wordHelper.ts). */
export const DEFAULT_WORD_REGEXP = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

export interface TextLine {
  readonly lineNumber: number;
  readonly text: string;
  readonly range: Range;
  readonly rangeIncludingLineBreak: Range;
  readonly firstNonWhitespaceCharacterIndex: number;
  readonly isEmptyOrWhitespace: boolean;
}

/** A change as the workbench reports it (0-based range in the text before the change). */
export interface ContentChange {
  range: [number, number, number, number];
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/**
 * The host's copy of an open document (vs/workbench/api/common/extHostDocumentData.ts),
 * kept in sync incrementally. `document` is the `vscode.TextDocument` facade
 * extensions see; it always reflects the latest text.
 */
export class DocumentData {
  #lines: string[];
  #eol: string;
  #offsets: number[] | null = null;
  version: number;
  languageId: string;
  isDirty = false;
  isClosed = false;
  readonly document: TextDocumentFacade;

  constructor(
    readonly uri: Uri,
    text: string,
    languageId: string,
    version: number,
    private readonly saveFn: (d: DocumentData) => Promise<boolean>,
    eol?: string,
  ) {
    this.#eol = eol ?? (text.includes("\r\n") ? "\r\n" : "\n");
    this.#lines = text.split(/\r\n|\r|\n/);
    this.languageId = languageId;
    this.version = version;
    this.document = new TextDocumentFacade(this);
  }

  get lines() {
    return this.#lines;
  }
  get eol() {
    return this.#eol;
  }
  setEol(eol: string) {
    this.#eol = eol;
  }

  getText(range?: Range): string {
    if (!range) return this.#lines.join(this.#eol);
    const r = this.validateRange(range);
    if (r.isEmpty) return "";
    if (r.isSingleLine) return this.#lines[r.start.line].substring(r.start.character, r.end.character);
    const out = [this.#lines[r.start.line].substring(r.start.character)];
    for (let i = r.start.line + 1; i < r.end.line; i++) out.push(this.#lines[i]);
    out.push(this.#lines[r.end.line].substring(0, r.end.character));
    return out.join(this.#eol);
  }

  /** Applies one replacement, as the main thread reports them (in order). */
  applyChange(change: ContentChange) {
    const [sl, sc, el, ec] = change.range;
    const startLine = Math.min(sl, this.#lines.length - 1);
    const endLine = Math.min(el, this.#lines.length - 1);
    const prefix = this.#lines[startLine].substring(0, sc);
    const suffix = this.#lines[endLine].substring(ec);
    const inserted = (prefix + change.text + suffix).split(/\r\n|\r|\n/);
    this.#lines.splice(startLine, endLine - startLine + 1, ...inserted);
    this.#offsets = null;
  }

  setText(text: string) {
    this.#lines = text.split(/\r\n|\r|\n/);
    this.#offsets = null;
  }

  #lineStarts(): number[] {
    if (!this.#offsets) {
      const out = new Array<number>(this.#lines.length);
      let acc = 0;
      for (let i = 0; i < this.#lines.length; i++) {
        out[i] = acc;
        acc += this.#lines[i].length + this.#eol.length;
      }
      this.#offsets = out;
    }
    return this.#offsets;
  }

  offsetAt(position: Position): number {
    const p = this.validatePosition(position);
    return this.#lineStarts()[p.line] + p.character;
  }

  positionAt(offset: number): Position {
    offset = Math.max(0, Math.floor(offset));
    const starts = this.#lineStarts();
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const character = Math.min(offset - starts[lo], this.#lines[lo].length);
    return new Position(lo, character);
  }

  validatePosition(position: Position): Position {
    if (!Position.isPosition(position)) throw new Error("Invalid argument");
    let { line, character } = position;
    let changed = false;
    if (line < 0) {
      line = 0;
      character = 0;
      changed = true;
    } else if (line >= this.#lines.length) {
      line = this.#lines.length - 1;
      character = this.#lines[line].length;
      changed = true;
    } else {
      const max = this.#lines[line].length;
      if (character < 0) {
        character = 0;
        changed = true;
      } else if (character > max) {
        character = max;
        changed = true;
      }
    }
    return changed ? new Position(line, character) : position instanceof Position ? position : new Position(line, character);
  }

  validateRange(range: Range): Range {
    if (!Range.isRange(range)) throw new Error("Invalid argument");
    const start = this.validatePosition(range.start);
    const end = this.validatePosition(range.end);
    if (start === range.start && end === range.end && range instanceof Range) return range;
    return new Range(start, end);
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line;
    if (typeof line !== "number" || line < 0 || line >= this.#lines.length || Math.floor(line) !== line) throw new Error("Illegal value for `line`");
    const text = this.#lines[line];
    const firstNonWs = /^(\s*)/.exec(text)![1].length;
    const range = new Range(line, 0, line, text.length);
    const withBreak = line < this.#lines.length - 1 ? new Range(line, 0, line + 1, 0) : range;
    return { lineNumber: line, text, range, rangeIncludingLineBreak: withBreak, firstNonWhitespaceCharacterIndex: firstNonWs, isEmptyOrWhitespace: firstNonWs === text.length };
  }

  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
    const p = this.validatePosition(position);
    let re = regex ?? DEFAULT_WORD_REGEXP;
    if (!re.global || re.sticky) re = new RegExp(re.source, (re.flags.replace(/[gy]/g, "") + "g"));
    const text = this.#lines[p.line];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (start <= p.character && p.character <= end && m[0].length) return new Range(p.line, start, p.line, end);
      if (start > p.character) break;
      if (!m[0].length) re.lastIndex++;
    }
    return undefined;
  }

  save() {
    return this.saveFn(this);
  }
}

/** `vscode.TextDocument`: a live view over DocumentData. */
export class TextDocumentFacade {
  readonly #d: DocumentData;
  constructor(d: DocumentData) {
    this.#d = d;
  }
  get uri() {
    return this.#d.uri;
  }
  get fileName() {
    return this.#d.uri.fsPath;
  }
  get isUntitled() {
    return this.#d.uri.scheme === "untitled";
  }
  get languageId() {
    return this.#d.languageId;
  }
  get version() {
    return this.#d.version;
  }
  get isClosed() {
    return this.#d.isClosed;
  }
  get isDirty() {
    return this.#d.isDirty;
  }
  get eol() {
    return this.#d.eol === "\r\n" ? EndOfLine.CRLF : EndOfLine.LF;
  }
  get lineCount() {
    return this.#d.lines.length;
  }
  get encoding() {
    return "utf8";
  }
  get notebook() {
    return undefined;
  }
  save() {
    return this.#d.save();
  }
  lineAt(lineOrPosition: number | Position) {
    return this.#d.lineAt(lineOrPosition);
  }
  offsetAt(position: Position) {
    return this.#d.offsetAt(position);
  }
  positionAt(offset: number) {
    return this.#d.positionAt(offset);
  }
  getText(range?: Range) {
    return this.#d.getText(range);
  }
  getWordRangeAtPosition(position: Position, regex?: RegExp) {
    return this.#d.getWordRangeAtPosition(position, regex);
  }
  validateRange(range: Range) {
    return this.#d.validateRange(range);
  }
  validatePosition(position: Position) {
    return this.#d.validatePosition(position);
  }
}
