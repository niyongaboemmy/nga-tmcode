import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingResolver, allCommands, formatKeybinding, registerCommand } from "./registry";

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
