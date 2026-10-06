/**
 * The Web Worker extension host: runs extensions' `browser` entry points
 * (VS Code for the Web style) with the same `vscode` API as the Node host.
 * Extension files and the workspace come from the workbench over RPC; the
 * worker has no file system of its own. Modules are CommonJS (what browser
 * extension bundles are); Node built-ins are not available.
 */

import { ExtHost, type HostEnvironment } from "../host/extHost";
import { FileSystemError, FileType } from "../api/types";
import type { Uri } from "../api/uri";
import type { HostFs, ModuleLoader } from "../host/fs";
import type { FileStatDTO } from "../protocol";

const scope = self as unknown as {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent) => void) | null;
  addEventListener(type: string, fn: (e: Event & { reason?: unknown; error?: unknown; message?: string }) => void): void;
};

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Workspace files through the workbench; storage (globalStorageUri…) in memory for this session. */
class WorkerFs implements HostFs {
  #mem = new Map<string, Uint8Array>();
  constructor(private readonly host: ExtHost) {}

  #ws(uri: Uri): string | null {
    return this.host.paths.toPath(uri);
  }

  async #call<T>(op: string, uri: Uri, ...args: unknown[]): Promise<T> {
    const p = this.#ws(uri);
    if (p === null) throw FileSystemError.NoPermissions(`TMCode limits workspace.fs to the open folder (${uri.toString(true)})`);
    try {
      return await this.host.rpc.request<T>("$main.fs", [op, p, ...args]);
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      if (/not found|no such|enoent|does not exist/i.test(m)) throw FileSystemError.FileNotFound(uri);
      throw e;
    }
  }

  async stat(uri: Uri): Promise<FileStatDTO> {
    if (uri.scheme === "tmcode-storage") {
      const d = this.#mem.get(uri.path);
      if (!d) throw FileSystemError.FileNotFound(uri);
      return { type: FileType.File, ctime: 0, mtime: 0, size: d.length };
    }
    return this.#call("stat", uri);
  }
  async readDirectory(uri: Uri): Promise<[string, number][]> {
    if (uri.scheme === "tmcode-storage") {
      const prefix = uri.path.replace(/\/?$/, "/");
      return [...this.#mem.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map((k) => [k.slice(prefix.length), FileType.File]);
    }
    return this.#call("readDirectory", uri);
  }
  async createDirectory(uri: Uri) {
    if (uri.scheme === "tmcode-storage") return;
    await this.#call("createDirectory", uri);
  }
  async readFile(uri: Uri): Promise<Uint8Array> {
    if (uri.scheme === "tmcode-storage") {
      const d = this.#mem.get(uri.path);
      if (!d) throw FileSystemError.FileNotFound(uri);
      return d;
    }
    return b64ToBytes(await this.#call<string>("readFile", uri));
  }
  async writeFile(uri: Uri, content: Uint8Array) {
    if (uri.scheme === "tmcode-storage") {
      this.#mem.set(uri.path, content);
      return;
    }
    await this.#call("writeFile", uri, bytesToB64(content));
  }
  async delete(uri: Uri, options?: { recursive?: boolean }) {
    if (uri.scheme === "tmcode-storage") {
      this.#mem.delete(uri.path);
      return;
    }
    await this.#call("delete", uri, !!options?.recursive);
  }
  async rename(source: Uri, target: Uri, options?: { overwrite?: boolean }) {
    const to = this.#ws(target);
    if (to === null) throw FileSystemError.NoPermissions(target);
    await this.#call("rename", source, to, !!options?.overwrite);
  }
  async copy(source: Uri, target: Uri, options?: { overwrite?: boolean }) {
    const data = await this.readFile(source);
    if (!options?.overwrite && (await this.stat(target).then(() => true, () => false))) throw FileSystemError.FileExists(target);
    await this.writeFile(target, data);
  }
}

const NODE_BUILTINS = new Set(["fs", "path", "os", "child_process", "net", "http", "https", "crypto", "util", "events", "stream", "url", "zlib", "assert", "buffer", "worker_threads", "readline", "tty", "module", "process"]);

function dirname(p: string) {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

/** A small CommonJS loader over the workbench's extension file reader. */
function createWorkerLoader(host: ExtHost, apiFor: (id: string) => unknown): ModuleLoader {
  return {
    async load(_location, entry, extensionId) {
      const cache = new Map<string, { exports: unknown }>();
      const sources = new Map<string, string | null>();
      const read = async (p: string) => {
        if (!sources.has(p)) sources.set(p, await host.rpc.request<string>("$main.readExtensionFile", [extensionId, p]).catch(() => null));
        return sources.get(p) ?? null;
      };
      // Browser bundles are usually one file; preload what a static scan of require() calls finds.
      const resolveFile = async (p: string): Promise<string | null> => {
        for (const cand of [p, `${p}.js`, `${p}.cjs`, `${p}/index.js`, `${p}.json`]) if ((await read(cand)) !== null) return cand;
        return null;
      };
      const preload = async (file: string, seen = new Set<string>()) => {
        if (seen.has(file)) return;
        seen.add(file);
        const src = await read(file);
        if (src === null || file.endsWith(".json")) return;
        const re = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
        let m: RegExpExecArray | null;
        const deps: string[] = [];
        while ((m = re.exec(src))) deps.push(m[1]);
        for (const d of deps) {
          const target = await resolveFile(normalize(`${dirname(file)}/${d}`));
          if (target) await preload(target, seen);
        }
      };
      const entryFile = await resolveFile(normalize(entry));
      if (!entryFile) throw new Error(`Cannot find the extension's browser entry '${entry}'`);
      await preload(entryFile);

      const requireFrom = (from: string) => (request: string): unknown => {
        if (request === "vscode") return apiFor(extensionId);
        if (request.startsWith("node:") || NODE_BUILTINS.has(request)) throw new Error(`The Node.js module '${request}' is not available to browser extensions.`);
        if (!request.startsWith(".") && !request.startsWith("/")) throw new Error(`Cannot find module '${request}' (browser extensions must bundle their dependencies).`);
        const base = normalize(`${dirname(from)}/${request}`);
        const file = [base, `${base}.js`, `${base}.cjs`, `${base}/index.js`, `${base}.json`].find((c) => typeof sources.get(c) === "string");
        if (!file) throw new Error(`Cannot find module '${request}' from '${from}'`);
        return evaluate(file);
      };
      const evaluate = (file: string): unknown => {
        const hit = cache.get(file);
        if (hit) return hit.exports;
        const src = sources.get(file)!;
        const module = { exports: {} as unknown };
        cache.set(file, module);
        if (file.endsWith(".json")) {
          module.exports = JSON.parse(src);
          return module.exports;
        }
        const fn = new Function("exports", "require", "module", "__filename", "__dirname", "globalThis", `${src}\n//# sourceURL=tmcode-extension://${extensionId}/${file}`);
        fn.call(module.exports, module.exports, requireFrom(file), module, `/${file}`, `/${dirname(file)}`, globalThis);
        return module.exports;
      };
      return evaluate(entryFile) as never;
    },
  };
}

let host: ExtHost;
const env: HostEnvironment = {
  kind: "worker",
  isWindows: false,
  createFs: (h) => new WorkerFs(h),
  createLoader: (apiFor) => createWorkerLoader(host, apiFor),
};

host = new ExtHost((m) => scope.postMessage(m), env);
// console in the worker → the Extension Host channel too.
const fmt = (a: unknown[]) => a.map((x) => (typeof x === "string" ? x : x instanceof Error ? (x.stack ?? x.message) : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(" ");
console.log = (...a: unknown[]) => host.log("info", fmt(a));
console.info = console.log;
console.warn = (...a: unknown[]) => host.log("warn", fmt(a));
console.error = (...a: unknown[]) => host.log("error", fmt(a));
scope.addEventListener("unhandledrejection", (e) => host.log("error", `Unhandled promise rejection in an extension: ${String((e.reason as Error)?.stack ?? e.reason)}`));
scope.addEventListener("error", (e) => host.log("error", `Uncaught error in an extension: ${String(e.message ?? e.error)}`));
scope.onmessage = (e) => host.rpc.handleMessage(e.data);
host.rpc.notify("$main.ready", [{ worker: true }]);

