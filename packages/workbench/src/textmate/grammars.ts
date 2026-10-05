/**
 * Which TextMate grammar colours which language. Built-in grammars come from
 * `tm-grammars` (MIT, the grammars VS Code and Shiki ship) and are bundled as
 * separate chunks, loaded the first time a language is tokenized. Extensions
 * add or override grammars at runtime (extensions/contributions.ts).
 */

/** A grammar's JSON (or plist parsed to an object). */
export type RawGrammarSource = { kind: "object"; value: unknown } | { kind: "text"; text: string; path: string };

export interface GrammarDef {
  scopeName: string;
  load(): Promise<RawGrammarSource>;
  /** Scopes this grammar is injected into (`injectTo` in a VS Code grammar contribution). */
  injectTo?: string[];
  /** Scope → language id of embedded code (for completeness; colours come from the grammar). */
  embeddedLanguages?: Record<string, string>;
  /** Scope → "string" | "comment" | "other" overrides for Monaco's token kinds. */
  tokenTypes?: Record<string, string>;
  /** Extension that contributed it (undefined for built-ins). */
  extension?: string;
}

/** `?raw` keeps tsc from type-checking megabytes of JSON; JSON.parse is also faster than a JS object literal. */
const obj = (p: Promise<{ default: string }>): Promise<RawGrammarSource> => p.then((m) => ({ kind: "object", value: JSON.parse(m.default) }));

/** Built-in grammars: scope → lazy chunk. */
const BUILTIN: GrammarDef[] = [
  { scopeName: "source.python", load: () => obj(import("tm-grammars/grammars/python.json?raw")) },
  { scopeName: "source.regexp.python", load: () => obj(import("tm-grammars/grammars/regexp.json?raw")) },
  { scopeName: "source.js", load: () => obj(import("tm-grammars/grammars/javascript.json?raw")) },
  { scopeName: "source.js.jsx", load: () => obj(import("tm-grammars/grammars/jsx.json?raw")) },
  { scopeName: "source.ts", load: () => obj(import("tm-grammars/grammars/typescript.json?raw")) },
  { scopeName: "source.tsx", load: () => obj(import("tm-grammars/grammars/tsx.json?raw")) },
  { scopeName: "text.html.basic", load: () => obj(import("tm-grammars/grammars/html.json?raw")) },
  { scopeName: "text.html.derivative", load: () => obj(import("tm-grammars/grammars/html-derivative.json?raw")) },
  { scopeName: "source.css", load: () => obj(import("tm-grammars/grammars/css.json?raw")) },
  { scopeName: "source.css.scss", load: () => obj(import("tm-grammars/grammars/scss.json?raw")) },
  { scopeName: "source.css.less", load: () => obj(import("tm-grammars/grammars/less.json?raw")) },
  { scopeName: "source.json", load: () => obj(import("tm-grammars/grammars/json.json?raw")) },
  { scopeName: "source.json.comments", load: () => obj(import("tm-grammars/grammars/jsonc.json?raw")) },
  { scopeName: "source.json5", load: () => obj(import("tm-grammars/grammars/json5.json?raw")) },
  { scopeName: "source.json.lines", load: () => obj(import("tm-grammars/grammars/jsonl.json?raw")) },
  { scopeName: "text.html.markdown", load: () => obj(import("tm-grammars/grammars/markdown.json?raw")) },
  { scopeName: "source.c", load: () => obj(import("tm-grammars/grammars/c.json?raw")) },
  { scopeName: "source.cpp", load: () => obj(import("tm-grammars/grammars/cpp.json?raw")) },
  { scopeName: "source.cpp.embedded.macro", load: () => obj(import("tm-grammars/grammars/cpp-macro.json?raw")) },
  { scopeName: "source.glsl", load: () => obj(import("tm-grammars/grammars/glsl.json?raw")) },
  { scopeName: "source.java", load: () => obj(import("tm-grammars/grammars/java.json?raw")) },
  { scopeName: "source.php", load: () => obj(import("tm-grammars/grammars/php.json?raw")) },
  { scopeName: "source.sql", load: () => obj(import("tm-grammars/grammars/sql.json?raw")) },
  { scopeName: "source.shell", load: () => obj(import("tm-grammars/grammars/shellscript.json?raw")) },
  { scopeName: "text.shell-session", load: () => obj(import("tm-grammars/grammars/shellsession.json?raw")) },
  { scopeName: "source.yaml", load: () => obj(import("tm-grammars/grammars/yaml.json?raw")) },
  { scopeName: "text.xml", load: () => obj(import("tm-grammars/grammars/xml.json?raw")) },
  { scopeName: "text.xml.xsl", load: () => obj(import("tm-grammars/grammars/xsl.json?raw")) },
  { scopeName: "source.ini", load: () => obj(import("tm-grammars/grammars/ini.json?raw")) },
  { scopeName: "source.dockerfile", load: () => obj(import("tm-grammars/grammars/docker.json?raw")) },
  { scopeName: "source.diff", load: () => obj(import("tm-grammars/grammars/diff.json?raw")) },
  { scopeName: "source.go", load: () => obj(import("tm-grammars/grammars/go.json?raw")) },
  { scopeName: "source.rust", load: () => obj(import("tm-grammars/grammars/rust.json?raw")) },
  { scopeName: "source.kotlin", load: () => obj(import("tm-grammars/grammars/kotlin.json?raw")) },
  { scopeName: "source.cs", load: () => obj(import("tm-grammars/grammars/csharp.json?raw")) },
  { scopeName: "source.ruby", load: () => obj(import("tm-grammars/grammars/ruby.json?raw")) },
  { scopeName: "source.lua", load: () => obj(import("tm-grammars/grammars/lua.json?raw")) },
  { scopeName: "source.r", load: () => obj(import("tm-grammars/grammars/r.json?raw")) },
  { scopeName: "source.toml", load: () => obj(import("tm-grammars/grammars/toml.json?raw")) },
  { scopeName: "source.makefile", load: () => obj(import("tm-grammars/grammars/make.json?raw")) },
  { scopeName: "source.batchfile", load: () => obj(import("tm-grammars/grammars/bat.json?raw")) },
  { scopeName: "source.powershell", load: () => obj(import("tm-grammars/grammars/powershell.json?raw")) },
  { scopeName: "source.swift", load: () => obj(import("tm-grammars/grammars/swift.json?raw")) },
  { scopeName: "source.dart", load: () => obj(import("tm-grammars/grammars/dart.json?raw")) },
  { scopeName: "source.graphql", load: () => obj(import("tm-grammars/grammars/graphql.json?raw")) },
  { scopeName: "text.log", load: () => obj(import("tm-grammars/grammars/log.json?raw")) },
  { scopeName: "text.csv", load: () => obj(import("tm-grammars/grammars/csv.json?raw")) },
  { scopeName: "text.git-commit", load: () => obj(import("tm-grammars/grammars/git-commit.json?raw")) },
  { scopeName: "text.git-rebase", load: () => obj(import("tm-grammars/grammars/git-rebase.json?raw")) },
];

/**
 * Monaco language id → grammar scope. `typescript` uses the TSX grammar
 * because Monaco has one language id for .ts and .tsx (its TypeScript worker
 * serves only "typescript"); JSX in .tsx files then colours like VS Code.
 */
const BUILTIN_LANGUAGES: Record<string, string> = {
  python: "source.python",
  javascript: "source.js",
  typescript: "source.tsx",
  html: "text.html.basic",
  css: "source.css",
  scss: "source.css.scss",
  less: "source.css.less",
  json: "source.json",
  markdown: "text.html.markdown",
  c: "source.c",
  cpp: "source.cpp",
  java: "source.java",
  php: "source.php",
  sql: "source.sql",
  mysql: "source.sql",
  pgsql: "source.sql",
  shell: "source.shell",
  yaml: "source.yaml",
  xml: "text.xml",
  ini: "source.ini",
  dockerfile: "source.dockerfile",
  go: "source.go",
  rust: "source.rust",
  kotlin: "source.kotlin",
  csharp: "source.cs",
  ruby: "source.ruby",
  lua: "source.lua",
  r: "source.r",
  bat: "source.batchfile",
  powershell: "source.powershell",
  swift: "source.swift",
  dart: "source.dart",
  graphql: "source.graphql",
  // Languages Monaco doesn't know; registered by monacoTm (VS Code's ids and file patterns).
  toml: "source.toml",
  diff: "source.diff",
  log: "text.log",
  makefile: "source.makefile",
  csv: "text.csv",
  "git-commit": "text.git-commit",
  jsonc: "source.json.comments",
};

/** Languages TMCode adds to Monaco so their grammars have something to colour. */
export const EXTRA_LANGUAGES: { id: string; extensions?: string[]; filenames?: string[]; aliases: string[] }[] = [
  { id: "toml", extensions: [".toml"], aliases: ["TOML", "toml"] },
  { id: "diff", extensions: [".diff", ".patch", ".rej"], aliases: ["Diff", "diff"] },
  { id: "log", extensions: [".log"], aliases: ["Log", "log"] },
  { id: "makefile", extensions: [".mk", ".mak"], filenames: ["Makefile", "makefile", "GNUmakefile"], aliases: ["Makefile", "makefile"] },
  { id: "csv", extensions: [".csv"], aliases: ["CSV", "csv"] },
  { id: "git-commit", filenames: ["COMMIT_EDITMSG", "MERGE_MSG"], aliases: ["Git Commit Message", "git-commit"] },
  { id: "jsonc", extensions: [".jsonc"], aliases: ["JSON with Comments", "jsonc"] },
];

const grammars = new Map<string, GrammarDef>(BUILTIN.map((g) => [g.scopeName, g]));
const languages = new Map<string, string>(Object.entries(BUILTIN_LANGUAGES));
let version = 0;

export function grammarFor(scopeName: string): GrammarDef | undefined {
  return grammars.get(scopeName);
}

export function scopeForLanguage(languageId: string): string | undefined {
  return languages.get(languageId);
}

export function tmLanguages(): string[] {
  return [...languages.keys()];
}

/** Scopes whose grammars inject into `scopeName`. */
export function injectionsFor(scopeName: string): string[] {
  const out: string[] = [];
  for (const g of grammars.values()) if (g.injectTo?.includes(scopeName)) out.push(g.scopeName);
  return out;
}

/** Bumps on every change, so the tokenizer knows to start a fresh registry. */
export function grammarsVersion() {
  return version;
}

/**
 * Replaces all extension-contributed grammars (called whenever the enabled
 * extensions change). Built-ins come back when an override is removed.
 */
export function setExtensionGrammars(defs: GrammarDef[], languageScopes: Record<string, string>) {
  for (const [scope, g] of [...grammars]) if (g.extension) grammars.delete(scope);
  for (const g of BUILTIN) if (!grammars.has(g.scopeName)) grammars.set(g.scopeName, g);
  for (const g of defs) grammars.set(g.scopeName, g);
  languages.clear();
  for (const [l, s] of Object.entries(BUILTIN_LANGUAGES)) languages.set(l, s);
  for (const [l, s] of Object.entries(languageScopes)) languages.set(l, s);
  version++;
}
