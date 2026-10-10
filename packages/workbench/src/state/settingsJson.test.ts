import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "./settings";
import { languageScope, parseSettingsJson, resolveSettings, stringifySettings, validateValue, workspaceOverlay } from "./settingsJson";

describe("settings.json validation", () => {
  it("accepts known settings with valid values, comments and trailing commas", () => {
    const p = parseSettingsJson(`{
      // bigger text
      "editor.fontSize": 18,
      "editor.wordWrap": "on",
      "files.autoSave": "off",
    }`);
    expect(p.syntaxError).toBe(false);
    expect(p.issues).toEqual([]);
    expect(p.values).toEqual({ "editor.fontSize": 18, "editor.wordWrap": "on", "files.autoSave": "off" });
  });

  it("reports wrong types, out-of-range numbers and unknown enum values without applying them", () => {
    const p = parseSettingsJson(`{ "editor.fontSize": 99, "editor.tabSize": "4", "editor.wordWrap": "sometimes", "editor.minimap.enabled": 1 }`);
    expect(p.values).toEqual({});
    expect(p.issues.map((i) => i.key)).toEqual(["editor.fontSize", "editor.tabSize", "editor.wordWrap", "editor.minimap.enabled"]);
    expect(p.issues.every((i) => i.severity === "error")).toBe(true);
    expect(p.issues[0].message).toContain("from 8 to 40");
    expect(p.issues[2].message).toContain('"off", "on"');
    expect(p.issues[0].offset).toBeGreaterThan(0);
  });

  it("keeps unknown keys (with a warning) and flags broken JSON", () => {
    const p = parseSettingsJson(`{ "python.analysis.typeCheckingMode": "strict" }`);
    expect(p.other).toEqual({ "python.analysis.typeCheckingMode": "strict" });
    expect(p.issues[0].severity).toBe("warning");
    const broken = parseSettingsJson(`{ "editor.fontSize": 14,, }`);
    expect(broken.syntaxError).toBe(true);
    expect(parseSettingsJson(`[1]`).syntaxError).toBe(true);
    expect(parseSettingsJson("   ").syntaxError).toBe(false);
  });

  it("dynamic enums (themes, shells) accept any id", () => {
    expect(validateValue("workbench.colorTheme", "ext:pub.x:Night")).toBeNull();
    expect(validateValue("terminal.integrated.defaultProfile", "gitbash")).toBeNull();
    expect(validateValue("terminal.integrated.defaultProfile", 3)).not.toBeNull();
  });
});

describe("language scopes", () => {
  it("reads [python] and [javascript][typescript] blocks of editor settings", () => {
    expect(languageScope("[python]")).toEqual(["python"]);
    expect(languageScope("[javascript][typescript]")).toEqual(["javascript", "typescript"]);
    expect(languageScope("editor.tabSize")).toBeNull();
    const p = parseSettingsJson(`{
      "[python]": { "editor.tabSize": 4, "editor.insertSpaces": true },
      "[javascript][typescript]": { "editor.tabSize": 2 },
      "[go]": { "files.autoSave": "off", "editor.tabSize": 0 }
    }`);
    expect(p.languages).toEqual({ python: { "editor.tabSize": 4, "editor.insertSpaces": true }, javascript: { "editor.tabSize": 2 }, typescript: { "editor.tabSize": 2 } });
    // files.* can't be per language; 0 is out of range.
    expect(p.issues.map((i) => [i.key, i.severity])).toEqual([
      ["files.autoSave", "warning"],
      ["editor.tabSize", "error"],
    ]);
  });

  it("most specific wins: default < user < workspace < user [lang] < workspace [lang]", () => {
    const user = { ...DEFAULT_SETTINGS, "editor.tabSize": 3, "editor.wordWrap": "on" as const };
    const ws = workspaceOverlay(`{ "editor.tabSize": 2, "[python]": { "editor.wordWrap": "off" } }`, { exam: false, locked: [] });
    const userLangs = { python: { "editor.tabSize": 8 } };
    expect(resolveSettings(user, userLangs, ws, null)["editor.tabSize"]).toBe(2);
    expect(resolveSettings(user, userLangs, ws, "javascript")["editor.tabSize"]).toBe(2);
    expect(resolveSettings(user, userLangs, ws, "python")["editor.tabSize"]).toBe(8);
    expect(resolveSettings(user, userLangs, ws, "python")["editor.wordWrap"]).toBe("off");
    expect(resolveSettings(user, userLangs, null, "javascript")["editor.wordWrap"]).toBe("on");
    // A locked setting keeps the user's value, whatever a scope says.
    expect(resolveSettings(user, userLangs, ws, "python", ["editor.tabSize"])["editor.tabSize"]).toBe(3);
  });

  it("writes only changed settings and the scopes, and reads them back", () => {
    const text = stringifySettings({ ...DEFAULT_SETTINGS, "editor.fontSize": 16 }, { python: { "editor.tabSize": 4 } }, { "x.y": true });
    expect(JSON.parse(text)).toEqual({ "editor.fontSize": 16, "x.y": true, "[python]": { "editor.tabSize": 4 } });
    const back = parseSettingsJson(text);
    expect(back.values).toEqual({ "editor.fontSize": 16 });
    expect(back.languages).toEqual({ python: { "editor.tabSize": 4 } });
  });
});

describe("workspace overlay (.vscode/settings.json)", () => {
  const text = `{
    "editor.tabSize": 2,
    "editor.formatOnSave": true,
    "workbench.colorTheme": "light-modern",
    "update.mode": "none",
    "python.defaultInterpreterPath": ".venv/bin/python",
    "[python]": { "editor.insertSpaces": true }
  }`;

  it("takes layout and saving settings from a folder, never the app's", () => {
    const o = workspaceOverlay(text, { exam: false, locked: [] });
    expect(o.values).toEqual({ "editor.tabSize": 2, "editor.formatOnSave": true });
    expect(o.languages).toEqual({ python: { "editor.insertSpaces": true } });
    expect(o.ignored.map((i) => i.key)).toEqual(["workbench.colorTheme", "update.mode", "python.defaultInterpreterPath"]);
  });

  it("during an exam takes only layout settings, and never locked ones", () => {
    const o = workspaceOverlay(text, { exam: true, locked: ["editor.tabSize"] });
    expect(o.values).toEqual({});
    expect(o.languages).toEqual({ python: { "editor.insertSpaces": true } });
    expect(o.ignored.find((i) => i.key === "editor.tabSize")?.reason).toMatch(/Locked/);
    expect(o.ignored.find((i) => i.key === "editor.formatOnSave")?.reason).toMatch(/exam/);
  });
});
