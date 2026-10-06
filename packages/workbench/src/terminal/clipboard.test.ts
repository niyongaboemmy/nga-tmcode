import { describe, expect, it } from "vitest";
import { clipboardAction } from "./enhance";

const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...mods });

describe("terminal clipboard keys (VS Code)", () => {
  it("macOS: ⌘C copies only a selection, ⌘V pastes, Ctrl+C stays an interrupt", () => {
    expect(clipboardAction(k("c", { metaKey: true }), true, true)).toBe("copy");
    expect(clipboardAction(k("c", { metaKey: true }), true, false)).toBeNull();
    expect(clipboardAction(k("v", { metaKey: true }), true, false)).toBe("paste");
    expect(clipboardAction(k("c", { ctrlKey: true }), true, true)).toBeNull();
  });
  it("Windows/Linux: Ctrl+C copies with a selection, else interrupts; Ctrl+Shift+C/V; Ctrl+V pastes", () => {
    expect(clipboardAction(k("c", { ctrlKey: true }), false, true)).toBe("copy");
    expect(clipboardAction(k("c", { ctrlKey: true }), false, false)).toBeNull();
    expect(clipboardAction(k("C", { ctrlKey: true, shiftKey: true }), false, true)).toBe("copy");
    expect(clipboardAction(k("v", { ctrlKey: true }), false, false)).toBe("paste");
    expect(clipboardAction(k("V", { ctrlKey: true, shiftKey: true }), false, false)).toBe("paste");
    expect(clipboardAction(k("v", { ctrlKey: true, altKey: true }), false, false)).toBeNull();
  });
});
