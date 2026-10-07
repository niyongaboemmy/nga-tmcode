/**
 * VS Code ships one built-in extension per language whose language
 * configuration (comments, brackets) other extensions read through
 * `vscode.extensions.all`: Better Comments, Todo Tree and comment-toggling
 * helpers find each language's comment syntax that way. TMCode has no
 * built-in extensions, so the host offers this one, "tmcode.language-basics",
 * listed in `extensions.all` (never activated: it has no code).
 */

type Comments = { lineComment?: string; blockComment?: [string, string] };

const C: Comments = { lineComment: "//", blockComment: ["/*", "*/"] };
const HASH: Comments = { lineComment: "#" };
const XML: Comments = { blockComment: ["<!--", "-->"] };
const SQL: Comments = { lineComment: "--", blockComment: ["/*", "*/"] };

/** Language id → comment syntax, as in VS Code's built-in language configurations. */
export const LANGUAGE_COMMENTS: Record<string, Comments> = {
  javascript: C,
  javascriptreact: C,
  typescript: C,
  typescriptreact: C,
  json: C,
  jsonc: C,
  java: C,
  c: C,
  cpp: C,
  csharp: C,
  go: C,
  rust: C,
  kotlin: C,
  swift: C,
  dart: C,
  scala: C,
  groovy: C,
  php: { lineComment: "//", blockComment: ["/*", "*/"] },
  css: { blockComment: ["/*", "*/"] },
  scss: C,
  less: C,
  python: { lineComment: "#", blockComment: ['"""', '"""'] },
  ruby: { lineComment: "#", blockComment: ["=begin", "=end"] },
  shellscript: HASH,
  powershell: { lineComment: "#", blockComment: ["<#", "#>"] },
  yaml: HASH,
  dockerfile: HASH,
  makefile: HASH,
  r: HASH,
  perl: HASH,
  ini: { lineComment: ";" },
  toml: HASH,
  sql: SQL,
  lua: { lineComment: "--", blockComment: ["--[[", "]]"] },
  haskell: { lineComment: "--", blockComment: ["{-", "-}"] },
  elixir: HASH,
  clojure: { lineComment: ";;" },
  vb: { lineComment: "'" },
  fsharp: { lineComment: "//", blockComment: ["(*", "*)"] },
  html: XML,
  xml: XML,
  markdown: XML,
  vue: XML,
  svelte: XML,
  handlebars: { blockComment: ["{{!--", "--}}"] },
  latex: { lineComment: "%" },
  bat: { lineComment: "@REM" },
};

const BRACKETS = [
  ["{", "}"],
  ["[", "]"],
  ["(", ")"],
];

/** The extension's files: package.json and one language configuration per language. */
export function languageBasicsFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const languages = Object.entries(LANGUAGE_COMMENTS).map(([id, comments]) => {
    files[`languages/${id}.language-configuration.json`] = JSON.stringify({ comments, brackets: BRACKETS }, null, 2);
    return { id, configuration: `./languages/${id}.language-configuration.json` };
  });
  files["package.json"] = JSON.stringify(languageBasicsManifest(languages), null, 2);
  return files;
}

export function languageBasicsManifest(languages = Object.keys(LANGUAGE_COMMENTS).map((id) => ({ id, configuration: `./languages/${id}.language-configuration.json` }))) {
  return {
    name: "language-basics",
    publisher: "tmcode",
    displayName: "Language Basics (built in)",
    version: "1.0.0",
    engines: { vscode: "*" },
    contributes: { languages },
  };
}
