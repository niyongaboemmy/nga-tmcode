import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { currentMonacoTheme, installTextmate } from "../textmate/monacoTm";
import { isDarkThemeId } from "../themes/themeService";
import { registerLogicLanguage } from "../logic/language";

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
  configureLanguages();
  registerLogicLanguage();
  installTextmate();
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

/** Monaco's theme is global and set by the theme service; editors created later just pick it up. */
export function monacoThemeFor(_theme?: string) {
  return currentMonacoTheme();
}

export function isDarkTheme(theme: string) {
  return isDarkThemeId(theme);
}

export { monaco };
