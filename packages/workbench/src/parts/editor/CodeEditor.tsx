import { useEffect, useMemo, useRef, useState } from "react";
import { allCommands, executeCommand, keybindingFor } from "../../commands/registry";
import { ensureDocument, languageForPath, saveOnFocusChange } from "../../monaco/documents";
import { registerCodeEditor } from "../../monaco/editors";
import { monaco, monacoThemeFor, setupMonaco } from "../../monaco/setup";
import { defaultFontFamily, type Settings } from "../../state/settings";
import { SkeletonLines } from "../../widgets/Skeleton";
import { focusGroup, getPlatform, scheduleLayoutSave, setCursor, setEditorInfo, settingsForLanguage, useWorkbench } from "../../state/store";
import { editorMemento } from "../../state/viewStates";
import type { OsKind } from "../../platform/types";
import { attachDebugEditor } from "../../debug/editorContrib";
import { guardEditorHelp, guardEditorPaste, intelligenceOptions } from "../../exam/editorPolicy";

const KEY_CODES: Record<string, number> = {
  "`": monaco.KeyCode.Backquote,
  "\\": monaco.KeyCode.Backslash,
  ",": monaco.KeyCode.Comma,
  ".": monaco.KeyCode.Period,
  "/": monaco.KeyCode.Slash,
  "=": monaco.KeyCode.Equal,
  "-": monaco.KeyCode.Minus,
  enter: monaco.KeyCode.Enter,
  left: monaco.KeyCode.LeftArrow,
  right: monaco.KeyCode.RightArrow,
  up: monaco.KeyCode.UpArrow,
  down: monaco.KeyCode.DownArrow,
};

/** "mod+k" → Monaco keybinding number (for chords Monaco must own while it has focus). */
function toMonacoKey(chord: string, os: OsKind): number | null {
  const parts = chord.split("+");
  const key = parts.pop()!;
  let code: number | undefined;
  if (/^[a-z]$/.test(key)) code = (monaco.KeyCode as unknown as Record<string, number>)[`Key${key.toUpperCase()}`];
  else if (/^[0-9]$/.test(key)) code = (monaco.KeyCode as unknown as Record<string, number>)[`Digit${key}`];
  else if (/^f[0-9]+$/.test(key)) code = (monaco.KeyCode as unknown as Record<string, number>)[key.toUpperCase()];
  else code = KEY_CODES[key];
  if (code === undefined) return null;
  let mods = 0;
  for (const p of parts) {
    if (p === "mod") mods |= monaco.KeyMod.CtrlCmd;
    else if (p === "ctrl") mods |= os === "mac" ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
    else if (p === "shift") mods |= monaco.KeyMod.Shift;
    else if (p === "alt") mods |= monaco.KeyMod.Alt;
  }
  return mods | code;
}

export function editorOptions(settings: Settings, os: OsKind): monaco.editor.IStandaloneEditorConstructionOptions {
  const reduce = settings["workbench.reduceMotion"];
  return {
    fontSize: settings["editor.fontSize"],
    fontFamily: settings["editor.fontFamily"] || defaultFontFamily(os),
    fontLigatures: false,
    lineHeight: 0,
    tabSize: settings["editor.tabSize"],
    insertSpaces: settings["editor.insertSpaces"],
    wordWrap: settings["editor.wordWrap"],
    minimap: { enabled: settings["editor.minimap.enabled"], renderCharacters: false, scale: 1 },
    lineNumbers: settings["editor.lineNumbers"],
    renderWhitespace: settings["editor.renderWhitespace"],
    cursorBlinking: settings["editor.cursorBlinking"],
    bracketPairColorization: { enabled: settings["editor.bracketPairColorization.enabled"] },
    guides: { bracketPairs: "active", indentation: true },
    stickyScroll: { enabled: settings["editor.stickyScroll.enabled"] },
    smoothScrolling: !reduce,
    cursorSmoothCaretAnimation: reduce ? "off" : "on",
    renderLineHighlight: "line",
    scrollBeyondLastLine: true,
    automaticLayout: true,
    fixedOverflowWidgets: true,
    padding: { top: 0 },
    scrollbar: { verticalScrollbarSize: 14, horizontalScrollbarSize: 12, useShadows: false },
    "semanticHighlighting.enabled": true,
  };
}

/**
 * One Monaco instance per editor group; switching tabs swaps models and
 * restores each file's scroll/cursor state, exactly like VS Code.
 */
export function CodeEditor({ groupId, path }: { groupId: number; path: string }) {
  const host = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const currentPath = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // The model's language: `[python]` settings apply to Python files only.
  const [language, setLanguage] = useState<string | null>(null);
  const userSettings = useWorkbench((s) => s.userSettings);
  const languageSettings = useWorkbench((s) => s.languageSettings);
  const workspaceSettings = useWorkbench((s) => s.workspaceSettings);
  const locked = useWorkbench((s) => s.policy.locked_settings);
  const settings = useMemo(
    () => settingsForLanguage(language, useWorkbench.getState()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [language, userSettings, languageSettings, workspaceSettings, locked],
  );
  const readOnly = useWorkbench((s) => s.readOnly);
  const readOnlyReason = useWorkbench((s) => s.readOnlyReason);
  const intelligence = useWorkbench((s) => s.policy.intelligence);
  const setHelpLevel = useRef<((level: typeof intelligence) => void) | null>(null);
  const os = getPlatform().os;

  // Create the editor once per group.
  useEffect(() => {
    setupMonaco();
    const ed = monaco.editor.create(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      ...intelligenceOptions(useWorkbench.getState().policy.intelligence),
      model: null,
      theme: monacoThemeFor(),
      ariaLabel: "Editor content",
    });
    editorRef.current = ed;
    const unregister = registerCodeEditor(groupId, ed);

    // Cursor and scroll are remembered per folder (restored after a restart, like VS Code).
    let viewTimer: ReturnType<typeof setTimeout> | null = null;
    const rememberView = () => {
      if (viewTimer) clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        const p = currentPath.current;
        const vs = ed.getModel() ? ed.saveViewState() : null;
        if (p && vs) {
          editorMemento.viewStates.set(`${groupId}:${p}`, vs);
          scheduleLayoutSave(1500);
        }
      }, 400);
    };
    const disposables = [
      ed.onDidScrollChange(rememberView),
      ed.onDidChangeCursorSelection((e) => {
        rememberView();
        const sel = e.selection;
        const model = ed.getModel();
        setCursor({
          line: sel.positionLineNumber,
          column: sel.positionColumn,
          selected: model ? model.getValueLengthInRange(sel) : 0,
        });
      }),
      ed.onDidFocusEditorText(() => focusGroup(groupId)),
      ed.onDidBlurEditorText(() => saveOnFocusChange()),
      attachDebugEditor(ed),
      { dispose: guardEditorPaste(ed) },
    ];
    setHelpLevel.current = guardEditorHelp(ed);
    setHelpLevel.current(useWorkbench.getState().policy.intelligence);

    // Chorded workbench commands (⌘K ⌘T …) must be bound inside Monaco, which owns ⌘K while focused.
    for (const cmd of allCommands()) {
      const kb = keybindingFor(cmd, os);
      if (!kb || !kb.includes(" ")) continue;
      const [a, b] = kb.split(" ").map((c) => toMonacoKey(c, os));
      if (a != null && b != null) ed.addCommand(monaco.KeyMod.chord(a, b), () => executeCommand(cmd.id));
    }

    return () => {
      if (viewTimer) clearTimeout(viewTimer);
      // Remounted (a split moved this group in the grid): the next editor of this group starts where this one was.
      if (currentPath.current && ed.getModel()) editorMemento.viewStates.set(`${groupId}:${currentPath.current}`, ed.saveViewState());
      disposables.forEach((d) => d.dispose());
      unregister();
      ed.dispose();
      editorRef.current = null;
      setHelpLevel.current = null;
    };
  }, [groupId, os]);

  // Swap the model when the active tab changes.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    let cancelled = false;
    setError(null);
    // Only show the skeleton if loading is slow enough to notice (large or remote files).
    const slow = setTimeout(() => !cancelled && setLoading(true), 150);
    if (currentPath.current) {
      const vs = ed.saveViewState();
      viewStates.current.set(currentPath.current, vs);
      if (vs) editorMemento.viewStates.set(`${groupId}:${currentPath.current}`, vs);
    }
    ensureDocument(path)
      .then((model) => {
        if (cancelled || model.isDisposed()) return;
        ed.setModel(model);
        currentPath.current = path;
        const vs = viewStates.current.get(path) ?? (editorMemento.viewStates.get(`${groupId}:${path}`) as monaco.editor.ICodeEditorViewState | undefined);
        if (vs) ed.restoreViewState(vs);
        setLanguage(model.getLanguageId() || languageForPath(path));
        // Opening from the explorer or search keeps focus there (keyboard browsing), as in VS Code.
        if (!document.activeElement?.closest(".tm-explorer, .tm-search")) ed.focus();
        const pos = ed.getPosition();
        if (pos) setCursor({ line: pos.lineNumber, column: pos.column, selected: 0 });
        setEditorInfo({ language: model.getLanguageId() || languageForPath(path), eol: model.getEOL() === "\r\n" ? "CRLF" : "LF" });
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)))
      .finally(() => {
        clearTimeout(slow);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(slow);
    };
  }, [path]);

  useEffect(() => {
    const ed = editorRef.current;
    ed?.updateOptions({
      ...editorOptions(settings, os),
      ...intelligenceOptions(intelligence),
      readOnly,
      readOnlyMessage: { value: readOnlyReason ?? "Time is up. Your code can no longer be changed." },
    });
    setHelpLevel.current?.(intelligence);
    // Indentation set for this language or by the folder wins over what Monaco guessed from the file.
    const model = ed?.getModel();
    if (model && language) {
      const explicit = (k: "editor.tabSize" | "editor.insertSpaces") =>
        k in (languageSettings[language] ?? {}) || k in (workspaceSettings?.values ?? {}) || k in (workspaceSettings?.languages[language] ?? {});
      const opts: monaco.editor.ITextModelUpdateOptions = {};
      if (explicit("editor.tabSize")) {
        opts.tabSize = settings["editor.tabSize"];
        opts.indentSize = settings["editor.tabSize"];
      }
      if (explicit("editor.insertSpaces")) opts.insertSpaces = settings["editor.insertSpaces"];
      if (Object.keys(opts).length) model.updateOptions(opts);
    }
  }, [settings, os, readOnly, readOnlyReason, intelligence, language, languageSettings, workspaceSettings]);


  return (
    <div className="tm-code-editor">
      {/* monaco-component: Monaco's theme colours (--vscode-menu-background …) are scoped to it, and the
          context menu's shadow host is a child of this element, so the menu gets the theme's colours. */}
      <div ref={host} className="tm-monaco-host monaco-component" data-testid="monaco-host" />
      {loading && (
        <div className="tm-editor-loading">
          <SkeletonLines lines={12} label="Opening file" />
        </div>
      )}
      {error && (
        <div className="tm-editor-error" role="alert">
          <p>The editor could not be opened due to an unexpected error:</p>
          <code>{error}</code>
        </div>
      )}
    </div>
  );
}
