import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "./../platform/memory";
import type { Platform } from "../platform/types";
import { initWorkbench, resetWorkbenchForTests } from "../state/store";
import { foldersOf, projectRules } from "./agent/projectRules";
import { detectTestCommand, failureSignature } from "./chat";
import { expandRecipe, recipeSuggestions } from "./recipes";

const platform = (files: Record<string, string>) =>
  ({ kind: "web", os: "mac", version: "t", fs: new MemoryFileSystem(files), store: { get: async () => undefined, set: async () => {} }, openFolder: async () => null, reopenFolder: async () => null }) as unknown as Platform;

describe("slash recipes (L6)", () => {
  it("Industrial: the agent does the job; Learning: the tutor guides", () => {
    const build = expandRecipe("/add-form contact us", false, "auto");
    expect(build).toMatchObject({ kind: "ask", mode: "auto" });
    expect(build && build.kind === "ask" && build.prompt).toMatch(/Add a form \(contact us\) with labelled inputs/);
    const guide = expandRecipe("/add-form", true, "auto");
    expect(guide).toMatchObject({ kind: "ask", mode: "chat" });
    expect(guide && guide.kind === "ask" && guide.prompt).toMatch(/Guide me .* I write the code/);
    // Chat or Plan mode: the recipe works on the project, asking first.
    expect(expandRecipe("/test", false, "chat")).toMatchObject({ mode: "manual" });
    expect(expandRecipe("/review", false, "auto")).toEqual({ kind: "action", action: "review", arg: "" });
    expect(expandRecipe("/nope", false, "auto")).toBeNull();
    expect(expandRecipe("not a recipe", false, "auto")).toBeNull();
    expect(recipeSuggestions("add").map((r) => r.id)).toEqual(["add-page", "add-form", "add-auth", "add-db", "add-api"]);
  });
});

describe("project rules (B2): AGENTS.md, nearest last", () => {
  it("reads the root and nested rules files on the way to the open file", async () => {
    resetWorkbenchForTests();
    const p = platform({ "AGENTS.md": "Use tabs.", "web/CLAUDE.md": "Vanilla JS only.", "web/js/AGENTS.md": "No globals.", "web/js/app.js": "" });
    await initWorkbench(p);
    expect(foldersOf("web/js/app.js")).toEqual(["", "web", "web/js"]);
    const r = await projectRules(p.fs, "web/js/app.js");
    expect(r.files).toEqual(["AGENTS.md", "web/CLAUDE.md", "web/js/AGENTS.md"]);
    expect(r.text.indexOf("Use tabs.")).toBeLessThan(r.text.indexOf("No globals."));
    expect((await projectRules(p.fs, null)).files).toEqual(["AGENTS.md"]);
  });
});

describe("the self-healing loop (L3)", () => {
  it("runs only the project's own tests", async () => {
    resetWorkbenchForTests();
    await initWorkbench(platform({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) }));
    expect(await detectTestCommand()).toBe("npm test --silent");
    resetWorkbenchForTests();
    await initWorkbench(platform({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
    expect(await detectTestCommand()).toBeNull();
    resetWorkbenchForTests();
    await initWorkbench(platform({ "tests/test_cart.py": "def test_x(): pass" }));
    expect(await detectTestCommand()).toBe("python3 -m pytest -q");
  });

  it("the breaker's fingerprint ignores timings, so the same failure is recognised", () => {
    expect(failureSignature("FAIL cart.test.js\nexpected 3, got 2\nTime: 12ms")).toBe(failureSignature("FAIL cart.test.js\nexpected 3, got 2\nTime: 15ms"));
    expect(failureSignature("expected 3, got 2")).not.toBe(failureSignature("expected 3, got 4"));
  });
});
