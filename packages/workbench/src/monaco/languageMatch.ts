/**
 * Which language a file gets from its name, as in VS Code: an exact file name
 * first (`Makefile`, `.env`; only a path pattern such as `.ssh/config` is more
 * specific), then a file name pattern (`.env.*`,
 * `Dockerfile.*`, `tsconfig.*.json`), then the longest matching extension
 * (".blade.php" before ".php"). On a tie the later registration wins (an
 * extension's language, or TMCode's own over Monaco's). Case-insensitive. Pure.
 */

export interface LanguageNamePatterns {
  id: string;
  extensions?: string[];
  filenames?: string[];
  filenamePatterns?: string[];
}

const globs = new Map<string, RegExp>();
/** A VS Code file glob (`*`, `?`, `**`, `{a,b}`) as a RegExp over the lower-cased name or path. */
function globRegExp(pattern: string): RegExp {
  let re = globs.get(pattern);
  if (!re) {
    let src = "";
    const p = pattern.toLowerCase();
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === "*" && p[i + 1] === "*") {
        src += ".*";
        i++;
        if (p[i + 1] === "/") i++;
      } else if (c === "*") src += "[^/]*";
      else if (c === "?") src += "[^/]";
      else if (c === "{") src += "(?:";
      else if (c === "}") src += ")";
      else if (c === ",") src += "|";
      else src += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
    re = new RegExp(`^${src}$`);
    globs.set(pattern, re);
  }
  return re;
}

/** True when `pattern` matches the file: patterns without "/" match the name, the others the end of the path. */
export function matchesFilenamePattern(pattern: string, path: string): boolean {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  if (!pattern.includes("/")) return globRegExp(pattern).test(lower.slice(lower.lastIndexOf("/") + 1));
  const re = globRegExp(pattern.replace(/^\*\*\//, ""));
  // ".vscode/*.json" matches "x/.vscode/settings.json": try every suffix that starts after a "/".
  for (let i = 0; i <= lower.length; i = lower.indexOf("/", i) + 1 || lower.length + 1) {
    if (re.test(lower.slice(i))) return true;
  }
  return false;
}

/** The language id for `path` among `languages` (in registration order), or undefined. */
export function matchLanguage(path: string, languages: readonly LanguageNamePatterns[]): string | undefined {
  const lower = path.toLowerCase().replace(/\\/g, "/");
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  let byName: string | undefined;
  let byPathPattern: { id: string; len: number } | undefined;
  let byPattern: { id: string; len: number } | undefined;
  let byExt: { id: string; len: number } | undefined;
  for (const l of languages) {
    if (l.filenames?.some((f) => f.toLowerCase() === name)) byName = l.id;
    for (const p of l.filenamePatterns ?? []) {
      const best = p.includes("/") ? byPathPattern : byPattern;
      if ((best && p.length < best.len) || !matchesFilenamePattern(p, lower)) continue;
      if (p.includes("/")) byPathPattern = { id: l.id, len: p.length };
      else byPattern = { id: l.id, len: p.length };
    }
    for (const e of l.extensions ?? []) {
      const el = e.toLowerCase();
      if (name.endsWith(el) && (!byExt || el.length >= byExt.len)) byExt = { id: l.id, len: el.length };
    }
  }
  return byPathPattern?.id ?? byName ?? byPattern?.id ?? byExt?.id;
}
