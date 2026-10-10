import { create } from "zustand";
import { monaco, setupMonaco } from "../monaco/setup";
import { languageLabel } from "../monaco/documents";
import { targetEditor } from "../commands/editorCommands";
import { extensionSnippetsFor } from "../extensions/monacoContributions";
import { inExam } from "../exam/state";
import { getPlatform, log, notify, openEditorInput } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { parseUserSnippets, snippetPreview, snippetTemplate, type UserSnippet } from "./snippetLogic";

/**
 * Snippets: Configure User Snippets (one JSON file per language, kept in the
 * user's TMCode data, edited in a JSON editor) and Insert Snippet. User
 * snippets join the completion list like VS Code's. Never in exams: a
 * student's own snippets could carry prepared answers.
 */

const STORE_KEY = "userSnippets";

interface SnippetsState {
  /** language id → the file's text. */
  texts: Record<string, string>;
  parsed: Record<string, UserSnippet[]>;
}

export const useUserSnippets = create<SnippetsState>(() => ({ texts: {}, parsed: {} }));

const providers = new Set<string>();

function registerProvider(language: string) {
  if (providers.has(language)) return;
  providers.add(language);
  monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems(model, position) {
      if (inExam()) return { suggestions: [] };
      const list = (useUserSnippets.getState().parsed[language] ?? []).filter((s) => s.prefixes.length);
      if (!list.length) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: list.flatMap((s) =>
          s.prefixes.map((prefix) => ({
            label: { label: prefix, description: s.name },
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: s.description ?? `${s.name} (User Snippet)`,
            documentation: { value: "```\n" + snippetPreview(s.body) + "\n```" },
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        ),
      };
    },
  });
}

function apply(texts: Record<string, string>) {
  const parsed: Record<string, UserSnippet[]> = {};
  for (const [lang, text] of Object.entries(texts)) {
    const r = parseUserSnippets(text);
    // A half-typed file keeps its last good snippets.
    parsed[lang] = r.error ? (useUserSnippets.getState().parsed[lang] ?? []) : r.snippets;
  }
  useUserSnippets.setState({ texts, parsed });
  setupMonaco();
  for (const lang of Object.keys(parsed)) if (parsed[lang].length) registerProvider(lang);
}

let loaded: Promise<void> | null = null;
export function loadUserSnippets() {
  loaded ??= (async () => {
    const texts = await getPlatform()
      .store.get<Record<string, string>>(STORE_KEY)
      .catch(() => undefined);
    apply(texts && typeof texts === "object" ? texts : {});
  })().catch((e) => log("Snippets", `Loading user snippets failed: ${String((e as Error)?.message ?? e)}`, "warn"));
  return loaded;
}

/** Saves a language's snippets file (the snippets editor calls this as you type). */
export function setUserSnippetsText(language: string, text: string) {
  const texts = { ...useUserSnippets.getState().texts, [language]: text };
  apply(texts);
  void getPlatform().store.set(STORE_KEY, texts);
}

export function userSnippetsText(language: string) {
  return useUserSnippets.getState().texts[language] ?? snippetTemplate(languageLabel(language));
}

/** Snippets: Configure User Snippets — pick a language, edit its snippets file. */
export async function configureUserSnippets() {
  await loadUserSnippets();
  setupMonaco();
  const existing = Object.keys(useUserSnippets.getState().texts);
  const langs = monaco.languages
    .getLanguages()
    .map((l) => ({ id: l.id, name: l.aliases?.[0] ?? languageLabel(l.id) }))
    .filter((l, i, all) => all.findIndex((x) => x.id === l.id) === i)
    .sort((a, b) => a.name.localeCompare(b.name));
  const pick = await showQuickPick({
    placeholder: "Select Snippets File or Create Snippets",
    matchOnDescription: true,
    items: [
      ...existing.map((id, i) => ({ id, label: `${langs.find((l) => l.id === id)?.name ?? id}`, description: `${id}.json`, icon: "symbol-snippet", separator: i === 0 ? "existing snippets" : undefined })),
      ...langs.filter((l) => !existing.includes(l.id)).map((l, i) => ({ id: l.id, label: l.name, description: `(${l.id})`, separator: i === 0 ? "new snippets" : undefined })),
    ],
  });
  if (!pick) return;
  openSnippetsEditor(pick.id);
}

export function openSnippetsEditor(language: string) {
  openEditorInput({ kind: "snippets", id: `snippets:${language}`, language, preview: false });
}

/** Snippets: Insert Snippet — this language's user and extension snippets, then Monaco inserts the body. */
export async function insertSnippet() {
  const ed = targetEditor();
  const model = ed?.getModel();
  if (!ed || !model) return;
  await loadUserSnippets();
  const lang = model.getLanguageId();
  const user = useUserSnippets.getState().parsed[lang] ?? [];
  const ext = extensionSnippetsFor(lang);
  const all = [
    ...user.map((s, i) => ({ s, source: "user", sep: i === 0 ? "user snippets" : undefined })),
    ...ext.map((s, i) => ({ s: { name: s.name, prefixes: s.prefixes, body: s.body, description: s.description }, source: "ext", sep: i === 0 ? "extension snippets" : undefined })),
  ];
  if (!all.length) {
    notify("info", `No snippets for ${languageLabel(lang)} yet. Use "Configure User Snippets" to add some.`, [{ label: "Configure User Snippets", run: () => openSnippetsEditor(lang) }]);
    return;
  }
  const pick = await showQuickPick({
    placeholder: "Select a snippet",
    matchOnDescription: true,
    items: all.map(({ s, source, sep }, i) => ({
      id: String(i),
      label: s.prefixes[0] ? `${s.prefixes[0]}` : s.name,
      description: s.prefixes[0] ? s.name : s.description,
      detail: snippetPreview(s.body).split("\n")[0].slice(0, 80),
      icon: source === "user" ? "symbol-snippet" : "extensions",
      separator: sep,
    })),
  });
  if (!pick) return;
  const chosen = all[Number(pick.id)];
  ed.focus();
  const controller = ed.getContribution("snippetController2") as { insert(template: string): void } | null;
  if (controller) controller.insert(chosen.s.body);
  else ed.trigger("snippets", "type", { text: snippetPreview(chosen.s.body) });
}

export const userSnippetsAllowed = () => !inExam();
