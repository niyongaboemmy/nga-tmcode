/**
 * The Node.js extension host (desktop). TMCode's Rust side starts it with the
 * system `node`, relays its stdio to the workbench, and restarts it if it
 * crashes. stdout carries only Content-Length-framed RPC messages: console
 * output and direct stdout writes of extensions are redirected to the
 * "Extension Host" Output channel, so they can never corrupt the stream.
 */

import * as path from "node:path";
import Module from "node:module";
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

/** `require('vscode')` from a module inside an extension's folder returns that extension's API. */
function createNodeLoader(apiFor: (id: string) => unknown, locations: () => { id: string; location: string }[]): ModuleLoader {
  type Loader = (request: string, parent: { filename?: string } | null, isMain: boolean) => unknown;
  const M = Module as unknown as { _load: Loader };
  const original = M._load;
  const sep = path.sep;
  M._load = function (request, parent, isMain) {
    if (request === "vscode") {
      const file = parent?.filename ?? "";
      const owner = locations()
        .sort((a, b) => b.location.length - a.location.length)
        .find((l) => file === l.location || file.startsWith(l.location.endsWith(sep) ? l.location : l.location + sep));
      const first = locations()[0];
      if (!owner && !first) throw new Error("Cannot find module 'vscode'");
      return apiFor((owner ?? first).id);
    }
    return original.call(this, request, parent, isMain);
  };
  return {
    async load(location, entry) {
      const file = path.resolve(location, entry);
      const require = Module.createRequire(path.join(location, "package.json"));
      return require(file) as never;
    },
  };
}

const env: HostEnvironment = {
  kind: "node",
  isWindows: process.platform === "win32",
  createFs: (host) => new NodeFs(host),
  createLoader: (apiFor) => createNodeLoader(apiFor, () => [...host.exts.values()].map((e) => ({ id: e.desc.id, location: path.resolve(e.desc.location) }))),
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
