import { describe, expect, it } from "vitest";
import { CommandLineTracker } from "./history";

const track = (...chunks: string[]) => {
  const out: string[] = [];
  const t = new CommandLineTracker((c) => out.push(c));
  chunks.forEach((c) => t.feed(c));
  return out;
};

describe("terminal command tracking", () => {
  it("records typed lines with backspace applied", () => {
    expect(track("n", "p", "m", " ", "r", "x", "\x7f", "u", "n", " dev", "\r")).toEqual(["npm run dev"]);
  });
  it("records pasted commands", () => {
    expect(track("\x1b[200~git status\x1b[201~", "\r")).toEqual(["git status"]);
  });
  it("skips lines edited with arrows or completed with Tab, and Ctrl+C clears", () => {
    expect(track("\x1b[A", "\r", "ls sr", "\t", "\r", "abc", "\x03", "pwd\r")).toEqual(["pwd"]);
  });
});
