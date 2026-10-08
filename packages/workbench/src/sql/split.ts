/**
 * Splits a SQL script into statements, keeping where each one starts, so the
 * runner can show every statement's result and put an error on its line.
 * Understands quotes ('…', "…", `…`, […]), -- and /* *\/ comments, and
 * CREATE TRIGGER … BEGIN … END bodies (their inner semicolons don't split).
 */

export interface SqlStatement {
  text: string;
  /** 1-based line of the statement's first character. */
  line: number;
  /** Offset of the first character in the script. */
  start: number;
  end: number;
}

export function splitSql(script: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  let i = 0;
  let start = -1;
  let depth = 0; // BEGIN … END nesting inside triggers
  let word = "";
  let prevWord = "";
  const n = script.length;
  const flushWord = () => {
    if (!word) return;
    const w = word.toUpperCase();
    if (w === "BEGIN" && /^(CREATE|TRIGGER)$/.test(prevWord) === false && isTriggerBody(script, start, i)) depth++;
    else if (w === "END" && depth > 0) depth--;
    prevWord = w;
    word = "";
  };
  const push = (end: number) => {
    if (start < 0) return;
    const text = script.slice(start, end).trim();
    if (text && !/^(--[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(text)) {
      out.push({ text, start, end, line: lineOf(script, start) });
    }
    start = -1;
  };
  while (i < n) {
    const c = script[i];
    const next = script[i + 1];
    if (c === "-" && next === "-") {
      flushWord();
      const e = script.indexOf("\n", i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (c === "/" && next === "*") {
      flushWord();
      const e = script.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (start < 0 && !/\s/.test(c) && c !== ";") start = i;
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      flushWord();
      const close = c === "[" ? "]" : c;
      i++;
      while (i < n) {
        if (script[i] === close) {
          if (close !== "]" && script[i + 1] === close) {
            i += 2; // '' escapes a quote
            continue;
          }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      word += c;
      i++;
      continue;
    }
    flushWord();
    if (c === ";" && depth === 0) {
      push(i);
      i++;
      continue;
    }
    i++;
  }
  flushWord();
  push(n);
  return out;
}

/** A BEGIN that opens a trigger body (not a BEGIN TRANSACTION statement). */
function isTriggerBody(script: string, stmtStart: number, at: number) {
  if (stmtStart < 0) return false;
  const head = script.slice(stmtStart, at).replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ");
  return /\bCREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b/i.test(head);
}

export function lineOf(text: string, offset: number) {
  let line = 1;
  for (let k = 0; k < offset && k < text.length; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

/** The statement under a cursor offset (or the one just before it, on the line after its semicolon). */
export function statementAt(script: string, offset: number): SqlStatement | null {
  const all = splitSql(script);
  return all.find((s) => offset >= s.start && offset <= s.end + 1) ?? [...all].reverse().find((s) => s.end <= offset) ?? all[0] ?? null;
}
