import { describe, expect, it } from "vitest";
import { menusThatFit } from "./TitleBar";

describe("title bar menus that fit (L6)", () => {
  const widths = [40, 40, 60, 50, 40, 40, 40, 40]; // File … Help
  it("keeps every menu when there is room", () => expect(menusThatFit(widths, 400)).toBe(8));
  it("moves the rest into … and leaves room for its button", () => {
    expect(menusThatFit(widths, 200, 30)).toBe(3);
    expect(menusThatFit(widths, 30, 30)).toBe(0);
  });
});
