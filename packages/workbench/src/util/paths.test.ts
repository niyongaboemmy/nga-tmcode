import { describe, expect, it } from "vitest";
import { basename, dirname, extname, isWithin, join, rebase, validateName } from "./paths";

describe("paths", () => {
  it("splits paths", () => {
    expect(basename("web/app.js")).toBe("app.js");
    expect(dirname("web/app.js")).toBe("web");
    expect(dirname("main.py")).toBe("");
    expect(join("", "a")).toBe("a");
    expect(join("web", "a")).toBe("web/a");
    expect(extname("web/App.JSX")).toBe("jsx");
    expect(extname(".gitignore")).toBe("");
  });

  it("knows ancestry", () => {
    expect(isWithin("web/app.js", "web")).toBe(true);
    expect(isWithin("website/a", "web")).toBe(false);
    expect(isWithin("anything", "")).toBe(true);
  });

  it("rebases renamed paths", () => {
    expect(rebase("web/app.js", "web", "site")).toBe("site/app.js");
    expect(rebase("website/x", "web", "site")).toBe("website/x");
  });

  it("validates new names", () => {
    expect(validateName("  ", [])).toMatch(/must be provided/);
    expect(validateName("a.py", ["a.py"])).toMatch(/already exists/);
    expect(validateName("../x", [])).toMatch(/not valid/);
    expect(validateName("src/new.ts", ["main.py"])).toBeNull();
  });
});
