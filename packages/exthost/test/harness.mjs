// A fake workbench ("main thread") for the Node extension host: spawns the
// bundled host (apps/desktop/src-tauri/resources/exthost.cjs) over stdio and
// answers its requests with in-memory documents. Used by the Node end-to-end
// test (src/node/host.e2e.test.ts) and the real-extension self-test
// (test/real-extensions.mjs).

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const HOST_SCRIPT = resolve(here, "../../../apps/desktop/src-tauri/resources/exthost.cjs");

function offsetAt(text, line, ch) {
  let off = 0;
  const lines = text.split("\n");
  for (let i = 0; i < line && i < lines.length; i++) off += lines[i].length + 1;
  return off + Math.min(ch, (lines[line] ?? "").length);
}

function positionAt(text, off) {
  const before = text.slice(0, off).split("\n");
  return [before.length - 1, before[before.length - 1].length];
}

/** Describes an unpacked extension folder for $init. */
export function describeExtension(dir) {
  const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  const id = `${manifest.publisher}.${manifest.name}`.toLowerCase();
  return { id, name: manifest.name, publisher: manifest.publisher, displayName: manifest.displayName ?? manifest.name, version: manifest.version, location: dir, entry: manifest.main ?? manifest.browser, activationEvents: [], manifest };
}

export class FakeWorkbench {
  constructor({ root, extensions, documents = {}, configuration = {}, onRequest, env = {} } = {}) {
    this.root = root;
    this.docs = new Map(Object.entries(documents).map(([path, d]) => [path, { text: d.text, languageId: d.languageId, version: 1 }]));
    this.providers = new Map();
    this.commands = new Set();
    this.output = [];
    this.diagnostics = new Map();
    this.messages = [];
    this.states = new Map();
    this.statusBar = new Map();
    this.logs = [];
    /** $main.treeView / $main.webview / $main.webviewView notifications, in order: [method, op, id, data]. */
    this.ui = [];
    /** Messages extensions posted to webviews ($main.webviewPost). */
    this.posted = [];
    this.seq = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.onRequest = onRequest ?? (() => undefined);
    this.child = spawn(process.execPath, [HOST_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], cwd: root ?? process.cwd() });
    this.child.stderr.on("data", (d) => this.logs.push(String(d)));
    this.child.stdout.on("data", (d) => this.#onData(d));
    this.exited = new Promise((r) => this.child.on("exit", (code) => r(code)));
    this.init = this.request("$init", [
      {
        hostKind: "node",
        extensions,
        workspace: root ? { name: "ws", root } : null,
        configuration: { defaults: { "editor.tabSize": 4, "editor.insertSpaces": true, "files.exclude": { "**/.git": true }, "search.exclude": { "**/node_modules": true } }, user: configuration },
        state: { global: {}, workspace: {} },
        env: { appName: "TMCode", appRoot: "", appHost: "desktop", language: "en", machineId: "m", sessionId: "s", uiKind: 1, shell: "/bin/sh", version: "0.0.0", storagePath: mkdtempSync(resolve(tmpdir(), "tmcode-exthost-storage-")), workspaceKey: "ws", webviewBase: "tmwebview://localhost", webviewCspSource: "tmwebview://localhost tmwebview:", os: process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux", ...env },
        documents: [...this.docs].map(([path, d]) => ({ path, languageId: d.languageId, version: 1, text: d.text, eol: "\n", isDirty: false })),
        editors: [...this.docs.keys()].slice(0, 1).map((path) => ({ id: "g0", path, selections: [{ anchor: [0, 0], active: [0, 0] }], visibleRanges: [[0, 0, 10, 0]], options: { tabSize: 4, insertSpaces: true }, viewColumn: 1 })),
        activeEditor: this.docs.size ? "g0" : null,
        languages: ["javascript", "typescript", "html", "css", "json", "plaintext", "markdown"],
      },
    ]);
  }

  #onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const i = this.buf.indexOf("\r\n\r\n");
      if (i < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, i).toString())?.[1]);
      if (this.buf.length < i + 4 + len) return;
      const msg = JSON.parse(this.buf.subarray(i + 4, i + 4 + len).toString());
      this.buf = this.buf.subarray(i + 4 + len);
      if ("method" in msg) {
        Promise.resolve()
          .then(() => this.#handle(msg.method, msg.params))
          .then(
            (result) => "id" in msg && this.send({ id: msg.id, result: result ?? null }),
            (e) => "id" in msg && this.send({ id: msg.id, error: { message: String(e?.message ?? e) } }),
          );
      } else {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(Object.assign(new Error(msg.error.message), msg.error));
        else p?.resolve(msg.result);
      }
    }
  }

  send(m) {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    const b = Buffer.from(JSON.stringify(m));
    this.child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`);
    this.child.stdin.write(b);
  }

  request(method, params = []) {
    const id = ++this.seq;
    this.send({ id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method, params = []) {
    this.send({ method, params });
  }

  /** Applies edits to a document the way Monaco would, and tells the host. */
  applyEdits(path, edits) {
    const doc = this.docs.get(path);
    const sorted = [...edits].sort((a, b) => b.range[0] - a.range[0] || b.range[1] - a.range[1]);
    const changes = [];
    for (const e of sorted) {
      const start = offsetAt(doc.text, e.range[0], e.range[1]);
      const end = offsetAt(doc.text, e.range[2], e.range[3]);
      const s = positionAt(doc.text, start);
      const en = positionAt(doc.text, end);
      changes.push({ range: [s[0], s[1], en[0], en[1]], rangeOffset: start, rangeLength: end - start, text: e.text });
      doc.text = doc.text.slice(0, start) + e.text + doc.text.slice(end);
    }
    doc.version++;
    this.notify("$documentChanged", [path, doc.version, changes, true]);
    return true;
  }

  /** Types `text` at a position (an edit from the user). */
  type(path, line, ch, text, replaceLength = 0) {
    const doc = this.docs.get(path);
    const end = positionAt(doc.text, offsetAt(doc.text, line, ch) + replaceLength);
    return this.applyEdits(path, [{ range: [line, ch, end[0], end[1]], text }]);
  }

  setSelection(path, anchor, active) {
    this.notify("$editorSelection", ["g0", [{ anchor, active }], 1]);
  }

  async #handle(method, params) {
    if (process.env.TMCODE_HARNESS_TRACE) console.error("<-", method, JSON.stringify(params).slice(0, 400));
    const custom = await this.onRequest(method, params, this);
    if (custom !== undefined) return custom;
    switch (method) {
      case "$main.registerProvider":
        this.providers.set(params[0], { kind: params[1], selector: params[2], meta: params[3] });
        return;
      case "$main.unregisterProvider":
        this.providers.delete(params[0]);
        return;
      case "$main.registerCommand":
        this.commands.add(params[0]);
        return;
      case "$main.output":
        if (params[0] === "append") this.output.push(params[2]);
        return;
      case "$main.setDiagnostics":
        for (const [path, list] of params[1]) this.diagnostics.set(`${params[0]}|${path}`, list ?? []);
        return;
      case "$main.extensionState":
        this.states.set(params[0].id, params[0]);
        return;
      case "$main.showMessage":
        this.messages.push({ severity: params[0], message: params[1], items: params[3] });
        return null;
      case "$main.statusBar":
        this.statusBar.set(params[1].id, params[1]);
        return;
      case "$main.editorEdit":
        return this.applyEdits(params[0], params[1]);
      case "$main.applyEdit":
        for (const e of params[0].entries) if (e.kind === "text") this.applyEdits(e.path, [e.edit]);
        return true;
      case "$main.openTextDocument": {
        const d = this.docs.get(params[0]);
        return d ? { path: params[0], languageId: d.languageId, version: d.version, text: d.text, eol: "\n", isDirty: false } : null;
      }
      case "$main.showQuickPick":
        return [0];
      case "$main.showInputBox":
        return null;
      case "$main.log":
        this.logs.push(`[${params[0]}] ${params[2]}`);
        return;
      case "$main.treeView":
      case "$main.webview":
      case "$main.webviewView":
        this.ui.push([method, ...params]);
        return;
      case "$main.webviewPost":
        this.posted.push({ handle: params[0], message: params[1] });
        return true;
      default:
        return null;
    }
  }

  providerOf(kind) {
    return [...this.providers].filter(([, p]) => p.kind === kind).map(([h]) => h);
  }

  async waitFor(pred, what, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`Timed out waiting for ${what}\n${this.logs.join("")}`);
  }

  async close() {
    this.child.stdin.end();
    const t = setTimeout(() => this.child.kill("SIGKILL"), 4000);
    await this.exited;
    clearTimeout(t);
  }
}
