/**
 * The TypeScript/JavaScript project of the open folder (review V3): which
 * workspace files the TypeScript service should know besides the open ones,
 * and the compiler options from the project's tsconfig.json / jsconfig.json.
 * Pure logic (no Monaco, no platform), so it is unit tested; the loader is
 * monaco/workspaceSources.ts.
 */

/** Workspace files given to the TypeScript service, at most. */
export const MAX_SOURCE_FILES = 2000;
/** Total size of those files, at most (20 MB). */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
/** One file bigger than this is generated or minified: skipped. */
export const MAX_SOURCE_FILE_BYTES = 1024 * 1024;

/** The URI prefix of workspace files in Monaco (monaco/documents.ts uriFor). */
export const ROOT_URI = "tmcode:/";

const TS_EXT = /\.(ts|tsx|mts|cts)$/i;
const JS_EXT = /\.(js|jsx|mjs|cjs)$/i;
const MIN_JS = /[.-]min\.js$/i;

/** Folders never read: dependencies (their types come from acquireTypes), VCS and caches. */
const ALWAYS_SKIP = new Set(["node_modules", ".git", ".tmcode", "bower_components", "jspm_packages", "__pycache__", ".venv", "venv"]);
/** Also skipped when there is no tsconfig/jsconfig: build output. */
const OUTPUT_DIRS = new Set(["dist", "build", "out", "coverage", "target", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache"]);

// ───────────────────────── JSON with comments ─────────────────────────

/** Parses tsconfig-style JSON: comments and trailing commas allowed. Returns null when it is not valid. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas: `,` followed by only whitespace and a closing bracket.
  out = out.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(out.replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

// ───────────────────────── paths ─────────────────────────

export function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** Joins workspace-relative paths, resolving `.` and `..` (never above the folder). */
export function joinPath(dir: string, rel: string) {
  const parts = rel.startsWith("/") ? [] : dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

const toUri = (path: string) => `${ROOT_URI}${path}`;

// ───────────────────────── config files ─────────────────────────

export interface RawConfig {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
  files?: string[];
  extends?: string | string[];
  references?: { path: string }[];
}

export interface ProjectConfig {
  /** "tsconfig.json", "jsconfig.json", or null when the folder has neither. */
  configPath: string | null;
  kind: "tsconfig" | "jsconfig" | null;
  /** Folder of the config; include/exclude/paths are relative to it. */
  dir: string;
  /** compilerOptions after `extends`, with paths still as written (relative to `optionsDirs`). */
  compilerOptions: Record<string, unknown>;
  /** Folder each path-valued option came from (`extends` makes them relative to the base config). */
  optionsDirs: Record<string, string>;
  include: string[] | null;
  exclude: string[] | null;
  files: string[] | null;
  /** Problems reading the config, for the Output channel. */
  warnings: string[];
}

type Reader = (path: string) => Promise<string | null>;

const PATH_OPTIONS = ["baseUrl", "rootDir", "outDir", "declarationDir", "typeRoots", "rootDirs", "paths"];

async function readConfig(read: Reader, path: string, warnings: string[], depth = 0): Promise<{ raw: RawConfig; dirs: Record<string, string> } | null> {
  const text = await read(path);
  if (text === null) return null;
  const raw = parseJsonc(text) as RawConfig | null;
  if (!raw || typeof raw !== "object") {
    warnings.push(`${path} is not valid JSON; its settings were ignored.`);
    return null;
  }
  const dir = dirOf(path);
  const dirs: Record<string, string> = {};
  let options: Record<string, unknown> = {};
  let include = raw.include;
  let exclude = raw.exclude;
  let files = raw.files;
  const bases = raw.extends === undefined ? [] : Array.isArray(raw.extends) ? raw.extends : [raw.extends];
  for (const ext of bases) {
    if (depth > 5 || typeof ext !== "string") break;
    const target = await resolveExtends(read, dir, ext);
    const base = target ? await readConfig(read, target, warnings, depth + 1) : null;
    if (!base) {
      warnings.push(`${path}: could not read "extends": "${ext}".`);
      continue;
    }
    options = { ...options, ...(base.raw.compilerOptions ?? {}) };
    Object.assign(dirs, base.dirs);
    include ??= base.raw.include;
    exclude ??= base.raw.exclude;
    files ??= base.raw.files;
  }
  const own = raw.compilerOptions && typeof raw.compilerOptions === "object" ? raw.compilerOptions : {};
  for (const k of PATH_OPTIONS) if (k in own) dirs[k] = dir;
  options = { ...options, ...own };
  return { raw: { ...raw, compilerOptions: options, include, exclude, files }, dirs };
}

/** `extends`: a relative file, or a package in node_modules ("@tsconfig/node20/tsconfig.json", "@vue/tsconfig"). */
async function resolveExtends(read: Reader, dir: string, ext: string): Promise<string | null> {
  const withJson = (p: string) => (p.endsWith(".json") ? [p] : [`${p}.json`, `${p}/tsconfig.json`, p]);
  if (ext.startsWith(".") || ext.startsWith("/")) {
    for (const c of withJson(joinPath(dir, ext))) if ((await read(c)) !== null) return c;
    return null;
  }
  // Walk up node_modules folders, as TypeScript does.
  let d = dir;
  for (;;) {
    const nm = joinPath(d, `node_modules/${ext}`);
    for (const c of withJson(nm)) if ((await read(c)) !== null) return c;
    if (!d) return null;
    d = dirOf(d);
  }
}

/**
 * Reads the folder's tsconfig.json (else jsconfig.json), following `extends`
 * and, for a solution-style config (`"files": []` + `references`, as Vite's
 * templates write), merging the referenced projects.
 */
export async function loadProjectConfig(read: Reader): Promise<ProjectConfig> {
  const warnings: string[] = [];
  for (const name of ["tsconfig.json", "jsconfig.json"] as const) {
    const cfg = await readConfig(read, name, warnings);
    if (!cfg) continue;
    const kind = name === "tsconfig.json" ? "tsconfig" : "jsconfig";
    let { compilerOptions = {}, include = null, exclude = null, files = null } = cfg.raw as RawConfig & { include: string[] | null };
    let dirs = cfg.dirs;
    const refs = (cfg.raw.references ?? []).filter((r) => r && typeof r.path === "string");
    if (refs.length && Array.isArray(files) && files.length === 0 && !cfg.raw.include) {
      // Solution config: the app's options first; every referenced project's files.
      const merged: string[] = [];
      let first = true;
      for (const ref of refs) {
        const p = joinPath("", ref.path);
        const target = p.endsWith(".json") ? p : `${p}/tsconfig.json`;
        const sub = await readConfig(read, target, warnings);
        if (!sub) continue;
        const subDir = dirOf(target);
        const inc = sub.raw.include ?? (sub.raw.files ? [] : ["**/*"]);
        merged.push(...inc.map((g) => joinPath(subDir, g)), ...(sub.raw.files ?? []).map((f) => joinPath(subDir, f)));
        if (first) {
          compilerOptions = { ...compilerOptions, ...(sub.raw.compilerOptions ?? {}) };
          dirs = { ...dirs, ...sub.dirs };
          exclude = sub.raw.exclude?.map((g) => joinPath(subDir, g)) ?? exclude;
          first = false;
        }
      }
      include = merged;
      files = null;
    }
    return { configPath: name, kind, dir: "", compilerOptions, optionsDirs: dirs, include: include ?? null, exclude: exclude ?? null, files: files ?? null, warnings };
  }
  return { configPath: null, kind: null, dir: "", compilerOptions: {}, optionsDirs: {}, include: null, exclude: null, files: null, warnings };
}

// ───────────────────────── compiler options ─────────────────────────

const TARGET: Record<string, number> = { es3: 0, es5: 1, es6: 2, es2015: 2, es2016: 3, es2017: 4, es2018: 5, es2019: 6, es2020: 7, es2021: 8, es2022: 9, es2023: 10, es2024: 11, esnext: 99 };
const MODULE: Record<string, number> = { none: 0, commonjs: 1, amd: 2, umd: 3, system: 4, es6: 5, es2015: 5, es2020: 6, es2022: 7, esnext: 99, node16: 100, node18: 101, node20: 102, nodenext: 199, preserve: 200 };
const RESOLUTION: Record<string, number> = { classic: 1, node: 2, node10: 2, node16: 3, nodenext: 99, bundler: 100 };
const JSX: Record<string, number> = { none: 0, preserve: 1, react: 2, "react-native": 3, "react-jsx": 4, "react-jsxdev": 5 };
const DETECTION: Record<string, number> = { legacy: 1, auto: 2, force: 3 };
const NEWLINE: Record<string, number> = { crlf: 0, lf: 1 };

/** Options that matter to the language service and are passed through as written. */
const PASS_THROUGH = [
  "strict",
  "noImplicitAny",
  "strictNullChecks",
  "strictFunctionTypes",
  "strictBindCallApply",
  "strictPropertyInitialization",
  "strictBuiltinIteratorReturn",
  "noImplicitThis",
  "useUnknownInCatchVariables",
  "alwaysStrict",
  "noImplicitReturns",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
  "noUncheckedIndexedAccess",
  "noPropertyAccessFromIndexSignature",
  "exactOptionalPropertyTypes",
  "noUnusedLocals",
  "noUnusedParameters",
  "allowUnreachableCode",
  "allowUnusedLabels",
  "allowJs",
  "checkJs",
  "maxNodeModuleJsDepth",
  "esModuleInterop",
  "allowSyntheticDefaultImports",
  "allowUmdGlobalAccess",
  "allowImportingTsExtensions",
  "allowArbitraryExtensions",
  "resolveJsonModule",
  "resolvePackageJsonExports",
  "resolvePackageJsonImports",
  "customConditions",
  "moduleSuffixes",
  "verbatimModuleSyntax",
  "isolatedModules",
  "preserveConstEnums",
  "experimentalDecorators",
  "emitDecoratorMetadata",
  "useDefineForClassFields",
  "jsxFactory",
  "jsxFragmentFactory",
  "jsxImportSource",
  "skipLibCheck",
  "noLib",
  "types",
  "forceConsistentCasingInFileNames",
  "noErrorTruncation",
  "importHelpers",
  "downlevelIteration",
  "erasableSyntaxOnly",
  "rewriteRelativeImportExtensions",
  "libReplacement",
];

/** `"ES2020"` → `"lib.es2020.d.ts"`, `"DOM.Iterable"` → `"lib.dom.iterable.d.ts"` (Monaco's bundled lib files). */
export function libFileName(lib: string) {
  return `lib.${lib.toLowerCase()}.d.ts`;
}

const enumOf = (table: Record<string, number>, v: unknown) => (typeof v === "string" ? table[v.toLowerCase()] : typeof v === "number" ? v : undefined);

/** Defaults VS Code applies to a jsconfig.json project. */
const JSCONFIG_DEFAULTS = { allowJs: true, maxNodeModuleJsDepth: 2, allowSyntheticDefaultImports: true, skipLibCheck: true, noEmit: true };

/**
 * A config's compilerOptions as the TypeScript language service takes them:
 * enum names → numbers, `lib` → lib file names, path options → `tmcode:/` URIs
 * (Monaco's file names). Without a config, `fallback` (TMCode's defaults) applies.
 */
export function toServiceOptions(config: ProjectConfig, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!config.kind) return { ...fallback };
  const raw = config.compilerOptions;
  const out: Record<string, unknown> = { allowNonTsExtensions: true, ...(config.kind === "jsconfig" ? JSCONFIG_DEFAULTS : {}) };
  for (const k of PASS_THROUGH) if (raw[k] !== undefined) out[k] = raw[k];
  const set = (key: string, value: number | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  set("target", enumOf(TARGET, raw.target));
  set("module", enumOf(MODULE, raw.module));
  set("moduleResolution", enumOf(RESOLUTION, raw.moduleResolution));
  set("jsx", enumOf(JSX, raw.jsx));
  set("moduleDetection", enumOf(DETECTION, raw.moduleDetection));
  set("newLine", enumOf(NEWLINE, raw.newLine));
  if (Array.isArray(raw.lib)) out.lib = raw.lib.filter((l): l is string => typeof l === "string").map(libFileName);
  const dirFor = (k: string) => config.optionsDirs[k] ?? config.dir;
  if (typeof raw.baseUrl === "string") out.baseUrl = toUri(joinPath(dirFor("baseUrl"), raw.baseUrl));
  if (raw.paths && typeof raw.paths === "object") {
    out.paths = raw.paths;
    // TypeScript 4.1+: without baseUrl, `paths` are relative to the config that set them.
    if (out.baseUrl === undefined) out.pathsBasePath = toUri(dirFor("paths"));
  }
  if (Array.isArray(raw.rootDirs)) out.rootDirs = raw.rootDirs.filter((d): d is string => typeof d === "string").map((d) => toUri(joinPath(dirFor("rootDirs"), d)));
  if (Array.isArray(raw.typeRoots)) out.typeRoots = raw.typeRoots.filter((d): d is string => typeof d === "string").map((d) => toUri(joinPath(dirFor("typeRoots"), d)));
  return out;
}

// ───────────────────────── file selection ─────────────────────────

/** A tsconfig glob (`src/**`, `*.ts`, `src`) as a RegExp over workspace-relative paths. */
export function globToRegExp(glob: string, dir: string): RegExp {
  let g = joinPath(dir, glob.replace(/\\/g, "/"));
  // A folder name without wildcards or extension means everything under it.
  const last = g.slice(g.lastIndexOf("/") + 1);
  if (!/[*?]/.test(g) && !last.includes(".")) g = g ? `${g}/**/*` : "**/*";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      // `**/` matches zero or more folders.
      if (g[i + 2] === "/") {
        re += "(?:[^/]+/)*";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export interface SourcePlan {
  /** Which extensions are TypeScript/JavaScript sources here. */
  accepts(path: string): boolean;
  /** Folders worth reading (`false` prunes the walk). */
  walkDir(path: string, name: string): boolean;
  /** Without a config only ES/CommonJS modules are loaded (a loose script's globals would clash, as in VS Code's inferred projects). */
  modulesOnly: boolean;
}

/** Which workspace files the project includes, from its config (or VS Code's inferred-project rules without one). */
export function planSources(config: ProjectConfig): SourcePlan {
  const opts = config.compilerOptions;
  const js = config.kind !== "tsconfig" || opts.allowJs === true || opts.checkJs === true;
  const json = opts.resolveJsonModule === true;
  const ext = (p: string) => (TS_EXT.test(p) || (js && JS_EXT.test(p) && !MIN_JS.test(p)) || (json && /\.json$/i.test(p) && !/(^|\/)(package-lock|tsconfig[^/]*|jsconfig)\.json$/i.test(p)));
  if (!config.kind) {
    return {
      accepts: ext,
      walkDir: (_p, name) => !ALWAYS_SKIP.has(name) && !OUTPUT_DIRS.has(name),
      modulesOnly: true,
    };
  }
  const outDir = typeof opts.outDir === "string" ? joinPath(config.optionsDirs.outDir ?? config.dir, opts.outDir) : null;
  const files = new Set((config.files ?? []).map((f) => joinPath(config.dir, f)));
  // TypeScript: `include` defaults to everything unless `files` is given.
  const include = (config.include ?? (config.files ? [] : ["**/*"])).map((g) => globToRegExp(g, config.dir));
  const exclude = (config.exclude ?? []).map((g) => globToRegExp(g, config.dir));
  const excludedDir = (p: string) => exclude.some((re) => re.test(p) || re.test(`${p}/x`)) || (!!outDir && (p === outDir || p.startsWith(`${outDir}/`)));
  return {
    accepts: (p) => {
      if (files.has(p)) return true;
      if (!ext(p)) return false;
      if (outDir && p.startsWith(`${outDir}/`)) return false;
      return include.some((re) => re.test(p)) && !exclude.some((re) => re.test(p));
    },
    walkDir: (p, name) => !ALWAYS_SKIP.has(name) && !excludedDir(p),
    modulesOnly: false,
  };
}

/** Is this source an ES module or CommonJS module (imports or exports), not a global script? */
export function isModuleSource(text: string): boolean {
  return /^\s*(import\s*[\w{*"'(]|import\s+type\b|export\s)/m.test(text) || /\bmodule\.exports\b|\bexports\.[\w$]+\s*=/.test(text);
}

export interface DirEntryLike {
  name: string;
  path: string;
  kind: "file" | "dir";
}

/** Lists the candidate source files (sorted, at most `limit`), walking only folders the plan keeps. */
export async function listSources(readDir: (path: string) => Promise<DirEntryLike[]>, plan: SourcePlan, limit = MAX_SOURCE_FILES * 2): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (out.length >= limit || depth > 30) return;
    const entries = await readDir(dir).catch(() => [] as DirEntryLike[]);
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "file" ? -1 : 1));
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.kind === "dir") {
        if (plan.walkDir(e.path, e.name)) await walk(e.path, depth + 1);
      } else if (plan.accepts(e.path)) out.push(e.path);
    }
  };
  await walk("", 0);
  return out;
}

export interface Budget {
  files: number;
  bytes: number;
}

/** Open files and their folders first (what the student works on), then the rest in walk order. */
export function orderByPreference(paths: string[], preferred: string[]): string[] {
  const open = new Set(preferred);
  const near = new Set(preferred.map(dirOf));
  const rank = (p: string) => (open.has(p) ? 0 : near.has(dirOf(p)) ? 1 : 2);
  return paths
    .map((p, i) => ({ p, i, r: rank(p) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.p);
}

/** Counts files and bytes against the budget; `take(size)` says whether one more file fits. */
export function createBudget(limit: Budget = { files: MAX_SOURCE_FILES, bytes: MAX_SOURCE_BYTES }) {
  const used = { files: 0, bytes: 0, skipped: 0 };
  return {
    used,
    full: () => used.files >= limit.files || used.bytes >= limit.bytes,
    take(size: number) {
      if (size > MAX_SOURCE_FILE_BYTES || used.files >= limit.files || used.bytes + size > limit.bytes) {
        used.skipped++;
        return false;
      }
      used.files++;
      used.bytes += size;
      return true;
    },
    release(size: number) {
      used.files--;
      used.bytes -= size;
    },
  };
}
