/**
 * What the terminal and Run output make clickable (pure, unit-tested):
 * local dev-server URLs (offered in the browser preview) and file references
 * like `src/app.ts:12:5` (opened in the editor).
 */

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'`<>)\]]*)?/gi;

// strip ANSI colour codes before matching
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Dev-server URLs printed by Vite, Next, Angular, Django, Flask, Spring… (0.0.0.0 shown as localhost). */
export function findLocalUrls(text: string): string[] {
  const clean = text.replace(ANSI, "");
  const out = new Set<string>();
  for (const m of clean.matchAll(LOCAL_URL)) {
    out.add(m[0].replace("0.0.0.0", "localhost").replace(/[.,;:]+$/, ""));
  }
  return [...out];
}

export function portOf(url: string): number | null {
  try {
    const u = new URL(url);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

const CODE_EXT = "py|js|mjs|cjs|jsx|ts|tsx|java|c|h|cpp|cc|hpp|cs|go|rs|rb|php|html|htm|css|scss|json|md|yml|yaml|vue|svelte|kt|swift|sql|sh|txt";
const FILE_REF = new RegExp(String.raw`(?:^|[\s("'\[])((?:\.{1,2}\/|\/)?[\w@.\-]+(?:\/[\w@.\-]+)*\.(?:${CODE_EXT}))(?![\w])(?:[:(](\d+)(?:[:,](\d+))?\)?)?`, "g");

export interface FileRef {
  /** Index of the match in the line and its length (for xterm link ranges). */
  start: number;
  length: number;
  path: string;
  line?: number;
  column?: number;
}

/** File references in one line of output: `src/app.ts:12:5`, `main.py", line 4`, `(utils.ts:3)`. */
export function findFileRefs(line: string): FileRef[] {
  const out: FileRef[] = [];
  const py = /File "([^"]+)", line (\d+)/.exec(line);
  if (py) out.push({ start: py.index + 6, length: py[1].length, path: py[1], line: Number(py[2]) });
  for (const m of line.matchAll(FILE_REF)) {
    const path = m[1];
    if (out.some((r) => r.path === path)) continue;
    const start = (m.index ?? 0) + m[0].indexOf(path);
    const full = m[2] ? m[0].slice(m[0].indexOf(path)).replace(/\)$/, "") : path;
    out.push({ start, length: full.length, path, line: m[2] ? Number(m[2]) : undefined, column: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

/** Workspace-relative path for a reference, or null when it points outside the workspace. */
export function toWorkspaceRef(path: string, root: string): string | null {
  const p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  if (p.startsWith("/")) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
