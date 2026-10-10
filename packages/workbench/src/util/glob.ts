/**
 * Glob patterns as VS Code reads them in `files.exclude`, `search.exclude` and
 * the Search view's "files to include / exclude" boxes, plus `.gitignore`.
 * Paths are workspace-relative with "/" separators and no leading slash.
 */

function escapeRe(ch: string) {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Compiles one glob (`**`, `*`, `?`, `{a,b}`, `[abc]`) to an anchored RegExp source. */
export function globToRegExpSource(glob: string): string {
  let out = "";
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more folders; a trailing "**" matches everything below.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end < 0) {
        out += "\\[";
        i++;
      } else {
        let body = glob.slice(i + 1, end);
        if (body[0] === "!") body = `^${body.slice(1)}`;
        out += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end + 1;
      }
    } else if (c === "{") {
      braces++;
      out += "(?:";
      i++;
    } else if (c === "}" && braces > 0) {
      braces--;
      out += ")";
      i++;
    } else if (c === "," && braces > 0) {
      out += "|";
      i++;
    } else {
      out += escapeRe(c);
      i++;
    }
  }
  while (braces-- > 0) out += ")";
  return out;
}

/**
 * One user-typed pattern, VS Code style: "*.py" and "node_modules" match at any
 * depth, "/src" or "src/x" are relative to the root, and a folder pattern also
 * matches everything inside it.
 */
export function compileGlob(pattern: string): RegExp | null {
  let p = pattern.trim().replace(/\\/g, "/");
  if (!p) return null;
  if (p.startsWith("./")) p = p.slice(2);
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
  }
  p = p.replace(/\/+$/, "");
  if (!p) return null;
  if (!anchored && !p.startsWith("**/") && !p.includes("/")) p = `**/${p}`;
  try {
    return new RegExp(`^${globToRegExpSource(p)}(?:/.*)?$`);
  } catch {
    return null;
  }
}

/** "a, b , {c,d}" → ["a", "b", "{c,d}"] (commas inside braces stay). */
export function splitGlobList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export type PathMatcher = (path: string) => boolean;

/** A matcher for a comma-separated list; an empty list matches nothing. */
export function globMatcher(list: string | string[]): PathMatcher {
  const res = (Array.isArray(list) ? list : splitGlobList(list)).map(compileGlob).filter((r): r is RegExp => !!r);
  if (!res.length) return () => false;
  return (path) => res.some((r) => r.test(path));
}

// ───────────── .gitignore ─────────────

export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Parses a `.gitignore` found in folder `base` ("" for the root). */
export function parseGitignore(text: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    }
    line = line.replace(/^\\([#!])/, "$1");
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.replace(/\/+$/, "");
    }
    if (!line) continue;
    // A slash at the start or in the middle anchors the pattern to the .gitignore's folder.
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = anchored || line.startsWith("**/") ? line : `**/${line}`;
    const prefix = base ? `${base.split("/").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/")}/` : "";
    try {
      rules.push({ re: new RegExp(`^${prefix}${globToRegExpSource(body)}$`), negate, dirOnly });
    } catch {
      /* skip a broken line, as git does */
    }
  }
  return rules;
}

/** Last matching rule wins (git's order); `!pattern` re-includes. */
export function ignoredBy(rules: IgnoreRule[], path: string, isDir: boolean): boolean {
  let ignored = false;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(path)) ignored = !r.negate;
  }
  return ignored;
}
