import { useEffect, useRef } from "react";
import { monaco, monacoThemeFor, setupMonaco } from "../../monaco/setup";
import { editorOptions } from "./CodeEditor";
import { focusGroup, getPlatform, openSpecialEditor, useWorkbench } from "../../state/store";
import { useKeybindingRules } from "../../commands/keybindingRules";
import { saveKeybindingsText } from "../../commands/keybindings";
import { Codicon } from "../../widgets/icons";

const MARKER_OWNER = "tmcode-keybindings";
const URI = "tmcode-settings:/User/keybindings.json";

/** One model for the session (a half-typed file survives closing the tab). */
function keybindingsModel() {
  const uri = monaco.Uri.parse(URI);
  return monaco.editor.getModel(uri) ?? monaco.editor.createModel(useKeybindingRules.getState().text, "jsonc", uri);
}

/** Saves and applies the text; problems are shown on the first line. */
function apply(model: monaco.editor.ITextModel) {
  const parsed = saveKeybindingsText(model.getValue());
  monaco.editor.setModelMarkers(
    model,
    MARKER_OWNER,
    parsed.issues.map((i) => ({ severity: parsed.syntaxError ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning, message: i.message, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 })),
  );
}

/**
 * "Preferences: Open Keyboard Shortcuts (JSON)": keybindings.json, VS Code's
 * format. Valid rules apply as you type.
 */
export function KeybindingsJsonEditor() {
  const host = useRef<HTMLDivElement>(null);
  const os = getPlatform().os;
  const count = useKeybindingRules((s) => s.rules.length);

  useEffect(() => {
    setupMonaco();
    const model = keybindingsModel();
    const ed = monaco.editor.create(host.current!, {
      ...editorOptions(useWorkbench.getState().settings, os),
      model,
      theme: monacoThemeFor(),
      tabSize: 2,
      insertSpaces: true,
      ariaLabel: "Keyboard shortcuts (JSON)",
    });
    ed.focus();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = model.onDidChangeContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => apply(model), 250);
    });
    const focus = ed.onDidFocusEditorText(() => focusGroup(useWorkbench.getState().activeGroup));
    return () => {
      if (timer) {
        clearTimeout(timer);
        apply(model);
      }
      sub.dispose();
      focus.dispose();
      ed.dispose();
    };
  }, [os]);

  return (
    <div className="tm-settings-json" data-testid="keybindings-json">
      <div className="tm-settings-json-bar">
        <span>
          <Codicon name="info" /> Your keyboard shortcuts ({count} rule{count === 1 ? "" : "s"}). Later rules win; "-command" removes a key; "when" limits where it works.
        </span>
        <button type="button" className="tm-link-button" onClick={() => openSpecialEditor("shortcuts")}>
          Open Keyboard Shortcuts
        </button>
      </div>
      <div ref={host} className="tm-monaco-host monaco-component" />
    </div>
  );
}
