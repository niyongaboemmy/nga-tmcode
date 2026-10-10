import { useEffect, useRef } from "react";
import { monaco, monacoThemeFor, setupMonaco } from "../monaco/setup";
import { editorOptions } from "../parts/editor/CodeEditor";
import { languageLabel } from "../monaco/documents";
import { focusGroup, getPlatform, useWorkbench, type EditorInput } from "../state/store";
import { Codicon } from "../widgets/icons";
import { loadUserSnippets, setUserSnippetsText, userSnippetsText } from "./userSnippets";
import { parseUserSnippets } from "./snippetLogic";

const MARKER_OWNER = "tmcode-snippets";

/** A language's user snippets file (VS Code format). Valid changes apply as you type, like settings.json. */
export function SnippetsEditor({ input }: { input: Extract<EditorInput, { kind: "snippets" }> }) {
  const host = useRef<HTMLDivElement>(null);
  const os = getPlatform().os;

  useEffect(() => {
    setupMonaco();
    let disposed = false;
    let ed: monaco.editor.IStandaloneCodeEditor | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subs: monaco.IDisposable[] = [];
    const check = (model: monaco.editor.ITextModel) => {
      const r = parseUserSnippets(model.getValue());
      monaco.editor.setModelMarkers(model, MARKER_OWNER, r.error ? [{ severity: monaco.MarkerSeverity.Error, message: r.error, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }] : []);
      setUserSnippetsText(input.language, model.getValue());
    };
    void loadUserSnippets().then(() => {
      if (disposed || !host.current) return;
      const uri = monaco.Uri.parse(`tmcode-snippets:/User/snippets/${input.language}.json`);
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(userSnippetsText(input.language), "json", uri);
      ed = monaco.editor.create(host.current, {
        ...editorOptions(useWorkbench.getState().settings, os),
        model,
        theme: monacoThemeFor(),
        tabSize: 4,
        insertSpaces: false,
        ariaLabel: `${languageLabel(input.language)} snippets (JSON)`,
      });
      ed.focus();
      subs.push(
        model.onDidChangeContent(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => check(model), 300);
        }),
        ed.onDidFocusEditorText(() => focusGroup(useWorkbench.getState().activeGroup)),
      );
    });
    return () => {
      disposed = true;
      const model = ed?.getModel();
      if (timer && model) check(model);
      if (timer) clearTimeout(timer);
      subs.forEach((d) => d.dispose());
      ed?.dispose();
    };
  }, [input.language, os]);

  return (
    <div className="tm-settings-json" data-testid="snippets-editor">
      <div className="tm-settings-json-bar">
        <span>
          <Codicon name="symbol-snippet" /> Your {languageLabel(input.language)} snippets. Valid changes apply as you type.
        </span>
      </div>
      <div ref={host} className="tm-monaco-host monaco-component" />
    </div>
  );
}
