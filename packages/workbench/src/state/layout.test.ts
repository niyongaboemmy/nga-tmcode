import { beforeEach, describe, expect, it } from "vitest";
import { groupOrder, leaf, neighbour, readSavedLayout, reconcile, removeNode, serializeLayout, splitNode, type GridNode } from "./layout";
import { MemoryFileSystem } from "../platform/memory";
import type { Platform } from "../platform/types";
import { addGroup, closeEditors, initWorkbench, moveEditorToNewGroup, openFile, resetWorkbenchForTests, setEditorSticky, setWorkspace, splitEditor, useWorkbench } from "./store";
import { editorMemento } from "./viewStates";

describe("editor grid", () => {
  it("splits right as siblings and down as a nested column", () => {
    let t: GridNode = leaf(0);
    t = splitNode(t, 0, 1, "right");
    expect(t).toEqual({ type: "branch", dir: "row", children: [leaf(0), leaf(1)] });
    t = splitNode(t, 1, 2, "right");
    // Same direction: a third sibling, not a nested row.
    expect(t).toEqual({ type: "branch", dir: "row", children: [leaf(0), leaf(1), leaf(2)] });
    t = splitNode(t, 0, 3, "down");
    expect(t).toEqual({ type: "branch", dir: "row", children: [{ type: "branch", dir: "column", children: [leaf(0), leaf(3)] }, leaf(1), leaf(2)] });
    t = splitNode(t, 3, 4, "up");
    expect(groupOrder(t)).toEqual([0, 4, 3, 1, 2]);
  });

  it("removing a group collapses branches left with one child", () => {
    let t: GridNode = splitNode(splitNode(leaf(0), 0, 1, "down"), 1, 2, "right");
    expect(t).toEqual({ type: "branch", dir: "column", children: [leaf(0), { type: "branch", dir: "row", children: [leaf(1), leaf(2)] }] });
    t = removeNode(t, 2)!;
    expect(t).toEqual({ type: "branch", dir: "column", children: [leaf(0), leaf(1)] });
    t = removeNode(t, 0)!;
    expect(t).toEqual(leaf(1));
    expect(removeNode(t, 1)).toBeNull();
  });

  it("finds neighbours by position", () => {
    // [0 | (1 / 2)]
    const t = splitNode(splitNode(leaf(0), 0, 1, "right"), 1, 2, "down");
    expect(neighbour(t, 0, "right")).toBe(1);
    expect(neighbour(t, 2, "left")).toBe(0);
    expect(neighbour(t, 1, "down")).toBe(2);
    expect(neighbour(t, 2, "up")).toBe(1);
    expect(neighbour(t, 0, "up")).toBeNull();
  });

  it("reconciles the tree with the groups that exist", () => {
    const t = splitNode(leaf(0), 0, 1, "down");
    expect(reconcile(t, [0])).toEqual(leaf(0));
    expect(groupOrder(reconcile(t, [0, 1, 5]))).toEqual([0, 1, 5]);
    expect(reconcile(null, [3])).toEqual(leaf(3));
  });
});

describe("saved layout", () => {
  const groups = [
    { id: 0, editors: [{ kind: "file", id: "a.py", path: "a.py", preview: false, sticky: true }, { kind: "file", id: "b.py", path: "b.py", preview: true }], activeId: "a.py" },
    { id: 4, editors: [{ kind: "settings", id: "settings", preview: false }], activeId: "settings" },
    { id: 7, editors: [{ kind: "file", id: "c.py", path: "c.py", preview: false }], activeId: "c.py" },
  ];

  it("keeps file tabs, pins, splits, sizes and view states; drops groups with nothing to restore", () => {
    const tree = splitNode(splitNode(leaf(0), 0, 4, "right"), 0, 7, "down");
    const saved = serializeLayout(tree, groups, 7, { sizes: { "row:0": [300, 500] }, viewStates: { "0:a.py": { cursor: 3 }, "4:x": {} } });
    expect(saved.groups).toEqual([
      { id: 0, editors: [{ path: "a.py", pinned: true }], active: "a.py" },
      { id: 7, editors: [{ path: "c.py" }], active: "c.py" },
    ]);
    expect(saved.tree).toEqual({ type: "branch", dir: "column", children: [leaf(0), leaf(7)] });
    expect(saved.activeGroup).toBe(7);
    expect(saved.viewStates).toEqual({ "0:a.py": { cursor: 3 } });
    expect(readSavedLayout(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });

  it("reads the old format (paths only)", () => {
    expect(readSavedLayout({ paths: ["a.py", "b.py"], active: "b.py" })).toEqual({
      version: 2,
      tree: leaf(0),
      groups: [{ id: 0, editors: [{ path: "a.py" }, { path: "b.py" }], active: "b.py" }],
      activeGroup: 0,
    });
    expect(readSavedLayout(null)).toBeNull();
    expect(readSavedLayout({ nope: 1 })).toBeNull();
  });
});

describe("editor groups in the store", () => {
  const memory = new Map<string, unknown>();
  beforeEach(async () => {
    resetWorkbenchForTests();
    memory.clear();
    const fs = new MemoryFileSystem({ "a.py": "a\n", "b.py": "b\n", "c.py": "c\n" });
    const platform = {
      kind: "web",
      os: "mac",
      version: "test",
      fs,
      store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
      openFolder: async () => null,
      reopenFolder: async (root: string) => ({ name: "p", root }),
    } as unknown as Platform;
    await initWorkbench(platform);
    await setWorkspace({ name: "p", root: "memory://p" });
  });

  it("splits down, keeps up to the limit, and closes an emptied group", async () => {
    openFile("a.py", { pinned: true });
    splitEditor("down");
    const s = useWorkbench.getState();
    const lower = s.activeGroup;
    expect(s.groups).toHaveLength(2);
    expect(s.editorLayout).toEqual({ type: "branch", dir: "column", children: [leaf(0), leaf(lower)] });
    for (let i = 0; i < 10; i++) addGroup(0, "right");
    expect(useWorkbench.getState().groups).toHaveLength(8);
    await closeEditors(lower, ["a.py"]);
    expect(useWorkbench.getState().groups.some((g) => g.id === lower)).toBe(false);
    expect(groupOrder(useWorkbench.getState().editorLayout)).not.toContain(lower);
  });

  it("pinned tabs stay left and a preview never replaces them", () => {
    openFile("a.py", { pinned: true });
    openFile("b.py", { pinned: true });
    setEditorSticky(0, "b.py", true);
    expect(useWorkbench.getState().groups[0].editors.map((e) => e.id)).toEqual(["b.py", "a.py"]);
    openFile("c.py");
    const editors = useWorkbench.getState().groups[0].editors;
    // Opened next to the active (pinned) tab: the first place after the pinned ones.
    expect(editors.map((e) => [e.id, !!e.sticky, e.preview])).toEqual([
      ["b.py", true, false],
      ["c.py", false, true],
      ["a.py", false, false],
    ]);
    openFile("a.py");
    openFile("b.py");
    openFile("c.py");
    expect(useWorkbench.getState().groups[0].editors.map((e) => e.id)).toEqual(["b.py", "c.py", "a.py"]);
    setEditorSticky(0, "b.py", false);
    expect(useWorkbench.getState().groups[0].editors[0].sticky).toBeFalsy();
  });

  it("a tab dropped on an editor's edge moves into a new group there", () => {
    openFile("a.py", { pinned: true });
    openFile("b.py", { pinned: true });
    moveEditorToNewGroup(0, "b.py", 0, "down");
    const s = useWorkbench.getState();
    expect(s.groups.map((g) => g.editors.map((e) => e.id))).toEqual([["a.py"], ["b.py"]]);
    expect(s.editorLayout.type === "branch" && s.editorLayout.dir).toBe("column");
  });

  it("restores groups, splits, pins and view states when the folder opens again", async () => {
    openFile("a.py", { pinned: true });
    setEditorSticky(0, "a.py", true);
    openFile("b.py", { pinned: true });
    splitEditor("down");
    openFile("c.py", { pinned: true });
    editorMemento.viewStates.set(`${useWorkbench.getState().activeGroup}:c.py`, { cursorState: [] });
    await new Promise((r) => setTimeout(r, 650));
    const saved = memory.get("editors:memory://p") as { groups: unknown[] };
    expect(saved.groups).toHaveLength(2);
    await setWorkspace({ name: "q", root: "memory://q" });
    expect(useWorkbench.getState().groups).toHaveLength(1);
    await setWorkspace({ name: "p", root: "memory://p" });
    const s = useWorkbench.getState();
    expect(s.groups.map((g) => g.editors.map((e) => [e.id, !!e.sticky]))).toEqual([
      [
        ["a.py", true],
        ["b.py", false],
      ],
      [
        ["b.py", false],
        ["c.py", false],
      ],
    ]);
    expect(s.editorLayout.type === "branch" && s.editorLayout.dir).toBe("column");
    expect(editorMemento.viewStates.get(`${s.groups[1].id}:c.py`)).toEqual({ cursorState: [] });
  });
});
