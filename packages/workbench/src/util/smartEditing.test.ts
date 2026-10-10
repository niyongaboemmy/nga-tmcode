import { describe, expect, it } from "vitest";
import { detectLanguage } from "./languageDetection";
import { linkedTagRanges } from "./linkedTags";
import { markdownLinkFor, relativePath } from "./markdownLinks";
import { aliasMatch, aliasesFor, closeness, editDistance, similarCommands } from "../commands/aliases";

describe("language detection (untitled editors)", () => {
  it.each([
    ["def f():\n    return 1", "python"],
    ["def f():", "python"],
    ["import os\nfor x in range(3):\n    print(x)", "python"],
    ["#!/usr/bin/env python3\nx = 1", "python"],
    ["#!/bin/bash\necho hi", "shell"],
    ["#!/usr/bin/env node\nconsole.log(1)", "javascript"],
    ["const x = 1;\nconsole.log(x);", "javascript"],
    ["function add(a, b) {\n  return a + b;\n}", "javascript"],
    ["interface User { name: string }\nconst u: User = { name: 'a' };", "typescript"],
    ["let n: number = 3;\nconsole.log(n);", "typescript"],
    ['public class Main {\n  public static void main(String[] args) {\n    System.out.println("hi");\n  }\n}', "java"],
    ["#include <stdio.h>\nint main() { printf(\"hi\"); return 0; }", "c"],
    ["#include <iostream>\nusing namespace std;\nint main() { cout << 1; }", "cpp"],
    ["<!DOCTYPE html>\n<html><body><p>Hi</p></body></html>", "html"],
    ["<div class=\"a\">\n  <p>Hello</p>\n</div>", "html"],
    ["body {\n  margin: 0;\n  color: red;\n}", "css"],
    ['{ "name": "x", "version": "1.0.0" }', "json"],
    ["[1, 2, 3]", "json"],
    ["SELECT name FROM students WHERE age > 12;", "sql"],
    ["CREATE TABLE t (id INT PRIMARY KEY);", "sql"],
    ["# Title\n\nSome **bold** text and a [link](https://x.y).", "markdown"],
    ["<?php echo 'hi'; ?>", "php"],
  ])("%j → %s", (text, lang) => {
    expect(detectLanguage(text)).toBe(lang);
  });

  it("stays fast on long and awkward text (typing in a big buffer)", () => {
    const awkward = ["a b c d e f g h i j k l m n o p ".repeat(300), "SELECT x y z w v u t s r q p o n m".repeat(200), "<a ".repeat(2000), "x".repeat(20000)];
    const t0 = performance.now();
    for (const text of awkward) detectLanguage(text);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("says nothing when unsure", () => {
    expect(detectLanguage("")).toBeNull();
    expect(detectLanguage("hello")).toBeNull();
    expect(detectLanguage("Dear class, the test is on Monday.")).toBeNull();
  });
});

describe("linked tag editing", () => {
  const ranges = (text: string, at: string) => {
    const offset = text.indexOf(at);
    return linkedTagRanges(text, offset)?.map((r) => [text.slice(r.start, r.end), r.start]);
  };

  it("pairs an opening tag with its closing tag and back", () => {
    const t = "<div><p>hi</p></div>";
    expect(ranges(t, "div>")).toEqual([
      ["div", 1],
      ["div", 16],
    ]);
    // On the slash of </div>: not on a name.
    expect(ranges(t, "/div")).toBeUndefined();
    expect(linkedTagRanges(t, t.lastIndexOf("div"))).toEqual([
      { start: 1, end: 4 },
      { start: 16, end: 19 },
    ]);
    expect(linkedTagRanges(t, t.indexOf("p>"))).toEqual([
      { start: 6, end: 7 },
      { start: 12, end: 13 },
    ]);
  });

  it("handles nesting of the same tag, attributes and JSX", () => {
    const t = '<div a=">"><div>x</div></div>';
    expect(linkedTagRanges(t, 1)).toEqual([
      { start: 1, end: 4 },
      { start: t.lastIndexOf("div"), end: t.lastIndexOf("div") + 3 },
    ]);
    const jsx = "return <Button onClick={() => a > b}>Go</Button>;";
    const at = jsx.indexOf("Button");
    expect(linkedTagRanges(jsx, at)).toEqual([
      { start: at, end: at + 6 },
      { start: jsx.lastIndexOf("Button"), end: jsx.lastIndexOf("Button") + 6 },
    ]);
  });

  it("ignores self-closing tags, comments and text", () => {
    expect(linkedTagRanges("<br/><img src=x />", 1)).toBeNull();
    expect(linkedTagRanges("<!-- <b> --><b>x</b>", 6)).toBeNull();
    expect(linkedTagRanges("hello <b>x</b>", 2)).toBeNull();
  });
});

describe("Markdown links for dropped files", () => {
  it("links relative to the Markdown file", () => {
    expect(relativePath("docs/guide.md", "img/logo.png")).toBe("../img/logo.png");
    expect(relativePath("README.md", "src/main.py")).toBe("src/main.py");
    expect(relativePath("docs/a/b.md", "docs/c.md")).toBe("../c.md");
    expect(markdownLinkFor("README.md", "img/logo.png")).toBe("![logo](img/logo.png)");
    expect(markdownLinkFor("docs/notes.md", "src/main.py")).toBe("[main.py](../src/main.py)");
    expect(markdownLinkFor("README.md", "my files/a b.txt")).toBe("[a b.txt](<my files/a b.txt>)");
  });
});

describe("command palette aliases", () => {
  it("matches other words for a command", () => {
    expect(aliasMatch("reload", aliasesFor("workbench.action.reloadWindow"))).toBe("reload");
    expect(aliasMatch("close all", aliasesFor("workbench.action.closeAllEditors"))).toBe("close all");
    expect(aliasMatch("clo al", aliasesFor("workbench.action.closeAllEditors"))).toBe("close all");
    expect(aliasMatch("format", aliasesFor("editor.action.formatDocument"))).toBe("format");
    expect(aliasMatch("terminal", aliasesFor("workbench.action.terminal.toggleTerminal"))).toBe("terminal");
    expect(aliasMatch("rename", aliasesFor("editor.action.rename"))).toBe("rename");
    expect(aliasMatch("zebra", aliasesFor("workbench.action.reloadWindow"))).toBeNull();
    expect(aliasMatch("mine", aliasesFor("x.unknown", ["mine"]))).toBe("mine");
  });

  it("suggests similar commands for typos", () => {
    expect(editDistance("relaod", "reload")).toBe(2);
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(closeness("termnal", "View: Toggle Terminal")).toBeLessThan(0.5);
    const entries = [
      { id: "workbench.action.terminal.toggleTerminal", label: "View: Toggle Terminal" },
      { id: "workbench.action.files.save", label: "File: Save" },
      { id: "editor.action.formatDocument", label: "Format Document" },
    ];
    expect(similarCommands("termnal", entries).map((e) => e.id)).toEqual(["workbench.action.terminal.toggleTerminal"]);
    expect(similarCommands("fromat", entries)[0].id).toBe("editor.action.formatDocument");
    expect(similarCommands("qqqqqqq", entries)).toEqual([]);
  });
});
