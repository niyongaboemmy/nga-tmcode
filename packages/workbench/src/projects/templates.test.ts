import { describe, expect, it } from "vitest";
import { detectProjects, fileActions, PROJECT_FILES, type FolderSnapshot } from "../run/projectKind";
import { CATEGORY_ORDER, TEMPLATES } from "./templates";

/** The template's folders as the Run hub scans them (root plus sub-folders). */
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

describe("New Project templates", () => {
  it("have unique ids, a known category, and cover every category", () => {
    const ids = TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of TEMPLATES) expect(CATEGORY_ORDER).toContain(t.category);
    for (const c of CATEGORY_ORDER) expect(TEMPLATES.some((t) => t.category === c)).toBe(true);
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(TEMPLATES.map((t) => [t.id, t] as const))("%s: valid files, and TMCode knows how to run it", (_id, t) => {
    expect(Object.keys(t.files).length).toBeGreaterThan(0);
    if (t.main) expect(Object.keys(t.files)).toContain(t.main);
    for (const [path, text] of Object.entries(t.files)) {
      if (path.endsWith(".json")) expect(() => JSON.parse(text), path).not.toThrow();
      if (path === ".tmcode/tests.json") {
        const tests = JSON.parse(text) as { entry: string; tests: unknown[] };
        expect(Object.keys(t.files)).toContain(tests.entry);
        expect(tests.tests.length).toBeGreaterThan(0);
      }
    }
    // Scaffolded templates (Laravel, Rails) only exist after their setup step.
    if (t.setup && Object.keys(t.files).every((p) => /readme\.md$/i.test(p))) return;
    const projects = detectProjects(snapshots(t.files)).filter((p) => p.kind !== "markdown");
    const fileRuns = Object.keys(t.files).flatMap((p) => fileActions(p, { webRoot: /\.html?$/.test(p) ? "" : null }));
    expect(projects.length + fileRuns.length, `${t.id} has nothing to run`).toBeGreaterThan(0);
  });
});
