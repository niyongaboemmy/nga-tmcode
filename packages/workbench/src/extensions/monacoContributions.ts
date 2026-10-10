import { monaco, setupMonaco } from "../monaco/setup";
import { languageForPath } from "../monaco/documents";
import { ensureTextmateLanguage, refreshTextmate } from "../textmate/monacoTm";
import { log } from "../state/store";
import type { ExtensionHost } from "../platform/types";
import { parseLanguageConfiguration, parseSnippets, type Snippet } from "./manifest";
import { monacoSink, type InstalledExtension } from "./service";

/**
 * Extension languages, language configurations and snippets in Monaco.
 * Monaco cannot unregister a language, so a disabled extension's language ids
 * stay known until the next start (with no grammar, configuration or
 * snippets); everything else is undone immediately.
 */

const registered = new Set<string>();
let configs: monaco.IDisposable[] = [];
/** language id → snippets from enabled extensions. */
let snippets = new Map<string, Snippet[]>();
const snippetProviders = new Set<string>();
let seq = 0;

/** Snippets that enabled extensions give a language (Insert Snippet). */
export function extensionSnippetsFor(language: string): Snippet[] {
  return [...(snippets.get(language) ?? []), ...(snippets.get("*") ?? []).filter((s) => !s.scope || s.scope.includes(language))];
}

function registerSnippetProvider(language: string) {
  if (snippetProviders.has(language)) return;
  snippetProviders.add(language);
  monaco.languages.registerCompletionItemProvider(language, {
    provideCompletionItems(model, position) {
      const list = [...(snippets.get(language) ?? []), ...(snippets.get("*") ?? []).filter((s) => !s.scope || s.scope.includes(language))];
      if (!list.length) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: list.flatMap((s) =>
          s.prefixes.map((prefix) => ({
            label: { label: prefix, description: s.name },
            kind: monaco.languages.CompletionItemKind.Snippet,
            detail: s.description ?? s.name,
            documentation: { value: "```\n" + s.body + "\n```" },
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            sortText: `~${prefix}`,
          })),
        ),
      };
    },
  });
}

async function apply(exts: InstalledExtension[], host: ExtensionHost) {
  const mySeq = ++seq;
  setupMonaco();
  const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
  const newLanguages: string[] = [];
  for (const ext of exts) {
    for (const l of ext.manifest.languages) {
      const key = `${ext.id}|${l.id}`;
      if (registered.has(key)) continue;
      registered.add(key);
      // Monaco merges a second registration of a known id (extra extensions, aliases).
      monaco.languages.register({ id: l.id, extensions: l.extensions, aliases: l.aliases, filenames: l.filenames, filenamePatterns: l.filenamePatterns, firstLine: l.firstLine, mimetypes: l.mimetypes });
      if (!known.has(l.id)) newLanguages.push(l.id);
    }
    for (const g of ext.manifest.grammars) if (g.language) ensureTextmateLanguage(g.language);
  }

  // Configurations and snippets are rebuilt from scratch (cheap, and handles disable/uninstall).
  const nextConfigs: monaco.IDisposable[] = [];
  const nextSnippets = new Map<string, Snippet[]>();
  await Promise.all(
    exts.flatMap((ext) => [
      ...ext.manifest.languages
        .filter((l) => l.configuration)
        .map(async (l) => {
          try {
            const cfg = parseLanguageConfiguration(await host.readFile(ext.id, l.configuration!, "text"));
            if (mySeq === seq) nextConfigs.push(monaco.languages.setLanguageConfiguration(l.id, cfg as monaco.languages.LanguageConfiguration));
          } catch (e) {
            log("Extensions", `${ext.id}: language configuration for '${l.id}' failed (${String((e as Error)?.message ?? e)})`, "warn");
          }
        }),
      ...ext.manifest.snippets.map(async (s) => {
        try {
          const list = parseSnippets(await host.readFile(ext.id, s.path, "text"));
          nextSnippets.set(s.language, [...(nextSnippets.get(s.language) ?? []), ...list]);
        } catch (e) {
          log("Extensions", `${ext.id}: snippets ${s.path} failed (${String((e as Error)?.message ?? e)})`, "warn");
        }
      }),
    ]),
  );
  if (mySeq !== seq) {
    nextConfigs.forEach((d) => d.dispose());
    return;
  }
  configs.forEach((d) => d.dispose());
  configs = nextConfigs;
  snippets = nextSnippets;
  for (const lang of snippets.keys()) {
    if (lang === "*") monaco.languages.getLanguages().forEach((l) => registerSnippetProvider(l.id));
    else registerSnippetProvider(lang);
  }

  // Files opened before their language existed get it now.
  if (newLanguages.length) {
    for (const model of monaco.editor.getModels()) {
      if (model.uri.scheme !== "tmcode" || model.getLanguageId() !== "plaintext") continue;
      const lang = languageForPath(model.uri.path.replace(/^\//, ""));
      if (lang !== "plaintext") monaco.editor.setModelLanguage(model, lang);
    }
  }
  await refreshTextmate();
}

monacoSink.apply = (exts, host) => {
  void apply(exts, host).catch((e) => log("Extensions", `Applying extension contributions failed: ${String((e as Error)?.message ?? e)}`, "error"));
};
