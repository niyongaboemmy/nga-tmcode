import { create } from "zustand";
import { extname } from "../../util/paths";

/**
 * What a file can be previewed as, besides its text: documents (PDF, Word)
 * open in the document viewer; Markdown, CSV and SQL (a schema diagram) keep their text editor with
 * an Edit / Preview switch above it, Edit first (as GitHub does).
 */

const DOCUMENTS: Record<string, "pdf" | "docx"> = { pdf: "pdf", docx: "docx" };

export function documentKind(path: string): "pdf" | "docx" | null {
  return DOCUMENTS[extname(path).toLowerCase()] ?? null;
}

export function isDocumentFile(path: string): boolean {
  return documentKind(path) !== null;
}

export type PreviewKind = "markdown" | "csv" | "sql";

export function previewKind(path: string): PreviewKind | null {
  const ext = extname(path).toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "sql") return "sql";
  return null;
}

/** Edit or Preview, per file (Edit unless switched). */
export const useViewMode = create<{ modes: Record<string, "edit" | "preview"> }>(() => ({ modes: {} }));

export function viewModeOf(path: string): "edit" | "preview" {
  return useViewMode.getState().modes[path] ?? "edit";
}

export function setViewMode(path: string, mode: "edit" | "preview") {
  useViewMode.setState((s) => ({ modes: { ...s.modes, [path]: mode } }));
}

const TASK = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/;
const FENCE = /^\s*(?:>\s*)*(`{3,}|~{3,})/;

/**
 * Where the n-th task-list box ("- [ ]") is in Markdown source, outside code
 * blocks: its line (0-based), the column of the mark, and whether it is ticked.
 */
export function findTask(src: string, n: number): { line: number; column: number; checked: boolean } | null {
  let fence: string | null = null;
  let seen = 0;
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = TASK.exec(lines[i]);
    if (!m) continue;
    if (seen++ === n) return { line: i, column: m[1].length, checked: m[2] !== " " };
  }
  return null;
}

/** The source with the n-th task box ticked or cleared. */
export function toggleTask(src: string, n: number): string {
  const t = findTask(src, n);
  if (!t) return src;
  const lines = src.split("\n");
  const l = lines[t.line];
  lines[t.line] = l.slice(0, t.column) + (t.checked ? " " : "x") + l.slice(t.column + 1);
  return lines.join("\n");
}

/** RFC 4180 CSV (or TSV): quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string, delimiter = ",", maxRows = Infinity): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if ((field !== "" || row.length) && rows.length < maxRows) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A TSV's tabs, else the likeliest of , ; | in the first line. */
export function guessDelimiter(path: string, text: string): string {
  if (extname(path).toLowerCase() === "tsv") return "\t";
  const first = text.slice(0, text.indexOf("\n") >>> 0 || text.length);
  let best = ",";
  let most = 0;
  for (const d of [",", ";", "\t", "|"]) {
    const n = first.split(d).length - 1;
    if (n > most) [best, most] = [d, n];
  }
  return best;
}
