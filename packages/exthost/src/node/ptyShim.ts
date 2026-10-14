/**
 * A `node-pty` stand-in for extensions that `require` VS Code's bundled copy
 * from `vscode.env.appRoot/node_modules/node-pty` (Gemini Code Assist does so
 * while activating). VS Code ships a native addon built for its Electron;
 * TMCode's host runs the system Node.js, so a prebuilt addon would rarely
 * match. This module needs no addon:
 *
 * - macOS and Linux: the program runs under `script`, which gives it a real
 *   terminal (colours, prompts, line editing), as node-pty does.
 * - Windows: plain pipes (no ConPTY without an addon); output still streams.
 *
 * `pid` is the real process id, so extensions that kill the tree by pid work.
 * The API is node-pty's: spawn() → IPty { pid, cols, rows, process, onData,
 * onExit, write, resize, kill, pause, resume, clear }.
 */

export const PTY_SHIM_SOURCE = String.raw`"use strict";
const { spawn: cp } = require("child_process");
const { EventEmitter } = require("events");

function quote(a) {
  return /^[A-Za-z0-9_\/.,:=@%+-]+$/.test(a) ? a : "'" + String(a).replace(/'/g, "'\\''") + "'";
}

class Pty {
  constructor(file, args, opt) {
    opt = opt || {};
    args = Array.isArray(args) ? args : typeof args === "string" ? [args] : [];
    this.cols = opt.cols || 80;
    this.rows = opt.rows || 24;
    this.process = file;
    this.handleFlowControl = false;
    this._events = new EventEmitter();
    const env = Object.assign({}, opt.env || process.env, { TERM: (opt.env && opt.env.TERM) || "xterm-256color", COLUMNS: String(this.cols), LINES: String(this.rows) });
    let cmd = file, argv = args;
    if (process.platform === "darwin") {
      argv = ["-q", "/dev/null", file].concat(args);
      cmd = "/usr/bin/script";
    } else if (process.platform !== "win32") {
      argv = ["-qfec", [file].concat(args).map(quote).join(" "), "/dev/null"];
      cmd = "script";
    }
    const child = cp(cmd, argv, { cwd: opt.cwd || process.cwd(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this._child = child;
    this.pid = child.pid;
    const out = (d) => this._events.emit("data", typeof d === "string" ? d : d.toString(opt.encoding === null ? undefined : "utf8"));
    child.stdout.on("data", out);
    child.stderr.on("data", out);
    child.on("error", (e) => { out("\r\n" + (e && e.message ? e.message : String(e)) + "\r\n"); this._events.emit("exit", { exitCode: 1, signal: undefined }); });
    child.on("exit", (code, signal) => this._events.emit("exit", { exitCode: code == null ? 1 : code, signal: signal ? require("os").constants.signals[signal] : undefined }));
    this.onData = (cb) => { this._events.on("data", cb); return { dispose: () => this._events.off("data", cb) }; };
    this.onExit = (cb) => { this._events.on("exit", cb); return { dispose: () => this._events.off("exit", cb) }; };
  }
  // node-pty's old event API.
  on(event, cb) { this._events.on(event, event === "exit" ? (e) => cb(e.exitCode, e.signal) : cb); }
  write(data) { try { this._child.stdin.write(data); } catch (e) { /* closed */ } }
  resize(cols, rows) { this.cols = cols; this.rows = rows; }
  clear() {}
  kill(signal) { try { this._child.kill(signal || "SIGHUP"); } catch (e) { /* gone */ } }
  pause() { this._child.stdout.pause(); }
  resume() { this._child.stdout.resume(); }
}

exports.spawn = (file, args, opt) => new Pty(file, args, opt);
exports.fork = exports.spawn;
exports.createTerminal = exports.spawn;
exports.open = () => { throw new Error("node-pty open() is not available in TMCode"); };
exports.native = undefined;
`;

export const PTY_SHIM_PACKAGE = JSON.stringify({ name: "node-pty", version: "1.0.0-tmcode", main: "lib/index.js", description: "TMCode's node-pty stand-in (no native addon)" }, null, 2);
