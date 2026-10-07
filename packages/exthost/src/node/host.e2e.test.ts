// @vitest-environment node
/**
 * The bundled Node extension host (apps/desktop/src-tauri/resources/exthost.cjs)
 * running fixture extensions end to end over stdio, against a fake workbench
 * (test/harness.mjs). Rebuild the bundle first: `node packages/exthost/build.mjs`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error plain ESM helper without typings
import { FakeWorkbench, describeExtension } from "../../test/harness.mjs";

type WB = {
  init: Promise<unknown>;
  request(m: string, p?: unknown[]): Promise<any>;
  states: Map<string, { state: string; error?: string }>;
  docs: Map<string, { text: string }>;
  output: string[];
  diagnostics: Map<string, unknown[]>;
  messages: { message: string }[];
  statusBar: Map<string, { text: string }>;
  providerOf(kind: string): number[];
  waitFor(pred: () => boolean, what: string, ms?: number): Promise<void>;
  close(): Promise<void>;
};

function writeExtension(root: string, name: string, pkg: Record<string, unknown>, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, publisher: "fixture", version: "1.0.0", engines: { vscode: "^1.80.0" }, ...pkg }));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

const UPPER = `
const vscode = require("vscode");
exports.activate = (context) => {
  const out = vscode.window.createOutputChannel("Upper");
  out.appendLine("activated " + vscode.workspace.getConfiguration("upper").get("suffix"));
  context.subscriptions.push(
    vscode.commands.registerCommand("upper.run", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) throw new Error("no editor");
      const doc = ed.document;
      const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
      await ed.edit((b) => b.replace(full, doc.getText().toUpperCase()));
      return doc.getText();
    }),
    vscode.languages.registerDocumentFormattingEditProvider("plaintext", {
      provideDocumentFormattingEdits(doc) {
        return [vscode.TextEdit.replace(new vscode.Range(0, 0, doc.lineCount, 0), doc.getText().trim() + "\\n")];
      },
    }),
    vscode.languages.registerCompletionItemProvider({ language: "plaintext", scheme: "file" }, {
      provideCompletionItems(doc, pos) {
        const item = new vscode.CompletionItem("hello", vscode.CompletionItemKind.Keyword);
        item.insertText = new vscode.SnippetString("hello \${1:world}");
        return [item];
      },
    }, "."),
  );
  const diags = vscode.languages.createDiagnosticCollection("upper");
  const check = (doc) => {
    const i = doc.getText().indexOf("TODO");
    diags.set(doc.uri, i < 0 ? [] : [new vscode.Diagnostic(new vscode.Range(doc.positionAt(i), doc.positionAt(i + 4)), "Found a TODO", vscode.DiagnosticSeverity.Warning)]);
  };
  vscode.workspace.textDocuments.forEach(check);
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => check(e.document)));
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
  item.text = "$(check) Upper";
  item.show();
  // Unsupported APIs log and never break activation.
  vscode.window.registerCustomEditorProvider("upper.editor", {});
  try { vscode.window.showNotebookDocument({}); } catch (e) { out.appendLine("notebook: " + e.message); }
  return { api: 42 };
};
`;

const ESM = `
import * as vscode from "vscode";
import { commands } from "vscode";
export function activate(context) {
  context.subscriptions.push(commands.registerCommand("esm.hello", async () => {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, "data.txt"));
    await context.globalState.update("count", 1);
    return new TextDecoder().decode(data) + ":" + context.globalState.get("count");
  }));
  context.subscriptions.push(commands.registerCommand("esm.outside", async (path) => {
    try {
      await vscode.workspace.fs.readFile(vscode.Uri.file(path));
      return "read";
    } catch (e) {
      return e.code;
    }
  }));
}
`;

const VIEWS = `
const vscode = require("vscode");
class Provider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; this.count = 2; this.root = { name: "root", kids: true }; this.leaves = []; }
  getChildren(el) {
    if (!el) return [this.root];
    for (let i = this.leaves.length; i < this.count; i++) this.leaves.push({ name: "leaf" + i, parent: el });
    return this.leaves.slice(0, this.count);
  }
  getParent(el) { return el.parent; }
  getTreeItem(el) {
    const item = new vscode.TreeItem(el.name, el.kids ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    if (el.kids) item.id = "root";
    item.contextValue = el.kids ? "folder" : "leaf";
    item.iconPath = el.kids ? new vscode.ThemeIcon("repo", new vscode.ThemeColor("charts.blue")) : vscode.Uri.file(__dirname + "/media/leaf.svg");
    item.tooltip = new vscode.MarkdownString("**" + el.name + "**");
    item.description = el.kids ? "2 items" : undefined;
    item.command = { command: "views.clicked", title: "Click", arguments: [el.name] };
    return item;
  }
}
exports.activate = (context) => {
  const provider = new Provider();
  const tree = vscode.window.createTreeView("views.tree", { treeDataProvider: provider, showCollapseAll: true });
  const events = [];
  tree.onDidChangeVisibility((e) => events.push("visible:" + e.visible));
  tree.onDidChangeSelection((e) => events.push("selected:" + e.selection.map((x) => x.name).join(",")));
  tree.onDidExpandElement((e) => events.push("expanded:" + e.element.name));
  tree.message = "Hello tree";
  tree.badge = { value: 3, tooltip: "three" };
  let panel;
  context.subscriptions.push(
    tree,
    vscode.commands.registerCommand("views.clicked", (name) => events.push("clicked:" + name)),
    vscode.commands.registerCommand("views.menu", (el) => events.push("menu:" + el.name)),
    vscode.commands.registerCommand("views.events", () => events.splice(0)),
    vscode.commands.registerCommand("views.grow", () => { provider.count = 3; provider.emitter.fire(); }),
    vscode.commands.registerCommand("views.reveal", async () => { const root = provider.getChildren()[0]; await tree.reveal(provider.getChildren(root)[1], { select: true }); }),
    vscode.commands.registerCommand("views.panel", () => {
      panel = vscode.window.createWebviewPanel("views.panel", "Panel", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
      const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", "main.js"));
      panel.webview.html = "<html><head><meta http-equiv='Content-Security-Policy' content='script-src " + panel.webview.cspSource + "'></head><body><script src='" + script + "'></script></body></html>";
      panel.webview.onDidReceiveMessage((m) => { events.push("webview:" + m.type); panel.webview.postMessage({ echo: m.type }); });
      panel.onDidDispose(() => events.push("disposed"));
      return { cspSource: panel.webview.cspSource, script: script.toString() };
    }),
    vscode.window.registerWebviewViewProvider("views.side", {
      resolveWebviewView(view) {
        view.webview.options = { enableScripts: true };
        view.webview.html = "<p>side</p>";
        view.title = "Side!";
        events.push("resolved:" + view.viewType);
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
  );
};
`;

let wb: WB;
let root: string;
let viewsDir: string;

beforeAll(async () => {
  // Test the current sources: rebuild the bundled host (identical output when it is up to date).
  execFileSync(process.execPath, [join(__dirname, "../../build.mjs")]);
  const exts = mkdtempSync(join(tmpdir(), "tmcode-fixture-ext-"));
  root = mkdtempSync(join(tmpdir(), "tmcode-fixture-ws-"));
  writeFileSync(join(root, "data.txt"), "from disk");
  const upper = writeExtension(exts, "upper", { main: "./main.js", activationEvents: ["onLanguage:plaintext"], contributes: { commands: [{ command: "upper.run", title: "Upper" }], configuration: { properties: { "upper.suffix": { type: "string", default: "!" } } } } }, { "main.js": UPPER });
  const esm = writeExtension(exts, "esm", { main: "./main.js", type: "module", contributes: { commands: [{ command: "esm.hello", title: "Hello" }] } }, { "main.js": ESM });
  viewsDir = writeExtension(
    exts,
    "views",
    {
      main: "./main.js",
      contributes: {
        viewsContainers: { activitybar: [{ id: "views-c", title: "Views", icon: "media/leaf.svg" }] },
        views: { "views-c": [{ id: "views.tree", name: "Tree" }, { id: "views.side", name: "Side", type: "webview" }] },
        commands: [{ command: "views.panel", title: "Open Panel" }],
      },
    },
    { "main.js": VIEWS, "media/leaf.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>", "media/main.js": "acquireVsCodeApi().postMessage({ type: 'ready' });" },
  );
  const broken = writeExtension(exts, "broken", { main: "./main.js", activationEvents: ["*"] }, { "main.js": "exports.activate = () => { throw new Error('broken on purpose'); };" });
  wb = new FakeWorkbench({
    root,
    extensions: [describeExtension(upper), describeExtension(esm), describeExtension(broken), { ...describeExtension(viewsDir), activationEvents: [] }],
    documents: { "notes.txt": { text: "  hello TODO  \n", languageId: "plaintext" } },
  }) as WB;
  await wb.init;
  await wb.request("$startup");
}, 30_000);

afterAll(async () => {
  await wb?.close();
});

describe("Node extension host (stdio, fixture extensions)", () => {
  it("activates on events and isolates a failing extension", async () => {
    await wb.waitFor(() => wb.states.get("fixture.upper")?.state === "activated", "upper to activate");
    await wb.waitFor(() => wb.states.get("fixture.broken")?.state === "failed", "broken to fail");
    expect(wb.states.get("fixture.broken")?.error).toContain("broken on purpose");
    expect(wb.output.join("")).toContain("activated !");
  });

  it("runs a contributed command that edits the active editor", async () => {
    const text = await wb.request("$executeCommand", ["upper.run", []]);
    expect(text).toBe("  HELLO TODO  \n");
    expect(wb.docs.get("notes.txt")!.text).toBe("  HELLO TODO  \n");
  });

  it("serves formatting and completion providers", async () => {
    const [fmt] = wb.providerOf("formatting");
    const edits = await wb.request("$provide", [fmt, "provideDocumentFormattingEdits", ["notes.txt", { tabSize: 4, insertSpaces: true }]]);
    expect(edits[0].text).toBe("HELLO TODO\n");
    const [comp] = wb.providerOf("completion");
    const list = await wb.request("$provide", [comp, "provideCompletionItems", ["notes.txt", [0, 2], { triggerKind: 0 }]]);
    expect(list.items[0]).toMatchObject({ label: "hello", insertText: "hello ${1:world}", snippet: true, kind: 13 });
  });

  it("reports diagnostics and status bar items", async () => {
    await wb.waitFor(() => [...wb.diagnostics.values()].some((l) => l.length), "diagnostics");
    const list = [...wb.diagnostics.values()].flat() as { message: string; severity: number; range: number[] }[];
    expect(list[0]).toMatchObject({ message: "Found a TODO", severity: 1, range: [0, 8, 0, 12] });
    await wb.waitFor(() => [...wb.statusBar.values()].some((s) => s.text === "$(check) Upper"), "the status bar item");
  });

  it("logs unsupported APIs instead of failing", () => {
    const log = wb.output.join("");
    expect(log).toContain("'window.registerCustomEditorProvider (upper.editor)' is not supported in TMCode yet");
    expect(log).toContain("notebook: 'window.showNotebookDocument' is not supported in TMCode yet.");
  });

  it("loads ES module extensions, reads the workspace and keeps state", async () => {
    expect(await wb.request("$executeCommand", ["esm.hello", []])).toBe("from disk:1");
    expect(wb.states.get("fixture.esm")?.state).toBe("activated");
  });

  it("refuses workspace.fs outside the open folder", async () => {
    expect(await wb.request("$executeCommand", ["esm.outside", [join(tmpdir(), "elsewhere.txt")]])).toBe("NoPermissions");
    expect(await wb.request("$executeCommand", ["esm.outside", [join(root, "missing.txt")]])).toBe("FileNotFound");
  });
});

describe("save participants and terminals", () => {
  const SAVER = `
const vscode = require("vscode");
exports.activate = (context) => {
  context.subscriptions.push(
    vscode.workspace.onWillSaveTextDocument((e) => {
      if (!e.document.fileName.endsWith(".txt")) return;
      e.waitUntil(Promise.resolve([vscode.TextEdit.insert(new vscode.Position(0, 0), "// saved\\n")]));
    }),
    vscode.commands.registerCommand("saver.term", () => {
      const t = vscode.window.createTerminal({ name: "Build" });
      t.sendText("echo hi");
      t.show();
      return vscode.window.terminals.length;
    }),
  );
};`;
  let wb: WB & { notify(m: string, p?: unknown[]): void };
  const terminalCalls: unknown[][] = [];
  beforeAll(async () => {
    const extRoot = mkdtempSync(join(tmpdir(), "tmcode-saver-"));
    const ws = mkdtempSync(join(tmpdir(), "tmcode-saver-ws-"));
    writeFileSync(join(ws, "a.txt"), "hello\n");
    const dir = writeExtension(extRoot, "saver", { main: "./main.js", activationEvents: ["*"] }, { "main.js": SAVER });
    wb = new FakeWorkbench({
      root: ws,
      extensions: [describeExtension(dir)],
      documents: { "a.txt": { text: "hello\n", languageId: "plaintext" } },
      onRequest: (m: string, p: unknown[], w: { notify(m: string, p: unknown[]): void }) => {
        if (m !== "$main.terminal") return undefined;
        terminalCalls.push(p);
        if (p[0] === "create") setTimeout(() => w.notify("$terminalEvent", [p[1], "ready", 7]), 10);
        return null;
      },
    });
    await wb.init;
    await wb.request("$startup");
    await wb.waitFor(() => wb.states.get("fixture.saver")?.state === "activated", "activation");
  });
  afterAll(async () => {
    await wb?.close();
  });

  it("onWillSaveTextDocument edits come back from $willSaveTextDocument", async () => {
    const edits = await wb.request("$willSaveTextDocument", ["a.txt", 1]);
    expect(edits).toEqual([expect.objectContaining({ text: "// saved\n", range: [0, 0, 0, 0] })]);
  });

  it("createTerminal creates, sends text and shows a workbench terminal", async () => {
    const count = await wb.request("$executeCommand", ["saver.term", []]);
    expect(count).toBe(1);
    expect(terminalCalls.map((c) => c[0])).toEqual(["create", "send", "show"]);
    expect(terminalCalls[0][2]).toMatchObject({ name: "Build" });
    expect(terminalCalls[1][2]).toBe("echo hi\r");
  });
});

describe("browser-only extensions on the desktop", () => {
  it("run in the Node host (their web bundle uses `self`)", async () => {
    const extRoot = mkdtempSync(join(tmpdir(), "tmcode-webext-"));
    const WEB = `
const vscode = require("vscode");
self.webExtLoaded = true;
exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand("webext.hello", () => "hello from " + (typeof self === "object" ? "self" : "?")));
};`;
    const dir = writeExtension(extRoot, "webext", { browser: "./dist/web.js", activationEvents: ["onCommand:webext.hello"] }, { "dist/web.js": WEB });
    const wb: WB = new FakeWorkbench({ root: mkdtempSync(join(tmpdir(), "tmcode-webext-ws-")), extensions: [describeExtension(dir)] });
    try {
      await wb.init;
      await wb.request("$startup");
      expect(await wb.request("$executeCommand", ["webext.hello", []])).toBe("hello from self");
    } finally {
      await wb.close();
    }
  });
});

describe("tree views and webviews", () => {
  const ui = () => (wb as unknown as { ui: unknown[][] }).ui;
  const posted = () => (wb as unknown as { posted: { handle: string; message: unknown }[] }).posted;
  const events = () => wb.request("$executeCommand", ["views.events", []]) as Promise<string[]>;

  it("activates on onView and registers the tree", async () => {
    await wb.request("$activateByEvent", ["onView:views.tree"]);
    await wb.waitFor(() => wb.states.get("fixture.views")?.state === "activated", "views to activate", 4000);
    expect(ui()).toContainEqual(["$main.treeView", "register", "views.tree", { extensionId: "fixture.views", canSelectMany: false, showCollapseAll: true, manageCheckboxStateManually: false }]);
    expect(ui()).toContainEqual(["$main.treeView", "update", "views.tree", { message: "Hello tree" }]);
    expect(ui()).toContainEqual(["$main.treeView", "update", "views.tree", { badge: { value: 3, tooltip: "three" } }]);
    expect(ui()).toContainEqual(["$main.webviewView", "register", "views.side", { extensionId: "fixture.views", retainContextWhenHidden: true }]);
  });

  it("serves children lazily with stable handles, icons and commands", async () => {
    const roots = await wb.request("$treeChildren", ["views.tree", null]);
    expect(roots).toEqual([
      expect.objectContaining({ handle: "1/root", label: "root", collapsible: 2, description: "2 items", contextValue: "folder", icon: { codicon: "repo", color: "charts.blue" }, tooltip: expect.objectContaining({ value: "**root**" }), command: { title: "Click" } }),
    ]);
    const kids = await wb.request("$treeChildren", ["views.tree", "1/root"]);
    expect(kids.map((k: { handle: string }) => k.handle)).toEqual(["0/1/root/0:leaf0", "0/1/root/1:leaf1"]);
    expect(kids[0].icon).toEqual({ light: { ext: "fixture.views", path: "media/leaf.svg" }, dark: { ext: "fixture.views", path: "media/leaf.svg" } });
    await wb.request("$treeVisible", ["views.tree", true]);
    await wb.request("$treeSelection", ["views.tree", ["0/1/root/1:leaf1"]]);
    await wb.request("$treeExpanded", ["views.tree", "1/root", true]);
    await wb.request("$treeCommand", ["views.tree", "0/1/root/0:leaf0"]);
    await wb.request("$treeMenuCommand", ["views.tree", "views.menu", "0/1/root/1:leaf1", []]);
    expect(await events()).toEqual(["visible:true", "selected:leaf1", "expanded:root", "clicked:leaf0", "menu:leaf1"]);
  });

  it("refreshes, releases old handles and reveals", async () => {
    const before = ui().length;
    await wb.request("$executeCommand", ["views.grow", []]);
    await wb.waitFor(() => ui().slice(before).some((u) => u[1] === "refresh"), "a refresh");
    expect(ui().slice(before)).toContainEqual(["$main.treeView", "refresh", "views.tree", null]);
    const roots = await wb.request("$treeChildren", ["views.tree", null]);
    // The old children of the root are gone with it.
    expect(await wb.request("$treeChildren", ["views.tree", "0/1/root/0:leaf0"])).toEqual([]);
    expect(roots).toHaveLength(1);
    expect(await wb.request("$treeChildren", ["views.tree", "1/root"])).toHaveLength(3);
    await wb.request("$executeCommand", ["views.reveal", []]);
    await wb.waitFor(() => ui().some((u) => u[1] === "reveal"), "the reveal");
    const reveal = ui().find((u) => u[1] === "reveal") as [string, string, string, { path: string[]; select: boolean }];
    expect(reveal[3]).toMatchObject({ path: ["1/root", "0/1/root/1:leaf1"], select: true });
  });

  it("creates a webview panel, serves asWebviewUri and relays messages both ways", async () => {
    const res = await wb.request("$executeCommand", ["views.panel", []]);
    await wb.waitFor(() => ui().some((u) => u[1] === "html"), "the panel's html");
    expect(res.cspSource).toBe("tmwebview://localhost tmwebview:");
    expect(res.script).toBe(`tmwebview://localhost/wv1/file${viewsDir.replace(/\\/g, "/").replace(/^\/?/, "/")}/media/main.js`);
    const create = ui().find((u) => u[0] === "$main.webview" && u[1] === "create") as [string, string, string, { kind: string; options: { enableScripts: boolean; retainContextWhenHidden: boolean; localResourceRoots: string[] } }];
    expect(create[2]).toBe("wv1");
    expect(create[3]).toMatchObject({ kind: "panel", viewType: "views.panel", title: "Panel", options: { enableScripts: true, retainContextWhenHidden: true } });
    expect(create[3].options.localResourceRoots).toEqual([viewsDir, root]);
    expect(ui().find((u) => u[1] === "html")?.[3]).toContain("script-src tmwebview://localhost tmwebview:");
    await wb.request("$webviewMessage", ["wv1", { type: "ready" }]);
    await wb.waitFor(() => posted().length > 0, "the echo");
    expect(posted()[0]).toEqual({ handle: "wv1", message: { echo: "ready" } });
    await wb.request("$webviewPanelDisposed", ["wv1"]);
    expect(await events()).toEqual(["webview:ready", "disposed"]);
  });

  it("resolves a webview view when the workbench shows it", async () => {
    const handle = await wb.request("$resolveWebviewView", ["views.side"]);
    expect(handle).toBe("wv2");
    await wb.waitFor(() => ui().some((u) => u[1] === "viewMeta"), "the view's title");
    expect(ui()).toContainEqual(["$main.webview", "create", "wv2", expect.objectContaining({ kind: "view", viewType: "views.side" })]);
    expect(ui()).toContainEqual(["$main.webview", "html", "wv2", "<p>side</p>"]);
    expect(ui()).toContainEqual(["$main.webview", "viewMeta", "wv2", { title: "Side!" }]);
    expect(await events()).toEqual(["resolved:views.side"]);
  });
});

describe("the active editor", () => {
  it("fires onDidChangeActiveTextEditor when a group switches files, and when the document arrives late", async () => {
    const extRoot = mkdtempSync(join(tmpdir(), "tmcode-active-"));
    const SRC = `
const vscode = require("vscode");
exports.activate = (context) => {
  const seen = [];
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => seen.push(ed ? vscode.workspace.asRelativePath(ed.document.uri) : "none")),
    vscode.commands.registerCommand("active.seen", () => seen.join(",")),
    vscode.commands.registerCommand("active.now", () => (vscode.window.activeTextEditor ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri) : "none")),
  );
};`;
    const dir = writeExtension(extRoot, "active", { main: "./main.js", activationEvents: ["*"] }, { "main.js": SRC });
    const ws = mkdtempSync(join(tmpdir(), "tmcode-active-ws-"));
    const wb = new FakeWorkbench({ root: ws, extensions: [describeExtension(dir)], documents: { "a.js": { text: "a\n", languageId: "javascript" } } }) as WB & { notify(m: string, p?: unknown[]): void };
    const editor = (path: string) => ({ id: "g0", path, selections: [{ anchor: [0, 0], active: [0, 0] }], visibleRanges: [[0, 0, 1, 0]], options: { tabSize: 2, insertSpaces: true }, viewColumn: 1 });
    const doc = (path: string) => ({ path, languageId: "html", version: 1, text: "<div></div>\n", eol: "\n", isDirty: false });
    try {
      await wb.init;
      await wb.request("$startup");
      await wb.waitFor(() => wb.states.get("fixture.active")?.state === "activated", "activation");
      // The same group (g0) now shows b.html: a new TextEditor, so the event fires.
      wb.notify("$documentOpened", [doc("b.html")]);
      wb.notify("$editorsChanged", [[editor("b.html")], "g0"]);
      expect(await wb.request("$executeCommand", ["active.now", []])).toBe("b.html");
      // The switch to c.html arrives before its document.
      wb.notify("$editorsChanged", [[editor("c.html")], "g0"]);
      wb.notify("$documentOpened", [doc("c.html")]);
      expect(await wb.request("$executeCommand", ["active.now", []])).toBe("c.html");
      expect(await wb.request("$executeCommand", ["active.seen", []])).toBe("b.html,none,c.html");
    } finally {
      await wb.close();
    }
  });
});

describe("built-in language basics", () => {
  it("lists language configurations in extensions.all, readable through workspace.fs (Better Comments)", async () => {
    const extRoot = mkdtempSync(join(tmpdir(), "tmcode-basics-"));
    const SRC = `
const vscode = require("vscode");
const path = require("path");
exports.activate = (context) => {
  context.subscriptions.push(vscode.commands.registerCommand("basics.comments", async (lang) => {
    for (const ext of vscode.extensions.all) {
      for (const l of (ext.packageJSON.contributes && ext.packageJSON.contributes.languages) || []) {
        if (l.id !== lang || !l.configuration) continue;
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(ext.extensionPath, l.configuration)));
        return ext.id + " " + JSON.stringify(JSON.parse(new TextDecoder().decode(raw)).comments);
      }
    }
    return "none";
  }));
};`;
    const dir = writeExtension(extRoot, "basics", { main: "./main.js", activationEvents: ["onCommand:basics.comments"] }, { "main.js": SRC });
    const wb: WB = new FakeWorkbench({ root: mkdtempSync(join(tmpdir(), "tmcode-basics-ws-")), extensions: [describeExtension(dir)] });
    try {
      await wb.init;
      await wb.request("$startup");
      expect(await wb.request("$executeCommand", ["basics.comments", ["javascript"]])).toBe('tmcode.language-basics {"lineComment":"//","blockComment":["/*","*/"]}');
      expect(await wb.request("$executeCommand", ["basics.comments", ["python"]])).toContain('"lineComment":"#"');
    } finally {
      await wb.close();
    }
  });
});
