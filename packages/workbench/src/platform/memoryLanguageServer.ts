import type { DirEntry, LanguageServerEvent, LanguageServerHost } from "./types";

/**
 * Browser build (e2e only): a stand-in for Pyright that speaks real LSP JSON
 * to the workbench's client, so the client, the download offer and the
 * editor wiring are tested without Node or a download. Turned on by
 * `window.__TMCODE_FAKE_LSP__ = true` before the app starts.
 *
 * It knows three things: `def name` in any .py file (Go to Definition and
 * hover), and that `undefined_thing` is not defined (a diagnostic).
 */

type Fs = { readFile(p: string): Promise<string>; readDir(p: string): Promise<DirEntry[]> };

export function fakeLanguageServersEnabled() {
  return typeof window !== "undefined" && !!(window as unknown as { __TMCODE_FAKE_LSP__?: boolean }).__TMCODE_FAKE_LSP__;
}

export function createFakeLanguageServers(fs: Fs): LanguageServerHost {
  let installed = false;
  let next = 0;
  return {
    async probe(server) {
      if (server !== "pyright") return { available: false, install: null, detail: null, message: "Not available in the browser build.", python: null };
      return installed
        ? { available: true, install: null, detail: "Pyright (test double)", message: null, python: null }
        : { available: false, install: "pyright", detail: null, message: "Python IntelliSense uses Pyright, downloaded once.", python: null };
    },
    async install(_server, onEvent) {
      for (const downloaded of [2e6, 4e6, 6e6]) {
        onEvent({ type: "progress", downloaded, total: 6e6 });
        await new Promise((r) => setTimeout(r, 30));
      }
      installed = true;
    },
    async start(_server, onEvent) {
      const id = ++next;
      const server = fakePyright(fs, (m) => setTimeout(() => onEvent({ type: "message", message: JSON.stringify(m) }), 0), (e) => setTimeout(() => onEvent(e), 0));
      return { id, send: (text) => void server(JSON.parse(text)), stop: () => setTimeout(() => onEvent({ type: "exit", code: null }), 0) };
    },
  };
}

type Msg = { id?: number; method?: string; params?: Record<string, unknown> & { textDocument?: { uri: string; text?: string }; position?: { line: number; character: number }; contentChanges?: { text: string }[] } };

function fakePyright(fs: Fs, send: (m: unknown) => void, emit: (e: LanguageServerEvent) => void) {
  const docs = new Map<string, string>();
  let root = "file:///";
  const reply = (id: number | undefined, result: unknown) => send({ jsonrpc: "2.0", id, result });
  const uriOf = (path: string) => `${root}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const diagnose = (uri: string, text: string) => {
    const diagnostics = text.split("\n").flatMap((line, i) => {
      const at = line.indexOf("undefined_thing");
      return at < 0 ? [] : [{ range: { start: { line: i, character: at }, end: { line: i, character: at + 15 } }, severity: 2, source: "Pyright", message: '"undefined_thing" is not defined' }];
    });
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  };
  const pyFiles = async () => {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readDir(dir).catch(() => [] as DirEntry[])) {
        if (e.kind === "dir") await walk(e.path);
        else if (e.name.endsWith(".py")) out.push(e.path);
      }
    };
    await walk("");
    return out;
  };
  const wordAt = (text: string, pos: { line: number; character: number }) => {
    const line = text.split("\n")[pos.line] ?? "";
    const left = /[\w]*$/.exec(line.slice(0, pos.character))?.[0] ?? "";
    const right = /^[\w]*/.exec(line.slice(pos.character))?.[0] ?? "";
    return left + right;
  };
  return async (m: Msg) => {
    switch (m.method) {
      case "initialize":
        root = String((m.params as { rootUri?: string }).rootUri ?? root).replace(/\/$/, "");
        send({ jsonrpc: "2.0", method: "window/logMessage", params: { type: 3, message: "Pyright test double ready" } });
        return reply(m.id, { capabilities: { textDocumentSync: 1, definitionProvider: true, hoverProvider: true } });
      case "textDocument/didOpen":
        docs.set(m.params!.textDocument!.uri, m.params!.textDocument!.text ?? "");
        return diagnose(m.params!.textDocument!.uri, m.params!.textDocument!.text ?? "");
      case "textDocument/didChange": {
        const text = m.params!.contentChanges?.at(-1)?.text ?? "";
        docs.set(m.params!.textDocument!.uri, text);
        return diagnose(m.params!.textDocument!.uri, text);
      }
      case "textDocument/didClose":
        docs.delete(m.params!.textDocument!.uri);
        return;
      case "textDocument/definition": {
        const word = wordAt(docs.get(m.params!.textDocument!.uri) ?? "", m.params!.position!);
        if (!word) return reply(m.id, null);
        const re = new RegExp(`^\\s*def\\s+${word}\\b`);
        for (const path of await pyFiles()) {
          const text = docs.get(uriOf(path)) ?? (await fs.readFile(path).catch(() => ""));
          const lines = text.split("\n");
          const line = lines.findIndex((l) => re.test(l));
          if (line < 0) continue;
          const character = lines[line].indexOf(word);
          return reply(m.id, [{ uri: uriOf(path), range: { start: { line, character }, end: { line, character: character + word.length } } }]);
        }
        return reply(m.id, []);
      }
      case "textDocument/hover": {
        const word = wordAt(docs.get(m.params!.textDocument!.uri) ?? "", m.params!.position!);
        return reply(m.id, word ? { contents: { kind: "markdown", value: `\`\`\`python\n(name) ${word}\n\`\`\`` } } : null);
      }
      case "shutdown":
        return reply(m.id, null);
      case "exit":
        return emit({ type: "exit", code: 0 });
      default:
        if (m.id !== undefined && m.method) reply(m.id, null);
    }
  };
}
