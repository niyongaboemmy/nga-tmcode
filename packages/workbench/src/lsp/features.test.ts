import { beforeAll, describe, expect, it } from "vitest";
import { MemoryFileSystem } from "../platform/memory";
import type { Platform } from "../platform/types";
import { initWorkbench } from "../state/store";
import { monaco } from "../monaco/setup";
import { ensureDocument, uriFor } from "../monaco/documents";
import { workspaceSymbols } from "../commands/symbols";
import { pyrightSettings } from "./manifest";
import { inlayLabel, LanguageClient, markersAsDiagnostics, toFoldingRanges, toInlayHint, toSelectionRanges } from "./client";

// jsdom has no CSS.escape; Monaco's theme service needs it.
const g = globalThis as { CSS?: { escape?: (s: string) => string } };
g.CSS ??= {};
g.CSS.escape ??= (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`);
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const r = (line: number, a: number, b: number, endLine = line) => ({ start: { line, character: a }, end: { line: endLine, character: b } });

describe("LSP conversions for the newer features", () => {
  it("inlay hints, folding and selection ranges", () => {
    expect(inlayLabel([{ value: ": " }, { value: "int" }])).toBe(": int");
    expect(toInlayHint({ position: { line: 0, character: 5 }, label: ": int", kind: 1, paddingLeft: true })).toMatchObject({ label: ": int", position: { lineNumber: 1, column: 6 }, kind: monaco.languages.InlayHintKind.Type, paddingLeft: true });
    expect(toFoldingRanges([{ startLine: 0, endLine: 3, kind: "imports" }, { startLine: 5, endLine: 9 }])).toEqual([
      { start: 1, end: 4, kind: monaco.languages.FoldingRangeKind.Imports },
      { start: 6, end: 10, kind: undefined },
    ]);
    const sel = toSelectionRanges([{ range: r(0, 4, 9), parent: { range: r(0, 0, 20), parent: { range: r(0, 0, 0, 3) } } }]);
    expect(sel[0].map((s) => s.range.endColumn)).toEqual([10, 21, 1]);
  });

  it("sends the server its own markers back as diagnostics", () => {
    const d = markersAsDiagnostics([{ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 6, severity: monaco.MarkerSeverity.Warning, message: "unused", source: "Pyright", code: "reportUnused", owner: "pyright", resource: monaco.Uri.parse("tmcode:/a.py") }]);
    expect(d).toEqual([{ range: r(1, 0, 5), severity: 2, message: "unused", source: "Pyright", code: "reportUnused" }]);
  });
});

describe("the language client: quick fixes, formatting, hints, lenses, symbols", () => {
  const ROOT = "/home/ada/proj";
  const files = { "main.py": "import os\nx=1\nprint( x )\n", "lib.py": "def greet():\n    pass\n" };
  const received: { id?: number; method?: string; params?: Record<string, unknown> }[] = [];
  let client: LanguageClient;

  function server(text: string) {
    const msg = JSON.parse(text) as { id?: number; method?: string; params?: Record<string, unknown> };
    received.push(msg);
    const reply = (result: unknown) => queueMicrotask(() => client.receive(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })));
    switch (msg.method) {
      case "initialize":
        return reply({
          capabilities: {
            codeActionProvider: { codeActionKinds: ["quickfix", "source.organizeImports"], resolveProvider: true },
            documentFormattingProvider: true,
            documentRangeFormattingProvider: true,
            inlayHintProvider: true,
            codeLensProvider: { resolveProvider: true },
            foldingRangeProvider: true,
            selectionRangeProvider: true,
            workspaceSymbolProvider: true,
            executeCommandProvider: { commands: ["pyright.organizeimports"] },
            semanticTokensProvider: { legend: { tokenTypes: ["variable", "function"], tokenModifiers: [] }, full: true },
          },
        });
      case "textDocument/codeAction":
        return reply([
          { title: "Remove unused import", kind: "quickfix", isPreferred: true, diagnostics: [{ range: r(0, 7, 9), message: '"os" is not accessed' }], edit: { changes: { [`file://${ROOT}/main.py`]: [{ range: r(0, 0, 0, 1), newText: "" }] } } },
          { title: "Organize Imports", kind: "source.organizeImports", data: { lazy: true } },
          { title: "Run a server command", command: "pyright.organizeimports", arguments: [`file://${ROOT}/main.py`] },
        ]);
      case "codeAction/resolve":
        return reply({ ...(msg.params as object), edit: { changes: { [`file://${ROOT}/main.py`]: [{ range: r(0, 0, 0, 0), newText: "# sorted\n" }] } } });
      case "textDocument/formatting":
        return reply([{ range: r(1, 0, 3), newText: "x = 1" }]);
      case "textDocument/rangeFormatting":
        return reply([{ range: r(2, 0, 10), newText: "print(x)" }]);
      case "textDocument/inlayHint":
        return reply([{ position: { line: 1, character: 1 }, label: ": int", kind: 1 }]);
      case "textDocument/codeLens":
        return reply([{ range: r(0, 0, 3), data: { refs: 1 } }]);
      case "codeLens/resolve":
        return reply({ ...(msg.params as object), command: { title: "1 reference", command: "pyright.showReferences" } });
      case "textDocument/semanticTokens/full":
        return reply({ data: [1, 0, 1, 0, 0] });
      case "workspace/symbol":
        return reply([
          { name: "greet", kind: 12, location: { uri: `file://${ROOT}/lib.py`, range: r(0, 4, 9) } },
          { name: "print", kind: 12, location: { uri: "file:///usr/lib/typeshed/builtins.pyi", range: r(0, 0, 1) } },
        ]);
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

  it("asks for the newer features when it starts", () => {
    const caps = received[0].params?.capabilities as { textDocument: Record<string, unknown>; workspace: Record<string, unknown> };
    for (const k of ["codeAction", "formatting", "rangeFormatting", "inlayHint", "codeLens", "foldingRange", "selectionRange", "documentLink", "semanticTokens"]) expect(caps.textDocument[k], k).toBeTruthy();
    expect(caps.workspace.executeCommand).toBeTruthy();
  });

  it("quick fixes carry their edit and the server's markers; lazy ones resolve when picked; commands run on the server", async () => {
    const main = await ensureDocument("main.py");
    monaco.editor.setModelMarkers(main, "pyright", [{ startLineNumber: 1, startColumn: 8, endLineNumber: 1, endColumn: 10, severity: monaco.MarkerSeverity.Hint, message: '"os" is not accessed', source: "Pyright" }]);
    const actions = await client.provideCodeActions(main, new monaco.Range(1, 1, 1, 10));
    expect(actions.map((a) => a.title)).toEqual(["Remove unused import", "Organize Imports", "Run a server command"]);
    const sent = received.filter((m) => m.method === "textDocument/codeAction").at(-1)!.params as { context: { diagnostics: { message: string }[] } };
    expect(sent.context.diagnostics.map((d) => d.message)).toEqual(['"os" is not accessed']);
    expect(actions[0].isPreferred).toBe(true);
    expect(actions[0].diagnostics).toHaveLength(1);
    expect((actions[0].edit!.edits[0] as monaco.languages.IWorkspaceTextEdit).resource.toString()).toBe(uriFor("main.py").toString());
    const resolved = await client.resolveCodeAction(actions[1]);
    expect((resolved.edit!.edits[0] as monaco.languages.IWorkspaceTextEdit).textEdit.text).toBe("# sorted\n");
    expect(actions[2].command?.id).toBe(client.commandId);
    await client.executeCommand(actions[2].command!.arguments![0] as { title: string; command: string });
    expect(received.find((m) => m.method === "workspace/executeCommand")?.params).toEqual({ command: "pyright.organizeimports", arguments: [`file://${ROOT}/main.py`] });
  });

  it("formats a document or a selection", async () => {
    const main = await ensureDocument("main.py");
    const opts = { tabSize: 4, insertSpaces: true };
    expect(await client.provideFormatting(main, opts)).toEqual([{ range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 }, text: "x = 1" }]);
    expect((await client.provideFormatting(main, opts, new monaco.Range(3, 1, 3, 11)))[0].text).toBe("print(x)");
    expect(received.find((m) => m.method === "textDocument/formatting")?.params).toMatchObject({ options: { tabSize: 4, insertSpaces: true } });
  });

  it("inlay hints, code lenses (resolved), semantic tokens", async () => {
    const main = await ensureDocument("main.py");
    expect((await client.provideInlayHints(main, new monaco.Range(1, 1, 3, 1)))[0]).toMatchObject({ label: ": int", position: { lineNumber: 2, column: 2 } });
    const lenses = await client.provideCodeLenses(main);
    expect(lenses[0].command).toBeUndefined();
    expect((await client.resolveCodeLens(lenses[0])).command?.title).toBe("1 reference");
    expect(Array.from((await client.provideSemanticTokens(main))!.data)).toEqual([1, 0, 1, 0, 0]);
  });

  it("# workspace symbols in Quick Open come from the server (folder files only)", async () => {
    const found = await workspaceSymbols("gre");
    expect(found).toEqual([{ name: "greet", kind: monaco.languages.SymbolKind.Function, path: "lib.py", line: 1, column: 5, container: undefined }]);
    await client.dispose();
    expect(await workspaceSymbols("gre")).toEqual([]);
  });
});
