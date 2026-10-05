import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../platform/memory";
import { buildRegExp, listFiles, searchText } from "./search";

describe("workspace search", () => {
  it("escapes plain queries and honours options", () => {
    const re = buildRegExp({ query: "a.b", matchCase: false, wholeWord: false, regex: false }) as RegExp;
    expect(re.test("xa.by")).toBe(true);
    expect(re.test("axb")).toBe(false);
    const word = buildRegExp({ query: "avg", matchCase: true, wholeWord: true, regex: false }) as RegExp;
    expect("average avg".match(word)).toHaveLength(1);
    expect(buildRegExp({ query: "(", matchCase: false, wholeWord: false, regex: true })).toMatch(/Invalid regular expression/);
  });

  it("finds matches with 1-based columns and preview offsets", () => {
    const re = buildRegExp({ query: "score", matchCase: false, wholeWord: false, regex: false }) as RegExp;
    const res = searchText("main.py", "x = 1\n    scores = []\n", re, { left: 100 })!;
    expect(res.matches).toHaveLength(1);
    const m = res.matches[0];
    expect(m).toMatchObject({ line: 2, start: 5, end: 10 });
    expect(m.preview.slice(m.previewStart, m.previewEnd)).toBe("score");
  });

  it("walks the workspace skipping dependency folders and binaries", async () => {
    const fs = new MemoryFileSystem({ "a.py": "", "node_modules/x/index.js": "", "img/logo.png": "", "src/b.ts": "" });
    expect(await listFiles(fs)).toEqual(["a.py", "src/b.ts"]);
  });
});
