/**
 * VS Code glob patterns (`**`, `*`, `?`, `{a,b}`, `[a-z]`, `[!x]`) as regular
 * expressions over "/"-separated paths. Used by findFiles, file watchers and
 * document selectors with a `pattern`.
 */

const cache = new Map<string, RegExp>();

function escapeRe(c: string) {
  return c.replace(/[.+^$()|\\/]/g, "\\$&");
}

function translate(glob: string): string {
  let re = "";
  let i = 0;
  let inGroup = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**" spans path segments; "**/" also matches nothing.
        i += 2;
        if (glob[i] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      inGroup++;
      re += "(?:";
    } else if (c === "}" && inGroup) {
      inGroup--;
      re += ")";
    } else if (c === "," && inGroup) {
      re += "|";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close < 0) {
        re += "\\[";
      } else {
        let body = glob.slice(i + 1, close);
        if (body.startsWith("!") || body.startsWith("^")) body = "^" + body.slice(1);
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else {
      re += escapeRe(c);
    }
    i++;
  }
  return re;
}

export function globToRegExp(glob: string): RegExp {
  let hit = cache.get(glob);
  if (!hit) {
    const g = glob.replace(/\\/g, "/").replace(/^\.\//, "");
    hit = new RegExp(`^${translate(g)}$`);
    if (cache.size > 500) cache.clear();
    cache.set(glob, hit);
  }
  return hit;
}

/** Does a "/"-separated relative path match the glob? */
export function matchGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path.replace(/\\/g, "/").replace(/^\/+/, ""));
}

/** files.exclude-style objects ({"**\/node_modules": true}) → the patterns that are on. */
export function enabledPatterns(obj: unknown): string[] {
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj as Record<string, unknown>)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}
