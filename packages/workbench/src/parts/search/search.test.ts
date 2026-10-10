import { describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../../platform/memory";
import { buildRegExp, listFiles, matchKey, planReplace, searchText } from "./search";

const re = (query: string, o: { regex?: boolean; matchCase?: boolean; wholeWord?: boolean } = {}) =>
  buildRegExp({ query, matchCase: !!o.matchCase, wholeWord: !!o.wholeWord, regex: !!o.regex }) as RegExp;

describe("workspace search", () => {
  it("escapes plain queries and honours options", () => {
    const r = re("a.b");
    expect(r.test("xa.by")).toBe(true);
    expect(r.test("axb")).toBe(false);
    expect("average avg".match(re("avg", { matchCase: true, wholeWord: true }))).toHaveLength(1);
    expect(buildRegExp({ query: "(", matchCase: false, wholeWord: false, regex: true })).toMatch(/Invalid regular expression/);
  });

  it("finds matches with 1-based columns and preview offsets", () => {
    const res = searchText("main.py", "x = 1\n    scores = []\n", re("score"), { left: 100 })!;
    expect(res.matches).toHaveLength(1);
    const m = res.matches[0];
    expect(m).toMatchObject({ line: 2, start: 5, end: 10, text: "score" });
    expect(m.preview.slice(m.previewStart, m.previewEnd)).toBe("score");
  });

  it("walks the workspace skipping excluded folders, binaries and .gitignore'd files", async () => {
    const fs = new MemoryFileSystem({
      "a.py": "",
      "node_modules/x/index.js": "",
      "img/logo.png": "",
      "src/b.ts": "",
      ".git/HEAD": "",
      ".gitignore": "*.log\nout/\n",
      "debug.log": "",
      "out/x.js": "",
      ".tmcode/history/x.txt": "",
    });
    expect(await listFiles(fs)).toEqual([".gitignore", "a.py", "src/b.ts"]);
    expect(await listFiles(fs, { useIgnoreFiles: false })).toEqual([".gitignore", "a.py", "debug.log", "out/x.js", "src/b.ts"]);
    // "Use Exclude Settings and Ignore Files" off: only TMCode's own folder stays out.
    expect(await listFiles(fs, { settingsExclude: "", useIgnoreFiles: false })).toContain("node_modules/x/index.js");
    expect(await listFiles(fs, { settingsExclude: "", useIgnoreFiles: false })).not.toContain(".tmcode/history/x.txt");
  });

  it("files to include / exclude", async () => {
    const fs = new MemoryFileSystem({ "a.py": "", "src/b.py": "", "src/c.ts": "", "tests/test_b.py": "" });
    expect(await listFiles(fs, { include: "*.py" })).toEqual(["a.py", "src/b.py", "tests/test_b.py"]);
    expect(await listFiles(fs, { include: "src/**" })).toEqual(["src/b.py", "src/c.ts"]);
    expect(await listFiles(fs, { include: "*.py", exclude: "tests" })).toEqual(["a.py", "src/b.py"]);
  });
});

describe("replace planning", () => {
  it("replaces every match, keeping line endings", () => {
    const plan = planReplace("total = 1\r\ntotal += total\n", re("total"), "sum", { regex: false });
    expect(plan).toEqual({ text: "sum = 1\r\nsum += sum\n", count: 3 });
  });

  it("replaces only the chosen matches", () => {
    const text = "a a\na\n";
    const hits = searchText("f", text, re("a"), { left: 10 })!.matches;
    const only = new Set([matchKey(hits[1])]);
    expect(planReplace(text, re("a"), "b", { regex: false, only })).toEqual({ text: "a b\na\n", count: 1 });
  });

  it("expands groups and escapes in regex mode, never in plain mode", () => {
    expect(planReplace("def f(x):", re("def (\\w+)", { regex: true }), "async def $1", { regex: true }).text).toBe("async def f(x):");
    expect(planReplace("a-b", re("(?<l>a)-(?<r>b)", { regex: true }), "$<r>\\t$<l>$$", { regex: true }).text).toBe("b\ta$");
    expect(planReplace("price", re("price"), "$1 & $&", { regex: false }).text).toBe("$1 & $&");
  });

  it("is case-aware and whole-word aware", () => {
    expect(planReplace("Avg avg average", re("avg", { wholeWord: true }), "mean", { regex: false })).toEqual({ text: "mean mean average", count: 2 });
    expect(planReplace("Avg avg", re("avg", { matchCase: true }), "x", { regex: false }).text).toBe("Avg x");
  });
});
