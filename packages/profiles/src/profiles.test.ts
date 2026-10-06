import { describe, expect, it } from "vitest";
import { PROFILES, profileForPath } from "./index";

describe("built-in profiles", () => {
  it("are valid and uniquely identified", () => {
    expect(PROFILES.length).toBe(10);
    expect(new Set(PROFILES.map((p) => p.id)).size).toBe(PROFILES.length);
  });

  it("never claim the same extension twice", () => {
    const seen = new Map<string, string>();
    for (const p of PROFILES) {
      for (const ext of p.extensions) {
        expect(seen.get(ext), `.${ext} claimed by ${seen.get(ext)} and ${p.id}`).toBeUndefined();
        seen.set(ext, p.id);
      }
    }
  });

  it("only use known tools and tokens", () => {
    for (const p of PROFILES) {
      for (const step of [...(p.local?.build ?? []), ...(p.local ? [p.local.run] : [])]) {
        for (const arg of step.args) {
          for (const token of arg.match(/\{[^}]+\}/g) ?? []) {
            expect(["{entry}", "{entry_stem}", "{out}"].includes(token) || /^\{sources:[a-z]+\}$/.test(token), `${p.id}: ${token}`).toBe(true);
          }
        }
        if (step.tool === "exe") expect(step.args[0].startsWith("{out}/")).toBe(true);
      }
      // Either it runs locally or it previews (web).
      expect(p.local !== null || p.preview !== null).toBe(true);
    }
  });

  it("finds the profile for a file", () => {
    expect(profileForPath("src/main.py")?.id).toBe("python-3");
    expect(profileForPath("Main.java")?.id).toBe("java-21");
    expect(profileForPath("web/index.html")?.id).toBe("web");
    expect(profileForPath("README.md")).toBeUndefined();
    expect(profileForPath("cmd/main.go")?.id).toBe("go");
    expect(profileForPath("src/main.rs")?.id).toBe("rust");
  });
});
