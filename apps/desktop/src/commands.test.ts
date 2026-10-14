import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Every Tauri command the app registers must also be declared in build.rs and allowed in the
 * workbench capability, or the webview's invoke() is refused before it reaches Rust. The browser
 * e2e never calls Tauri, so this is the only test that sees it: 0.18.0 shipped without
 * tm_stream allowed, and TMCode AI's answers and Task Mentor live runs never started.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("Tauri commands", () => {
  const lib = read("../src-tauri/src/lib.rs");
  const handler = lib.slice(lib.indexOf("generate_handler!["), lib.indexOf("]", lib.indexOf("generate_handler![")));
  const registered = [...handler.matchAll(/(?:\w+::)?(\w+),?\s*$/gm)].map((m) => m[1]).filter((c) => c && c !== "generate_handler");
  const build = read("../src-tauri/build.rs");
  const declared = new Set([...build.slice(build.indexOf(".commands(&["), build.indexOf("])")).matchAll(/"(\w+)"/g)].map((m) => m[1]));
  const allowed = new Set([...read("../src-tauri/capabilities/workbench.json").matchAll(/"allow-([\w-]+)"/g)].map((m) => m[1].replace(/-/g, "_")));

  it("finds the registered commands", () => {
    expect(registered.length).toBeGreaterThan(50);
    expect(registered).toContain("tm_api");
  });
  it("declares every registered command in build.rs", () => {
    expect(registered.filter((c) => !declared.has(c))).toEqual([]);
  });
  it("allows every declared command in the workbench capability", () => {
    expect([...declared].filter((c) => !allowed.has(c))).toEqual([]);
  });
});
