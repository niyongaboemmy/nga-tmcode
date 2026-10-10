import type { FileSystem } from "../../platform/types";
import { globMatcher, ignoredBy, parseGitignore, splitGlobList, type IgnoreRule } from "../../util/glob";

export interface SearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface LineMatch {
  line: number;
  /** 1-based columns of the match, end exclusive. */
  start: number;
  end: number;
  preview: string;
  /** Match offsets inside `preview`. */
  previewStart: number;
  previewEnd: number;
  /** The matched text (replace previews). */
  text: string;
}

export interface FileMatches {
  path: string;
  matches: LineMatch[];
}

/** TMCode's own folder: never searched, whatever the settings. */
const ALWAYS_SKIP = new Set([".tmcode"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|class|jar|exe|dll|so|dylib|o|pyc|woff2?|ttf|mp3|mp4|wasm)$/i;
const MAX_FILES = 3000;
export const MAX_MATCHES = 2000;

/** Defaults of `files.exclude` and `search.exclude` (also in state/settings.ts). */
export const DEFAULT_FILES_EXCLUDE = "**/.git, **/.svn, **/.hg, **/.DS_Store, **/Thumbs.db";
export const DEFAULT_SEARCH_EXCLUDE = "**/node_modules, **/__pycache__, **/.venv, **/venv, **/dist, **/build, **/target";

export interface FileFilter {
  /** "files to include": empty = everything. */
  include?: string;
  /** "files to exclude", added to the settings' excludes. */
  exclude?: string;
  /** `files.exclude` + `search.exclude`; pass "" when "Use Exclude Settings and Ignore Files" is off. */
  settingsExclude?: string;
  /** Honour `.gitignore` files (`search.useIgnoreFiles`). */
  useIgnoreFiles?: boolean;
}

export function buildRegExp(opts: SearchOptions): RegExp | string {
  if (!opts.query) return "Type to search.";
  let source = opts.regex ? opts.query : opts.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) source = `\\b${source}\\b`;
  try {
    return new RegExp(source, opts.matchCase ? "g" : "gi");
  } catch (e) {
    return `Invalid regular expression: ${(e as Error).message}`;
  }
}

/** Lists every searchable file in the workspace, honouring includes, excludes and `.gitignore`. */
export async function listFiles(fs: FileSystem, filter: FileFilter = {}): Promise<string[]> {
  const out: string[] = [];
  const include = filter.include?.trim() ? globMatcher(filter.include) : null;
  const exclude = globMatcher([
    ...splitGlobList(filter.exclude ?? ""),
    ...splitGlobList(filter.settingsExclude ?? `${DEFAULT_FILES_EXCLUDE}, ${DEFAULT_SEARCH_EXCLUDE}`),
  ]);
  const walk = async (dir: string, rules: IgnoreRule[]) => {
    if (out.length >= MAX_FILES) return;
    const entries = await fs.readDir(dir).catch(() => []);
    if (filter.useIgnoreFiles !== false && entries.some((e) => e.name === ".gitignore" && e.kind === "file")) {
      const text = await fs.readFile(dir ? `${dir}/.gitignore` : ".gitignore").catch(() => "");
      rules = [...rules, ...parseGitignore(text, dir)];
    }
    for (const e of entries) {
      if (dir === "" && ALWAYS_SKIP.has(e.name)) continue;
      if (exclude(e.path) || ignoredBy(rules, e.path, e.kind === "dir")) continue;
      if (e.kind === "dir") await walk(e.path, rules);
      else if (!BINARY_EXT.test(e.name) && (!include || include(e.path))) out.push(e.path);
      if (out.length >= MAX_FILES) return;
    }
  };
  await walk("", []);
  return out.sort();
}

export function searchText(path: string, text: string, re: RegExp, budget: { left: number }): FileMatches | null {
  const matches: LineMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && budget.left > 0; i++) {
    const line = lines[i];
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) && budget.left > 0) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      // Trim long lines around the hit so the preview stays readable.
      const from = Math.max(0, m.index - 30);
      const lead = line.slice(from).replace(/^\s+/, "");
      const trimmed = line.slice(from).length - lead.length;
      matches.push({
        line: i + 1,
        start: m.index + 1,
        end: m.index + m[0].length + 1,
        preview: (from > 0 ? "…" : "") + lead.slice(0, 200),
        previewStart: m.index - from - trimmed + (from > 0 ? 1 : 0),
        previewEnd: m.index - from - trimmed + m[0].length + (from > 0 ? 1 : 0),
        text: m[0],
      });
      budget.left--;
    }
  }
  return matches.length ? { path, matches } : null;
}

/** "$1", "$&", "$<name>", "$$", and (regex mode) "\n" / "\t", as VS Code's Replace does. */
export function expandReplacement(replacement: string, m: RegExpExecArray, regex: boolean): string {
  if (!regex) return replacement;
  return replacement.replace(/\\([nt\\])|\$(\$|&|\d{1,2}|<([^>]+)>)/g, (all, esc: string | undefined, tok: string | undefined, name: string | undefined) => {
    if (esc) return esc === "n" ? "\n" : esc === "t" ? "\t" : "\\";
    if (tok === "$") return "$";
    if (tok === "&") return m[0];
    if (name !== undefined) return m.groups?.[name] ?? "";
    const n = Number(tok);
    return n > 0 && n < m.length ? (m[n] ?? "") : all;
  });
}

/** Key of one match for `planReplace({ only })`. */
export const matchKey = (m: { line: number; start: number }) => `${m.line}:${m.start}`;

export interface ReplacePlan {
  text: string;
  count: number;
}

/**
 * Replaces the matches of `re` in `text`, line by line (the same matches the
 * results list shows). `only` limits it to some matches ("line:start" keys).
 */
export function planReplace(text: string, re: RegExp, replacement: string, opts: { regex: boolean; only?: Set<string> }): ReplacePlan {
  const parts = text.split(/(\r?\n)/);
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    const lineNo = i / 2 + 1;
    re.lastIndex = 0;
    let out = "";
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      if (opts.only && !opts.only.has(`${lineNo}:${m.index + 1}`)) continue;
      out += line.slice(last, m.index) + expandReplacement(replacement, m, opts.regex);
      last = m.index + m[0].length;
      count++;
    }
    if (count && last > 0) parts[i] = out + line.slice(last);
  }
  return { text: parts.join(""), count };
}
