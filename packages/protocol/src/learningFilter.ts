/**
 * The Learning layer's output filter, run on this computer: for answers that never pass Task
 * Mentor (signed out with your own key or a local model, while a sticky Learning layer applies).
 * A copy of Task Mentor's tmcode/ai/learning.ts filter, kept identical; both are checked against
 * the same eval set (learningFilter.test.ts / learning.test.ts). Signed in, Task Mentor's copy is
 * the enforcement: this one only covers paths NGA never sees.
 */

// ── the output filter ──

const KEYWORDS = new Set(
  "if else elif for while do return def class function fn func let const var import from export public private protected static void int float double char bool boolean string true false null none nil new this self print println printf console log len range in is not and or try catch except finally throw raise async await yield lambda switch case break continue struct enum interface extends implements package using namespace include main echo select insert update delete where set values table create into join on order by group the a an to of it".split(
    " ",
  ),
);

/** Identifiers worth matching: the student's own names (≥ 3 letters, not keywords). */
export function identifiersOf(text: string | undefined | null): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const w = m[0];
    if (!KEYWORDS.has(w.toLowerCase())) out.add(w);
    if (out.size > 2000) break;
  }
  return out;
}

const STATEMENT_START = /^(def|class|function|fn|func|public|private|protected|static|import|from\s+\S+\s+import|#include|using|package|let|const|var|return|elif|else\s*:|else\s*\{|try\s*[:{]|except\b|catch\s*\(|switch\s*\(|case\s+.+:|SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/i;
const CONTROL = /^(for|while|if|foreach)\b.*(\)\s*\{?|:)\s*$/;
const ASSIGNMENT = /^[A-Za-z_$][\w$.[\]'"]*\s*(?:[+\-*/%&|^]|\*\*|\/\/|<<|>>)?=(?!=)\s*\S/;
const CALL_STATEMENT = /^[A-Za-z_$][\w$.]*\s*\(.*\)\s*;?\s*$/;
const ENDS_CODE = /(;|\{|\}|\)\s*\{|=>\s*\{?|\]\s*;?)\s*$/;
const HTML_LINE = /^<\/?[a-z][\w-]*(\s[^>]*)?\/?>.*$/i;
const PROSE_WORDS = /\b(the|this|that|your|you|is|are|it|of|to|and|what|why|how|think|should|would|could|try|then|when|which|because)\b/gi;

/** Does one line of an answer read as code rather than prose? (exported for the eval set) */
export function looksLikeCode(raw: string, ids: Set<string> = new Set()): boolean {
  const line = raw.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "").trim();
  if (!line || line.length < 3) return false;
  // The terminal's JSON answer format ({"commands":[{"command":"…"}]}): a command to run is code.
  if (/"commands?"\s*:/.test(line)) return true;
  const words = (line.match(/[A-Za-z]+/g) ?? []).length;
  const prose = (line.match(PROSE_WORDS) ?? []).length;
  // Mostly English words: prose, even when it mentions `for` or `if`.
  const prosey = words >= 6 && prose / words > 0.25 && !/[;{}]\s*$/.test(line);
  if (prosey) return false;
  if (STATEMENT_START.test(line) && /[(){}:=;,<>[\]"']/.test(line)) return true;
  if (CONTROL.test(line)) return true;
  if (ASSIGNMENT.test(line)) return true;
  if (CALL_STATEMENT.test(line) && !/\s{2,}/.test(line) && words <= 8) return true;
  if (ENDS_CODE.test(line) && /[=(]/.test(line)) return true;
  if (HTML_LINE.test(line) && /<\/?[a-z]/i.test(line)) return true;
  // Reuses the student's names with code punctuation.
  if (ids.size && /[=();{}[\]]/.test(line)) {
    let hits = 0;
    for (const m of line.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) if (ids.has(m[0])) hits++;
    if (hits >= 2) return true;
  }
  return false;
}

/** An inline `code span` that is a whole statement rather than a name. */
export function inlineIsStatement(span: string, ids: Set<string> = new Set()): boolean {
  const s = span.trim();
  if (!s) return false;
  if (/^[\w$.]+(\(\))?$/.test(s)) return false; // a name: `len()`, `fetch`, `Array.map`
  if (/^<\/?[a-z][\w-]*>$/i.test(s)) return false; // a tag name: `<div>`
  if (/^[\w.]+\s*\([^()]{0,24}\)$/.test(s) && !/[=;]/.test(s)) return s.length > 28; // a short call example
  if (s.length > 40) return true;
  if (/[;{}]|(?<![=!<>])=(?!=)|=>|\+=|-=/.test(s)) return true;
  if (looksLikeCode(s, ids)) return true;
  return false;
}

/** Normalised lines of the reference solution(s), to catch an answer that copies them. */
export function referenceLines(solutions: string[]): Set<string> {
  const out = new Set<string>();
  for (const sol of solutions)
    for (const l of sol.split("\n")) {
      const n = l.replace(/\s+/g, "").toLowerCase();
      if (n.length >= 8) out.add(n);
    }
  return out;
}

export interface FilterOptions {
  /** The student's identifiers (open file, selection). */
  identifiers?: Set<string>;
  /** Normalised reference-solution lines. */
  reference?: Set<string>;
  /** The teacher allows one tiny generic syntax example (≤ 2 lines, no student names). */
  syntax?: boolean;
}

const NOTE = (n: number) => `_(TMCode removed ${n} line${n === 1 ? "" : "s"} of code here: in Learning you write every line. Ask for the next hint if you're stuck.)_`;

/**
 * Cuts code out of a streamed answer, line by line: `push` returns what may be shown now (whole
 * lines), `end` the rest. `removed` counts the lines cut. Text inside a fence is held until the
 * fence closes, so a removed block never flashes on screen.
 */
export class LearningFilter {
  removed = 0;
  private buf = "";
  private fence: { marker: string; lines: string[] } | null = null;
  private cutRun = 0;
  private readonly ids: Set<string>;
  private readonly ref: Set<string>;

  constructor(private readonly opts: FilterOptions = {}) {
    this.ids = opts.identifiers ?? new Set();
    this.ref = opts.reference ?? new Set();
  }

  push(text: string): string {
    this.buf += text;
    let out = "";
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      out += this.line(this.buf.slice(0, nl), true);
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
    return out;
  }

  end(): string {
    let out = "";
    if (this.buf) out += this.line(this.buf, false);
    this.buf = "";
    if (this.fence) {
      // An unterminated block: never shown.
      this.removed += this.fence.lines.length;
      this.cutRun += this.fence.lines.length;
      this.fence = null;
    }
    out += this.flushCut();
    return out;
  }

  /** The note for a run of cut lines, once the run ends. */
  private flushCut(): string {
    if (!this.cutRun) return "";
    const n = this.cutRun;
    this.cutRun = 0;
    return `${NOTE(n)}\n`;
  }

  private matchesReference(line: string): boolean {
    if (!this.ref.size) return false;
    const n = line.replace(/\s+/g, "").toLowerCase();
    return n.length >= 8 && this.ref.has(n);
  }

  private keepFence(lines: string[]): boolean {
    if (!this.opts.syntax || lines.length > 2 || !lines.length) return false;
    for (const l of lines) {
      if (this.matchesReference(l)) return false;
      for (const m of l.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) if (this.ids.has(m[0])) return false;
    }
    return true;
  }

  private line(raw: string, complete: boolean): string {
    const eol = complete ? "\n" : "";
    const fenceMark = raw.match(/^\s*(`{3,}|~{3,})/);
    if (this.fence) {
      if (fenceMark && fenceMark[1][0] === this.fence.marker[0] && fenceMark[1].length >= this.fence.marker.length && !raw.trim().slice(fenceMark[1].length).trim()) {
        const lines = this.fence.lines;
        const marker = this.fence.marker;
        this.fence = null;
        if (this.keepFence(lines)) return `${this.flushCut()}${marker}\n${lines.join("\n")}\n${marker}${eol}`;
        this.removed += lines.length;
        this.cutRun += Math.max(1, lines.length);
        return "";
      }
      this.fence.lines.push(raw);
      return "";
    }
    if (fenceMark) {
      this.fence = { marker: fenceMark[1], lines: [] };
      return "";
    }
    if (raw.trim() && (looksLikeCode(raw, this.ids) || this.matchesReference(raw))) {
      this.removed++;
      this.cutRun++;
      return "";
    }
    if (!raw.trim() && this.cutRun) return ""; // blank lines inside a run of cut code
    const kept = raw.replace(/(`+)([^`]+?)\1/g, (all, _t: string, inner: string) => {
      if (inlineIsStatement(inner, this.ids) || this.matchesReference(inner)) {
        this.removed++;
        return "`…`";
      }
      return all;
    });
    return `${this.flushCut()}${kept}${eol}`;
  }
}

/** The whole answer at once (tests, the eval runner, non-streamed paths). */
export function filterLearningText(text: string, opts: FilterOptions = {}): { text: string; removed: number } {
  const f = new LearningFilter(opts);
  const out = f.push(text) + f.end();
  return { text: out.replace(/\n{3,}/g, "\n\n").trimEnd(), removed: f.removed };
}
