import { describe, expect, it } from "vitest";
import { copyName } from "./fileClipboard";

describe("Explorer copy names (VS Code)", () => {
  it("adds ' copy', then ' copy 2'… before the extension", () => {
    const taken = new Set(["main.py"]);
    expect(copyName("main.py", (n) => taken.has(n))).toBe("main copy.py");
    taken.add("main copy.py");
    expect(copyName("main.py", (n) => taken.has(n))).toBe("main copy 2.py");
  });
  it("folders and dotfiles keep their whole name", () => {
    expect(copyName("src.v2", () => false, true)).toBe("src.v2 copy");
    expect(copyName(".env", () => false)).toBe(".env copy");
  });
});
