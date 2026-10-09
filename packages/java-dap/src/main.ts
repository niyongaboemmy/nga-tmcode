// Entry point: a Java debug adapter speaking DAP over stdio and JDWP to the JVM.
//   node java-dap.cjs
import { format } from "node:util";
import { DapReader, encodeMessage } from "./dap";
import { JavaDebugSession } from "./session";

// stdout carries the protocol: route stray logging to stderr.
const toStderr = (...args: unknown[]) => void process.stderr.write(format(...args) + "\n");
console.log = toStderr;
console.info = toStderr;
console.warn = toStderr;
console.debug = toStderr;

let exiting = false;
const session = new JavaDebugSession(
  (m) => process.stdout.write(encodeMessage(m)),
  () => {
    if (exiting) return;
    exiting = true;
    // Let the last messages flush before leaving.
    setTimeout(() => process.exit(0), 50);
  },
);
const reader = new DapReader((m) => session.handleMessage(m));
process.stdin.on("data", (d: Buffer) => reader.feed(d));
process.stdin.on("end", () => session.shutdown());
process.on("uncaughtException", (e) => process.stderr.write(`[java-dap] ${e.stack ?? e}\n`));
process.on("unhandledRejection", (e) => process.stderr.write(`[java-dap] ${(e as Error)?.stack ?? e}\n`));
