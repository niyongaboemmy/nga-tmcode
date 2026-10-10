import { parseJsonc } from "../textmate/jsonc";

/**
 * User snippets in VS Code's format: one JSON-with-comments file per
 * language, `name → { prefix, body, description }`. A snippet without a
 * prefix is offered by Insert Snippet only. Bodies use Monaco's (= VS Code's)
 * snippet syntax: $1, ${2:default}, ${3|a,b|}, $0, $TM_FILENAME…
 * Pure (unit-tested).
 */

export interface UserSnippet {
  name: string;
  /** Empty: Insert Snippet only, never in completions. */
  prefixes: string[];
  body: string;
  description?: string;
}

export interface SnippetParse {
  snippets: UserSnippet[];
  /** Set when the text isn't valid JSON (the file keeps its last good snippets). */
  error: string | null;
}

export function parseUserSnippets(text: string): SnippetParse {
  if (!text.trim()) return { snippets: [], error: null };
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (e) {
    return { snippets: [], error: String((e as Error)?.message ?? e) };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { snippets: [], error: "A snippets file is one JSON object: snippet name → { prefix, body, description }." };
  const snippets: UserSnippet[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const s = v as Record<string, unknown>;
    const body = typeof s.body === "string" ? s.body : Array.isArray(s.body) ? s.body.filter((x): x is string => typeof x === "string").join("\n") : null;
    if (body === null) continue;
    const prefixes = typeof s.prefix === "string" ? [s.prefix] : Array.isArray(s.prefix) ? s.prefix.filter((x): x is string => typeof x === "string" && !!x) : [];
    const description = typeof s.description === "string" ? s.description : Array.isArray(s.description) ? s.description.join("\n") : undefined;
    snippets.push({ name, prefixes: prefixes.filter(Boolean), body, ...(description ? { description } : {}) });
  }
  return { snippets, error: null };
}

/** The text a new snippets file starts with (VS Code's template, shortened). */
export function snippetTemplate(languageName: string) {
  return `{
\t// Snippets for ${languageName}. Each one has a name, a prefix (what you type),
\t// a body and a description. In the body, $1, $2 are tab stops, $0 is where the
\t// cursor ends, and \${1:label} is a tab stop with a default text. Example:
\t// "Print to console": {
\t// \t"prefix": "log",
\t// \t"body": [
\t// \t\t"console.log('$1');",
\t// \t\t"$2"
\t// \t],
\t// \t"description": "Log output to console"
\t// }
}
`;
}

/** Plain text of a snippet body, for previews: placeholders show their default text. */
export function snippetPreview(body: string): string {
  // An escaped \$ is a literal dollar: keep it out of the placeholder rules.
  let out = body.replace(/\\\$/g, "\u0000");
  // ${1:text} / ${1|a,b|} / ${TM_FILENAME:x}, repeated for nesting.
  for (let i = 0; i < 5; i++) {
    const next = out
      .replace(/\$\{\d+:([^{}]*)\}/g, "$1")
      .replace(/\$\{\d+\|([^,|}]*)[^}]*\|\}/g, "$1")
      .replace(/\$\{[A-Z_]+(?::([^{}]*))?\}/g, (_m, d: string | undefined) => d ?? "");
    if (next === out) break;
    out = next;
  }
  return out.replace(/\$\{\d+\}/g, "").replace(/\$\d+/g, "").replace(/\$[A-Z_]+/g, "").replace(/\u0000/g, "$");
}
