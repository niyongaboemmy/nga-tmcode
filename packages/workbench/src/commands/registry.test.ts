import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeybindingResolver,
  allCommands,
  defaultKeybindingFor,
  dispatchKeybindingFor,
  formatKeybinding,
  keybindingFor,
  registerCommand,
  setEditorDefaultKeybindings,
  setUserKeybindings,
  suspendKeybindings,
} from "./registry";

function key(init: Partial<KeyboardEvent> & { key: string; code: string }) {
  return new KeyboardEvent("keydown", init);
}

describe("formatKeybinding", () => {
  it("uses symbols on macOS and names elsewhere", () => {
    expect(formatKeybinding("mod+shift+p", "mac")).toBe("⇧⌘P");
    expect(formatKeybinding("mod+shift+p", "windows")).toBe("Ctrl+Shift+P");
    expect(formatKeybinding("mod+k mod+t", "mac")).toBe("⌘K ⌘T");
    expect(formatKeybinding("ctrl+`", "mac")).toBe("⌃`");
  });
});

describe("KeybindingResolver", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    disposers.splice(0).forEach((d) => d());
    expect(allCommands()).toHaveLength(0);
  });

  it("runs a direct binding with the platform modifier", () => {
    const run = vi.fn();
    disposers.push(registerCommand({ id: "a", title: "A", keybinding: "mod+shift+p", run }));
    const mac = new KeybindingResolver("mac");
    expect(mac.handle(key({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))).toBe("executed");
    const win = new KeybindingResolver("windows");
    expect(win.handle(key({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))).toBe("none");
    expect(win.handle(key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe("executed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("supports two-step chords", () => {
    const run = vi.fn();
    const pending = vi.fn();
    disposers.push(registerCommand({ id: "theme", title: "Theme", keybinding: "mod+k mod+t", run }));
    const r = new KeybindingResolver("mac", pending);
    expect(r.handle(key({ key: "k", code: "KeyK", metaKey: true }))).toBe("chord");
    expect(pending).toHaveBeenLastCalledWith("⌘K");
    expect(r.handle(key({ key: "t", code: "KeyT", metaKey: true }))).toBe("executed");
    expect(run).toHaveBeenCalledOnce();
    expect(pending).toHaveBeenLastCalledWith(null);
  });

  it("skips disabled commands", () => {
    const run = vi.fn();
    disposers.push(registerCommand({ id: "t", title: "T", keybinding: "ctrl+`", enabled: () => false, run }));
    const r = new KeybindingResolver("windows");
    expect(r.handle(key({ key: "`", code: "Backquote", ctrlKey: true }))).toBe("none");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("user keybindings", () => {
  const disposers: (() => void)[] = [];
  afterEach(() => {
    disposers.splice(0).forEach((d) => d());
    setUserKeybindings({});
    setEditorDefaultKeybindings(new Map());
    suspendKeybindings(false);
  });

  it("an override replaces the default key, and an empty one removes it", () => {
    const run = vi.fn();
    disposers.push(registerCommand({ id: "a", title: "A", keybinding: "mod+shift+p", run }));
    const r = new KeybindingResolver("mac");
    setUserKeybindings({ a: "mod+alt+j" });
    expect(r.handle(key({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }))).toBe("none");
    expect(r.handle(key({ key: "j", code: "KeyJ", metaKey: true, altKey: true }))).toBe("executed");
    expect(keybindingFor(allCommands()[0], "mac")).toBe("mod+alt+j");
    expect(defaultKeybindingFor(allCommands()[0], "mac")).toBe("mod+shift+p");
    setUserKeybindings({ a: "" });
    expect(keybindingFor(allCommands()[0], "mac")).toBeUndefined();
    expect(r.handle(key({ key: "j", code: "KeyJ", metaKey: true, altKey: true }))).toBe("none");
    expect(run).toHaveBeenCalledOnce();
  });

  it("shows Monaco's own keys but never dispatches them from the workbench", () => {
    const run = vi.fn();
    disposers.push(registerCommand({ id: "editor.action.copyLinesDownAction", title: "Copy Line Down", editorOwned: true, run }));
    setEditorDefaultKeybindings(new Map([["editor.action.copyLinesDownAction", "alt+shift+down"]]));
    expect(keybindingFor(allCommands()[0], "mac")).toBe("alt+shift+down");
    expect(dispatchKeybindingFor(allCommands()[0], "mac")).toBeUndefined();
    const r = new KeybindingResolver("mac");
    expect(r.handle(key({ key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true }))).toBe("none");
    expect(run).not.toHaveBeenCalled();
  });

  it("lets every key through while one is being recorded", () => {
    const run = vi.fn();
    disposers.push(registerCommand({ id: "s", title: "S", keybinding: "mod+s", run }));
    const r = new KeybindingResolver("windows");
    suspendKeybindings(true);
    expect(r.handle(key({ key: "s", code: "KeyS", ctrlKey: true }))).toBe("none");
    suspendKeybindings(false);
    expect(r.handle(key({ key: "s", code: "KeyS", ctrlKey: true }))).toBe("executed");
  });
});
