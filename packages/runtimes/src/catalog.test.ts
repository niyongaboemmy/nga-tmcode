// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CATALOG, KINDS, LANGUAGES, RUNTIMES, kindById } from "./catalog";
import { CatalogSchema, KindDefSchema } from "./schema";
import { validateCatalog } from "./validate";

const WAVE_A_KINDS = [
  "c/single", "c/make", "c/cmake", "cpp/single", "cpp/make", "cpp/cmake", "java/single", "java/maven", "java/gradle",
  "python/single", "python/project", "python/data", "js/single", "js/npm", "ts/single", "ts/npm", "go/single", "go/module",
  "rust/single", "rust/cargo", "sql/sqlite",
];

describe("runtime catalog", () => {
  it("passes the zod schema and every cross-reference", () => {
    expect(() => CatalogSchema.parse(CATALOG)).not.toThrow();
    expect(validateCatalog(CATALOG)).toEqual([]);
  });

  it.each(KINDS.map((k) => [k.id, k] as const))("%s is a valid kind", (_id, k) => {
    expect(KindDefSchema.safeParse(k).success).toBe(true);
    expect(k.id.startsWith(`${k.language === "javascript" ? "js" : k.language === "typescript" ? "ts" : k.language}/`) || ["flutter/app", "web/static", "web/react-cdn"].includes(k.id)).toBe(true);
  });

  it("lists about 25 languages, wave A enabled and later waves as data", () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(24);
    for (const key of ["c", "cpp", "java", "python", "javascript", "typescript", "go", "rust", "sql"]) {
      expect(LANGUAGES.find((l) => l.key === key)).toMatchObject({ wave: "A", enabled: true });
    }
    for (const l of LANGUAGES.filter((x) => x.wave !== "A")) expect(l.enabled).toBe(false);
  });

  it("has every wave A kind, enabled, with a run step", () => {
    for (const id of WAVE_A_KINDS) {
      const k = kindById(id);
      expect(k, id).not.toBeNull();
      expect(k!.enabled, id).toBe(true);
      expect(k!.steps.run, id).toBeDefined();
    }
  });

  it("puts project builds in isolate-build and flags the steps that run project scripts", () => {
    for (const id of ["c/make", "c/cmake", "cpp/make", "cpp/cmake", "java/maven", "java/gradle", "js/npm", "ts/npm", "rust/cargo"]) {
      const k = kindById(id)!;
      expect(k.tier, id).toBe("isolate-build");
      expect(Object.values(k.steps).some((s) => s?.runsProjectScripts), id).toBe(true);
    }
    for (const id of ["c/single", "cpp/single", "java/single", "python/single", "js/single", "ts/single", "go/single", "rust/single", "sql/sqlite"]) {
      expect(kindById(id)!.tier, id).toBe("isolate");
    }
  });

  it("never runs container kinds on a shared runner", () => {
    for (const k of KINDS.filter((x) => x.tier === "container")) expect(k.enabled, k.id).toBe(false);
  });

  it("has the wave C and D languages as data, each with at least one kind", () => {
    const later = ["scala", "csharp", "julia", "haskell", "elixir", "swift", "dart", "zig", "nim", "fortran", "pascal", "cobol", "asm", "d", "crystal", "v", "ada", "objc", "groovy", "clojure", "fsharp", "vb", "pwsh", "perl", "tcl", "octave", "ocaml", "erlang", "gleam", "racket", "scheme", "lisp", "prolog", "verilog", "vhdl"];
    for (const key of later) {
      const lang = LANGUAGES.find((l) => l.key === key);
      expect(lang, key).toBeDefined();
      expect(["C", "D"]).toContain(lang!.wave);
      expect(KINDS.some((k) => k.language === key), `${key} kind`).toBe(true);
    }
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(50);
    for (const k of KINDS.filter((x) => x.wave === "D")) expect(k.enabled, k.id).toBe(false);
  });

  it("runs .NET builds and Gradle (Kotlin) in tier 3, Flutter too", () => {
    for (const id of ["csharp/single", "csharp/console", "csharp/xunit", "csharp/aspnet", "fsharp/script", "fsharp/console", "fsharp/test", "vb/console", "kotlin/gradle", "flutter/app"]) {
      expect(kindById(id)!.tier, id).toBe("container");
    }
    for (const id of ["csharp/console", "fsharp/console", "vb/console", "kotlin/gradle"]) expect(kindById(id)!.interactive, id).toBe("pty");
    // A run step in tier 3 still gets run limits.
    for (const k of KINDS.filter((x) => x.tier === "container" && x.steps.run)) expect(k.limits.run, k.id).toBeDefined();
  });

  it("every compiled wave D single file builds into the project (so run boxes get the binary)", () => {
    for (const k of KINDS.filter((x) => x.wave === "D" && x.steps.build && x.tier !== "container")) {
      const outs = k.steps.build!.args.filter((a) => typeof a === "object" && "out" in a);
      if (k.id.endsWith("/single") || k.id === "asm/nasm" || k.id === "verilog/iverilog") expect(outs.length, k.id).toBeGreaterThan(0);
    }
  });

  it("pins the wave A runtimes", () => {
    for (const id of ["gcc-13", "gxx-13", "jdk-21", "python-3.12", "node-22", "typescript", "go-1.25", "rust-stable", "sqlite-3"]) {
      expect(RUNTIMES.some((r) => r.id === id), id).toBe(true);
    }
  });
});
