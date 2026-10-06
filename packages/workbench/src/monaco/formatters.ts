import { FormattingConflicts } from "monaco-editor/editor/contrib/format/browser/format.js";
import { ExtensionIdentifier } from "monaco-editor/platform/extensions/common/extensions.js";
import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { getPlatform, notify } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { monaco } from "./setup";

/**
 * VS Code's formatter choice: several formatters can serve one language
 * (TMCode's built-in Prettier, TypeScript's, the Prettier extension…).
 * "Format Document With…" picks one; "Configure Default Formatter…" remembers
 * it per language (VS Code's `[language].editor.defaultFormatter`); without a
 * default, the most specific / most recently registered wins, as in Monaco.
 */

const KEY = "editor.defaultFormatters";
let defaults: Record<string, string> = {};
let loaded = false;

async function loadDefaults() {
  if (loaded) return;
  loaded = true;
  defaults = (await getPlatform().store.get<Record<string, string>>(KEY).catch(() => undefined)) ?? {};
}

interface Formatter {
  displayName?: string;
  extensionId?: { value: string };
  provideDocumentFormattingEdits?: (model: monaco.editor.ITextModel, options: monaco.languages.FormattingOptions, token: monaco.CancellationToken) => Promise<monaco.languages.TextEdit[] | null | undefined> | monaco.languages.TextEdit[] | null | undefined;
  provideDocumentRangeFormattingEdits?: (model: monaco.editor.ITextModel, range: monaco.IRange, options: monaco.languages.FormattingOptions, token: monaco.CancellationToken) => Promise<monaco.languages.TextEdit[] | null | undefined> | monaco.languages.TextEdit[] | null | undefined;
}

/** A stable id for a formatter: its extension's id, else its name. */
export function formatterId(f: Formatter): string {
  return f.extensionId?.value ?? `builtin:${(f.displayName ?? "formatter").toLowerCase()}`;
}

export function formatterLabel(f: Formatter): string {
  return f.displayName ?? f.extensionId?.value ?? "Built-in formatter";
}

/** Tag a formatter provider so it can be chosen by id (extensions get their own id). */
export function withFormatterId<T extends object>(provider: T, id: string): T {
  return Object.assign(provider, { extensionId: new ExtensionIdentifier(id) });
}

function documentFormatters(model: monaco.editor.ITextModel): Formatter[] {
  const svc = StandaloneServices.get(ILanguageFeaturesService) as {
    documentFormattingEditProvider: { ordered(m: unknown): Formatter[] };
    documentRangeFormattingEditProvider: { ordered(m: unknown): Formatter[] };
  };
  const out = [...svc.documentFormattingEditProvider.ordered(model)];
  const seen = new Set(out.map(formatterId));
  for (const f of svc.documentRangeFormattingEditProvider.ordered(model)) if (!seen.has(formatterId(f))) out.push(f);
  return out;
}

const hinted = new Set<string>();

let installed = false;
export function installFormatterSelection() {
  if (installed) return;
  installed = true;
  void loadDefaults();
  FormattingConflicts.setFormatterSelector(async (formatters, model) => {
    await loadDefaults();
    const list = formatters as Formatter[];
    const lang = model.getLanguageId();
    const wanted = defaults[lang];
    const match = wanted ? list.find((f) => formatterId(f) === wanted) : undefined;
    if (match) return match;
    if (list.length > 1 && !hinted.has(lang)) {
      hinted.add(lang);
      notify("info", `There are ${list.length} formatters for ${lang} files (${list.map(formatterLabel).join(", ")}). TMCode uses ${formatterLabel(list[0])}.`, [
        { label: "Configure Default Formatter…", run: () => void configureDefaultFormatter(model) },
      ]);
    }
    return list[0];
  });
}

async function pickFormatter(model: monaco.editor.ITextModel, title: string): Promise<Formatter | null> {
  await loadDefaults();
  const list = documentFormatters(model);
  if (!list.length) {
    notify("info", `There is no formatter for ${model.getLanguageId()} files installed.`);
    return null;
  }
  const current = defaults[model.getLanguageId()];
  const pick = await showQuickPick({
    placeholder: title,
    items: list.map((f, i) => ({ id: String(i), label: formatterLabel(f), description: formatterId(f) === current ? "(default)" : formatterId(f).startsWith("builtin:") ? "built in" : formatterId(f), icon: formatterId(f) === current ? "check" : "symbol-ruler" })),
  });
  return pick ? list[Number(pick.id)] : null;
}

export async function configureDefaultFormatter(model: monaco.editor.ITextModel) {
  const f = await pickFormatter(model, `Select a default formatter for ${model.getLanguageId()} files`);
  if (!f) return;
  defaults = { ...defaults, [model.getLanguageId()]: formatterId(f) };
  await getPlatform().store.set(KEY, defaults).catch(() => {});
  notify("info", `${formatterLabel(f)} now formats ${model.getLanguageId()} files.`);
}

export async function formatDocumentWith(editor: monaco.editor.ICodeEditor) {
  const model = editor.getModel();
  if (!model) return;
  const f = await pickFormatter(model, "Select a formatter");
  if (!f) return;
  const opts = model.getOptions();
  const options = { tabSize: opts.tabSize, insertSpaces: opts.insertSpaces };
  const cts = new monaco.CancellationTokenSource();
  try {
    const edits = f.provideDocumentFormattingEdits
      ? await f.provideDocumentFormattingEdits(model, options, cts.token)
      : await f.provideDocumentRangeFormattingEdits?.(model, model.getFullModelRange(), options, cts.token);
    if (!edits?.length) return;
    editor.pushUndoStop();
    editor.executeEdits("format", edits.map((e) => ({ range: e.range, text: e.text })));
    editor.pushUndoStop();
  } catch (e) {
    notify("error", `${formatterLabel(f)} could not format the file: ${String((e as Error)?.message ?? e)}`);
  } finally {
    cts.dispose();
  }
}

/** Editor context menu + palette entries, like VS Code's. */
export function registerFormatterActions() {
  monaco.editor.addEditorAction({
    id: "editor.action.formatDocument.multiple",
    label: "Format Document With...",
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 1.31,
    run: (ed) => formatDocumentWith(ed),
  });
  monaco.editor.addEditorAction({
    id: "editor.action.configureDefaultFormatter",
    label: "Configure Default Formatter...",
    run: (ed) => {
      const m = ed.getModel();
      if (m) return configureDefaultFormatter(m);
    },
  });
}
