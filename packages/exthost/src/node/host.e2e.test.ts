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
  vscode.window.registerTreeDataProvider("upper.view", {});
  try { vscode.window.createWebviewPanel("x", "x", 1, {}); } catch (e) { out.appendLine("webview: " + e.message); }
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

let wb: WB;
let root: string;

beforeAll(async () => {
  // Test the current sources: rebuild the bundled host (identical output when it is up to date).
  execFileSync(process.execPath, [join(__dirname, "../../build.mjs")]);
  const exts = mkdtempSync(join(tmpdir(), "tmcode-fixture-ext-"));
  root = mkdtempSync(join(tmpdir(), "tmcode-fixture-ws-"));
  writeFileSync(join(root, "data.txt"), "from disk");
  const upper = writeExtension(exts, "upper", { main: "./main.js", activationEvents: ["onLanguage:plaintext"], contributes: { commands: [{ command: "upper.run", title: "Upper" }], configuration: { properties: { "upper.suffix": { type: "string", default: "!" } } } } }, { "main.js": UPPER });
  const esm = writeExtension(exts, "esm", { main: "./main.js", type: "module", contributes: { commands: [{ command: "esm.hello", title: "Hello" }] } }, { "main.js": ESM });
  const broken = writeExtension(exts, "broken", { main: "./main.js", activationEvents: ["*"] }, { "main.js": "exports.activate = () => { throw new Error('broken on purpose'); };" });
  wb = new FakeWorkbench({
    root,
    extensions: [describeExtension(upper), describeExtension(esm), describeExtension(broken)],
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
    expect(log).toContain("'window.registerTreeDataProvider (upper.view)' is not supported in TMCode yet");
    expect(log).toContain("webview: 'window.createWebviewPanel' is not supported in TMCode yet.");
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
