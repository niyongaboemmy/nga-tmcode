import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlightRuns } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("matches characters in order", () => {
    expect(fuzzyMatch("mpy", "main.py")?.indices).toEqual([0, 5, 6]);
    expect(fuzzyMatch("ypm", "main.py")).toBeNull();
  });

  it("ranks contiguous and word-start matches higher", () => {
    const a = fuzzyMatch("app", "web/app.js")!;
    const b = fuzzyMatch("app", "a/p/p.txt")!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it("prefers the typed phrase over scattered matches", () => {
    const exact = fuzzyMatch("toggle panel", "View: Toggle Panel Visibility")!;
    const scattered = fuzzyMatch("toggle panel", "View: Toggle Maximized Panel")!;
    expect(exact.score).toBeGreaterThan(scattered.score);
    expect(exact.indices[0]).toBe(6);
  });

  it("treats an empty query as a match", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("highlightRuns", () => {
  it("groups adjacent hits", () => {
    expect(highlightRuns("main", [0, 1])).toEqual([
      { text: "ma", hit: true },
      { text: "in", hit: false },
    ]);
  });
});
