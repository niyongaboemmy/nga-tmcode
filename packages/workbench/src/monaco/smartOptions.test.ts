import { describe, expect, it } from "vitest";
import { applyLineEdits, codeActionsForSave, saveWhitespaceEdits, smartEditorOptions } from "./smartOptions";
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from "../state/settings";
import { parseSettingsJson, stringifySettings } from "../state/settingsJson";

const ws = (text: string, opts: Partial<Parameters<typeof saveWhitespaceEdits>[1]>) => {
  const o = { trimTrailingWhitespace: false, insertFinalNewline: false, trimFinalNewlines: false, ...opts };
  return applyLineEdits(text, saveWhitespaceEdits(text.split("\n"), o));
};

describe("save whitespace (files.*)", () => {
  it("trims trailing whitespace", () => {
    expect(ws("a  \nb\t\n  c ", { trimTrailingWhitespace: true })).toBe("a\nb\n  c");
  });
  it("inserts a final newline once", () => {
    expect(ws("a\nb", { insertFinalNewline: true })).toBe("a\nb\n");
    expect(ws("a\nb\n", { insertFinalNewline: true })).toBe("a\nb\n");
    expect(ws("", { insertFinalNewline: true })).toBe("");
  });
  it("trims extra final newlines, keeping one", () => {
    expect(ws("a\n\n\n", { trimFinalNewlines: true })).toBe("a\n");
    expect(ws("a\n", { trimFinalNewlines: true })).toBe("a\n");
    expect(ws("a", { trimFinalNewlines: true })).toBe("a");
  });
  it("combines all three without overlapping edits", () => {
    expect(ws("x = 1  \n  \n\t\n", { trimTrailingWhitespace: true, trimFinalNewlines: true, insertFinalNewline: true })).toBe("x = 1\n");
    expect(ws("x = 1  ", { trimTrailingWhitespace: true, insertFinalNewline: true })).toBe("x = 1\n");
  });
  it("defaults to off, like VS Code", () => {
    expect(DEFAULT_SETTINGS["files.trimTrailingWhitespace"]).toBe(false);
    expect(DEFAULT_SETTINGS["files.insertFinalNewline"]).toBe(false);
    expect(DEFAULT_SETTINGS["files.trimFinalNewlines"]).toBe(false);
  });
});

describe("editor.codeActionsOnSave", () => {
  it("reads VS Code's object and list forms", () => {
    expect(codeActionsForSave({}, "explicit")).toEqual([]);
    expect(codeActionsForSave({ "source.organizeImports": "explicit", "source.fixAll": "always" }, "explicit")).toEqual(["source.organizeImports", "source.fixAll"]);
    expect(codeActionsForSave({ "source.organizeImports": "explicit", "source.fixAll": "always" }, "auto")).toEqual(["source.fixAll"]);
    expect(codeActionsForSave({ "source.fixAll": true, "source.organizeImports": "never" }, "explicit")).toEqual(["source.fixAll"]);
    expect(codeActionsForSave(["source.organizeImports"], "explicit")).toEqual(["source.organizeImports"]);
    expect(codeActionsForSave(["source.organizeImports"], "auto")).toEqual([]);
  });
});

describe("smart editor options under the exam policy", () => {
  const s: Settings = { ...DEFAULT_SETTINGS };
  it("VS Code's smarts are on in practice", () => {
    const o = smartEditorOptions(s, "full");
    expect(o.linkedEditing).toBe(true);
    expect(o.guides).toEqual({ bracketPairs: "active", indentation: true });
    expect(o.inlayHints).toEqual({ enabled: "on" });
    expect(o.inlineSuggest).toEqual({ enabled: true });
    expect(o.wordBasedSuggestions).toBe("matchingDocuments");
    expect(o.occurrencesHighlight).toBe("singleFile");
    expect(o.formatOnPaste).toBe(false);
  });
  it("the intelligence level wins", () => {
    const user = { ...s, "editor.formatOnPaste": true, "editor.suggest.preview": true } as Settings;
    const basic = smartEditorOptions(user, "basic");
    expect(basic.inlayHints).toEqual({ enabled: "off" });
    expect(basic.inlineSuggest).toEqual({ enabled: false });
    expect(basic.formatOnPaste).toBe(true);
    const none = smartEditorOptions(user, "none", { suggest: { showWords: false } });
    expect(none.linkedEditing).toBe(false);
    expect(none.wordBasedSuggestions).toBe("off");
    expect(none.formatOnPaste).toBe(false);
    expect(none.suggest).toEqual({ showWords: false, preview: false });
  });
  it("bracket pair guides accept VS Code's true/false", () => {
    const parsed = parseSettingsJson('{ "editor.guides.bracketPairs": true }');
    expect(parsed.issues).toEqual([]);
    expect(parsed.values["editor.guides.bracketPairs"]).toBe("true");
    expect(smartEditorOptions({ ...s, "editor.guides.bracketPairs": "true" }, "full").guides).toEqual({ bracketPairs: true, indentation: true });
    expect(smartEditorOptions({ ...s, "editor.guides.bracketPairs": "false" }, "full").guides).toEqual({ bracketPairs: false, indentation: true });
  });
  it("object defaults don't leak into settings.json", () => {
    const text = stringifySettings({ ...DEFAULT_SETTINGS, "editor.codeActionsOnSave": {} }, {}, {});
    expect(text).not.toContain("codeActionsOnSave");
  });
});

describe("default icon theme migration", () => {
  it("moves users on the old default to Seti, once", () => {
    const first = migrateSettings({ "workbench.iconTheme": "tmcode", "editor.fontSize": 15 }, undefined);
    expect(first.settings["workbench.iconTheme"]).toBe("vs-seti");
    expect(first.settings["editor.fontSize"]).toBe(15);
    expect(first.done).toContain("iconTheme.vs-seti");
    // Picking TMCode Glyphs again afterwards sticks.
    const again = migrateSettings({ "workbench.iconTheme": "tmcode" }, first.done);
    expect(again.settings["workbench.iconTheme"]).toBe("tmcode");
  });
  it("leaves other choices alone and new users get Seti", () => {
    expect(migrateSettings({ "workbench.iconTheme": "none" }, []).settings["workbench.iconTheme"]).toBe("none");
    expect(migrateSettings({ "workbench.iconTheme": "ext:pkief.material-icon-theme:material-icon-theme" }, []).settings["workbench.iconTheme"]).toContain("material");
    expect(migrateSettings(undefined, undefined).settings["workbench.iconTheme"]).toBeUndefined();
    expect(DEFAULT_SETTINGS["workbench.iconTheme"]).toBe("vs-seti");
  });
});
