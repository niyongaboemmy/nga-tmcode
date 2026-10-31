import { describe, expect, it } from "vitest";
import { hexRow } from "./HexView";

describe("hex rows", () => {
  it("shows offset, 16 bytes with a gap after 8, and printable characters", () => {
    const bytes = Uint8Array.from([0x41, 0x42, 0, 1, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, ...Array(8).fill(0x2e)]);
    expect(hexRow(bytes, 0)).toEqual({ offset: "00000000", hex: "41 42 00 01 68 65 6c 6c  6f ff 2e 2e 2e 2e 2e 2e", ascii: "AB..hello......." });
    const second = hexRow(bytes, 16);
    expect(second.offset).toBe("00000010");
    expect(second.hex.startsWith("2e 2e")).toBe(true);
    expect(second.ascii).toBe("..");
  });
});
