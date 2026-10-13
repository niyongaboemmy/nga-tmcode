import { readFileSync } from "node:fs";

interface Stats {
  lines: number;
  words: number;
  longest: string;
}

function count(text: string): Stats {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const words = lines.flatMap((line) => line.trim().split(/\s+/));
  const longest = words.reduce((best, w) => (w.length > best.length ? w : best), "");
  return { lines: lines.length, words: words.length, longest };
}

const stats = count(readFileSync(0, "utf8"));
console.log(`Lines: ${stats.lines}`);
console.log(`Words: ${stats.words}`);
console.log(`Longest: ${stats.longest || "-"}`);
