// Compatibility survey: activates real extensions in the Node host against a
// small multi-language workspace and reports what each one registers.
//   node packages/exthost/test/survey.mjs <dir with <id>/extension/package.json>
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FakeWorkbench, describeExtension } from "./harness.mjs";

const base = process.argv[2];
const files = {
  "index.html": "<!doctype html>\n<html><body><div class=\"p-4 text-red-500\">Hello</div></body></html>\n",
  "style.css": "body { color: #ff0000; }\n",
  "app.js": "// TODO: fix this\nconst msg = 'helo wrold';\nconsole.log(msg)\n",
  "App.tsx": "export function App() { return <div className=\"m-2\">Hi</div>; }\n",
  "main.py": "print('hello')\n",
  "README.md": "# Readme\n\nSome txet with a typo.\n",
  "requests.http": "GET https://example.com\n",
  "package.json": JSON.stringify({ name: "demo", devDependencies: { prettier: "3", eslint: "9", tailwindcss: "3" } }),
  "tailwind.config.js": "module.exports = { content: ['./**/*.html'] };\n",
};
const lang = { html: "html", css: "css", js: "javascript", tsx: "typescriptreact", py: "python", md: "markdown", http: "http", json: "json" };
const root = mkdtempSync(join(tmpdir(), "tmcode-survey-"));
for (const [p, t] of Object.entries(files)) writeFileSync(join(root, p), t);
mkdirSync(join(root, ".git"));
const documents = Object.fromEntries(Object.entries(files).map(([p, t]) => [p, { text: t, languageId: lang[p.split(".").pop()] ?? "plaintext" }]));

for (const id of readdirSync(base).filter((d) => existsSync(join(base, d, "extension", "package.json"))).sort()) {
  const ext = describeExtension(resolve(base, id, "extension"));
  const code = !!(ext.manifest.main || ext.manifest.browser);
  const wb = new FakeWorkbench({ root, extensions: [ext], documents });
  const t0 = Date.now();
  let line;
  try {
    await wb.init;
    await wb.request("$startup");
    for (const ev of ["onLanguage:javascript", "onLanguage:html", "onLanguage:css", "onLanguage:typescriptreact", "onLanguage:markdown", "onLanguage:http", "onLanguage:python"]) await wb.request("$activateByEvent", [ev]).catch(() => {});
    await new Promise((r) => setTimeout(r, 6000));
    const st = wb.states.get(ext.id) ?? {};
    const kinds = {};
    for (const p of wb.providers.values()) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
    const diags = [...wb.diagnostics.values()].reduce((n, l) => n + l.length, 0);
    const errs = wb.logs.join("").split("\n").filter((l) => /error|not supported|cannot|failed/i.test(l)).slice(0, 2).map((l) => l.slice(0, 140));
    line = { id, code, state: st.state ?? (code ? "not activated" : "declarative"), ms: st.activationMs ?? null, error: st.error ?? null, commands: wb.commands.size, providers: kinds, diagnostics: diags, statusBar: wb.statusBar.size, notes: errs };
  } catch (e) {
    line = { id, code, state: "host error", error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    await wb.close().catch(() => {});
  }
  console.log(JSON.stringify({ ...line, total_ms: Date.now() - t0 }));
}
