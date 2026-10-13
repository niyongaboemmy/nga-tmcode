import { describe, expect, it } from "vitest";
import { IoTestsSchema, kindById } from "@nga/runtimes";
import { detectProjects, fileActions, PROJECT_FILES, type FolderSnapshot } from "../run/projectKind";
import { catalogLanguage, starterById, starterFiles, starterLanguages, STARTERS, startersForLanguage } from "./starters";

/** The starter's folders as the Run hub scans them (root plus sub-folders). */
function snapshots(files: Record<string, string>): FolderSnapshot[] {
  const dirs = new Set<string>([""]);
  for (const p of Object.keys(files)) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  return [...dirs].map((dir) => {
    const inDir = Object.keys(files).filter((p) => (dir ? p.startsWith(`${dir}/`) : true) && p.slice(dir ? dir.length + 1 : 0).split("/").length === 1);
    const names = inDir.map((p) => p.split("/").pop()!);
    const sub = [...dirs].filter((d) => d !== dir && (dir ? d.startsWith(`${dir}/`) : true) && d.slice(dir ? dir.length + 1 : 0).split("/").length === 1).map((d) => d.split("/").pop()!);
    const read: Record<string, string> = {};
    for (const n of names) if (PROJECT_FILES.includes(n) || /\.(csproj|fsproj)$/.test(n)) read[n] = files[dir ? `${dir}/${n}` : n];
    return { dir, files: names, dirs: sub, read };
  });
}

describe("starters (from the Runtime Catalog)", () => {
  it("are the catalog's starters, unique, in a picker of languages", () => {
    expect(STARTERS.length).toBeGreaterThanOrEqual(150);
    expect(new Set(STARTERS.map((s) => s.id)).size).toBe(STARTERS.length);
    const langs = starterLanguages();
    expect(langs[0].key).toBe("web");
    expect(langs.map((l) => l.key).slice(0, 4)).toEqual(["web", "python", "javascript", "typescript"]);
    // Each language's starters start with its first program.
    expect(langs.find((l) => l.key === "python")!.starters[0].purpose).toBe("hello");
  });

  it("find the starter that replaced a New Project template by its old id", () => {
    expect(starterById("python")?.id).toBe("tmcode-python");
    expect(starterById("web")?.id).toBe("tmcode-web");
    expect(starterById("python-hello")?.id).toBe("python-hello");
    expect(starterById("nope")).toBeNull();
  });

  it("fit an assignment's language only", () => {
    expect(catalogLanguage("C++")).toBe("cpp");
    expect(catalogLanguage("HTML")).toBe("web");
    expect(catalogLanguage("klingon")).toBeNull();
    expect(startersForLanguage("python").every((s) => s.language === "python")).toBe(true);
    expect(startersForLanguage("html").every((s) => s.language === "web" || s.language === "javascript")).toBe(true);
    expect(startersForLanguage("klingon")).toEqual([]);
    expect(startersForLanguage(null).every((s) => s.purpose === "hello")).toBe(true);
  });

  it.each(STARTERS.map((s) => [s.id, s] as const))("%s: its files, tests, and TMCode knows how to run it", async (_id, s) => {
    const files = await starterFiles(s);
    expect(Object.keys(files)).not.toContain("starter.json");
    for (const p of s.open) expect(Object.keys(files), p).toContain(p);
    for (const [path, text] of Object.entries(files)) if (path.endsWith(".json") && !path.includes(".vscode/")) expect(() => JSON.parse(text), path).not.toThrow();
    if (s.tests?.io) {
      const io = IoTestsSchema.parse(JSON.parse(files[s.tests.io]));
      expect(Object.keys(files)).toContain(io.entry);
    }
    // Scaffolded starters (Laravel, Rails) only exist after their setup step.
    if (s.setup && Object.keys(files).every((p) => /readme\.md$|\.gitignore$/i.test(p))) return;
    const projects = detectProjects(snapshots(files)).filter((p) => p.kind !== "markdown");
    const folderOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const fileRuns = Object.keys(files)
      .flatMap((p) => fileActions(p, { webRoot: /\.html?$/.test(p) ? "" : null, source: files[p], folderFiles: Object.keys(files).filter((q) => folderOf(q) === folderOf(p)).map((q) => q.split("/").pop()!) }))
      .filter((a) => a.kind !== "markdownPreview");
    // A few kinds need the code runner's own setup (NASM's link script, GNUstep headers): they run on Task Mentor only.
    if (s.kind === "asm/nasm" || s.kind === "objc/single") return expect(kindById(s.kind)?.steps.run).toBeTruthy();
    expect(projects.length + fileRuns.length, `${s.id} has nothing to run`).toBeGreaterThan(0);
  });
});
