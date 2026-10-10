import type * as Monaco from "monaco-editor";
import type { Intelligence } from "@tmcode/protocol";
import type { Settings } from "../state/settings";

/**
 * The editor's "smart" defaults (VS Code's: linked tag editing, bracket
 * guides, inlay hints, word suggestions…) as Monaco options, after the exam's
 * intelligence level: the level only ever takes help away, never adds it.
 * Spread after `intelligenceOptions(level)`. Pure.
 */
export function smartEditorOptions(
  settings: Settings,
  level: Intelligence,
  base: { suggest?: Monaco.editor.ISuggestOptions } = {},
): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
  const none = level === "none";
  const full = level === "full";
  const pairs = settings["editor.guides.bracketPairs"];
  return {
    linkedEditing: settings["editor.linkedEditing"] && !none,
    guides: { bracketPairs: pairs === "active" ? "active" : pairs === "true", indentation: settings["editor.guides.indentation"] },
    // Inlay hints are language help: only with full intelligence.
    inlayHints: { enabled: full ? settings["editor.inlayHints.enabled"] : "off" },
    formatOnPaste: settings["editor.formatOnPaste"] && !none,
    formatOnType: settings["editor.formatOnType"] && !none,
    suggest: { ...base.suggest, preview: settings["editor.suggest.preview"] && !none },
    // Ghost-text completions come from extensions (never AI in an exam): practice / full only.
    inlineSuggest: { enabled: settings["editor.inlineSuggest.enabled"] && full },
    wordBasedSuggestions: none ? "off" : settings["editor.wordBasedSuggestions"],
    detectIndentation: settings["editor.detectIndentation"],
    occurrencesHighlight: settings["editor.occurrencesHighlight"],
    dragAndDrop: settings["editor.dragAndDrop"],
    copyWithSyntaxHighlighting: settings["editor.copyWithSyntaxHighlighting"],
  };
}

/** Code action kinds `editor.codeActionsOnSave` asks for on this save ("explicit": ⌘S; "always": auto save too). */
export function codeActionsForSave(value: Settings["editor.codeActionsOnSave"] | undefined, reason: "explicit" | "auto"): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return reason === "explicit" ? value.filter((k) => typeof k === "string") : [];
  return Object.entries(value)
    .filter(([, v]) => v === "always" || ((v === "explicit" || v === true) && reason === "explicit"))
    .map(([k]) => k);
}

export interface SaveWhitespaceOptions {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  trimFinalNewlines: boolean;
}

/** A text edit in Monaco's 1-based line/column terms. */
export interface LineEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

/**
 * VS Code's files.trimTrailingWhitespace / trimFinalNewlines /
 * insertFinalNewline as non-overlapping edits on the document's lines (so
 * the cursor, folding and undo survive). `eol` is the model's line ending.
 */
export function saveWhitespaceEdits(lines: string[], opts: SaveWhitespaceOptions, eol = "\n"): LineEdit[] {
  const n = lines.length;
  if (!n) return [];
  const blank = (l: string) => (opts.trimTrailingWhitespace ? l.trim() === "" : l === "");
  // Lines after `keepUntil` (0-based) go: all but one of the empty lines at the end.
  let keepUntil = n - 1;
  let removeTail: LineEdit | null = null;
  if (opts.trimFinalNewlines && lines[n - 1] !== undefined && blank(lines[n - 1])) {
    let k = n - 1;
    while (k >= 0 && blank(lines[k])) k--;
    // k: last line with content. Keep it and one empty line after it.
    if (n - 1 - k > 1) {
      removeTail = { startLine: k + 2, startColumn: 1, endLine: n, endColumn: lines[n - 1].length + 1, text: "" };
      keepUntil = k;
    }
  }
  const edits: LineEdit[] = [];
  if (opts.trimTrailingWhitespace) {
    for (let i = 0; i <= Math.min(keepUntil, n - 1); i++) {
      const m = /[ \t]+$/.exec(lines[i]);
      if (m) edits.push({ startLine: i + 1, startColumn: m.index + 1, endLine: i + 1, endColumn: lines[i].length + 1, text: "" });
    }
  }
  if (removeTail) edits.push(removeTail);
  else if (opts.insertFinalNewline) {
    const last = lines[n - 1];
    const lastAfterTrim = opts.trimTrailingWhitespace ? last.replace(/[ \t]+$/, "") : last;
    if (lastAfterTrim !== "") {
      const trim = edits.find((e) => e.startLine === n);
      // The trailing-whitespace edit of the last line also adds the newline (edits must not touch).
      if (trim) trim.text = eol;
      else edits.push({ startLine: n, startColumn: last.length + 1, endLine: n, endColumn: last.length + 1, text: eol });
    }
  }
  return edits;
}

/** The text after `saveWhitespaceEdits` (tests and models without an editor). */
export function applyLineEdits(text: string, edits: LineEdit[], eol = "\n"): string {
  const lines = text.split(/\r?\n/);
  const offsets: number[] = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + eol.length;
  }
  const off = (line: number, col: number) => offsets[line - 1] + col - 1;
  let out = text;
  for (const e of [...edits].sort((a, b) => off(b.startLine, b.startColumn) - off(a.startLine, a.startColumn))) {
    out = out.slice(0, off(e.startLine, e.startColumn)) + e.text + out.slice(off(e.endLine, e.endColumn));
  }
  return out;
}
