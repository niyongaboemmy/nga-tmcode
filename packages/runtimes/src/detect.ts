/**
 * Which catalog kind a project is, and which file is its program. Pure: the
 * caller passes the project's file paths (relative to its root) and, for the
 * content rules, a reader. Adapted from TMCode's run/projectKind.ts (build
 * manifests beat loose files, frameworks beat their build tool) and Task
 * Mentor's practical/run.ts (entry = the file that declares main).
 */
import { KINDS, languageByKey } from "./catalog";
import type { KindDef } from "./schema";

/** Reads a project file's text; null/undefined when it can't (binary, too big, missing). */
export type FileReader = (path: string) => string | null | undefined;

/** Dependency, build and editor folders: never part of detection or entry points. */
export const IGNORED_PATH = /(^|\/)(node_modules|\.git|\.nga|\.tmcode|\.vscode|\.idea|dist|build|out|target|bin\/Debug|obj|__pycache__|\.venv|venv|\.dart_tool|vendor)\//;

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const hasGlob = (p: string) => p.includes("*");

function globRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/** "a|b|*.c" against a base name. */
export function matchName(pattern: string, name: string): boolean {
  return pattern.split("|").some((alt) => globRe(alt).test(name));
}

export interface DetectedKind {
  kind: string;
  language: string;
  label: string;
  /** priority × 1000 + how many source files matched (ties between C and C++, JS and TS…). */
  score: number;
}

export interface DetectOptions {
  /** The kinds to consider (default: the whole catalog). */
  kinds?: KindDef[];
  /** Only kinds a school can use now. */
  enabledOnly?: boolean;
}

/**
 * Every kind whose rules match the project, best first. Content rules
 * (`contains`) only match when `read` can read the file.
 */
export function detect(paths: string[], read?: FileReader, opts: DetectOptions = {}): DetectedKind[] {
  const files = paths.map((p) => p.replace(/^\.\//, "")).filter((p) => !IGNORED_PATH.test(p));
  const root = files.filter((p) => !p.includes("/"));
  const atRoot = (pattern: string) => root.some((p) => matchName(pattern, p));
  const texts = new Map<string, string | null>();
  const text = (p: string) => {
    if (!texts.has(p)) texts.set(p, read?.(p) ?? null);
    return texts.get(p) ?? null;
  };
  /** Files a `contains.file` pattern names: root files for plain names, any file for globs. */
  const filesFor = (pattern: string) =>
    files.filter((p) => pattern.split("|").some((alt) => (hasGlob(alt) ? globRe(alt).test(base(p)) : p === alt)));

  const out: DetectedKind[] = [];
  for (const k of opts.kinds ?? KINDS) {
    if (opts.enabledOnly && !k.enabled) continue;
    const d = k.detect;
    if (d.files && !d.files.every(atRoot)) continue;
    if (d.none && d.none.some(atRoot)) continue;
    let sources = 0;
    if (d.anyOf) {
      sources = files.filter((p) => d.anyOf!.some((g) => matchName(g, base(p)))).length;
      if (!sources) continue;
    }
    if (d.contains) {
      const ok = d.contains.every((rule) => {
        const re = new RegExp(rule.text, "m");
        return filesFor(rule.file)
          .slice(0, 64)
          .some((p) => {
            const t = text(p);
            return t != null && re.test(t);
          });
      });
      if (!ok) continue;
    }
    if (!d.files && !d.anyOf && !d.contains) continue;
    out.push({ kind: k.id, language: k.language, label: k.label, score: d.priority * 1000 + Math.min(sources, 999) });
  }
  return out.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
}

/** The best kind, or null. */
export function detectKind(paths: string[], read?: FileReader, opts?: DetectOptions): string | null {
  return detect(paths, read, opts)[0]?.kind ?? null;
}

// ───────────── entry points ─────────────

/** What a program's entry file declares (Task Mentor practical/run.ts). */
const MAIN_PATTERNS: Record<string, RegExp> = {
  c: /\bint\s+main\s*\(/,
  cpp: /\bint\s+main\s*\(/,
  java: /\bstatic\s+void\s+main\s*\(/,
  csharp: /\bstatic\s+(async\s+)?[\w<>]+\s+Main\s*\(/,
  python: /__name__\s*==\s*["']__main__["']/,
  go: /^package\s+main\b[\s\S]*\bfunc\s+main\s*\(/m,
  rust: /\bfn\s+main\s*\(/,
  kotlin: /\bfun\s+main\s*\(/,
  scala: /\bdef\s+main\s*\(|@main\b|extends\s+App\b/,
  dart: /\bvoid\s+main\s*\(|^main\s*\(/m,
  haskell: /^main\s*=|^main\s*::/m,
};

const ENTRY_NAMES = ["main", "index", "app", "program", "solution", "server"];
const NOT_ENTRY_EXT = new Set(["h", "hpp", "hh"]);
const SIBLING: Record<string, string> = { javascript: "typescript", typescript: "javascript", c: "cpp", cpp: "c" };

/** Test files: never the program, even when they declare main. */
export function isTestPath(p: string): boolean {
  const name = base(p).replace(/\.[^.]+$/, "").toLowerCase();
  return /(^|\/)(tests?|spec|__tests__)\//i.test(p) || /[._-](test|spec|tests)$|^(test|spec)[._-]/i.test(name);
}

function rankByDeclaration(candidates: string[], language: string, preferred: string | null, read?: FileReader): string[] {
  const main = MAIN_PATTERNS[language];
  const score = (p: string) => {
    const stem = base(p).replace(/\.[^.]+$/, "").toLowerCase();
    let s = 0;
    const src = main && read ? read(p) : null;
    if (main && src && main.test(src)) s += 100;
    if (preferred && p === preferred) s += 50;
    const named = ENTRY_NAMES.indexOf(stem);
    if (named >= 0) s += 30 - named;
    if (isTestPath(p)) s -= 200;
    s -= p.split("/").length * 2;
    return s;
  };
  return candidates
    .map((p) => ({ p, s: score(p) }))
    .sort((a, b) => b.s - a.s || a.p.localeCompare(b.p))
    .map((x) => x.p);
}

function fromManifest(k: KindDef, files: string[], read?: FileReader): string | null {
  const has = (p: string) => files.includes(p);
  const clean = (p: string) => p.replace(/^\.\//, "");
  if (k.language === "javascript" || k.language === "typescript") {
    const text = read?.("package.json");
    if (text) {
      try {
        const pkg = JSON.parse(text) as { main?: string; bin?: string | Record<string, string>; scripts?: Record<string, string> };
        const start = /\b(?:node|tsx|ts-node)\s+([\w./-]+\.[cm]?[jt]sx?)/.exec(pkg.scripts?.start ?? pkg.scripts?.dev ?? "")?.[1];
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin ? Object.values(pkg.bin)[0] : undefined;
        for (const c of [start, pkg.main, bin]) {
          if (!c) continue;
          const p = clean(c);
          if (has(p)) return p;
          // "dist/index.js" built from "src/index.ts".
          const src = p.replace(/^(dist|build|out)\//, "src/").replace(/\.js$/, ".ts");
          if (has(src)) return src;
        }
      } catch {
        /* not JSON: fall through */
      }
    }
  }
  if (k.language === "rust") {
    if (has("src/main.rs")) return "src/main.rs";
    const bin = files.find((p) => /^src\/bin\/[^/]+\.rs$/.test(p));
    if (bin) return bin;
    if (has("src/lib.rs")) return "src/lib.rs";
  }
  if (k.language === "sql") {
    const named = ["main.sql", "queries.sql", "query.sql", "solution.sql"].find(has);
    if (named) return named;
    const sql = files.filter((p) => p.endsWith(".sql") && !/^(schema|seed)\.sql$/.test(base(p)));
    if (sql.length) return sql.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
  }
  if (k.language === "web") {
    if (has("index.html")) return "index.html";
    const html = files.filter((p) => /\.html?$/.test(p)).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    if (html.length) return html[0];
  }
  return null;
}

/**
 * The file a kind runs: from the manifest (package.json, Cargo layout…) or the
 * file that declares main, else the kind's default when it exists, else the
 * best-named source file. Null when the project has no file of the language.
 */
export function entryFor(kind: KindDef | string, paths: string[], read?: FileReader): string | null {
  const k = typeof kind === "string" ? KINDS.find((x) => x.id === kind) : kind;
  if (!k) return null;
  const files = paths.map((p) => p.replace(/^\.\//, "")).filter((p) => !IGNORED_PATH.test(p));
  const def = k.entry?.default ?? null;
  const manifest = k.entry?.find === "manifest" || k.language === "web" || k.language === "sql" ? fromManifest(k, files, read) : null;
  if (manifest) return manifest;
  const sourcesOf = (language: string | undefined) => {
    const exts = new Set((languageByKey(language ?? "")?.extensions ?? []).filter((e) => !NOT_ENTRY_EXT.has(e)).map((e) => e.toLowerCase()));
    return files.filter((p) => {
      const dot = base(p).lastIndexOf(".");
      return dot > 0 && exts.has(base(p).slice(dot + 1).toLowerCase());
    });
  };
  // A JavaScript framework app written in TypeScript (and the reverse) still has an entry.
  let candidates = sourcesOf(k.language);
  if (!candidates.length) candidates = sourcesOf(SIBLING[k.language]);
  if (!candidates.length) return def && files.includes(def) ? def : null;
  const preferred = def && files.includes(def) ? def : null;
  if (k.entry?.find === "main-decl" || k.entry?.find === "manifest") return rankByDeclaration(candidates, k.language, preferred, read)[0];
  return preferred ?? rankByDeclaration(candidates, k.language, null, read)[0];
}

/**
 * The JVM main class of a Java file: its `package` plus the file name
 * ("src/rw/ac/nga/Main.java" with `package rw.ac.nga;` → "rw.ac.nga.Main").
 */
export function javaMainClass(path: string, source?: string | null): string {
  const cls = base(path).replace(/\.(java|kt)$/, "");
  const pkg = source ? /^\s*package\s+([\w.]+)\s*;?/m.exec(source)?.[1] : undefined;
  const name = path.endsWith(".kt") ? `${cls.charAt(0).toUpperCase()}${cls.slice(1)}Kt` : cls;
  return pkg ? `${pkg}.${name}` : name;
}
