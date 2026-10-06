/**
 * The Node.js extension host (desktop). TMCode's Rust side starts it with the
 * system `node`, relays its stdio to the workbench, and restarts it if it
 * crashes. stdout carries only Content-Length-framed RPC messages: console
 * output and direct stdout writes of extensions are redirected to the
 * "Extension Host" Output channel, so they can never corrupt the stream.
 */

import * as path from "node:path";
import { realpathSync } from "node:fs";
import Module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { encodeFrame, FrameDecoder, type RpcMessage } from "../rpc";
import { ExtHost, type HostEnvironment } from "../host/extHost";
import { NodeFs } from "./nodeFs";
import type { ModuleLoader } from "../host/fs";

const realWrite = process.stdout.write.bind(process.stdout);
const realExit = process.exit.bind(process);

function send(message: unknown) {
  realWrite(Buffer.from(encodeFrame(message as RpcMessage)));
}

let consoleSink: (level: "info" | "warn" | "error", text: string) => void = (_l, t) => process.stderr.write(t + "\n");

function format(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// Extensions' console output → the Extension Host channel (never stdout).
console.log = (...a: unknown[]) => consoleSink("info", format(a));
console.info = console.log;
console.debug = console.log;
console.trace = console.log;
console.warn = (...a: unknown[]) => consoleSink("warn", format(a));
console.error = (...a: unknown[]) => consoleSink("error", format(a));
process.stdout.write = ((chunk: unknown) => {
  consoleSink("info", String(chunk).replace(/\n$/, ""));
  return true;
}) as typeof process.stdout.write;
// VS Code refuses process.exit() from extensions; so does TMCode.
process.exit = ((code?: number) => {
  consoleSink("warn", `An extension called process.exit(${code ?? ""}); ignored.`);
}) as typeof process.exit;
process.on("uncaughtException", (e) => consoleSink("error", `Uncaught exception in an extension: ${e?.stack ?? e}`));
process.on("unhandledRejection", (e) => consoleSink("error", `Unhandled promise rejection in an extension: ${(e as Error)?.stack ?? e}`));

/** The extension that owns a module file (the longest matching folder). */
function ownerOf(file: string, locations: { id: string; location: string }[]): string | undefined {
  const sep = path.sep;
  return locations
    .sort((a, b) => b.location.length - a.location.length)
    .find((l) => file === l.location || file.startsWith(l.location.endsWith(sep) ? l.location : l.location + sep))?.id;
}

const realPaths = new Map<string, string>();
function realPath(p: string): string {
  let r = realPaths.get(p);
  if (r === undefined) {
    try {
      r = realpathSync(p);
    } catch {
      r = path.resolve(p);
    }
    realPaths.set(p, r);
  }
  return r;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * VS Code runs extensions on its bundled Node; TMCode uses the one installed.
 * Node 25 removed `buffer.SlowBuffer`, which popular extensions still bundle
 * (REST Client via buffer-equal-constant-time): put the old alias back.
 */
function restoreRemovedNodeApis() {
  const buffer = require("node:buffer") as { SlowBuffer?: unknown; Buffer: unknown };
  if (buffer.SlowBuffer === undefined) {
    try {
      Object.defineProperty(buffer, "SlowBuffer", { value: buffer.Buffer, configurable: true, writable: true });
    } catch {
      /* frozen module namespace: nothing to do */
    }
  }
}
restoreRemovedNodeApis();
// Web extension bundles (run here on the desktop) expect the worker global `self`.
if (typeof (globalThis as { self?: unknown }).self === "undefined") (globalThis as { self?: unknown }).self = globalThis;

/**
 * `require('vscode')` (CommonJS) and `import … from "vscode"` (ES modules,
 * through Node's synchronous module hooks where available) from a module
 * inside an extension's folder return that extension's API.
 */
function createNodeLoader(apiFor: (id: string) => unknown, locations: () => { id: string; location: string }[]): ModuleLoader {
  type Loader = (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown;
  const M = Module as unknown as { _load: Loader; registerHooks?: (hooks: unknown) => void };
  const original = M._load;
  const resolveId = (file: string) => ownerOf(file, locations()) ?? locations()[0]?.id;
  M._load = function (request, parent, isMain) {
    if (request === "vscode") {
      const id = resolveId(parent?.filename ?? "");
      if (!id) throw new Error("Cannot find module 'vscode'");
      return apiFor(id);
    }
    return original.call(this, request, parent, isMain);
  };
  (globalThis as Record<string, unknown>).__tmcodeVscodeApi = apiFor;
  M.registerHooks?.({
    resolve(specifier: string, context: { parentURL?: string }, next: (s: string, c: unknown) => unknown) {
      if (specifier !== "vscode") return next(specifier, context);
      let parent = "";
      try {
        parent = context.parentURL ? fileURLToPath(context.parentURL) : "";
      } catch {
        /* not a file URL */
      }
      return { url: `tmcode-vscode:${resolveId(parent) ?? ""}`, format: "module", shortCircuit: true };
    },
    load(url: string, context: unknown, next: (u: string, c: unknown) => unknown) {
      if (!url.startsWith("tmcode-vscode:")) return next(url, context);
      const id = url.slice("tmcode-vscode:".length);
      const names = Object.keys(apiFor(id) as object).filter((k) => IDENT.test(k) && k !== "default");
      const source = [`const api = globalThis.__tmcodeVscodeApi(${JSON.stringify(id)});`, "export default api;", ...names.map((n) => `export const ${n} = api.${n};`)].join("\n");
      return { format: "module", source, shortCircuit: true };
    },
  });
  return {
    async load(location, entry) {
      const file = path.resolve(location, entry);
      const require = Module.createRequire(path.resolve(location, "package.json"));
      try {
        return require(require.resolve(file)) as never;
      } catch (e) {
        // ES modules with top-level await cannot be required; import them.
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== "ERR_REQUIRE_ASYNC_MODULE" && code !== "ERR_REQUIRE_ESM") throw e;
        const mod = (await import(pathToFileURL(require.resolve(file)).href)) as { default?: unknown } & Record<string, unknown>;
        return (typeof mod.activate === "function" ? mod : (mod.default ?? mod)) as never;
      }
    },
  };
}

const env: HostEnvironment = {
  kind: "node",
  isWindows: process.platform === "win32",
  createFs: (host) => new NodeFs(host),
  realPath,
  // Module files have real paths: an extension folder reached through a symlink (/var → /private/var) is matched by both.
  createLoader: (apiFor) => createNodeLoader(apiFor, () => [...host.exts.values()].flatMap((e) => [{ id: e.desc.id, location: path.resolve(e.desc.location) }, { id: e.desc.id, location: realPath(e.desc.location) }])),
  onConsole(write) {
    consoleSink = write;
  },
};

const host = new ExtHost(send, env);
host.setHostLog((level, text) => process.stderr.write(`[${level}] ${text}\n`));

const decoder = new FrameDecoder();
process.stdin.on("data", (chunk: Buffer) => {
  for (const msg of decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) host.rpc.handleMessage(msg);
});
// The workbench went away: deactivate (briefly) and leave.
process.stdin.on("end", () => {
  void Promise.race([host.deactivateAll(), new Promise((r) => setTimeout(r, 2000))]).finally(() => realExit(0));
});
host.rpc.register("$exit", async () => {
  await Promise.race([host.deactivateAll(), new Promise((r) => setTimeout(r, 3000))]);
  setTimeout(() => realExit(0), 10);
});

host.rpc.notify("$main.ready", [{ pid: process.pid, node: process.version }]);
