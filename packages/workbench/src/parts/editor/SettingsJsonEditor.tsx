import { useEffect, useRef } from "react";
import { monaco, monacoThemeFor, setupMonaco } from "../../monaco/setup";
import { editorOptions } from "./CodeEditor";
import { applyUserSettingsJson, focusGroup, getPlatform, openFile, openSpecialEditor, useWorkbench, type WorkbenchState } from "../../state/store";
import { DEFAULT_SETTINGS } from "../../state/settings";
import { parseSettingsJson, stringifySettings, userDiff, WORKSPACE_SETTINGS_FILE, type ParsedSettings } from "../../state/settingsJson";
import { Codicon } from "../../widgets/icons";

const MARKER_OWNER = "tmcode-settings";
const URI = "tmcode-settings:/User/settings.json";

/** settings.json text for the user's settings as they are now. */
export function userSettingsText(s: WorkbenchState = useWorkbench.getState()) {
  return stringifySettings(userDiff(s.userSettings), s.languageSettings, s.otherSettings);
}

function sortKeys(o: object): object {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** The text already says what the store has (so an outside change needs no rewrite). */
const same = (p: ParsedSettings, s: WorkbenchState) =>
  JSON.stringify([sortKeys(userDiff(s.userSettings)), sortKeys(s.languageSettings)]) ===
  JSON.stringify([sortKeys(userDiff({ ...DEFAULT_SETTINGS, ...p.values })), sortKeys(p.languages)]);

/** One model for the session: a half-typed (invalid) settings.json survives closing and reopening the tab. */
function settingsModel() {
  const uri = monaco.Uri.parse(URI);
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(userSettingsText(), "json", uri);
}

/** Checks the text, marks problems, and applies it when it is valid JSON. */
export function applySettingsText(model: monaco.editor.ITextModel, apply = true) {
  const text = model.getValue();
  const parsed = parseSettingsJson(text);
  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    parsed.issues.map((i) => {
      const start = model.getPositionAt(i.offset ?? 0);
      const end = model.getPositionAt((i.offset ?? 0) + (i.key ? JSON.stringify(i.key).length : 1));
      return {
        severity: i.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        message: i.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      };
    }),
  );
  if (apply && !parsed.syntaxError) applyUserSettingsJson(parsed);
  return parsed;
}

/**
 * "Preferences: Open User Settings (JSON)": the user's settings as JSON with
 * comments. Valid settings apply as you type; problems are underlined.
 */
export function SettingsJsonEditor() {
  const host = useRef<HTMLDivElement>(null);
  const overlay = useWorkbench((s) => s.workspaceSettings);
  const os = getPlatform().os;

  useEffect(() => {
    setupMonaco();
    const model = settingsModel();
    const ed = monaco.editor.create(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      model,
      theme: monacoThemeFor(),
      tabSize: 4,
      insertSpaces: true,
      ariaLabel: "User settings (JSON)",
    });
    ed.focus();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = model.onDidChangeContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => applySettingsText(model), 250);
    });
    // Reopened: a valid copy that is out of date (changed in the Settings editor since) shows the settings now; a half-typed one stays.
    const opened = parseSettingsJson(model.getValue());
    if (!opened.syntaxError && !same(opened, useWorkbench.getState())) model.setValue(userSettingsText());
    applySettingsText(model, false);
    const focus = ed.onDidFocusEditorText(() => focusGroup(useWorkbench.getState().activeGroup));
    // Changed in the Settings editor (or by a command) while this is open: show it here too.
    const unsub = useWorkbench.subscribe((s, prev) => {
      if (s.userSettings === prev.userSettings && s.languageSettings === prev.languageSettings) return;
      const parsed = parseSettingsJson(model.getValue());
      if (parsed.syntaxError || same(parsed, s)) return;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: userSettingsText(s) }], () => null);
    });
    return () => {
      if (timer) {
        clearTimeout(timer);
        applySettingsText(model);
      }
      sub.dispose();
      focus.dispose();
      unsub();
      ed.dispose();
    };
  }, [os]);

  const wsCount = overlay ? Object.keys(overlay.values).length + Object.values(overlay.languages).reduce((n, l) => n + Object.keys(l).length, 0) : 0;
  return (
    <div className="tm-settings-json" data-testid="settings-json">
      <div className="tm-settings-json-bar">
        <span>
          <Codicon name="info" /> Your settings. Valid changes apply as you type.
        </span>
        {overlay && (
          <button type="button" className="tm-link-button" onClick={() => openFile(WORKSPACE_SETTINGS_FILE, { pinned: true })}>
            This folder sets {wsCount} more (read-only)
          </button>
        )}
        <button type="button" className="tm-link-button" onClick={() => openSpecialEditor("settings")}>
          Open Settings
        </button>
      </div>
      <div ref={host} className="tm-monaco-host monaco-component" />
    </div>
  );
}
