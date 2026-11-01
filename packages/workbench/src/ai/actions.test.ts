import { describe, expect, it } from "vitest";
import { parseReview, parseTour } from "./actions";

describe("the AI reviewer's comments (E5)", () => {
  it("reads L<line> (<kind>): comment lines, warnings for bugs and risks", () => {
    expect(parseReview("Here you go:\nL3 (bug): The loop never updates biggest.\n- L10 (style): A clearer name helps.\nL7: Consider an empty list.\nnot a comment")).toEqual([
      { line: 3, severity: "warning", comment: "The loop never updates biggest." },
      { line: 10, severity: "info", comment: "A clearer name helps." },
      { line: 7, severity: "info", comment: "Consider an empty list." },
    ]);
  });
});

describe("the code tour (N6)", () => {
  it("keeps stops in files that exist, in order", () => {
    const exists = (p: string) => ["src/app.js", "src/cart.js"].includes(p);
    expect(parseTour("1. src/app.js:1 — The app starts here.\n2. `src/cart.js:4` — Totals are added up.\nsrc/ghost.js:2 — Not real.", exists)).toEqual([
      { path: "src/app.js", line: 1, text: "The app starts here." },
      { path: "src/cart.js", line: 4, text: "Totals are added up." },
    ]);
  });
});
