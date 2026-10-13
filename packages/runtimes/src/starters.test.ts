// @vitest-environment node
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CATALOG, LANGUAGES, kindById } from "./catalog";
import { detect, entryFor, isEntrySource } from "./detect";
import { loadStarters } from "./node/starters";
import { IoTestsSchema, StarterManifestSchema } from "./schema";
import { startersFor } from "./starters";
import { validateStarters } from "./validate";

const STARTERS = loadStarters(fileURLToPath(new URL("../starters", import.meta.url)));
const manifests = STARTERS.map((s) => s.manifest);

describe("starters", () => {
  it("exist (the 50 migrated TMCode templates plus the new ones) with unique ids", () => {
    expect(STARTERS.filter((s) => s.manifest.id.startsWith("tmcode-")).length).toBe(50);
    expect(STARTERS.length).toBeGreaterThanOrEqual(85);
    expect(validateStarters(STARTERS, CATALOG)).toEqual([]);
  });

  it.each(STARTERS.map((s) => [s.manifest.id, s] as const))("%s", (_id, s) => {
    const m = s.manifest;
    expect(StarterManifestSchema.safeParse(m).success).toBe(true);
    const kind = kindById(m.kind);
    expect(kind, `kind ${m.kind}`).not.toBeNull();
    expect(s.dir.split(/[\\/]/).slice(-2)).toEqual([m.language, m.id]);
    const paths = s.files.map((f) => f.path);
    expect(paths).toContain(m.entry);
    for (const o of m.open) expect(paths).toContain(o);
    if (m.tests?.io) {
      const io = IoTestsSchema.parse(JSON.parse(s.files.find((f) => f.path === m.tests!.io)!.content));
      expect(paths).toContain(io.entry);
      for (const t of io.tests) expect(t.points).toBeGreaterThan(0);
    }
    if (m.setup && paths.every((p) => /(readme\.md|\.gitignore)$/i.test(p))) return; // scaffolded on first open
    const read = (p: string) => s.files.find((f) => f.path === p)?.content ?? null;
    const ranked = detect(paths, read);
    expect(ranked.length).toBeGreaterThan(0);
    // The declared kind wins, or ties on priority with a kind of the same language.
    const top = ranked[0];
    const mine = ranked.find((r) => r.kind === m.kind);
    expect(mine, `${m.kind} not detected (top: ${top.kind})`).toBeDefined();
    if (top.kind !== m.kind) {
      expect(top.language).toBe(m.language);
      expect(Math.floor(top.score / 1000)).toBe(Math.floor(mine!.score / 1000));
    }
    expect(entryFor(kind!, paths, read)).not.toBeNull();
    // The runner runs the entry: it must be a source file of the kind (never PROBLEM.md or a README).
    if (kind!.steps.run) expect(isEntrySource(kind!, m.entry), `entry ${m.entry}`).toBe(true);
  });

  it("give every wave A language a hello, an io-exercise and a project with a unit test", () => {
    for (const lang of LANGUAGES.filter((l) => l.wave === "A" && !["web", "logic"].includes(l.key))) {
      const mine = manifests.filter((m) => m.language === lang.key && !m.id.startsWith("tmcode-"));
      expect(mine.some((m) => m.purpose === "hello"), `${lang.key} hello`).toBe(true);
      expect(mine.some((m) => m.purpose === "io-exercise" && m.tests?.io), `${lang.key} io-exercise`).toBe(true);
      const project = mine.some((m) => m.purpose === "project" && (m.tests?.unit || (lang.key === "sql" && m.tests?.io)));
      expect(project, `${lang.key} project with a unit test`).toBe(true);
    }
  });

  it("give every wave B, C and D language a hello and a two-number io-exercise", () => {
    for (const lang of LANGUAGES.filter((l) => l.wave === "B" || l.wave === "C" || l.wave === "D")) {
      const hello = STARTERS.find((s) => s.manifest.id === `${lang.key}-hello`);
      const io = STARTERS.find((s) => s.manifest.id === `${lang.key}-io`);
      expect(hello?.manifest.purpose, `${lang.key}-hello`).toBe("hello");
      expect(io?.manifest.purpose, `${lang.key}-io`).toBe("io-exercise");
      const tests = IoTestsSchema.parse(JSON.parse(io!.files.find((f) => f.path === ".nga/tests.json")!.content));
      expect(tests.entry).toBe(io!.manifest.entry);
      for (const t of tests.tests) expect(t.expected_output, `${lang.key}-io ${t.id}`).toMatch(/^Sum: -?\d+\n$/);
    }
  });

  it("give PHP, Ruby, Lua, Bash and R a project with a unit test (PHPUnit, RSpec, busted, bats, testthat)", () => {
    const want = { php: "phpunit", ruby: "rspec", lua: "busted", bash: "bats", r: "testthat" } as const;
    for (const [lang, framework] of Object.entries(want)) {
      const m = manifests.find((x) => x.language === lang && x.purpose === "project" && x.tests?.unit?.framework === framework);
      expect(m, `${lang} ${framework} project`).toBeDefined();
      expect(kindById(m!.kind)?.steps.test, `${m!.kind} has a test step`).toBeDefined();
    }
  });

  it("io-exercises have 1–4 visible tests", () => {
    for (const s of STARTERS.filter((x) => x.manifest.purpose === "io-exercise" && !x.manifest.id.startsWith("tmcode-"))) {
      const io = IoTestsSchema.parse(JSON.parse(s.files.find((f) => f.path === ".nga/tests.json")!.content));
      expect(io.tests.length, s.manifest.id).toBeGreaterThanOrEqual(1);
      expect(io.tests.length, s.manifest.id).toBeLessThanOrEqual(4);
    }
  });

  it("ships no .tmcode/tests.json (renamed to .nga/tests.json)", () => {
    for (const s of STARTERS) expect(s.files.some((f) => f.path === ".tmcode/tests.json"), s.manifest.id).toBe(false);
  });

  it("startersFor orders by purpose", () => {
    const c = startersFor(manifests, "c");
    expect(c[0].purpose).toBe("hello");
    expect(startersFor(manifests, "java/maven").every((m) => m.kind === "java/maven")).toBe(true);
  });
});
