import type { FileSystem } from "../../platform/types";

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
}

export interface FileMatches {
  path: string;
  matches: LineMatch[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", "target", ".tmcode"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|class|jar|exe|dll|so|dylib|o|pyc|woff2?|ttf|mp3|mp4|wasm)$/i;
const MAX_FILES = 3000;
export const MAX_MATCHES = 2000;

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

/** Lists every searchable file in the workspace. */
export async function listFiles(fs: FileSystem): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    if (out.length >= MAX_FILES) return;
    const entries = await fs.readDir(dir).catch(() => []);
    for (const e of entries) {
      if (e.kind === "dir") {
        if (!SKIP_DIRS.has(e.name)) await walk(e.path);
      } else if (!BINARY_EXT.test(e.name)) out.push(e.path);
      if (out.length >= MAX_FILES) return;
    }
  };
  await walk("");
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
      });
      budget.left--;
    }
  }
  return matches.length ? { path, matches } : null;
}
