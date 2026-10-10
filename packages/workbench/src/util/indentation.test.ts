import { describe, expect, it } from "vitest";
import { convertIndentation } from "./indentation";
import { zoomFactor } from "../state/windowZoom";

describe("Convert Indentation", () => {
  it("turns leading tabs into spaces and back", () => {
    expect(convertIndentation("def f():\n\tif x:\n\t\treturn 1\r\n", true, 4)).toBe("def f():\n    if x:\n        return 1\r\n");
    expect(convertIndentation("    a\n      b\n", false, 4)).toBe("\ta\n\t  b\n");
    // Only leading whitespace changes.
    expect(convertIndentation("\tx = '\t'\n", true, 2)).toBe("  x = '\t'\n");
  });
});

describe("window zoom", () => {
  it("is 20 % per level, as in VS Code", () => {
    expect(zoomFactor(0)).toBe(1);
    expect(zoomFactor(1)).toBe(1.2);
    expect(zoomFactor(-1)).toBe(0.833);
  });
});
