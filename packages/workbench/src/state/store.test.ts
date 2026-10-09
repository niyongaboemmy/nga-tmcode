import { beforeEach, describe, expect, it } from "vitest";
import { MemoryFileSystem, SwitchableFileSystem } from "../platform/memory";
import type { Platform } from "../platform/types";
import { useExam } from "../exam/state";
import { beforeQuit } from "./quit";
import {
  initWorkbench,
  notify,
  notifyProgress,
  openRecent,
  resetWorkbenchForTests,
  saveHandlers,
  setDirty,
  setWorkspace,
  useWorkbench,
  workbench,
} from "./store";

/** Two folders behind one file system, like the desktop host: reopenFolder switches the target. */
function twoFolders() {
  const a = new MemoryFileSystem({ "main.py": "print('A')\n" });
  const b = new MemoryFileSystem({ "main.py": "print('B')\n" });
  const fs = new SwitchableFileSystem(a);
  const memory = new Map<string, unknown>();
  const platform = {
    kind: "web",
    os: "mac",
    version: "test",
    fs,
    store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
    async openFolder() {
      return null;
    },
    async reopenFolder(root: string) {
      fs.target = root === "memory://a" ? a : b;
      return { name: root.slice(9), root };
    },
  } as unknown as Platform;
  return { platform, a, b, fs };
}

/** Answers the dialog that is (or is about to be) open. */
async function answer(id: string) {
  for (let i = 0; i < 50 && !workbench.get().dialog; i++) await new Promise((r) => setTimeout(r, 0));
  const d = workbench.get().dialog;
  if (!d) throw new Error("no dialog");
  const message = d.message;
  d.resolve(id);
  return message;
}

describe("switching folders with unsaved files", () => {
  let env: ReturnType<typeof twoFolders>;
  const saved: string[] = [];
  const discarded: string[] = [];
  beforeEach(async () => {
    resetWorkbenchForTests();
    useExam.setState({ phase: "idle" });
    env = twoFolders();
    saved.length = 0;
    discarded.length = 0;
    saveHandlers.save = async (p) => {
      saved.push(`${env.fs.target === env.a ? "A" : "B"}:${p}`);
      setDirty(p, false);
    };
    saveHandlers.discard = async (p) => {
      discarded.push(p);
      setDirty(p, false);
    };
    await initWorkbench(env.platform);
    await setWorkspace({ name: "a", root: "memory://a" });
  });

  it("Cancel keeps the old folder, and the host still points at it", async () => {
    setDirty("main.py", true);
    const opening = openRecent("memory://b");
    expect(await answer("cancel")).toContain("main.py");
    expect(await opening).toBe(false);
    expect(useWorkbench.getState().workspace?.root).toBe("memory://a");
    expect(useWorkbench.getState().dirty["main.py"]).toBe(true);
    expect(env.fs.target).toBe(env.a);
  });

  it("Save writes the file to the old folder before switching", async () => {
    setDirty("main.py", true);
    const opening = openRecent("memory://b");
    await answer("save");
    expect(await opening).toBe(true);
    expect(saved).toEqual(["A:main.py"]);
    expect(useWorkbench.getState().workspace?.root).toBe("memory://b");
    expect(useWorkbench.getState().dirty).toEqual({});
  });

  it("a host that switched first is pointed back while saving", async () => {
    setDirty("main.py", true);
    await env.platform.reopenFolder("memory://b");
    const opening = setWorkspace({ name: "b", root: "memory://b" });
    await answer("save");
    expect(await opening).toBe(true);
    expect(saved).toEqual(["A:main.py"]);
    expect(env.fs.target).toBe(env.b);
  });

  it("Don't Save drops the changes and switches", async () => {
    setDirty("main.py", true);
    const opening = openRecent("memory://b");
    await answer("discard");
    expect(await opening).toBe(true);
    expect(discarded).toEqual(["main.py"]);
    expect(useWorkbench.getState().workspace?.root).toBe("memory://b");
  });
});

describe("quit guard", () => {
  beforeEach(async () => {
    resetWorkbenchForTests();
    useExam.setState({ phase: "idle", sync: { pending: 0, queued: 0, offline: false, lastSyncedAt: null, tampered: false } });
    await initWorkbench(twoFolders().platform);
  });

  it("closes straight away with nothing unsaved", async () => {
    expect(await beforeQuit()).toBe(true);
  });

  it("asks about unsaved files: Cancel keeps TMCode open, Don't Save quits", async () => {
    setDirty("main.py", true);
    let quitting = beforeQuit();
    await answer("cancel");
    expect(await quitting).toBe(false);
    quitting = beforeQuit();
    await answer("discard");
    expect(await quitting).toBe(true);
  });

  it("in an exam, unsent changes ask first", async () => {
    useExam.setState({ phase: "active", sync: { pending: 2, queued: 1, offline: true, lastSyncedAt: null, tampered: false } });
    let quitting = beforeQuit();
    expect(await answer("keep")).toBe("3 changes haven't reached Task Mentor yet.");
    expect(await quitting).toBe(false);
    quitting = beforeQuit();
    await answer("quit");
    expect(await quitting).toBe(true);
  });
});

describe("notifications", () => {
  beforeEach(() => resetWorkbenchForTests());

  it("never pushes out a notification with buttons or progress", () => {
    notify("warning", "changed on disk", [{ label: "Discard my changes", run: () => {} }]);
    notifyProgress("Cloning…");
    for (let i = 0; i < 8; i++) notify(i % 2 ? "info" : "error", `n${i}`);
    const list = useWorkbench.getState().notifications;
    expect(list).toHaveLength(5);
    expect(list.map((n) => n.message)).toEqual(expect.arrayContaining(["changed on disk", "Cloning…"]));
    // Plain info goes before warnings and errors; of those, the newest stay.
    expect(list.map((n) => n.message).slice(2)).toEqual(["n2", "n4", "n6"]);
  });
});
