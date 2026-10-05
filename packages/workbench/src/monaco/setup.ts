import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import type { ThemeId } from "../state/settings";

let started = false;
/** Labels of workers that started; the Phase 0 spike checks this on WKWebView. */
export const startedWorkers: string[] = [];

/**
 * Bundled workers only (never a CDN), so the editor works offline and behind
 * an exam network allow-list.
 */
export function setupMonaco() {
  if (started) return monaco;
  started = true;
  self.MonacoEnvironment = {
    getWorker(_id, label) {
      startedWorkers.push(label);
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };
  defineThemes();
  configureLanguages();
  return monaco;
}

function configureLanguages() {
  const ts = monaco.typescript;
  const compilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    strict: true,
  };
  ts.typescriptDefaults.setCompilerOptions(compilerOptions);
  ts.javascriptDefaults.setCompilerOptions({ ...compilerOptions, strict: false, checkJs: false });
  ts.javascriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.setEagerModelSync(true);
}

/** Editor colours from VS Code's Dark Modern / Light Modern themes. */
function defineThemes() {
  monaco.editor.defineTheme("tm-dark-modern", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1F1F1F",
      "editor.foreground": "#CCCCCC",
      "editorLineNumber.foreground": "#6E7681",
      "editorLineNumber.activeForeground": "#CCCCCC",
      "editorGutter.background": "#1F1F1F",
      "editorWidget.background": "#202020",
      "editorWidget.border": "#313131",
      "editorSuggestWidget.background": "#202020",
      "editorSuggestWidget.selectedBackground": "#04395E",
      "editorHoverWidget.background": "#202020",
      "editorStickyScroll.background": "#1F1F1F",
      "editorStickyScrollHover.background": "#2A2D2E",
      "editor.lineHighlightBorder": "#282828",
      "editorIndentGuide.background1": "#404040",
      "editorIndentGuide.activeBackground1": "#707070",
      "minimap.background": "#1F1F1F",
      "scrollbarSlider.background": "#79797966",
      "scrollbarSlider.hoverBackground": "#646464B3",
      focusBorder: "#0078D4",
      "input.background": "#313131",
      "input.border": "#3C3C3C",
      "list.activeSelectionBackground": "#04395E",
      "list.hoverBackground": "#2A2D2E",
    },
  });
  monaco.editor.defineTheme("tm-light-modern", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#3B3B3B",
      "editorLineNumber.foreground": "#6E7681",
      "editorLineNumber.activeForeground": "#171184",
      "editorGutter.background": "#FFFFFF",
      "editorWidget.background": "#F8F8F8",
      "editorWidget.border": "#E5E5E5",
      "editorSuggestWidget.background": "#F8F8F8",
      "editorStickyScroll.background": "#FFFFFF",
      "editor.lineHighlightBorder": "#EEEEEE",
      "minimap.background": "#FFFFFF",
      focusBorder: "#005FB8",
      "input.background": "#FFFFFF",
      "input.border": "#CECECE",
      "list.hoverBackground": "#F2F2F2",
    },
  });
  monaco.editor.defineTheme("tm-dark-hc", { base: "hc-black", inherit: true, rules: [], colors: {} });
}

/**
 * Proves Monaco's language workers really run off the main thread in this
 * webview (plan spike S1): spins up the TypeScript worker and round-trips a
 * diagnostics request through it.
 */
export async function selfCheckWorkers(): Promise<string> {
  setupMonaco();
  const model = monaco.editor.createModel("const x: number = 'no';", "typescript", monaco.Uri.parse(`tmcode-selfcheck:/check-${Date.now()}.ts`));
  const started = performance.now();
  try {
    const getWorker = await monaco.typescript.getTypeScriptWorker();
    const worker = await getWorker(model.uri);
    // The model reaches the worker on the next sync; poll briefly until it is there.
    let diags: unknown[] = [];
    for (let i = 0; i < 20 && diags.length === 0; i++) {
      diags = await worker.getSemanticDiagnostics(model.uri.toString());
      if (!diags.length) await new Promise((r) => setTimeout(r, 100));
    }
    return `ok in ${Math.round(performance.now() - started)}ms; workers=[${startedWorkers.join(",")}]; ts diagnostics=${diags.length}`;
  } catch (e) {
    return `FAILED: ${String((e as Error)?.message ?? e)}; workers=[${startedWorkers.join(",")}]`;
  } finally {
    model.dispose();
  }
}

export function monacoThemeFor(theme: ThemeId) {
  return theme === "light-modern" ? "tm-light-modern" : theme === "dark-hc" ? "tm-dark-hc" : "tm-dark-modern";
}

export function isDarkTheme(theme: ThemeId) {
  return theme !== "light-modern";
}

export { monaco };
