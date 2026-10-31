import { describe, expect, it } from "vitest";
import { BACKUP_LIMITS, selectBackups } from "./backups";

describe("hot exit backups", () => {
  it("backs up every unsaved file that fits", () => {
    const out = selectBackups([{ path: "a.py", text: "x" }, { path: "tmcode-untitled:Untitled-1", text: "notes" }], 42);
    expect(out).toEqual([
      { path: "a.py", text: "x", at: 42 },
      { path: "tmcode-untitled:Untitled-1", text: "notes", at: 42 },
    ]);
  });

  it("skips files over the per-file limit and stops at the total", () => {
    const big = "y".repeat(BACKUP_LIMITS.file + 1);
    const part = "z".repeat(BACKUP_LIMITS.file);
    const files = [{ path: "huge.log", text: big }, ...Array.from({ length: 7 }, (_, i) => ({ path: `f${i}`, text: part }))];
    const out = selectBackups(files);
    expect(out.map((e) => e.path)).not.toContain("huge.log");
    expect(out.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(BACKUP_LIMITS.total);
    expect(out).toHaveLength(Math.floor(BACKUP_LIMITS.total / BACKUP_LIMITS.file));
  });
});
