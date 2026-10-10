/**
 * Other words people type for common commands in the palette ("reload" →
 * Developer: Reload Window), and "Similar commands" by edit distance when
 * nothing matches. A command's own `aliases` (commands/registry.ts) are
 * added to this table. Pure.
 */

export const COMMAND_ALIASES: Record<string, string[]> = {
  "workbench.action.reloadWindow": ["reload", "restart", "refresh window"],
  "workbench.action.closeAllEditors": ["close all", "close all tabs", "close tabs"],
  "workbench.action.closeActiveEditor": ["close tab", "close file"],
  "workbench.action.closeFolder": ["close project", "close workspace"],
  "editor.action.formatDocument": ["format", "prettier", "beautify", "indent code", "tidy"],
  "editor.action.rename": ["rename", "rename variable", "rename symbol", "refactor"],
  "workbench.action.terminal.toggleTerminal": ["terminal", "shell", "console", "command line", "cmd"],
  "workbench.action.terminal.new": ["new terminal", "terminal", "shell"],
  "workbench.action.openSettings": ["preferences", "options", "config", "configuration"],
  "workbench.action.selectTheme": ["dark mode", "light mode", "colour theme", "color scheme"],
  "workbench.action.selectIconTheme": ["icons", "file icons", "seti"],
  "workbench.action.files.save": ["save file", "write"],
  "workbench.action.files.saveAll": ["save everything"],
  "workbench.action.files.newUntitledFile": ["new file", "untitled", "scratch"],
  "workbench.action.files.openFolder": ["open project", "open directory"],
  "workbench.action.quickOpen": ["find file", "open file", "go to file"],
  "workbench.view.search": ["find in files", "grep", "search everywhere"],
  "workbench.action.gotoLine": ["line number", "jump to line"],
  "editor.action.commentLine": ["comment", "uncomment"],
  "workbench.action.toggleSidebarVisibility": ["sidebar", "hide sidebar", "show sidebar"],
  "workbench.action.togglePanel": ["panel", "bottom panel"],
  "workbench.action.zoomIn": ["bigger", "larger text", "font bigger"],
  "workbench.action.zoomOut": ["smaller", "smaller text"],
  "workbench.action.openGlobalKeybindings": ["shortcuts", "hotkeys", "keyboard"],
  "workbench.action.keybindingsReference": ["shortcuts", "hotkeys", "keyboard"],
  "workbench.action.debug.start": ["debug", "run with debugger"],
  "editor.action.toggleInlayHints": ["inlay hints", "parameter hints inline", "type hints"],
  "workbench.action.editor.changeLanguageMode": ["language", "syntax", "file type"],
};

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * Whether the query names one of `aliases`: the whole alias, a word-prefix of
 * it ("clos all" → "close all"), or the query starts with it.
 */
export function aliasMatch(query: string, aliases: readonly string[] | undefined): string | null {
  const q = norm(query);
  if (!q || !aliases?.length) return null;
  for (const a of aliases) {
    const n = norm(a);
    if (n === q || n.startsWith(q) || (q.startsWith(n) && q.length - n.length <= 3)) return a;
  }
  // Every query word is the start of an alias word, in order ("clo al" → "close all").
  const words = q.split(" ");
  for (const a of aliases) {
    const aw = norm(a).split(" ");
    let i = 0;
    for (const w of aw) if (i < words.length && w.startsWith(words[i])) i++;
    if (i === words.length) return a;
  }
  return null;
}

/** Aliases of a command: its own, then the table's. */
export function aliasesFor(id: string, own?: readonly string[]): string[] {
  return [...(own ?? []), ...(COMMAND_ALIASES[id] ?? [])];
}

/** Levenshtein distance, capped at `max + 1` (early exit). */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * How close a query is to a command: the best edit distance of the query
 * against the label's words (and word runs as long as the query) and the
 * aliases, relative to the query's length (0 = same, 1 = unrelated).
 */
export function closeness(query: string, label: string, aliases: readonly string[] = []): number {
  const q = norm(query);
  if (!q) return 1;
  const qWords = q.split(" ").length;
  const candidates = new Set<string>();
  for (const text of [label.replace(/^[^:]+:\s*/, ""), ...aliases]) {
    const words = norm(text).split(" ");
    for (let i = 0; i < words.length; i++) candidates.add(words.slice(i, i + qWords).join(" "));
    candidates.add(norm(text));
  }
  let best = 1;
  const max = Math.max(1, Math.floor(q.length / 2));
  for (const c of candidates) {
    const d = editDistance(q, c, max);
    if (d <= max) best = Math.min(best, d / Math.max(q.length, 1));
  }
  return best;
}

/** Up to `limit` entries closest to the query (typos: "relaod", "termnal", "fromat"). */
export function similarCommands<T extends { id: string; label: string; aliases?: readonly string[] }>(query: string, entries: T[], limit = 5): T[] {
  if (norm(query).length < 3) return [];
  return entries
    .map((e) => ({ e, c: closeness(query, e.label, aliasesFor(e.id, e.aliases)) }))
    .filter((x) => x.c < 0.5)
    .sort((a, b) => a.c - b.c || a.e.label.length - b.e.label.length)
    .slice(0, limit)
    .map((x) => x.e);
}
