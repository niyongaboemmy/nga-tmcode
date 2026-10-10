import { beforeAll, describe, expect, it, vi } from "vitest";
import { EXAM_POLICY_DEFAULTS } from "@tmcode/protocol";
import { MemoryFileSystem } from "../platform/memory";
import { createFakeLanguageServers } from "../platform/memoryLanguageServer";
import type { Platform } from "../platform/types";
import { initWorkbench, setPolicy, useWorkbench } from "../state/store";
import { languageServerRunning, wireLanguageServers } from "./servers";
import { monaco } from "../monaco/setup";
import { ensureDocument, getDocument, uriFor } from "../monaco/documents";
import { fileUri, pathOfFileUri, rootUri } from "./uri";
import { isCancellation, RpcConnection, RpcError } from "./jsonrpc";
import { configurationSection, downloadAllowed, pyrightSettings, serverAllowed, serverFor, SERVERS } from "./manifest";
import { LanguageClient, toCompletion, toDocumentSymbols, toMarker, toMarkdown, workspaceEditChanges } from "./client";

// jsdom has no CSS.escape; Monaco's theme service (started by model services) needs it.
const g = globalThis as { CSS?: { escape?: (s: string) => string } };
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`);
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

describe("file URIs", () => {
  it("maps workspace paths both ways (macOS/Linux)", () => {
    expect(rootUri("/Users/ada/my proj")).toBe("file:///Users/ada/my%20proj");
    expect(fileUri("/Users/ada/my proj", "src/a b.py")).toBe("file:///Users/ada/my%20proj/src/a%20b.py");
    expect(pathOfFileUri("/Users/ada/my proj", "file:///Users/ada/my%20proj/src/a%20b.py")).toBe("src/a b.py");
    expect(pathOfFileUri("/Users/ada/my proj", "file:///Users/ada/my%20proj")).toBe("");
    // Outside the folder: library stubs, a sibling folder with the same prefix.
    expect(pathOfFileUri("/Users/ada/proj", "file:///usr/lib/python3/typing.pyi")).toBeNull();
    expect(pathOfFileUri("/Users/ada/proj", "file:///Users/ada/project2/x.py")).toBeNull();
    expect(pathOfFileUri("/Users/ada/proj", "untitled:Untitled-1")).toBeNull();
  });

  it("handles Windows drive letters and case", () => {
    expect(rootUri("C:\\Users\\Ada\\proj")).toBe("file:///c%3A/Users/Ada/proj");
    expect(fileUri("C:\\Users\\Ada\\proj", "main.py")).toBe("file:///c%3A/Users/Ada/proj/main.py");
    expect(pathOfFileUri("C:\\Users\\Ada\\proj", "file:///c%3A/Users/Ada/proj/pkg/m.py")).toBe("pkg/m.py");
    expect(pathOfFileUri("C:\\Users\\Ada\\proj", "file:///C:/users/ada/PROJ/main.py")).toBe("main.py");
  });
});

describe("JSON-RPC", () => {
  function pair() {
    const sent: { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown }[] = [];
    const rpc = new RpcConnection({ send: (t) => sent.push(JSON.parse(t)) });
    return { rpc, sent };
  }

  it("matches responses to requests and turns errors into RpcError", async () => {
    const { rpc, sent } = pair();
    const a = rpc.request("a", { x: 1 });
    const b = rpc.request("b", null);
    rpc.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[1].id, error: { code: -32800, message: "cancelled" } }));
    rpc.receive(JSON.stringify({ jsonrpc: "2.0", id: sent[0].id, result: 42 }));
    expect(await a).toBe(42);
    const err = await b.catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(isCancellation(err)).toBe(true);
  });

  it("cancels, answers server requests and fails pending requests on close", async () => {
    const { rpc, sent } = pair();
    let cancel: () => void = () => {};
    const p = rpc.request("slow", null, { isCancellationRequested: false, onCancellationRequested: (cb) => (cancel = cb) });
    cancel();
    expect(sent[1]).toMatchObject({ method: "$/cancelRequest", params: { id: sent[0].id } });
    rpc.onRequest("workspace/configuration", () => [1]);
    rpc.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: {} }));
    rpc.receive(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "nobody/handles" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toContainEqual({ jsonrpc: "2.0", id: 7, result: [1] });
    expect(sent.find((m) => m.id === 8)).toMatchObject({ error: { code: -32601 } });
    rpc.close();
    await expect(p).rejects.toThrow("stopped");
    await expect(rpc.request("after", null)).rejects.toThrow("stopped");
  });
});

describe("which servers run", () => {
  it("Pyright serves Python; the Java server is planned, not built in", () => {
    expect(serverFor("python")?.id).toBe("pyright");
    expect(serverFor("java")).toBeNull();
    expect(SERVERS.find((s) => s.id === "jdtls")?.runtime).toBe("jdk");
  });

  it("is off in exams unless the policy gives diagnostics or full intelligence", () => {
    expect(serverAllowed({ mode: "practice", intelligence: "none" })).toBe(true);
    expect(serverAllowed({ mode: "monitored", intelligence: "basic" })).toBe(false);
    expect(serverAllowed({ mode: "secure", intelligence: "none" })).toBe(false);
    expect(serverAllowed({ mode: "monitored", intelligence: "diagnostics" })).toBe(true);
    expect(serverAllowed({ mode: "secure", intelligence: "full" })).toBe(true);
    expect(downloadAllowed({ mode: "practice" })).toBe(true);
    expect(downloadAllowed({ mode: "monitored" })).toBe(false);
  });

  it("answers workspace/configuration sections", () => {
    const s = pyrightSettings("/usr/bin/python3");
    expect(configurationSection(s, "python")).toMatchObject({ pythonPath: "/usr/bin/python3" });
    expect(configurationSection(s, "python.analysis")).toMatchObject({ typeCheckingMode: "off", diagnosticMode: "openFilesOnly" });
    expect(configurationSection(s, "python.nothing")).toBeNull();
    expect(configurationSection(s, undefined)).toBe(s);
    expect(configurationSection(pyrightSettings(null), "python")).not.toHaveProperty("pythonPath");
  });
});

describe("LSP → Monaco", () => {
  it("converts markdown, diagnostics, completions and symbols", () => {
    expect(toMarkdown({ kind: "markdown", value: "**x**" })).toEqual([{ value: "**x**" }]);
    expect(toMarkdown([{ language: "python", value: "def f()" }, "plain"])).toEqual([{ value: "```python\ndef f()\n```" }, { value: "plain" }]);
    const m = toMarker({ range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, severity: 2, message: '"foo" is not defined', code: "reportUndefinedVariable", tags: [1] }, "Pyright");
    expect(m).toMatchObject({ startLineNumber: 1, startColumn: 5, endColumn: 8, severity: monaco.MarkerSeverity.Warning, source: "Pyright", code: "reportUndefinedVariable", tags: [1] });
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 };
    const c = toCompletion({ label: "append", kind: 2, insertText: "append($0)", insertTextFormat: 2, documentation: { kind: "markdown", value: "Add" } }, range);
    expect(c).toMatchObject({ label: "append", kind: monaco.languages.CompletionItemKind.Method, insertText: "append($0)", insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range, documentation: { value: "Add" } });
    const e = toCompletion({ label: "x", textEdit: { newText: "xy", insert: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, replace: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } } }, range);
    expect(e.range).toEqual({ insert: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 }, replace: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 } });
    const r = { start: { line: 1, character: 0 }, end: { line: 3, character: 0 } };
    const syms = toDocumentSymbols([{ name: "Grade", kind: 5, range: r, selectionRange: r, children: [{ name: "score", kind: 6, range: r, selectionRange: r }] }]);
    expect(syms[0]).toMatchObject({ name: "Grade", kind: monaco.languages.SymbolKind.Class, children: [{ name: "score", kind: monaco.languages.SymbolKind.Method }] });
  });

  it("collects WorkspaceEdit text edits from changes and documentChanges", () => {
    const edit = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "y" };
    const map = workspaceEditChanges({ changes: { "file:///a.py": [edit] }, documentChanges: [{ textDocument: { uri: "file:///a.py" }, edits: [edit] }, { kind: "create" }] });
    expect(map.get("file:///a.py")).toHaveLength(2);
  });
});

describe("the language client against a scripted server", () => {
  const ROOT = "/home/ada/proj";
  const files = {
    "main.py": "from lib import greet\n\ngreet('Ada')\n",
    "lib.py": "def greet(name):\n    return 'Hello ' + name\n",
  };
  const received: { method?: string; params?: Record<string, unknown> }[] = [];
  let client: LanguageClient;
  const loc = (path: string, line: number, a: number, b: number) => ({ uri: `file://${ROOT}/${path}`, range: { start: { line, character: a }, end: { line, character: b } } });

  /** A tiny fake Pyright: answers what the test needs, records the rest. */
  function server(text: string) {
    const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> };
    received.push(msg);
    const reply = (result: unknown) => queueMicrotask(() => client.receive(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })));
    switch (msg.method) {
      case "initialize":
        // The server asks for its settings during startup, as Pyright does.
        queueMicrotask(() => client.receive(JSON.stringify({ jsonrpc: "2.0", id: 900, method: "workspace/configuration", params: { items: [{ section: "python.analysis" }] } })));
        return reply({ capabilities: { definitionProvider: true, referencesProvider: true, renameProvider: { prepareProvider: true }, completionProvider: { triggerCharacters: ["."] }, hoverProvider: true } });
      case "textDocument/definition":
        // One target in the folder (unopened), one in a typeshed stub outside it.
        return reply([loc("lib.py", 0, 4, 9), { uri: "file:///usr/lib/typeshed/builtins.pyi", range: loc("x", 0, 0, 1).range }]);
      case "textDocument/rename":
        return reply({ changes: { [`file://${ROOT}/main.py`]: [{ ...loc("main.py", 0, 16, 21), newText: "welcome" }, { ...loc("main.py", 2, 0, 5), newText: "welcome" }], [`file://${ROOT}/lib.py`]: [{ ...loc("lib.py", 0, 4, 9), newText: "welcome" }] } });
      default:
        if (msg.id !== undefined && msg.method) reply(null);
    }
  }

  beforeAll(async () => {
    const memory = new Map<string, unknown>();
    const platform = { kind: "web", os: "linux", version: "test", fs: new MemoryFileSystem(files), store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) } } as unknown as Platform;
    await initWorkbench(platform);
    client = new LanguageClient({ id: "pyright", label: "Pyright", languages: ["python"], root: ROOT, settings: pyrightSettings("/usr/bin/python3") }, { send: server });
    await client.start();
  });

  it("initializes, answers configuration and opens Python documents", async () => {
    expect(received[0]).toMatchObject({ method: "initialize", params: { rootUri: `file://${ROOT}` } });
    expect(received.find((m) => m.method === "initialized")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 0));
    expect(received).toContainEqual({ jsonrpc: "2.0", id: 900, result: [{ typeCheckingMode: "off", diagnosticMode: "openFilesOnly", autoSearchPaths: true, useLibraryCodeForTypes: true, autoImportCompletions: true }] });
    await ensureDocument("main.py");
    const open = received.find((m) => m.method === "textDocument/didOpen");
    expect(open?.params).toMatchObject({ textDocument: { uri: `file://${ROOT}/main.py`, languageId: "python", version: 1 } });
    getDocument("main.py")!.setValue("from lib import greet\n\ngreet('Ada')  \n");
    expect(received.filter((m) => m.method === "textDocument/didChange").at(-1)?.params).toMatchObject({ textDocument: { version: 2 } });
  });

  it("Go to Definition into an unopened file loads it; stubs outside the folder are skipped", async () => {
    const main = await ensureDocument("main.py");
    const links = await client.provideDefinition("definition", main, { lineNumber: 3, column: 2 });
    expect(links).toHaveLength(1);
    expect(links[0].uri.toString()).toBe(uriFor("lib.py").toString());
    expect(links[0].range).toMatchObject({ startLineNumber: 1, startColumn: 5, endColumn: 10 });
    // Peek needs a model: lib.py is loaded in the background (not an editor).
    expect(monaco.editor.getModel(uriFor("lib.py"))?.getValue()).toContain("def greet");
  });

  it("Rename edits every file the server names", async () => {
    const main = await ensureDocument("main.py");
    const edit = await client.provideRenameEdits(main, { lineNumber: 3, column: 2 }, "welcome");
    const byFile = new Map<string, number>();
    for (const e of edit.edits as monaco.languages.IWorkspaceTextEdit[]) byFile.set(e.resource.path, (byFile.get(e.resource.path) ?? 0) + 1);
    expect(Object.fromEntries(byFile)).toEqual({ "/main.py": 2, "/lib.py": 1 });
  });

  it("shows the server's diagnostics as markers, and clears them when it stops", async () => {
    const main = await ensureDocument("main.py");
    client.publishDiagnostics({ uri: `file://${ROOT}/main.py`, diagnostics: [{ range: loc("main.py", 2, 0, 5).range, severity: 1, message: '"greet" is not defined' }] });
    expect(monaco.editor.getModelMarkers({ owner: "pyright", resource: main.uri })).toHaveLength(1);
    await client.dispose();
    expect(received.find((m) => m.method === "shutdown")).toBeTruthy();
    expect(monaco.editor.getModelMarkers({ owner: "pyright", resource: main.uri })).toHaveLength(0);
  });
});

describe("built-in servers follow the exam policy", () => {
  it("never starts under a 'basic' exam policy, starts when it allows diagnostics, stops when it no longer does", async () => {
    const fs = new MemoryFileSystem({ "a.py": "x = 1\n" });
    const host = createFakeLanguageServers(fs);
    await host.install("pyright", () => {});
    const policies: boolean[] = [];
    const probes: string[] = [];
    const memory = new Map<string, unknown>();
    const platform = {
      kind: "web",
      os: "linux",
      version: "test",
      fs,
      store: { get: async (k: string) => memory.get(k), set: async (k: string, v: unknown) => void memory.set(k, v) },
      languageServers: { ...host, probe: (s: "pyright") => (probes.push(s), host.probe(s)), setExamPolicy: (a: boolean) => void policies.push(a) },
    } as unknown as Platform;
    await initWorkbench(platform);
    useWorkbench.setState({ workspace: { name: "exam", root: "/exams/1" }, policy: { ...EXAM_POLICY_DEFAULTS, intelligence: "basic" } });
    wireLanguageServers();
    await ensureDocument("a.py");
    await new Promise((r) => setTimeout(r, 20));
    expect(probes).toEqual([]);
    expect(languageServerRunning("python")).toBe(false);
    expect(policies.at(-1)).toBe(false);

    setPolicy({ ...EXAM_POLICY_DEFAULTS, intelligence: "diagnostics" });
    await vi.waitFor(() => expect(languageServerRunning("python")).toBe(true));
    expect(policies.at(-1)).toBe(true);

    setPolicy({ ...EXAM_POLICY_DEFAULTS, intelligence: "none" });
    expect(languageServerRunning("python")).toBe(false);
    expect(policies.at(-1)).toBe(false);
  });

  it("maps the browser build's folders to file URIs and back", () => {
    expect(fileUri("memory://practice-project", "py/a.py")).toBe("file:///memory/practice-project/py/a.py");
    expect(pathOfFileUri("memory://practice-project", "file:///memory/practice-project/py/a.py")).toBe("py/a.py");
  });
});
