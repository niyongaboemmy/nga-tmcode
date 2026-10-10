import { beforeAll, describe, expect, it } from "vitest";
import setiText from "./seti/vs-seti-icon-theme.json?raw";
import { parseJsonc } from "../textmate/jsonc";
import { allIconThemes, BUILTIN_ICON_THEMES, DEFAULT_ICON_THEME, MINIMAL_ICON_THEME, resolveIcon, setIconLanguageResolver, type IconThemeDocument } from "./iconThemes";
import { iconLanguageId } from "./iconLanguages";

const seti = parseJsonc<IconThemeDocument>(setiText);

/** Monaco's file → language guesses for the test files (what languageForPath returns in the app). */
const MONACO: Record<string, string> = {
  py: "python",
  json: "json",
  md: "markdown",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  kt: "kotlin",
  swift: "swift",
  dart: "dart",
  rb: "ruby",
  php: "php",
  cs: "csharp",
  go: "go",
  rs: "rust",
  java: "java",
  sql: "sql",
  html: "html",
  css: "css",
  sh: "shell",
  c: "c",
  cpp: "cpp",
  yml: "yaml",
  txt: "plaintext",
};
function monacoGuess(path: string) {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return MONACO[ext] ?? "plaintext";
}

beforeAll(() => setIconLanguageResolver(monacoGuess, () => "test"));

describe("Seti (Visual Studio Code)", () => {
  it("is the vendored VS Code theme, complete", () => {
    expect(Object.keys(seti.iconDefinitions!)).toHaveLength(383);
    expect(Object.keys(seti.fileExtensions!)).toHaveLength(238);
    expect(Object.keys(seti.fileNames!)).toHaveLength(101);
    expect(Object.keys(seti.languageIds!)).toHaveLength(83);
    expect(seti.fonts?.[0].src[0].path).toBe("./seti.woff");
  });

  it.each([
    ["main.py", "_python"],
    ["package.json", "_json"],
    ["README.md", "_info"],
    ["notes/intro.md", "_markdown"],
    ["Dockerfile", "_docker"],
    ["Makefile", "_makefile"],
    [".gitignore", "_git"],
    [".env", "_config"],
    [".env.local", "_config"],
    ["tsconfig.json", "_tsconfig"],
    ["src/App.jsx", "_react"],
    ["src/App.tsx", "_react"],
    ["App.vue", "_vue"],
    ["App.svelte", "_svelte"],
    ["Main.kt", "_kotlin"],
    ["main.swift", "_swift"],
    ["main.dart", "_dart"],
    ["app.rb", "_ruby"],
    ["index.php", "_php"],
    ["Program.cs", "_c-sharp"],
    ["main.go", "_go2"],
    ["main.rs", "_rust"],
    ["Main.java", "_java"],
    ["query.sql", "_db"],
    ["analysis.ipynb", "_notebook"],
    ["logo.png", "_image"],
    ["photo.JPG", "_image"],
    ["index.html", "_html_3"],
    ["style.css", "_css"],
    ["app.js", "_javascript"],
    ["app.spec.ts", "_typescript_1"],
    ["run.sh", "_shell"],
    ["main.c", "_c"],
    ["main.cpp", "_cpp"],
    ["notes.txt", "_default"],
  ])("%s → %s", (path, id) => {
    expect(resolveIcon(seti, path, "file", { variant: "dark" })).toBe(id);
  });

  it("uses the light section in light themes", () => {
    expect(resolveIcon(seti, "main.py", "file", { variant: "light" })).toBe("_python_light");
    expect(resolveIcon(seti, "README.md", "file", { variant: "light" })).toBe("_info_light");
    expect(resolveIcon(seti, "notes.txt", "file", { variant: "light" })).toBe("_default_light");
    // Same glyph, darker colour for a white background.
    expect(seti.iconDefinitions!._python_light.fontCharacter).toBe(seti.iconDefinitions!._python.fontCharacter);
    expect(seti.iconDefinitions!._python_light.fontColor).not.toBe(seti.iconDefinitions!._python.fontColor);
  });

  it("has no folder icons (VS Code shows only the twisties)", () => {
    expect(resolveIcon(seti, "src", "folder", { expanded: false })).toBeUndefined();
    expect(resolveIcon(seti, "src", "folder", { expanded: true })).toBeUndefined();
  });

  it("caches per name and variant", () => {
    const a = resolveIcon(seti, "a/main.py", "file", { variant: "dark" });
    const b = resolveIcon(seti, "b/main.py", "file", { variant: "dark" });
    expect(a).toBe(b);
    expect(resolveIcon(seti, "b/main.py", "file", { variant: "light" })).toBe("_python_light");
  });
});

describe("built-in icon themes", () => {
  it("lists Seti (the default), Minimal, TMCode Glyphs and None", () => {
    expect(BUILTIN_ICON_THEMES.map((t) => t.label)).toEqual(["Seti (Visual Studio Code)", "Minimal (Visual Studio Code)", "TMCode Glyphs", "None"]);
    expect(DEFAULT_ICON_THEME).toBe("vs-seti");
    expect(allIconThemes()[0].id).toBe("vs-seti");
  });

  it("Minimal: one generic file icon, no folders", () => {
    expect(resolveIcon(MINIMAL_ICON_THEME, "main.py", "file")).toBe("_file");
    expect(resolveIcon(MINIMAL_ICON_THEME, "Dockerfile", "file")).toBe("_file");
    expect(resolveIcon(MINIMAL_ICON_THEME, "src", "folder")).toBeUndefined();
  });
});

describe("iconLanguageId", () => {
  it("maps files to VS Code's language ids", () => {
    expect(iconLanguageId(".gitignore", "plaintext")).toBe("ignore");
    expect(iconLanguageId(".env.production", "plaintext")).toBe("dotenv");
    expect(iconLanguageId("Dockerfile.dev", "plaintext")).toBe("dockerfile");
    expect(iconLanguageId("App.tsx", "typescript")).toBe("typescriptreact");
    expect(iconLanguageId("App.jsx", "javascript")).toBe("javascriptreact");
    expect(iconLanguageId("build.sh", "shell")).toBe("shellscript");
    expect(iconLanguageId("docker-compose.yml", "yaml")).toBe("dockercompose");
    expect(iconLanguageId("main.py", "python")).toBe("python");
  });
});
