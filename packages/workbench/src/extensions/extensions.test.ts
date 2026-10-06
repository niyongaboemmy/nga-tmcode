/// <reference types="node" />
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { contributionSummary, hasNoUsableParts, localize, normalizeExtensionPath, parseLanguageConfiguration, parseManifest, parseSnippets } from "./manifest";
import { formatCount, normalizeGalleryExtension, searchUrl } from "./gallery";
import { unpackVsix } from "./vsix";
import { cssVarsForTheme, terminalThemeFor } from "../themes/workbenchColors";
import { iconFor, fontCharacter, type IconThemeDocument } from "../themes/iconThemes";
import { loadThemeFile, monacoThemeData, uiThemeOf } from "../textmate/themeData";

/** A minimal zip writer (stored or deflated entries) for .vsix fixtures. */
function zip(entries: { name: string; text: string; deflate?: boolean }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(enc.encode(e.text));
    const data = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cdBuf, end]));
}

const MANIFEST = JSON.stringify({
  name: "night-owl-lite",
  publisher: "Sarah",
  version: "1.2.3",
  displayName: "%displayName%",
  description: "%description%",
  icon: "./images/icon.png",
  categories: ["Themes"],
  main: "./out/extension.js",
  contributes: {
    themes: [
      { label: "Night Owl Lite", uiTheme: "vs-dark", path: "./themes/night.json" },
      { id: "owl-light", label: "%light%", uiTheme: "vs", path: "themes/light.json" },
      { label: "Escapes", uiTheme: "vs", path: "../../etc/passwd" },
    ],
    iconThemes: [{ id: "owl-icons", label: "Owl Icons", path: "./icons/owl.json" }],
    grammars: [
      { language: "owl", scopeName: "source.owl", path: "./syntaxes/owl.tmLanguage.json", embeddedLanguages: { "meta.embedded.js": "javascript" } },
      { scopeName: "todo.injection", path: "./syntaxes/todo.json", injectTo: ["source.js", "source.python"] },
    ],
    languages: [{ id: "owl", aliases: ["Owl", "owl"], extensions: [".owl"], configuration: "./language-configuration.json" }],
    snippets: [{ language: "owl", path: "./snippets/owl.code-snippets" }],
    commands: [{ command: "owl.hello", title: "Hello" }],
    keybindings: [],
  },
});

describe("extension manifest", () => {
  it("parses contributions, localises %keys% and keeps paths inside the extension", () => {
    const m = parseManifest(MANIFEST, { displayName: "Night Owl Lite", description: { message: "A theme" }, light: "Owl Light" });
    expect(m.id).toBe("sarah.night-owl-lite");
    expect(m.displayName).toBe("Night Owl Lite");
    expect(m.description).toBe("A theme");
    expect(m.icon).toBe("images/icon.png");
    expect(m.hasCode).toBe(true);
    expect(m.themes).toEqual([
      { id: undefined, label: "Night Owl Lite", uiTheme: "vs-dark", path: "themes/night.json" },
      { id: "owl-light", label: "Owl Light", uiTheme: "vs", path: "themes/light.json" },
    ]);
    expect(m.iconThemes).toEqual([{ id: "owl-icons", label: "Owl Icons", path: "icons/owl.json" }]);
    expect(m.grammars[0]).toMatchObject({ language: "owl", scopeName: "source.owl", path: "syntaxes/owl.tmLanguage.json" });
    expect(m.grammars[1].injectTo).toEqual(["source.js", "source.python"]);
    expect(m.languages[0]).toMatchObject({ id: "owl", extensions: [".owl"], configuration: "language-configuration.json" });
    expect(m.snippets).toEqual([{ language: "owl", path: "snippets/owl.code-snippets" }]);
    expect(m.unsupported).toEqual(["commands", "keybindings"]);
    expect(contributionSummary(m)).toEqual(["2 color themes", "1 file icon theme", "1 language", "2 grammars", "1 snippet file"]);
    expect(hasNoUsableParts(m)).toBe(false);
  });

  it("detects code-only extensions and rejects non-extensions", () => {
    const m = parseManifest(JSON.stringify({ name: "x", publisher: "p", browser: "./dist/web.js", contributes: { commands: [] } }));
    expect(m.hasCode).toBe(true);
    expect(hasNoUsableParts(m)).toBe(true);
    expect(parseManifest(`{ "name": "y", "publisher": "q", /* jsonc */ }`).hasCode).toBe(false);
    expect(() => parseManifest(JSON.stringify({ name: "no-publisher" }))).toThrow(/publisher/);
    expect(localize("%missing%", {})).toBe("%missing%");
    expect(normalizeExtensionPath("./a/../b")).toBeUndefined();
    expect(normalizeExtensionPath("a\\b.json")).toBe("a/b.json");
  });

  it("converts language-configuration.json into Monaco's shape", () => {
    const cfg = parseLanguageConfiguration(`{
      "comments": { "lineComment": "#", "blockComment": ["/*", "*/"] },
      "brackets": [["{", "}"], ["[", "]"]],
      "autoClosingPairs": [{ "open": "\\"", "close": "\\"", "notIn": "string" }, ["(", ")"]],
      "surroundingPairs": [["'", "'"]],
      "wordPattern": "[a-z]+",
      "folding": { "offSide": true, "markers": { "start": "^\\\\s*#region", "end": "^\\\\s*#endregion" } },
      "indentationRules": { "increaseIndentPattern": { "pattern": ":\\\\s*$", "flags": "i" }, "decreaseIndentPattern": "^\\\\s*end" },
      "onEnterRules": [{ "beforeText": ":\\\\s*$", "action": { "indent": "indent" } }, { "beforeText": "(", "action": { "indent": "none" } }],
    }`);
    expect(cfg.comments).toEqual({ lineComment: "#", blockComment: ["/*", "*/"] });
    expect(cfg.brackets).toEqual([["{", "}"], ["[", "]"]]);
    expect(cfg.autoClosingPairs).toEqual([{ open: '"', close: '"', notIn: ["string"] }, { open: "(", close: ")" }]);
    expect(cfg.wordPattern?.source).toBe("[a-z]+");
    expect(cfg.folding?.offSide).toBe(true);
    expect(cfg.folding?.markers?.start.test("  #region x")).toBe(true);
    expect(cfg.indentationRules?.increaseIndentPattern.flags).toBe("i");
    // The invalid "(" regex is dropped, as VS Code does.
    expect(cfg.onEnterRules).toHaveLength(1);
    expect(cfg.onEnterRules?.[0].action.indentAction).toBe(1);
  });

  it("parses snippet files", () => {
    const list = parseSnippets(`{
      // comment
      "Print": { "prefix": ["pr", "print"], "body": ["print($1)", "$0"], "description": "Print a value" },
      "Main": { "prefix": "main", "body": "def main():\\n\\t$0", "scope": "python, owl" },
      "Broken": { "body": "x" },
    }`);
    expect(list).toEqual([
      { name: "Print", prefixes: ["pr", "print"], body: "print($1)\n$0", description: "Print a value" },
      { name: "Main", prefixes: ["main"], body: "def main():\n\t$0", scope: ["python", "owl"] },
    ]);
  });
});

describe("Open VSX gallery", () => {
  it("normalises search hits and details", () => {
    const g = normalizeGalleryExtension({
      namespace: "dracula-theme",
      name: "theme-dracula",
      displayName: "Dracula Theme Official",
      version: "2.25.1",
      verified: true,
      downloadCount: 1234567,
      averageRating: 4.6,
      reviewCount: 12,
      namespaceDisplayName: "Dracula Theme",
      files: { icon: "https://open-vsx.org/api/dracula-theme/theme-dracula/2.25.1/file/icon.png", download: "https://open-vsx.org/x.vsix", manifest: "https://open-vsx.org/m.json" },
      categories: ["Themes"],
      tags: ["__sponsor", "dark"],
    });
    expect(g).toMatchObject({ id: "dracula-theme.theme-dracula", publisher: "Dracula Theme", verified: true, downloadCount: 1234567, averageRating: 4.6, downloadUrl: "https://open-vsx.org/x.vsix", manifestUrl: "https://open-vsx.org/m.json", tags: ["dark"] });
    expect(normalizeGalleryExtension({ namespace: "a", name: "b", downloads: { universal: "https://open-vsx.org/u.vsix" } }).downloadUrl).toBe("https://open-vsx.org/u.vsix");
  });

  it("builds search URLs with VS Code's @category filter", () => {
    expect(searchUrl("python")).toBe("https://open-vsx.org/api/-/search?query=python&offset=0&size=30&sortBy=relevance&sortOrder=desc&includeAllVersions=false");
    const u = new URL(searchUrl('@category:"themes" dark'));
    expect(u.searchParams.get("query")).toBe("dark");
    expect(u.searchParams.get("category")).toBe("themes");
  });

  it("formats install counts like VS Code", () => {
    expect(formatCount(812)).toBe("812");
    expect(formatCount(4530)).toBe("4.5K");
    expect(formatCount(45300)).toBe("45K");
    expect(formatCount(1_250_000)).toBe("1.3M");
    expect(formatCount(32_000_000)).toBe("32M");
  });
});

describe("vsix", () => {
  it("unpacks extension/ entries (stored and deflated) and skips the rest", async () => {
    const files = await unpackVsix(
      zip([
        { name: "[Content_Types].xml", text: "<Types/>" },
        { name: "extension.vsixmanifest", text: "<x/>" },
        { name: "extension/package.json", text: MANIFEST, deflate: true },
        { name: "extension/themes/night.json", text: '{"colors":{}}' },
        { name: "extension/../evil.txt", text: "no" },
        { name: "extension/images/", text: "" },
      ]),
    );
    expect([...files.keys()].sort()).toEqual(["package.json", "themes/night.json"]);
    expect(new TextDecoder().decode(files.get("package.json"))).toBe(MANIFEST);
  });

  it("rejects files that are not a vsix", async () => {
    await expect(unpackVsix(new TextEncoder().encode("not a zip at all, sorry".repeat(3)))).rejects.toThrow(/Not a .vsix/);
    await expect(unpackVsix(zip([{ name: "readme.md", text: "x" }]))).rejects.toThrow(/package.json/);
  });
});

describe("theme conversion", () => {
  const dark = { name: "Owl", uiTheme: "vs-dark" as const, colors: { "editor.background": "#011627", "sideBar.background": "#011627ff", "activityBar.background": "#0b2942", "statusBar.background": "#011627", "terminal.ansiRed": "#ef5350", "button.background": "bad" }, tokenColors: [] };

  it("maps VS Code colour keys to the workbench CSS variables, with registry defaults", () => {
    const vars = cssVarsForTheme(dark);
    expect(vars["--editor-bg"]).toBe("#011627");
    expect(vars["--sidebar-bg"]).toBe("#011627FF");
    expect(vars["--activitybar-bg"]).toBe("#0B2942");
    // Invalid colours fall back to the dark default.
    expect(vars["--button-bg"]).toBe("#0E639C");
    expect(vars["--tab-active-bg"]).toBe("#011627");
    // Light themes get the light defaults; high contrast keeps only explicit keys.
    expect(cssVarsForTheme({ ...dark, uiTheme: "vs", colors: {} })["--sidebar-bg"]).toBe("#F3F3F3");
    expect(cssVarsForTheme({ ...dark, uiTheme: "hc-black", colors: {} })["--sidebar-bg"]).toBeUndefined();
  });

  it("builds the terminal palette from terminal.* keys", () => {
    const t = terminalThemeFor(dark);
    expect(t.red).toBe("#EF5350");
    expect(t.background).toBe("#011627");
    expect(t.brightGreen).toBe("#23D18B");
  });

  it("loads a TextMate .tmTheme through the plist parser and converts it for Monaco", async () => {
    const plist = { settings: [{ settings: { background: "#272822", foreground: "#F8F8F2" } }, { scope: "comment", settings: { foreground: "#75715E" } }] };
    const theme = await loadThemeFile("themes/Monokai.tmTheme", { read: async () => "<plist/>", parsePlist: () => plist }, uiThemeOf("vs-dark"));
    expect(theme.tokenColors).toHaveLength(2);
    const data = monacoThemeData(theme, null);
    expect(data.base).toBe("vs-dark");
    expect(data.rules).toContainEqual({ token: "comment", foreground: "75715E" });
    expect(uiThemeOf("hc-light")).toBe("hc-light");
    expect(uiThemeOf("weird", "vs")).toBe("vs");
  });
});

describe("file icon themes", () => {
  const doc: IconThemeDocument = {
    file: "_file",
    folder: "_folder",
    folderExpanded: "_folder_open",
    fileExtensions: { ts: "_ts", "spec.ts": "_test" },
    fileNames: { "package.json": "_npm" },
    folderNames: { src: "_src" },
    languageIds: { python: "_py" },
    light: { fileExtensions: { ts: "_ts_light" } },
  };

  it("picks icons like VS Code: names, longest extension, language, default", () => {
    expect(iconFor(doc, "a/package.json", "file")).toBe("_npm");
    expect(iconFor(doc, "x.spec.ts", "file")).toBe("_test");
    expect(iconFor(doc, "x.ts", "file")).toBe("_ts");
    expect(iconFor(doc, "x.ts", "file", { variant: "light" })).toBe("_ts_light");
    expect(iconFor(doc, "main.py", "file", { languageId: "python" })).toBe("_py");
    expect(iconFor(doc, "notes.txt", "file")).toBe("_file");
    expect(iconFor(doc, "src", "folder")).toBe("_src");
    expect(iconFor(doc, "lib", "folder", { expanded: true })).toBe("_folder_open");
    expect(fontCharacter("\\E001")).toBe("\uE001");
  });
});
