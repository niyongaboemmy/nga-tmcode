import { describe, expect, it } from "vitest";
import { terminalFindDecorations } from "./workbenchColors";

const theme = (uiTheme: "vs" | "vs-dark" | "hc-black", colors: Record<string, string> = {}) => ({ name: "t", uiTheme, colors, tokenColors: [] });

describe("terminal find colours", () => {
  it("come from the theme, made opaque over the terminal background", () => {
    const d = terminalFindDecorations(theme("vs-dark", { "editor.findMatchHighlightBackground": "#FF000080", "editor.findMatchBackground": "#123456" }), "#000000");
    expect(d.matchBackground).toBe("#800000");
    expect(d.activeMatchBackground).toBe("#123456");
    for (const v of Object.values(d)) expect(v).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("differ between light and dark, and high contrast gets borders", () => {
    const light = terminalFindDecorations(theme("vs"), "#F8F8F8");
    const dark = terminalFindDecorations(theme("vs-dark"), "#181818");
    expect(light.activeMatchBackground).not.toBe(dark.activeMatchBackground);
    expect(light.matchBackground).not.toBe(dark.matchBackground);
    expect(terminalFindDecorations(theme("hc-black"), "#000000").matchBorder).toBe("#F38518");
    expect("matchBorder" in dark).toBe(false);
  });
});
