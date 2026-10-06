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
