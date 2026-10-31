/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { TextmateEngine, loadTextmateLibs } from "./engine";
import { parseJsonc } from "./jsonc";
import { decodeTokens, fontStyleName, loadThemeFile, matchScope, monacoThemeData, monacoTokenRules, normalizeHex, rawThemeOf, resolveRelative, tokenTypeOf, type ResolvedTheme } from "./themeData";
import { BUILTIN_THEMES } from "../themes/themeService";

const require = createRequire(import.meta.url);

describe("parseJsonc", () => {
  it("accepts comments and trailing commas but keeps strings intact", () => {
    const v = parseJsonc<{ a: string; b: number[]; c: { d: string } }>(`{
      // line comment
      "a": "http://x // not a comment, /* nor this */",
      /* block */ "b": [1, 2, ],
      "c": { "d": "q\\"uote", },
    }`);
    expect(v).toEqual({ a: "http://x // not a comment, /* nor this */", b: [1, 2], c: { d: 'q"uote' } });
  });
});

describe("theme data", () => {
  it("normalizes hex colours", () => {
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(normalizeHex("#abcd")).toBe("#AABBCCDD");
    expect(normalizeHex("#1e1E1e")).toBe("#1E1E1E");
    expect(normalizeHex("red")).toBeNull();
    expect(normalizeHex(undefined)).toBeNull();
  });

  it("resolves relative paths inside an extension", () => {
    expect(resolveRelative("themes/dark.json", "./base.json")).toBe("themes/base.json");
    expect(resolveRelative("dist/material-icons.json", "./../icons/a.svg")).toBe("icons/a.svg");
  });

  it("follows include chains with later files winning", async () => {
    const files: Record<string, string> = {
      "t/child.json": JSON.stringify({ name: "Child", include: "./base.json", colors: { "editor.background": "#111111" }, tokenColors: [{ scope: "string", settings: { foreground: "#00ff00" } }] }),
      "t/base.json": `{ "type": "dark", "colors": { "editor.background": "#000000", "editor.foreground": "#eeeeee", }, // jsonc
        "tokenColors": "./tokens.json" }`,
      "t/tokens.json": JSON.stringify([{ scope: "comment", settings: { foreground: "#888888", fontStyle: "italic" } }]),
    };
    const t = await loadThemeFile("t/child.json", { read: async (p) => files[p] }, "vs");
    expect(t.name).toBe("Child");
    expect(t.uiTheme).toBe("vs-dark");
    expect(t.colors).toEqual({ "editor.background": "#111111", "editor.foreground": "#eeeeee" });
    expect(t.tokenColors.map((r) => r.scope)).toEqual(["comment", "string"]);
    await expect(loadThemeFile("t/loop.json", { read: async () => JSON.stringify({ include: "./loop.json" }) })).rejects.toThrow(/cycle/);
  });

  it("encodes textmate metadata as Monaco token types", () => {
    // foreground 7, italic|bold, string
    const meta = (7 << 15) | (3 << 11) | (2 << 8);
    expect(tokenTypeOf(meta)).toBe("tm7.3.string");
    expect(tokenTypeOf(5 << 15)).toBe("tm5.0");
    expect(decodeTokens(new Uint32Array([0, 5 << 15, 3, 5 << 15, 6, (9 << 15) | (1 << 8)]))).toEqual([
      { startIndex: 0, scopes: "tm5.0" },
      { startIndex: 6, scopes: "tm9.0.comment" },
    ]);
    expect(fontStyleName(1 | 4)).toBe("italic underline");
  });

  it("generates one rule per colour id and font style", () => {
    const rules = monacoTokenRules(["", "#D4D4D4", "#1E1E1E", "#569cd6aa"]);
    expect(rules.find((r) => r.token === "tm3")).toEqual({ token: "tm3", foreground: "569CD6" });
    expect(rules.find((r) => r.token === "tm3.2")).toEqual({ token: "tm3.2", foreground: "569CD6", fontStyle: "bold" });
    expect(rules.filter((r) => r.token.startsWith("tm1"))).toHaveLength(16);
  });

  it("colours Monarch tokens from the same theme", () => {
    const theme: ResolvedTheme = {
      name: "x",
      uiTheme: "vs-dark",
      colors: { "editor.foreground": "#cccccc", "editor.background": "#1f1f1f", "sideBar.background": "not-a-colour" },
      tokenColors: [
        { scope: "keyword", settings: { foreground: "#569cd6" } },
        { scope: ["keyword.control", "keyword.other.x"], settings: { foreground: "#c586c0" } },
        { scope: "comment", settings: { foreground: "#6a9955", fontStyle: "italic" } },
      ],
    };
    expect(matchScope(theme, "keyword.control.flow").foreground).toBe("#C586C0");
    expect(matchScope(theme, "keyword.operator").foreground).toBe("#569CD6");
    const data = monacoThemeData(theme, null);
    expect(data.rules[0]).toEqual({ token: "", foreground: "CCCCCC", background: "1F1F1F" });
    expect(data.rules).toContainEqual({ token: "comment", foreground: "6A9955", fontStyle: "italic" });
    expect(data.colors["sideBar.background"]).toBeUndefined();
    expect(rawThemeOf(theme).settings[0]).toEqual({ settings: { foreground: "#CCCCCC", background: "#1F1F1F" } });
  });
});

/** Scopes that upstream grammars include but no grammar package ships (Shiki leaves them uncoloured too). */
const UNSHIPPED = new Set(
  "source.regexp source.asm source.x86 source.x86_64 source.arm source.openesql source.js.regexp source.c++ source.js.jquery source.sassdoc text.elixir text.html.javadoc text.json source.lean4.markdown text.html.markdown.source.gfm.apib text.html.asciidoc text.python.console source.gitconfig text.md source.gfm source.raku text.xml.svg source.vbnet source.dosbatch source.lisp source.pug source.fs source.postscript source.dts source.kconfig text.slim source.srs source.agda text.html.markdown.math source.twig source.yang text.plain source.scss source.postcss source.less text.tex.markdown_latex_combined source.asy source.cpp.embedded.latex source.asymptote source.dot".split(" "),
);

/** Real vscode-textmate + Oniguruma wasm + bundled grammars and VS Code's Dark Modern theme. */
describe("textmate engine", () => {
  const wasm = async () => {
    const buf = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm"));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  };

  async function colours(scope: string, theme: string, lines: string[]) {
    const engine = new TextmateEngine(await loadTextmateLibs(wasm));
    const resolved = await BUILTIN_THEMES.find((t) => t.id === theme)!.load();
    const colorMap = engine.setTheme(rawThemeOf(resolved) as never);
    const grammar = (await engine.grammar(scope))!;
    expect(grammar).toBeTruthy();
    let state = engine.initialState;
    const out: Record<string, string> = {};
    for (const line of lines) {
      const r = engine.tokenizeLine(grammar, line, state);
      state = r.endState;
      r.tokens.forEach((t, i) => {
        const end = r.tokens[i + 1]?.startIndex ?? line.length;
        const text = line.slice(t.startIndex, end).trim();
        const id = Number(/^tm(\d+)/.exec(t.scopes)![1]);
        if (text) out[text] = `${colorMap[id].toUpperCase()}${t.scopes.endsWith("comment") ? " comment" : ""}${t.scopes.endsWith("string") ? " string" : ""}`;
      });
    }
    if (process.env.TM_DEBUG) console.log(out);
    return out;
  }

  it("colours Python exactly like VS Code Dark Modern", async () => {
    const c = await colours("source.python", "dark-modern", ["def letter(average: float) -> str:", "    if 1 >= 80:", '        return "A"  # top grade']);
    expect(c["average"]).toBe("#9CDCFE");
    expect(c["def"]).toBe("#569CD6");
    expect(c["letter"]).toBe("#DCDCAA");
    expect(c["if"]).toBe("#C586C0");
    expect(c["return"]).toBe("#C586C0");
    expect(c["float"]).toBe("#4EC9B0");
    expect(c["80"]).toBe("#B5CEA8");
    expect(c['"A"']).toBe("#CE9178 string");
    expect(c["# top grade"]).toBe("#6A9955 comment");
  });

  it("colours TypeScript/TSX and HTML like VS Code", async () => {
    const ts = await colours("source.tsx", "dark-modern", ["export class Box<T> { value: number = 1; }", "const el = <div className=\"a\">{x}</div>;"]);
    expect(ts["export"]).toBe("#C586C0");
    expect(ts["class"]).toBe("#569CD6");
    expect(ts["Box"]).toBe("#4EC9B0");
    expect(ts["value"]).toBe("#9CDCFE");
    expect(ts["div"]).toBe("#569CD6");
    expect(ts["className"]).toBe("#9CDCFE");
    const html = await colours("text.html.basic", "dark-modern", ['<h1 id="x">Hi</h1>', "<style>", "body { color: red; }", "</style>"]);
    expect(html["h1"]).toBe("#569CD6");
    expect(html["id"]).toBe("#9CDCFE");
    expect(html["body"]).toBe("#D7BA7D");
    expect(html["color"]).toBe("#9CDCFE");
  });

  it("colours a .php file as HTML with PHP inside, HTML before <?php included (VS Code's text.html.php)", async () => {
    const { scopeForLanguage } = await import("./grammars");
    expect(scopeForLanguage("php")).toBe("text.html.php");
    const c = await colours("text.html.php", "dark-modern", ["<!doctype html>", '<h1 class="title">Hi <?= $name ?></h1>', "<?php", "$total = count($items);", "?>", "<p>Done</p>"]);
    // HTML tags and attributes as in an .html file, not PHP operators and constants.
    expect(c["h1"]).toBe("#569CD6");
    expect(c["class"]).toBe("#9CDCFE");
    expect(c["p"]).toBe("#569CD6");
    // The PHP inside <?php … ?> and <?= … ?> as PHP.
    expect(c["$total"] ?? c["total"]).toBe("#9CDCFE");
    expect(c["count"]).toBe("#DCDCAA");
  });

  it("colours .env files: comments, keys, values, numbers, booleans, quotes and interpolation all differ", async () => {
    const env = [
      "# Database settings",
      "export DB_HOST=localhost",
      "DB_PORT=5432",
      "DEBUG=true",
      'API_URL="https://${DB_HOST}:8080/api\\n"   # trailing note',
      "SECRET='p@ss$word'",
      "EMPTY=",
    ];
    const c = await colours("source.dotenv", "dark-modern", env);
    expect(c["# Database settings"]).toBe("#6A9955 comment");
    expect(c["# trailing note"]).toBe("#6A9955 comment");
    expect(c["export"]).toBe("#569CD6");
    expect(c["DB_PORT"]).toBe("#9CDCFE");
    expect(c["localhost"]).toBe("#CE9178 string");
    expect(c["5432"]).toBe("#B5CEA8");
    expect(c["true"]).toBe("#569CD6");
    expect(c['"https://']).toBe("#CE9178 string");
    expect(c["${"]).toBe("#569CD6 string");
    expect(c["DB_HOST"]).toBe("#9CDCFE string"); // inside "…${DB_HOST}…"
    expect(c["API_URL"]).toBe("#9CDCFE");
    expect(c["\\n"]).toBe("#D7BA7D string");
    expect(c["'p@ss$word'"]).toBe("#CE9178 string");
    // Key, value and comment never share a colour, in the light theme too.
    const light = await colours("source.dotenv", "light-modern", env);
    expect(new Set([light["# Database settings"], light["DB_PORT"], light["localhost"]]).size).toBe(3);
  });

  it("colours ignore files, requirements.txt, go.mod and crontab", async () => {
    const ignore = await colours("source.ignore", "dark-modern", ["# build output", "dist/", "*.log", "!keep.log"]);
    expect(ignore["# build output"]).toBe("#6A9955 comment");
    expect(ignore["dist/"]).toBe("#CE9178 string");
    expect(ignore["*"]).toBe("#569CD6");
    expect(ignore["!"]).toBe("#C586C0");
    const req = await colours("source.pip-requirements", "dark-modern", ["# pinned", "requests[socks]>=2.31,<3 ; python_version >= \"3.9\"", "-r base.txt"]);
    expect(req["# pinned"]).toBe("#6A9955 comment");
    expect(req["requests"]).toBe("#4EC9B0");
    expect(req["2.31"]).toBe("#B5CEA8");
    expect(req["python_version"]).toBe("#9CDCFE");
    expect(req["-r"]).toBe("#569CD6");
    const mod = await colours("source.gomod", "dark-modern", ["module example.com/app", "go 1.22", "require golang.org/x/net v0.24.0 // indirect"]);
    expect(mod["module"]).toBe("#569CD6");
    expect(mod["golang.org/x/net"]).toBe("#4EC9B0");
    expect(mod["v0.24.0"]).toBe("#B5CEA8");
    expect(mod["// indirect"]).toBe("#6A9955 comment");
    const cron = await colours("source.crontab", "dark-modern", ["MAILTO=ops@example.com", "*/5 * * * * /usr/bin/backup --quiet", "@daily echo hi"]);
    expect(cron["MAILTO"]).toBe("#9CDCFE");
    expect(cron["5"]).toBe("#B5CEA8");
    expect(cron["@daily"]).toBe("#569CD6");
    expect(cron["echo"]).toBe("#DCDCAA");
    expect(cron["/usr/bin/backup"]).toBe("#DCDCAA");
  });

  it("every language resolves to a grammar that tokenizes, and every grammar it embeds is bundled", async () => {
    const { grammarFor, scopeForLanguage, tmLanguages } = await import("./grammars");
    const engine = new TextmateEngine(await loadTextmateLibs(wasm));
    engine.setTheme(rawThemeOf(await BUILTIN_THEMES.find((t) => t.id === "dark-modern")!.load()) as never);
    const sample = ['# comment // comment -- comment ; comment', 'name = "value" + 42 <tag attr="x">{x}</tag>', "  if (x) { return f(1, 'two'); }"];
    const scopes = new Set(tmLanguages().map((l) => scopeForLanguage(l)!));
    expect(scopes.size).toBeGreaterThan(150);
    for (const scope of scopes) {
      const grammar = await engine.grammar(scope);
      expect(grammar, scope).toBeTruthy();
      let state = engine.initialState;
      for (const line of sample) state = engine.tokenizeLine(grammar!, line, state).endState;
    }
    expect(engine.errors).toEqual([]);
    // Embedded grammars (`include: "source.x"`) reachable from any language, minus scopes no grammar
    // package ships (upstream grammars reference them; that code just stays uncoloured, as in Shiki).
    const missing = new Set<string>();
    const seen = new Set<string>();
    const queue = [...scopes];
    while (queue.length) {
      const scope = queue.pop()!;
      if (seen.has(scope)) continue;
      seen.add(scope);
      const def = grammarFor(scope);
      if (!def) {
        missing.add(scope);
        continue;
      }
      const src = await def.load();
      JSON.stringify(src.kind === "object" ? src.value : {}, (k, v) => {
        if (k === "include" && typeof v === "string" && !v.startsWith("#") && !v.startsWith("$")) queue.push(v.split("#")[0]);
        return v;
      });
    }
    expect([...missing].filter((s) => !UNSHIPPED.has(s)).sort()).toEqual([]);
    // Loads and tokenizes 200+ grammars: seconds on a slow CI runner.
  }, 60_000);

  it("uses the light palette for Light Modern", async () => {
    const c = await colours("source.python", "light-modern", ["def f(): return 'x'"]);
    expect(c["def"]).toBe("#0000FF");
    expect(c["f"]).toBe("#795E26");
    expect(c["return"]).toBe("#AF00DB");
  });
});
