// Runs real Open VSX extensions in the Node extension host and checks that
// each one does its job. Needs the unpacked extensions:
//   node packages/exthost/test/real-extensions.mjs <dir>
// where <dir>/<publisher.name>/extension/package.json exist (the self-test in
// the desktop app installs them through Open VSX instead).
// Prints one line per extension: "ok …" or "FAIL …"; exits 1 on any failure.

import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeWorkbench, describeExtension } from "./harness.mjs";

const base = process.argv[2];
if (!base) {
  console.error("usage: real-extensions.mjs <dir with unpacked extensions>");
  process.exit(2);
}
const only = process.argv[3];
const ext = (id) => describeExtension(resolve(base, id, "extension"));
const has = (id) => existsSync(join(base, id, "extension", "package.json"));

function workspace(files) {
  const root = mkdtempSync(join(tmpdir(), "tmcode-exthost-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const checks = {
  async "christian-kohler.path-intellisense"() {
    const root = workspace({ "src/main.js": "import x from './'\n", "src/lib/util.js": "export const a = 1;\n" });
    const wb = new FakeWorkbench({ root, extensions: [ext("christian-kohler.path-intellisense")], documents: { "src/main.js": { text: "import x from './'\n", languageId: "javascript" } } });
    try {
      await wb.init;
      await wb.request("$startup");
      await wb.waitFor(() => wb.providerOf("completion").length, "a completion provider");
      const res = await wb.request("$provide", [wb.providerOf("completion")[0], "provideCompletionItems", ["src/main.js", [0, 17], { triggerKind: 1, triggerCharacter: "/" }]]);
      const labels = res.items.map((i) => (typeof i.label === "string" ? i.label : i.label.label));
      if (!labels.includes("lib")) throw new Error(`completions: ${labels.join(", ")}`);
      return `completion of './' → ${labels.join(", ")}`;
    } finally {
      await wb.close();
    }
  },

  async "lyuwenhan.code-formatter-and-minifier"() {
    const src = "function  add(a,b){return a+b}\nconst   x = {a:1,b:[1,2,3]};\n";
    const root = workspace({ "app.js": src });
    const wb = new FakeWorkbench({ root, extensions: [ext("lyuwenhan.code-formatter-and-minifier")], documents: { "app.js": { text: src, languageId: "javascript" } } });
    try {
      await wb.init;
      await wb.request("$startup");
      await wb.waitFor(() => wb.states.get("lyuwenhan.code-formatter-and-minifier")?.state === "activated" || wb.states.get("lyuwenhan.code-formatter-and-minifier")?.state === "failed", "activation");
      const st = wb.states.get("lyuwenhan.code-formatter-and-minifier");
      if (st.state !== "activated") throw new Error(`activation failed: ${st.error}`);
      // As from the editor context menu, which passes the file (the palette passes nothing).
      await wb.request("$executeCommand", ["minifier.beautify", [{ $path: "app.js" }]]);
      await wb.waitFor(() => wb.docs.get("app.js").text !== src, "the beautified file", 15000);
      const beautified = wb.docs.get("app.js").text;
      if (!beautified.includes("return a + b")) throw new Error(`beautify gave ${JSON.stringify(beautified)}`);
      await wb.request("$executeCommand", ["minifier.minify", [{ $path: "app.js" }]]);
      await wb.waitFor(() => wb.docs.get("app.js").text !== beautified, "the minified file", 15000);
      const minified = wb.docs.get("app.js").text;
      if (minified.length >= beautified.length) throw new Error(`minify gave ${JSON.stringify(minified)}`);
      return `beautify (${beautified.split("\n").length} lines) and minify (${minified.length} chars)`;
    } finally {
      await wb.close();
    }
  },

  async "esbenp.prettier-vscode"() {
    const src = "const   a = {b:1,c:[1,2]}\nfunction f( x ){return x}\n";
    const root = workspace({ "app.js": src, "package.json": "{}" });
    const wb = new FakeWorkbench({ root, extensions: [ext("esbenp.prettier-vscode")], documents: { "app.js": { text: src, languageId: "javascript" } } });
    try {
      await wb.init;
      await wb.request("$startup");
      await wb.waitFor(() => wb.providerOf("formatting").length, "a formatting provider", 30000);
      const handle = wb.providerOf("formatting").find((h) => JSON.stringify(wb.providers.get(h).selector).includes("javascript")) ?? wb.providerOf("formatting")[0];
      const edits = await wb.request("$provide", [handle, "provideDocumentFormattingEdits", ["app.js", { tabSize: 2, insertSpaces: true }]]);
      if (!edits?.length) throw new Error("no edits");
      wb.applyEdits("app.js", edits);
      const out = wb.docs.get("app.js").text;
      if (!out.includes("const a = { b: 1, c: [1, 2] };")) throw new Error(`formatted: ${JSON.stringify(out)}`);
      return `formatting provider → ${JSON.stringify(out.split("\n")[0])}`;
    } finally {
      await wb.close();
    }
  },

  async "formulahendry.auto-rename-tag"() {
    const src = "<div>\n  <span>hi</span>\n</div>\n";
    const root = workspace({ "index.html": src });
    const wb = new FakeWorkbench({ root, extensions: [ext("formulahendry.auto-rename-tag")], documents: { "index.html": { text: src, languageId: "html" } } });
    try {
      await wb.init;
      await wb.request("$startup");
      await wb.waitFor(() => wb.states.get("formulahendry.auto-rename-tag")?.state === "activated", "activation");
      // The user renames <span> to <spam>: the closing tag follows.
      wb.setSelection("index.html", [1, 7], [1, 7]);
      wb.type("index.html", 1, 6, "m", 1);
      await wb.waitFor(() => wb.docs.get("index.html").text.includes("</spam>"), "the closing tag to be renamed", 10000);
      return `<span> → <spam> renamed </span> too`;
    } finally {
      await wb.close();
    }
  },

  async "streetsidesoftware.code-spell-checker"() {
    const src = "This sentense has a mispeled word.\n";
    const root = workspace({ "notes.md": src });
    const wb = new FakeWorkbench({ root, extensions: [ext("streetsidesoftware.code-spell-checker")], documents: { "notes.md": { text: src, languageId: "markdown" } } });
    try {
      await wb.init;
      await wb.request("$startup");
      await wb.waitFor(() => [...wb.diagnostics.values()].some((l) => l.length), "spelling diagnostics", 60000);
      const words = [...wb.diagnostics.values()].flat().map((d) => d.message);
      return `diagnostics: ${words.join("; ")}`;
    } finally {
      await wb.close();
    }
  },
};

let failed = 0;
for (const [id, run] of Object.entries(checks)) {
  if (only && id !== only) continue;
  if (!has(id)) {
    console.log(`skip ${id}: not downloaded`);
    continue;
  }
  try {
    console.log(`ok ${id}: ${await run()}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${id}: ${String(e?.stack ?? e).slice(0, 2000)}`);
  }
}
process.exit(failed ? 1 : 0);
