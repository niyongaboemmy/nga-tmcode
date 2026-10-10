import { describe, expect, it } from "vitest";
import { changeCount, planSync, sameManifest, type Manifest } from "./plan";

const m = (o: Record<string, string>): Manifest => Object.entries(o).map(([path, sha256]) => ({ path, sha256, size: 1 }));

describe("sync planner", () => {
  it("nothing changed", () => {
    const base = m({ "a.cpp": "1", "b.h": "2" });
    const p = planSync(base, base, base);
    expect(changeCount(p.localChanges) + changeCount(p.remoteChanges) + p.conflicts.length).toBe(0);
  });

  it("local edits: added, modified, deleted", () => {
    const base = m({ "a.cpp": "1", "b.h": "2" });
    const p = planSync(base, m({ "a.cpp": "9", "c.txt": "3" }), base);
    expect(p.localChanges).toEqual({ added: ["c.txt"], modified: ["a.cpp"], deleted: ["b.h"] });
    expect(changeCount(p.remoteChanges)).toBe(0);
    expect(p.next.map((e) => e.path)).toEqual(["a.cpp", "c.txt"]);
  });

  it("remote edits come down", () => {
    const base = m({ "a.cpp": "1", "b.h": "2" });
    const p = planSync(base, base, m({ "a.cpp": "5", "new.md": "7" }));
    expect(p.remoteChanges).toEqual({ added: ["new.md"], modified: ["a.cpp"], deleted: ["b.h"] });
    expect(p.conflicts).toEqual([]);
  });

  it("both sides: same content is not a conflict, different content is", () => {
    const base = m({ "a.cpp": "1", "b.h": "2" });
    const p = planSync(base, m({ "a.cpp": "x", "b.h": "same" }), m({ "a.cpp": "y", "b.h": "same" }));
    expect(p.conflicts).toEqual(["a.cpp"]);
    expect(changeCount(p.localChanges)).toBe(0);
  });

  it("deleted here, edited there is a conflict", () => {
    const base = m({ "a.cpp": "1" });
    expect(planSync(base, m({}), m({ "a.cpp": "2" })).conflicts).toEqual(["a.cpp"]);
  });

  it("first sync of an existing folder against a new project uploads everything", () => {
    const p = planSync(null, m({ "main.cpp": "1" }), null);
    expect(p.localChanges.added).toEqual(["main.cpp"]);
  });

  it("first sync with both sides populated: equal files agree, different ones conflict", () => {
    const p = planSync(null, m({ "a": "1", "b": "2", "only-local": "3" }), m({ "a": "1", "b": "9", "only-remote": "4" }));
    expect(p.conflicts).toEqual(["b"]);
    expect(p.localChanges.added).toEqual(["only-local"]);
    expect(p.remoteChanges.added).toEqual(["only-remote"]);
  });

  it("sameManifest ignores order", () => {
    expect(sameManifest(m({ a: "1", b: "2" }), m({ b: "2", a: "1" }))).toBe(true);
    expect(sameManifest(m({ a: "1" }), m({ a: "2" }))).toBe(false);
    expect(sameManifest(null, m({}))).toBe(false);
  });
});

describe("left-out files (too large, over the caps, ignored)", () => {
  it("a file that grew past the size limit is not a deletion: its saved copy stays", () => {
    const base = m({ "a.js": "1", "data.csv": "2" });
    const p = planSync(base, m({ "a.js": "1" }), base, [{ path: "data.csv" }]);
    expect(changeCount(p.localChanges)).toBe(0);
    expect(p.next.map((e) => e.path)).toEqual(["a.js", "data.csv"]);
    expect(p.next.find((e) => e.path === "data.csv")?.sha256).toBe("2");
  });

  it("without the skipped list the same scan reads as a deletion (the old bug)", () => {
    const base = m({ "a.js": "1", "data.csv": "2" });
    expect(planSync(base, m({ "a.js": "1" }), base).localChanges.deleted).toEqual(["data.csv"]);
  });

  it("a whole left-out folder keeps every saved file under it", () => {
    const base = m({ "a.js": "1", "coverage/x.info": "2", "coverage/y/z": "3", "coverage2.txt": "4" });
    const p = planSync(base, m({ "a.js": "1" }), base, [{ path: "coverage", dir: true }]);
    expect(p.localChanges.deleted).toEqual(["coverage2.txt"]);
  });

  it("changed in Task Mentor while too big here: a conflict, never overwritten", () => {
    const base = m({ "data.csv": "2" });
    const p = planSync(base, m({}), m({ "data.csv": "9" }), [{ path: "data.csv" }]);
    expect(p.conflicts).toEqual(["data.csv"]);
    expect(changeCount(p.remoteChanges)).toBe(0);
    const gone = planSync(base, m({}), m({}), [{ path: "data.csv" }]);
    expect(gone.conflicts).toEqual(["data.csv"]);
    expect(gone.remoteChanges.deleted).toEqual([]);
  });

  it("first sync: a left-out file Task Mentor has agrees, one it lacks is just not uploaded", () => {
    const p = planSync(null, m({ "a.js": "1" }), m({ "a.js": "1", "big.bin": "7" }), [{ path: "big.bin" }, { path: "other.bin" }]);
    expect(changeCount(p.localChanges) + changeCount(p.remoteChanges) + p.conflicts.length).toBe(0);
    expect(p.next.map((e) => e.path)).toEqual(["a.js", "big.bin"]);
  });
});
