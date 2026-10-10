import { describe, expect, it } from "vitest";
import { findConflicts, monacoLabelToChord, normalizeKeybinding, sanitizeOverrides, toAccelerator, withOverride } from "./keybindingLogic";
import spec from "./menus.json";

describe("monacoLabelToChord", () => {
  it("maps Monaco's labels to TMCode keys", () => {
    expect(monacoLabelToChord("cmd+d", "mac")).toBe("mod+d");
    expect(monacoLabelToChord("ctrl+d", "windows")).toBe("mod+d");
    expect(monacoLabelToChord("shift+alt+down", "mac")).toBe("alt+shift+down");
    expect(monacoLabelToChord("cmd+k cmd+c", "mac")).toBe("mod+k mod+c");
    expect(monacoLabelToChord("ctrl+shift+cmd+right", "mac")).toBe("ctrl+mod+shift+right");
    expect(monacoLabelToChord("f12", "linux")).toBe("f12");
  });
  it("drops keys TMCode can't bind", () => {
    expect(monacoLabelToChord("win+x", "windows")).toBeNull();
    expect(monacoLabelToChord("cmd+[Slash]", "mac")).toBeNull();
    expect(monacoLabelToChord("", "mac")).toBeNull();
  });
});

describe("conflicts and overrides", () => {
  const rows = [
    { id: "a", kb: "mod+shift+p" },
    { id: "b", kb: "shift+mod+p" },
    { id: "c", kb: "mod+k mod+t" },
    { id: "d" },
  ];
  it("finds commands on the same key in any modifier order", () => {
    expect(findConflicts("mod+shift+p", rows, "mac", "a")).toEqual(["b"]);
    expect(findConflicts("mod+k mod+t", rows, "mac")).toEqual(["c"]);
    expect(findConflicts("mod+k", rows, "mac")).toEqual([]);
    expect(findConflicts("", rows, "mac")).toEqual([]);
  });
  it("Ctrl is the primary modifier off macOS", () => {
    expect(normalizeKeybinding("ctrl+s", "windows")).toBe("mod+s");
    expect(normalizeKeybinding("ctrl+s", "mac")).toBe("ctrl+s");
  });
  it("recording the default again drops the override; null resets", () => {
    expect(withOverride({}, "x", "mod+j", "mod+k", "mac")).toEqual({ x: "mod+j" });
    expect(withOverride({ x: "mod+j" }, "x", "mod+k", "mod+k", "mac")).toEqual({});
    expect(withOverride({ x: "mod+j" }, "x", null, "mod+k", "mac")).toEqual({});
    expect(withOverride({}, "x", "", "mod+k", "mac")).toEqual({ x: "" });
  });
  it("keeps only well-formed settings", () => {
    expect(sanitizeOverrides({ ok: "mod+k mod+t", bad: 3, "": "x", "a b": "mod+j" })).toEqual({ ok: "mod+k mod+t" });
    expect(sanitizeOverrides(["mod+j"])).toEqual({});
    expect(sanitizeOverrides(null)).toEqual({});
  });
});

describe("native accelerators", () => {
  it("only ⌘ / Ctrl shortcuts become accelerators", () => {
    expect(toAccelerator("mod+shift+p")).toBe("CmdOrCtrl+Shift+P");
    expect(toAccelerator("alt+mod+up")).toBe("CmdOrCtrl+Alt+Up");
    expect(toAccelerator("mod+\\")).toBe("CmdOrCtrl+\\");
    expect(toAccelerator("alt+up")).toBeNull();
    expect(toAccelerator("f5")).toBeNull();
    expect(toAccelerator("mod+k mod+t")).toBeNull();
    expect(toAccelerator(undefined)).toBeNull();
  });
});

describe("menus.json", () => {
  type Item = string | { command?: string; label?: string; role?: string };
  const menus = (spec as { menus: { label: string; native?: string; items: Item[] }[] }).menus;
  it("has Selection and Run menus and a fuller Go menu", () => {
    const byLabel = Object.fromEntries(menus.map((m) => [m.label, m.items]));
    const ids = (label: string) => byLabel[label].flatMap((i) => (typeof i === "object" && i.command ? [i.command] : []));
    expect(ids("Selection")).toEqual(
      expect.arrayContaining([
        "editor.action.selectAll",
        "editor.action.smartSelect.expand",
        "editor.action.smartSelect.shrink",
        "editor.action.copyLinesUpAction",
        "editor.action.copyLinesDownAction",
        "editor.action.moveLinesUpAction",
        "editor.action.moveLinesDownAction",
        "editor.action.insertCursorAbove",
        "editor.action.insertCursorBelow",
        "editor.action.addSelectionToNextFindMatch",
        "editor.action.selectHighlights",
      ]),
    );
    expect(ids("Run")).toEqual(
      expect.arrayContaining(["workbench.action.debug.start", "workbench.action.debug.run", "tmcode.stopAny", "tmcode.restartAny", "editor.debug.action.toggleBreakpoint", "tmcode.runProject", "tmcode.runTests"]),
    );
    expect(ids("Go")).toEqual(expect.arrayContaining(["workbench.action.navigateBack", "workbench.action.navigateForward", "workbench.action.quickOpen", "workbench.action.gotoSymbol", "editor.action.revealDefinition", "workbench.action.gotoLine", "editor.action.marker.nextInFiles", "editor.action.marker.prevInFiles"]));
  });
  it("every command item has a label (the native menu needs it before the workbench loads)", () => {
    for (const m of menus) for (const i of m.items) if (typeof i === "object" && i.command) expect(i.label, `${m.label} › ${i.command}`).toBeTruthy();
  });
});
