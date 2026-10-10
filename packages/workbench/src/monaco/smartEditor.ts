import { create } from "zustand";
import { monaco, setupMonaco } from "./setup";
import { pathOfUri, willSaveParticipants, type SaveReason } from "./documents";
import { onCodeEditor } from "./editors";
import { codeActionsForSave, saveWhitespaceEdits } from "./smartOptions";
import { registerCommand } from "../commands/registry";
import { activeFilePath, notify, setEditorInfo, settingsForLanguage, updateSetting, useWorkbench } from "../state/store";
import { detectLanguage } from "../util/languageDetection";
import { linkedTagRanges } from "../util/linkedTags";
import { markdownLinksFor } from "../util/markdownLinks";
import { isUntitled, UNTITLED_SCHEME } from "../util/untitled";

/**
 * The editor smarts VS Code has by default and Monaco alone doesn't:
 * linked tag renaming, whitespace and code actions on save, language
 * detection for untitled editors, Markdown links on drop, and the inlay
 * hints toggle. Editor options themselves are in smartOptions.ts.
 */

/** Untitled paths whose language was detected (the status bar says so). */
export const useDetectedLanguage = create<{ paths: Record<string, true> }>()(() => ({ paths: {} }));

// ───────────── linked editing ─────────────

/** Languages with tags: HTML-like files and JSX/TSX (whose Monaco ids are javascript/typescript). */
const TAG_LANGUAGES = ["html", "xml", "xsl", "php", "handlebars", "razor", "vue", "svelte", "javascript", "typescript", "javascriptreact", "typescriptreact", "markdown"];

function registerLinkedTags() {
  for (const language of TAG_LANGUAGES) {
    monaco.languages.registerLinkedEditingRangeProvider(language, {
      provideLinkedEditingRanges(model, position) {
        // Plain .js/.ts files with generics (Array<string>) have no tags to pair.
        if ((language === "javascript" || language === "typescript") && !/\.(jsx|tsx|js|mjs|cjs)$/i.test(model.uri.path)) return null;
        const ranges = linkedTagRanges(model.getValue(), model.getOffsetAt(position));
        if (!ranges) return null;
        return {
          ranges: ranges.map((r) => {
            const a = model.getPositionAt(r.start);
            const b = model.getPositionAt(r.end);
            return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
          }),
          wordPattern: /[A-Za-z][\w\-.:]*/,
        };
      },
    });
  }
}

// ───────────── save participants ─────────────

function editorsOf(model: monaco.editor.ITextModel) {
  return monaco.editor.getEditors().filter((e) => e.getModel() === model);
}

/** files.trimTrailingWhitespace / trimFinalNewlines / insertFinalNewline (undoable, cursor kept). */
function whitespaceOnSave(model: monaco.editor.ITextModel, reason: SaveReason) {
  const s = settingsForLanguage(model.getLanguageId());
  const opts = { trimTrailingWhitespace: s["files.trimTrailingWhitespace"], trimFinalNewlines: s["files.trimFinalNewlines"], insertFinalNewline: s["files.insertFinalNewline"] };
  if (!opts.trimTrailingWhitespace && !opts.trimFinalNewlines && !opts.insertFinalNewline) return;
  let edits = saveWhitespaceEdits(model.getLinesContent(), opts, model.getEOL());
  // Auto save leaves the lines being typed on alone, as VS Code does (no spaces vanishing mid-word).
  if (reason === "auto") {
    const cursorLines = new Set(editorsOf(model).flatMap((e) => (e.getSelections() ?? []).map((sel) => sel.positionLineNumber)));
    edits = edits.filter((e) => ![...cursorLines].some((l) => l >= e.startLine && l <= e.endLine));
  }
  if (!edits.length) return;
  model.pushEditOperations(
    editorsOf(model)[0]?.getSelections() ?? [],
    edits.map((e) => ({ range: new monaco.Range(e.startLine, e.startColumn, e.endLine, e.endColumn), text: e.text })),
    () => null,
  );
}

/** Monaco action for a code action kind of editor.codeActionsOnSave. */
const ACTION_FOR_KIND: Record<string, string> = {
  "source.organizeImports": "editor.action.organizeImports",
  "source.fixAll": "editor.action.fixAll",
};

async function codeActionsOnSave(model: monaco.editor.ITextModel, reason: SaveReason) {
  const { policy } = useWorkbench.getState();
  // Fixes and organised imports are language help: only with full intelligence.
  if (policy.intelligence !== "full") return;
  const kinds = codeActionsForSave(settingsForLanguage(model.getLanguageId())["editor.codeActionsOnSave"], reason);
  if (!kinds.length) return;
  const ed = editorsOf(model)[0];
  if (!ed) return;
  for (const kind of kinds) {
    const id = ACTION_FOR_KIND[kind] ?? Object.entries(ACTION_FOR_KIND).find(([k]) => kind.startsWith(`${k}.`))?.[1];
    const action = id ? ed.getAction(id) : null;
    if (!action?.isSupported()) continue;
    try {
      // A language server that never answers must not hold the save back.
      await Promise.race([action.run(), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* a failing action never blocks saving */
    }
  }
}

// ───────────── language detection ─────────────

const detected = new Set<string>();
const manual = new Set<string>();
let settingLanguage = false;

function setDetected(path: string, on: boolean) {
  const paths = { ...useDetectedLanguage.getState().paths };
  if (on) paths[path] = true;
  else delete paths[path];
  useDetectedLanguage.setState({ paths });
}

function detectNow(model: monaco.editor.ITextModel) {
  if (model.isDisposed()) return;
  const path = pathOfUri(model.uri);
  if (!useWorkbench.getState().settings["workbench.editor.languageDetection"] || manual.has(path)) return;
  const current = model.getLanguageId();
  if (current !== "plaintext" && !detected.has(path)) return;
  const guess = detectLanguage(model.getValue());
  const known = guess && monaco.languages.getLanguages().some((l) => l.id === guess);
  const next = known ? guess! : model.getValueLength() === 0 ? "plaintext" : null;
  if (!next || next === current) return;
  settingLanguage = true;
  try {
    monaco.editor.setModelLanguage(model, next);
  } finally {
    settingLanguage = false;
  }
  if (next === "plaintext") detected.delete(path);
  else detected.add(path);
  setDetected(path, next !== "plaintext");
  if (activeFilePath() === path) setEditorInfo({ language: next, eol: model.getEOL() === "\r\n" ? "CRLF" : "LF" });
}

function watchUntitled(model: monaco.editor.ITextModel) {
  if (model.uri.scheme !== UNTITLED_SCHEME) return;
  const path = pathOfUri(model.uri);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const subs = [
    model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(() => detectNow(model), 300);
    }),
    model.onDidChangeLanguage((e) => {
      if (settingLanguage) return;
      // Change Language Mode: the student's choice sticks; "Auto Detect" (plain text) starts guessing again.
      detected.delete(path);
      setDetected(path, false);
      if (e.newLanguage === "plaintext") {
        manual.delete(path);
        detectNow(model);
      } else manual.add(path);
    }),
  ];
  model.onWillDispose(() => {
    clearTimeout(timer);
    subs.forEach((s) => s.dispose());
    detected.delete(path);
    manual.delete(path);
    setDetected(path, false);
  });
  if (model.getValueLength()) detectNow(model);
}

// ───────────── Markdown drop ─────────────

/** Shift+drop of Explorer files into Markdown inserts relative links (images as ![…]), as VS Code. */
function attachMarkdownDrop(ed: monaco.editor.IStandaloneCodeEditor) {
  const node = ed.getContainerDomNode();
  const onDrop = (e: DragEvent) => {
    const model = ed.getModel();
    if (!model || model.getLanguageId() !== "markdown" || !e.shiftKey) return;
    if (useWorkbench.getState().settings["markdown.editor.drop.enabled"] === "never") return;
    let paths: string[] = [];
    try {
      paths = JSON.parse(e.dataTransfer?.getData("application/x-tmcode-paths") || "[]");
    } catch {
      paths = [];
    }
    if (!paths.length) paths = [e.dataTransfer?.getData("application/x-tmcode-path") ?? ""].filter(Boolean);
    if (!paths.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const target = ed.getTargetAtClientPoint(e.clientX, e.clientY);
    const pos = target?.position ?? ed.getPosition();
    if (!pos) return;
    const from = isUntitled(pathOfUri(model.uri)) ? "untitled.md" : pathOfUri(model.uri);
    const text = markdownLinksFor(from, paths);
    ed.executeEdits("tmcode.markdownDrop", [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text }]);
    ed.focus();
  };
  node.addEventListener("drop", onDrop, true);
  ed.onDidDispose(() => node.removeEventListener("drop", onDrop, true));
}

// ───────────── wiring ─────────────

let wired = false;
export function wireSmartEditor() {
  if (wired) return;
  wired = true;
  setupMonaco();
  registerLinkedTags();
  // Monaco's linked editing cancels its pending lookup when the cursor moves and leaves the
  // rejection unhandled; VS Code ignores CancellationError, so does TMCode (no log noise).
  window.addEventListener(
    "unhandledrejection",
    (e) => {
      const r = e.reason as { name?: string; message?: string } | undefined;
      if (r?.name === "Canceled" && r.message === "Canceled") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  willSaveParticipants.push(async (_path, model, reason) => {
    await codeActionsOnSave(model, reason);
    whitespaceOnSave(model, reason);
  });
  monaco.editor.onDidCreateModel(watchUntitled);
  monaco.editor.getModels().forEach(watchUntitled);
  onCodeEditor(attachMarkdownDrop);
  registerCommand({
    id: "editor.action.toggleInlayHints",
    title: "Toggle Inlay Hints",
    category: "View",
    aliases: ["inlay hints", "type hints"],
    run: () => {
      const on = useWorkbench.getState().settings["editor.inlayHints.enabled"] !== "off";
      updateSetting("editor.inlayHints.enabled", on ? "off" : "on");
      if (!on && useWorkbench.getState().policy.intelligence !== "full") notify("info", "Inlay hints stay hidden during this session: your teacher turned language help off.");
    },
  });
}

