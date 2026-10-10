import { describe, expect, it } from "vitest";
import { isBrowserReservedKey, WheelZoom, type KeyContext } from "./reservedKeys";
import { adjacentEditor, changeStarts, editorIdsToTheRight, moveWithinGroup, nextChangeLine, otherEditorIds, savedEditorIds, siblingGroup } from "./editorOrder";
import { recentItems } from "./recentLogic";
import { KeybindingResolver, registerCommand } from "./registry";
import { parseUserSnippets, snippetPreview } from "../snippets/snippetLogic";
import { defaultBuildTask } from "../tasks/buildTask";
import { recordToasts, visibleToasts } from "../state/notificationCenter";

const plain: KeyContext = { inEditor: false, inInput: false, inTerminal: false, devtools: false };

describe("browser-reserved keys", () => {
  it("always swallows reload, print and view-source", () => {
    for (const k of ["f5", "mod+r", "mod+shift+r", "mod+f5", "mod+p", "mod+u", "f7"]) {
      expect(isBrowserReservedKey(k, "windows", plain)).toBe(true);
      expect(isBrowserReservedKey(k, "windows", { ...plain, inEditor: true, inInput: true })).toBe(true);
    }
  });
  it("leaves ordinary keys alone", () => {
    for (const k of ["mod+c", "mod+v", "mod+z", "a", "shift+a", "enter", "mod+b"]) expect(isBrowserReservedKey(k, "windows", plain)).toBe(false);
  });
  it("blocks developer tools unless they are allowed", () => {
    expect(isBrowserReservedKey("mod+shift+i", "windows", plain)).toBe(true);
    expect(isBrowserReservedKey("f12", "windows", plain)).toBe(true);
    expect(isBrowserReservedKey("mod+shift+i", "windows", { ...plain, devtools: true })).toBe(false);
  });
  it("keeps the find bar keys for editors, fields and the terminal", () => {
    expect(isBrowserReservedKey("mod+f", "windows", plain)).toBe(true);
    expect(isBrowserReservedKey("mod+f", "windows", { ...plain, inEditor: true })).toBe(false);
    expect(isBrowserReservedKey("f3", "windows", { ...plain, inInput: true })).toBe(false);
    expect(isBrowserReservedKey("mod+f", "windows", { ...plain, inTerminal: true })).toBe(false);
  });
  it("blocks Alt+Left/Right navigation outside editors, never on macOS", () => {
    expect(isBrowserReservedKey("alt+left", "windows", plain)).toBe(true);
    expect(isBrowserReservedKey("alt+right", "linux", plain)).toBe(true);
    expect(isBrowserReservedKey("alt+left", "windows", { ...plain, inEditor: true })).toBe(false);
    expect(isBrowserReservedKey("alt+left", "windows", { ...plain, inInput: true })).toBe(false);
    expect(isBrowserReservedKey("alt+left", "mac", plain)).toBe(false);
  });
  it("turns Ctrl+wheel into whole zoom steps", () => {
    const steps: number[] = [];
    const z = new WheelZoom((d) => steps.push(d), 60, 120);
    expect(z.wheel(-30, 0)).toBe(false);
    expect(z.wheel(-40, 10)).toBe(true);
    // Too soon after a step.
    expect(z.wheel(-100, 50)).toBe(false);
    expect(z.wheel(200, 400)).toBe(true);
    expect(steps).toEqual([1, -1]);
  });
});

describe("the resolver's key-only `when`", () => {
  it("passes the key on to the next command while `when` is false", () => {
    const ran: string[] = [];
    let debugging = false;
    const off = [
      registerCommand({ id: "test.stepInto", title: "Step Into", keybinding: "f11", enabled: () => debugging, run: () => ran.push("step") }),
      registerCommand({ id: "test.fullScreen", title: "Toggle Full Screen", keybinding: "f11", when: () => !debugging, run: () => ran.push("full") }),
    ];
    const r = new KeybindingResolver("windows");
    const key = { key: "F11", code: "F11", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false } as KeyboardEvent;
    expect(r.handle(key)).toBe("executed");
    debugging = true;
    expect(r.handle(key)).toBe("executed");
    expect(ran).toEqual(["full", "step"]);
    off.forEach((f) => f());
  });
});

describe("editor order", () => {
  const tabs = [{ id: "a", sticky: true }, { id: "b" }, { id: "c", dirty: true }, { id: "d" }];
  it("Close Others / to the Right keep pinned tabs", () => {
    expect(otherEditorIds(tabs, "c")).toEqual(["b", "d"]);
    expect(editorIdsToTheRight(tabs, "a")).toEqual(["b", "c", "d"]);
    expect(editorIdsToTheRight(tabs, "d")).toEqual([]);
  });
  it("Close Saved leaves unsaved editors", () => {
    expect(savedEditorIds(tabs)).toEqual(["a", "b", "d"]);
  });
  it("next / previous editor walks into the next group and wraps", () => {
    const groups = [
      { id: 0, editors: [{ id: "a" }, { id: "b" }], activeId: "b" },
      { id: 1, editors: [], activeId: null },
      { id: 2, editors: [{ id: "c" }], activeId: "c" },
    ];
    expect(adjacentEditor(groups, 0, 1)).toEqual({ group: 2, id: "c" });
    expect(adjacentEditor(groups, 0, -1)).toEqual({ group: 0, id: "a" });
    expect(adjacentEditor(groups, 2, 1)).toEqual({ group: 0, id: "a" });
    expect(adjacentEditor(groups, 2, -1)).toEqual({ group: 0, id: "b" });
    expect(adjacentEditor([{ id: 0, editors: [{ id: "x" }], activeId: "x" }], 0, 1)).toBeNull();
  });
  it("moves a tab one place, never across the pinned line", () => {
    expect(moveWithinGroup(tabs, "c", -1)?.map((t) => t.id)).toEqual(["a", "c", "b", "d"]);
    expect(moveWithinGroup(tabs, "b", -1)).toBeNull();
    expect(moveWithinGroup(tabs, "d", 1)).toBeNull();
  });
  it("finds the next / previous group in reading order", () => {
    expect(siblingGroup([3, 1, 2], 1, 1)).toBe(2);
    expect(siblingGroup([3, 1, 2], 3, -1)).toBeNull();
  });
  it("goes to the next / previous change, wrapping", () => {
    const starts = changeStarts([3, 4, 5, 10, 20, 21]);
    expect(starts).toEqual([3, 10, 20]);
    expect(nextChangeLine(starts, 1, 1)).toBe(3);
    expect(nextChangeLine(starts, 4, 1)).toBe(10);
    expect(nextChangeLine(starts, 25, 1)).toBe(3);
    expect(nextChangeLine(starts, 10, -1)).toBe(3);
    expect(nextChangeLine(starts, 2, -1)).toBe(20);
    expect(nextChangeLine([], 2, 1)).toBeNull();
  });
});

describe("Open Recent", () => {
  it("lists other folders first, then this folder's recent files", () => {
    const items = recentItems(
      [
        { name: "here", root: "/w/here" },
        { name: "other", root: "/w/other" },
        { name: "other", root: "/w/other" },
      ],
      ["src/a.py", "b.py", "src/a.py"],
      "/w/here",
    );
    expect(items.map((i) => [i.kind, i.label, i.separator ?? ""])).toEqual([
      ["folder", "other", "folders"],
      ["file", "a.py", "recent files"],
      ["file", "b.py", ""],
    ]);
    expect(items[0].description).toBe("/w");
    expect(items[1].description).toBe("src");
  });
  it("is empty with nothing recent", () => {
    expect(recentItems([{ name: "here", root: "/w/here" }], [], "/w/here")).toEqual([]);
  });
});

describe("user snippets", () => {
  it("reads VS Code's format, with comments and prefix-less snippets", () => {
    const r = parseUserSnippets(`{
      // a comment
      "Print": { "prefix": ["log", "pr"], "body": ["print($1)", "$0"], "description": "Print" },
      "Header": { "body": "# \${1:Title}" },
      "Broken": { "prefix": "x" },
    }`);
    expect(r.error).toBeNull();
    expect(r.snippets).toEqual([
      { name: "Print", prefixes: ["log", "pr"], body: "print($1)\n$0", description: "Print" },
      { name: "Header", prefixes: [], body: "# ${1:Title}" },
    ]);
  });
  it("reports invalid JSON", () => {
    expect(parseUserSnippets("{ nope").error).toBeTruthy();
    expect(parseUserSnippets("[]").error).toBeTruthy();
    expect(parseUserSnippets("   ").snippets).toEqual([]);
  });
  it("previews a body as plain text", () => {
    expect(snippetPreview("for ${1:i} in ${2|range,list|}($3):\n\t$0")).toBe("for i in range():\n\t");
    expect(snippetPreview("${TM_FILENAME:file} \\$5")).toBe("file $5");
  });
});

describe("Run Build Task", () => {
  it("runs the default build task with its arguments and folder", () => {
    const json = `{
      "version": "2.0.0",
      // tasks
      "tasks": [
        { "label": "test", "type": "shell", "command": "npm test", "group": "test" },
        { "label": "build", "type": "shell", "command": "gcc", "args": ["-o", "my app", "main.c"], "options": { "cwd": "\${workspaceFolder}/src" },
          "group": { "kind": "build", "isDefault": true } },
        { "label": "other build", "command": "make", "group": "build" }
      ]
    }`;
    expect(defaultBuildTask(json, "linux")).toEqual({ label: "build", command: 'gcc -o "my app" main.c', cwd: "src" });
  });
  it("takes the only build task, npm scripts and per-OS commands", () => {
    expect(defaultBuildTask(`{"tasks":[{"label":"b","command":"make","group":"build","windows":{"command":"nmake"}}]}`, "windows")?.command).toBe("nmake");
    expect(defaultBuildTask(`{"tasks":[{"type":"npm","script":"build","group":"build"}]}`, "mac")).toEqual({ label: "npm: build", command: "npm run build", cwd: "" });
  });
  it("is null without one", () => {
    expect(defaultBuildTask(`{"tasks":[{"label":"a","command":"x","group":"build"},{"label":"b","command":"y","group":"build"}]}`, "mac")).toBeNull();
    expect(defaultBuildTask("not json", "mac")).toBeNull();
    expect(defaultBuildTask(`{"tasks":[{"label":"t","command":"x","options":{"cwd":"../out"},"group":{"kind":"build","isDefault":true}}]}`, "mac")?.cwd).toBe("");
  });
});

describe("notification centre", () => {
  it("keeps closed toasts and tracks message updates", () => {
    let h = recordToasts([], [{ id: 1, severity: "info", message: "a" }], 1);
    h = recordToasts(h, [{ id: 2, severity: "error", message: "b" }], 2);
    h = recordToasts(h, [{ id: 2, severity: "error", message: "b2" }], 3);
    expect(h.map((x) => [x.id, x.message])).toEqual([
      [2, "b2"],
      [1, "a"],
    ]);
  });
  it("Do Not Disturb shows errors and running operations only", () => {
    const list = [
      { id: 1, severity: "info" as const, message: "i" },
      { id: 2, severity: "error" as const, message: "e" },
      { id: 3, severity: "info" as const, message: "p", progress: null },
    ];
    expect(visibleToasts(list, true).map((n) => n.id)).toEqual([2, 3]);
    expect(visibleToasts(list, false)).toHaveLength(3);
  });
});
