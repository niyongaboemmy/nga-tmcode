import type { Intelligence } from "@tmcode/protocol";
import { monaco } from "../monaco/setup";
import { pasteRefusal, refusePaste, trackCopies } from "./pasteGuard";

/**
 * The exam policy inside Monaco (plan §6.2, §10.1): how much the editor helps
 * (`intelligence`) and where pasted text may come from (`paste`).
 */

// ───────────────────────── editor help ─────────────────────────

const SUGGEST_KINDS = [
  "showMethods",
  "showFunctions",
  "showConstructors",
  "showFields",
  "showVariables",
  "showClasses",
  "showStructs",
  "showInterfaces",
  "showModules",
  "showProperties",
  "showEvents",
  "showOperators",
  "showUnits",
  "showValues",
  "showConstants",
  "showEnums",
  "showEnumMembers",
  "showColors",
  "showFiles",
  "showReferences",
  "showFolders",
  "showTypeParameters",
  "showIssues",
  "showUsers",
] as const;

const kinds = (on: boolean) => Object.fromEntries(SUGGEST_KINDS.map((k) => [k, on]));

/** Editor options for an intelligence level. Every key is set at every level, so leaving an exam restores them. */
export function intelligenceOptions(level: Intelligence): monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions {
  const full = level === "full";
  const none = level === "none";
  return {
    // none: syntax colouring only. basic: words, keywords and snippets. full: language-aware IntelliSense.
    quickSuggestions: none ? false : { other: "on", comments: "off", strings: "off" },
    suggestOnTriggerCharacters: !none,
    wordBasedSuggestions: none ? "off" : "matchingDocuments",
    snippetSuggestions: none ? "none" : "inline",
    suggest: { ...kinds(full), showKeywords: !none, showWords: !none, showSnippets: !none },
    parameterHints: { enabled: full },
    hover: { enabled: full ? "on" : "off" },
    inlayHints: { enabled: full ? "on" : "off" },
    codeLens: full,
    lightbulb: { enabled: full ? monaco.editor.ShowLightbulbIconMode.OnCode : monaco.editor.ShowLightbulbIconMode.Off },
    // Error squiggles from "diagnostics" up.
    renderValidationDecorations: level === "none" || level === "basic" ? "off" : "editable",
  };
}

/**
 * Turning quick suggestions off still leaves the explicit triggers (⌃Space,
 * ⇧⌘Space): bind them to nothing while the level forbids them. Returns a
 * setter for the current level.
 */
export function guardEditorHelp(ed: monaco.editor.IStandaloneCodeEditor) {
  const noSuggest = ed.createContextKey<boolean>("tmcodeNoSuggest", false);
  const noHints = ed.createContextKey<boolean>("tmcodeNoParameterHints", false);
  const { KeyMod, KeyCode } = monaco;
  for (const kb of [KeyMod.CtrlCmd | KeyCode.Space, KeyMod.WinCtrl | KeyCode.Space, KeyMod.CtrlCmd | KeyCode.KeyI, KeyMod.Alt | KeyCode.Escape]) {
    ed.addCommand(kb, () => {}, "tmcodeNoSuggest");
  }
  ed.addCommand(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space, () => {}, "tmcodeNoParameterHints");
  return (level: Intelligence) => {
    noSuggest.set(level === "none");
    noHints.set(level !== "full");
  };
}

// ───────────────────────── paste ─────────────────────────

/** Applies the paste policy to one Monaco editor. Returns a disposer. */
export function guardEditorPaste(ed: monaco.editor.IStandaloneCodeEditor): () => void {
  trackCopies();
  const node = ed.getContainerDomNode();
  // A real paste (⌘V, Edit › Paste, the context menu) arrives as a DOM event: refuse it before Monaco sees it.
  const onPaste = (e: ClipboardEvent) => {
    const why = pasteRefusal(e.clipboardData?.getData("text/plain") ?? "");
    if (!why) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    refusePaste(why);
  };
  // Text dragged in from another app is a paste too.
  const onDrop = (e: DragEvent) => {
    // A dropped file has no text but inserts its path: refused under any paste limit.
    const why = pasteRefusal(e.dataTransfer?.getData("text/plain") || "\u0000");
    if (!why) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    refusePaste(why);
  };
  node.addEventListener("paste", onPaste, true);
  node.addEventListener("drop", onDrop, true);
  // Anything that reached the model another way (the clipboard API): undo it.
  const sub = ed.onDidPaste((e) => {
    if (e.clipboardEvent?.defaultPrevented) return;
    const model = ed.getModel();
    if (!model) return;
    const why = pasteRefusal(model.getValueInRange(e.range));
    if (!why) return;
    ed.trigger("tmcode.pasteGuard", "undo", null);
    refusePaste(why);
  });
  return () => {
    node.removeEventListener("paste", onPaste, true);
    node.removeEventListener("drop", onDrop, true);
    sub.dispose();
  };
}
