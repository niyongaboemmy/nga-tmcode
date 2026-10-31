import { getDocument, uriFor } from "../../monaco/documents";
import { monaco } from "../../monaco/setup";
import { openFile, useWorkbench } from "../../state/store";
import { nextUntitledPath } from "../../util/untitled";
import type { FileMatches, SearchOptions } from "./search";

/**
 * VS Code's Search Editor: the Search view's results as a document you can
 * keep, scroll and copy from. F12 / ⌘-click on a result line opens that
 * place. The text follows VS Code's .code-search layout.
 */

export const SEARCH_RESULT_LANGUAGE = "search-result";

export interface SearchEditorText {
  text: string;
  /** Result line (1-based) → where it points. */
  targets: Map<number, { path: string; line: number; column: number; length: number }>;
}

export function formatSearchResults(opts: SearchOptions, filters: { include: string; exclude: string }, results: FileMatches[]): SearchEditorText {
  const flags = [opts.regex && "RegExp", opts.matchCase && "CaseSensitive", opts.wholeWord && "WordMatch"].filter(Boolean).join(" ");
  const lines = [`# Query: ${opts.query}`];
  if (flags) lines.push(`# Flags: ${flags}`);
  if (filters.include) lines.push(`# Including: ${filters.include}`);
  if (filters.exclude) lines.push(`# Excluding: ${filters.exclude}`);
  const total = results.reduce((n, f) => n + f.matches.length, 0);
  lines.push("", `${total} result${total === 1 ? "" : "s"} - ${results.length} file${results.length === 1 ? "" : "s"}`);
  const targets = new Map<number, { path: string; line: number; column: number; length: number }>();
  for (const f of results) {
    lines.push("", `${f.path}:`);
    for (const m of f.matches) {
      lines.push(`  ${String(m.line).padStart(4)}: ${m.preview}`);
      targets.set(lines.length, { path: f.path, line: m.line, column: m.start, length: m.end - m.start });
    }
  }
  return { text: `${lines.join("\n")}\n`, targets };
}

const targetsByModel = new WeakMap<monaco.editor.ITextModel, SearchEditorText["targets"]>();
let registered = false;

function register() {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: SEARCH_RESULT_LANGUAGE, aliases: ["Search Result"] });
  monaco.languages.setMonarchTokensProvider(SEARCH_RESULT_LANGUAGE, {
    tokenizer: {
      root: [
        [/^#.*$/, "comment"],
        [/^\d+ results? - .*$/, "comment"],
        [/^\S.*:$/, "type"],
        [/^(\s+\d+)(:)/, ["number", "delimiter"]],
      ],
    },
  });
  monaco.languages.registerDefinitionProvider(SEARCH_RESULT_LANGUAGE, {
    provideDefinition(model, position) {
      const t = targetsByModel.get(model)?.get(position.lineNumber);
      if (!t) return null;
      return { uri: uriFor(t.path), range: new monaco.Range(t.line, t.column, t.line, t.column + t.length) };
    },
  });
}

/** Search: Open in Editor — the results in a new editor. */
export async function openSearchEditor(opts: SearchOptions, filters: { include: string; exclude: string }, results: FileMatches[]) {
  register();
  const s = useWorkbench.getState();
  const open = s.groups.flatMap((g) => g.editors).flatMap((e) => (e.kind === "file" ? [e.path] : []));
  const path = nextUntitledPath(open);
  openFile(path, { pinned: true });
  const formatted = formatSearchResults(opts, filters, results);
  // The untitled document exists once its editor opened it.
  for (let i = 0; i < 50 && !getDocument(path); i++) await new Promise((r) => setTimeout(r, 20));
  const model = getDocument(path);
  if (!model) return;
  monaco.editor.setModelLanguage(model, SEARCH_RESULT_LANGUAGE);
  model.setValue(formatted.text);
  targetsByModel.set(model, formatted.targets);
}
