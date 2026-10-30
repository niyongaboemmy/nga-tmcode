/**
 * Starters: the files a new project begins with. They come from the shared Runtime Catalog
 * (`@nga/runtimes`, packages/runtimes/starters), the same ones Task Mentor and the code runner use.
 * TMCode adds only its own layer on top: plain-word purpose labels, the language order of its
 * picker, and which starters fit an assignment's language. Manifests load with the app; a
 * starter's files load when it is used.
 */
import { LANGUAGES, startersFor as catalogStartersFor, type Purpose, type StarterManifest } from "@nga/runtimes";

const manifests = import.meta.glob<StarterManifest>("../../../runtimes/starters/*/*/starter.json", { eager: true, import: "default" });
const files = import.meta.glob<string>(
  ["../../../runtimes/starters/*/*/**/*", "../../../runtimes/starters/*/*/**/.*", "../../../runtimes/starters/*/*/.*/**/*", "!../../../runtimes/starters/*/*/starter.json"],
  { query: "?raw", import: "default" },
);

export interface Starter extends StarterManifest {
  /** "../../../runtimes/starters/python/python-hello/" (where its files are). */
  dir: string;
}

export const STARTERS: Starter[] = Object.entries(manifests)
  .map(([path, m]) => ({ ...m, dir: path.slice(0, path.length - "starter.json".length) }))
  .sort((a, b) => a.id.localeCompare(b.id));

/** A starter by id, or by the id of the New Project template it replaced ("python", "web"…). */
export function starterById(id: string): Starter | null {
  return STARTERS.find((s) => s.id === id) ?? STARTERS.find((s) => s.aliases?.includes(id)) ?? null;
}

/** The starter's files, `{ "main.py": "…", ".nga/tests.json": "…" }`. */
export async function starterFiles(s: Starter): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    Object.entries(files)
      .filter(([path]) => path.startsWith(s.dir))
      .map(async ([path, load]) => {
        out[path.slice(s.dir.length)] = await load();
      }),
  );
  return out;
}

/** What a starter is for, in plain words (the picker's second line). */
export const PURPOSE_LABEL: Record<Purpose, string> = {
  hello: "First program",
  "io-exercise": "Exercise (input and output)",
  project: "Project with tests",
  api: "Web API",
  data: "Data",
  algorithms: "Algorithms",
  web: "Website",
};

/** Languages most students use come first in the picker; the others follow in alphabetical order. */
const FIRST = ["web", "python", "javascript", "typescript", "java", "c", "cpp", "csharp", "php", "sql", "go", "rust", "kotlin", "dart", "ruby", "swift"];

export interface StarterLanguage {
  key: string;
  label: string;
  /** Offered to schools now (the catalog's enabled languages). */
  common: boolean;
  starters: Starter[];
}

/**
 * Every language that has starters, in picker order, each with its starters (catalog order).
 * Websites also offer PHP's websites (pages, forms, a small CMS) after their own: a student
 * looking for "a website with PHP" opens Website first.
 */
export function starterLanguages(): StarterLanguage[] {
  const label = (key: string) => (key === "web" ? "Website (HTML, CSS, JavaScript)" : (LANGUAGES.find((l) => l.key === key)?.label ?? key));
  const keys = [...new Set(STARTERS.map((s) => s.language))];
  const rank = (k: string) => (FIRST.includes(k) ? FIRST.indexOf(k) : FIRST.length);
  const startersOf = (key: string) => (key === "web" ? [...catalogStartersFor(STARTERS, "web"), ...catalogStartersFor(STARTERS, "php").filter((s) => s.purpose === "web")] : catalogStartersFor(STARTERS, key));
  return keys
    .map((key) => ({ key, label: label(key), common: FIRST.includes(key), starters: startersOf(key) }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
}

/** Task Mentor's language names ("C++", "html", "js") as catalog keys. */
const ALIAS: Record<string, string> = { "c++": "cpp", "c#": "csharp", js: "javascript", ts: "typescript", py: "python", html: "web", css: "web", "f#": "fsharp", golang: "go" };

export function catalogLanguage(language: string | null | undefined): string | null {
  const l = (language ?? "").trim().toLowerCase();
  if (!l) return null;
  const key = ALIAS[l] ?? l;
  return STARTERS.some((s) => s.language === key) ? key : null;
}

/**
 * Starters that fit an assignment's language, best first: a Python assignment never offers a React
 * app. Web work (HTML/CSS/JavaScript) also gets JavaScript's website starters. No language known:
 * the first program of each common language.
 */
export function startersForLanguage(language: string | null | undefined): Starter[] {
  if (!(language ?? "").trim()) {
    // Most-used languages first (Python before C), so the first few offered are the likely ones.
    return STARTERS.filter((s) => s.purpose === "hello" && FIRST.includes(s.language) && s.language !== "web").sort((a, b) => FIRST.indexOf(a.language) - FIRST.indexOf(b.language));
  }
  const key = catalogLanguage(language);
  if (!key) return [];
  const own = catalogStartersFor(STARTERS, key);
  if (key === "web" || key === "javascript") {
    const web = STARTERS.filter((s) => s.purpose === "web" && s.language !== key && (s.language === "web" || s.language === "javascript"));
    return key === "web" ? [...own, ...web] : [...own.filter((s) => s.purpose !== "web"), ...catalogStartersFor(STARTERS, "web"), ...own.filter((s) => s.purpose === "web")];
  }
  return own;
}

/** The file to open after writing a starter: its first `open` file that exists. */
export function firstOpenFile(s: Starter, written: Record<string, string>): string | null {
  return s.open.find((p) => written[p] !== undefined) ?? (written[s.entry] !== undefined ? s.entry : null);
}
