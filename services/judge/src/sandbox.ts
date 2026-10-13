import { spawn, type ChildProcess } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

/**
 * Where submissions run.
 * - IsolateSandbox: ioi/isolate boxes (cgroup v2): own PID/net/mount
 *   namespaces, memory/process/time/file-size limits, no network. Production.
 * - LocalSandbox: a temp folder and a timeout, **no isolation**. Only for
 *   development on machines without isolate (refuses to start in production).
 */

export interface Limits {
  cpuS: number;
  wallS: number;
  memoryMb: number;
  processes: number;
  outputKb: number;
  /** Largest file a program may write (isolate --fsize); default max(2 × outputKb, 1 MB). Builds need more. */
  fileKb?: number;
}

export interface ExecOptions {
  stdin: string;
  limits: Limits;
  env?: Record<string, string>;
  /** Working folder relative to the box root (default: the root, /box). */
  cwd?: string;
}

export interface SpawnOptions {
  limits: Limits;
  env?: Record<string, string>;
  cwd?: string;
  /** Containers only: a real terminal (Tty), raw bytes on stdout; size defaults to 120×30. */
  tty?: { cols: number; rows: number };
}

export type SessionSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

/** A running interactive program. `done` resolves with stdout/stderr empty (they were streamed). */
export interface Proc {
  write(data: string | Buffer): void;
  end(): void;
  kill(signal: SessionSignal): void;
  onStdout(cb: (chunk: Buffer) => void): void;
  onStderr(cb: (chunk: Buffer) => void): void;
  done: Promise<ExecResult>;
  /** PTY only: the terminal's size. */
  resize?(cols: number, rows: number): void;
  /** Containers only: the container's id and its address on the box's network (previews). */
  container?: Promise<{ id: string; ip: string | null }>;
}

/** Wires a child process's pipes into a Proc. */
function procOf(child: ChildProcess, kill: (signal: SessionSignal) => void, finish: (code: number | null, signal: NodeJS.Signals | null) => Promise<ExecResult>): Proc {
  child.stdin?.on("error", () => {});
  const done = new Promise<ExecResult>((resolve) => {
    let settled = false;
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      finish(code, signal).then(resolve);
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      resolve({ status: "internal", exitCode: null, stdout: "", stderr: String(e), timeMs: 0, memoryKb: null, message: String(e) });
    });
  });
  return {
    write: (d) => {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(d);
    },
    end: () => child.stdin?.end(),
    kill,
    onStdout: (cb) => child.stdout?.on("data", cb),
    onStderr: (cb) => child.stderr?.on("data", cb),
    done,
  };
}

/** A host folder visible read-only inside the box at `inside` (cache layers: /caches/<id>). */
export interface Mount {
  inside: string;
  host: string;
}

export interface AcquireOptions {
  /** Read-only mounts at another path (cache layers). */
  mounts?: Mount[];
  /** Host folders bound read-only at the same path (toolchains outside /usr, e.g. /opt/maven). */
  dirs?: string[];
  /** Containers only: the image the box's programs run in (tier 3). */
  image?: string;
  /** Containers only: a per-run internal Docker network (databases, previews); default: no network. */
  network?: string;
}

export interface ExecResult {
  status: "ok" | "runtime-error" | "signal" | "timeout" | "memory" | "output-limit" | "internal";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timeMs: number;
  memoryKb: number | null;
  message?: string;
  /** stderr was cut at the sandbox's 64 KB cap (stdout cut = "output-limit"). */
  stderrTruncated?: boolean;
}

/** A regular file in a box, for snapshots (build outputs keep their mode, e.g. ./main). */
export interface BoxFile {
  path: string;
  data: Buffer;
  mode: number;
  /** Kept so build tools that compare timestamps (make, cargo) see the build as up to date. */
  mtimeMs?: number;
  /** A relative symlink inside the box (node_modules/.bin/*); `data` is empty. */
  link?: string;
}

export interface Box {
  write(path: string, content: string | Buffer, mode?: number, mtimeMs?: number): Promise<void>;
  /** A relative symlink inside the box. */
  link(path: string, target: string): Promise<void>;
  /** Starts a program with live pipes (interactive sessions); no PTY. */
  spawn(argv: string[], opts: SpawnOptions): Proc;
  exec(argv: string[], opts: ExecOptions): Promise<ExecResult>;
  /** A box file's bytes, or null when it doesn't exist (reports). */
  read(path: string): Promise<Buffer | null>;
  /** Regular files directly in a box folder (names), [] when it doesn't exist. */
  list(dir: string): Promise<string[]>;
  /** The path a program in this box sees for a sandbox path ("/caches/m2-school" → itself under isolate, the host folder locally). */
  visible(path: string): string;
  /** Every regular file in the box (sources and build outputs), minus the judge's own stdio files. */
  snapshot(): Promise<BoxFile[]>;
  /** Empties the box, keeping the same box (no new acquire): the next test starts clean. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

/** The judge's redirect files, never part of a snapshot. */
const STDIO_FILES = new Set([".stdin", ".stdout", ".stderr"]);
const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

export async function listFiles(root: string): Promise<BoxFile[]> {
  const out: BoxFile[] = [];
  let total = 0;
  const walk = async (rel: string) => {
    const entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && STDIO_FILES.has(e.name)) continue;
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const full = join(root, path);
        const [data, st] = await Promise.all([readFile(full), lstat(full)]);
        total += data.length;
        if (total > SNAPSHOT_MAX_BYTES) throw new Error("Build output is larger than 64 MB.");
        out.push({ path, data, mode: st.mode & 0o777, mtimeMs: st.mtimeMs });
      } else if (e.isSymbolicLink()) {
        // Relative links that stay inside the box (npm's node_modules/.bin) are carried over; others are not.
        const target = await readlink(join(root, path));
        const resolved = normalize(join(dirname(path), target));
        if (!target.startsWith("/") && resolved !== ".." && !resolved.startsWith("../")) out.push({ path, data: Buffer.alloc(0), mode: 0o777, link: target });
      }
      // Special files are not carried over.
    }
  };
  await walk("");
  return out;
}

export async function writeInto(root: string, path: string, content: string | Buffer, mode?: number, mtimeMs?: number) {
  const full = safeJoin(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  if (mode !== undefined) await chmod(full, mode);
  if (mtimeMs !== undefined) await utimes(full, mtimeMs / 1000, mtimeMs / 1000);
}

export async function linkInto(root: string, path: string, target: string) {
  const full = safeJoin(root, path);
  const resolved = normalize(join(dirname(path), target));
  if (target.startsWith("/") || resolved === ".." || resolved.startsWith("../")) throw new Error(`Link '${path}' points outside the box.`);
  await mkdir(dirname(full), { recursive: true });
  await rm(full, { force: true });
  await symlink(target, full);
}

/** Refills a (reset) box from a snapshot. */
export async function restoreSnapshot(box: Box, files: BoxFile[]) {
  for (const f of files) {
    if (f.link !== undefined) await box.link(f.path, f.link);
    else await box.write(f.path, f.data, f.mode, f.mtimeMs);
  }
}

export async function readFrom(root: string, path: string): Promise<Buffer | null> {
  try {
    return await readFile(safeJoin(root, path));
  } catch {
    return null;
  }
}

export async function listIn(root: string, dir: string): Promise<string[]> {
  try {
    const full = dir && dir !== "." ? safeJoin(root, dir.replace(/\/+$/, "")) : root;
    if (!(await stat(full)).isDirectory()) return [];
    return (await readdir(full, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/** Folders to bind: drops duplicates and folders inside another one in the list. */
export function topDirs(dirs: string[]): string[] {
  const sorted = [...new Set(dirs.map((d) => d.replace(/\/+$/, "")).filter(Boolean))].sort();
  return sorted.filter((d) => !sorted.some((o) => o !== d && d.startsWith(`${o}/`)));
}

export interface Sandbox {
  kind: "isolate" | "none" | "container";
  acquire(opts?: AcquireOptions): Promise<Box>;
}

async function readCapped(path: string, limitBytes: number) {
  try {
    const buf = await readFile(path);
    return { text: buf.subarray(0, Math.min(buf.length, limitBytes)).toString("utf8"), over: buf.length >= limitBytes };
  } catch {
    return { text: "", over: false };
  }
}

function run(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (e) => resolve({ code: null, stdout, stderr: String(e) }));
    child.stdin.on("error", () => {}); // the child may exit before reading its input (EPIPE)
    child.stdin.end(opts.input ?? "");
  });
}

export function safeJoin(root: string, rel: string) {
  if (!rel || rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "")) throw new Error(`Invalid file path '${rel}'`);
  return join(root, rel);
}

// ───────────────────────── isolate ─────────────────────────

const DEFAULT_MOUNTS = ["/usr/", "/bin/", "/lib/", "/lib64/", "/box/"];

/**
 * Programs installed outside the standard system folders (nvm, /opt, tool
 * caches) need their install directory mounted read-only inside the box:
 * the folder above their bin/ (or their own folder).
 */
export function extraMounts(program: string): string[] {
  if (!program.startsWith("/") || DEFAULT_MOUNTS.some((m) => program.startsWith(m))) return [];
  const parts = program.split("/");
  const bin = parts.lastIndexOf("bin");
  const root = bin > 1 ? parts.slice(0, bin).join("/") : parts.slice(0, -1).join("/");
  return root && root !== "/" ? [root] : [];
}

export function parseMeta(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i)] = line.slice(i + 1);
  }
  return meta;
}

/** Maps isolate's meta file (and output size) to a result status. */
export function statusFromMeta(meta: Record<string, string>, outputOver: boolean, limits: Limits): ExecResult["status"] {
  if (meta["cg-oom-killed"] === "1") return "memory";
  if (outputOver || meta.exitsig === "25") return "output-limit"; // SIGXFSZ
  switch (meta.status) {
    case "TO":
      return "timeout";
    case "SG":
      return meta.exitsig === "9" && Number(meta["cg-mem"] ?? 0) >= limits.memoryMb * 1024 * 0.95 ? "memory" : "signal";
    case "RE":
      return "runtime-error";
    case "XX":
      return "internal";
    default:
      return "ok";
  }
}

export class IsolateSandbox implements Sandbox {
  kind = "isolate" as const;
  private free: number[];
  private waiters: ((id: number) => void)[] = [];
  private isolate: string;

  // No parameter properties: production runs this file with Node's type stripping.
  constructor(isolate: string, boxes: number, firstBox = 0) {
    this.isolate = isolate;
    this.free = Array.from({ length: boxes }, (_, i) => firstBox + i);
  }

  private take(): Promise<number> {
    const id = this.free.shift();
    if (id !== undefined) return Promise.resolve(id);
    return new Promise((r) => this.waiters.push(r));
  }

  private give(id: number) {
    const w = this.waiters.shift();
    if (w) w(id);
    else this.free.push(id);
  }

  async acquire(opts: AcquireOptions = {}): Promise<Box> {
    const id = await this.take();
    const mounts = opts.mounts ?? [];
    const dirs = topDirs((opts.dirs ?? []).filter((d) => !DEFAULT_MOUNTS.some((m) => `${d}/`.startsWith(m))));
    const iso = this.isolate;
    await run(iso, ["--cg", `--box-id=${id}`, "--cleanup"]);
    const init = await run(iso, ["--cg", `--box-id=${id}`, "--init"]);
    if (init.code !== 0) {
      this.give(id);
      throw new Error(`isolate --init failed: ${init.stderr.trim()}`);
    }
    let boxDir = join(init.stdout.trim(), "box");
    const metaFile = join(tmpdir(), `tm-judge-meta-${id}.txt`);
    const give = () => this.give(id);
    let disposed = false;

    const isolateArgs = (argv: string[], limits: Limits, env: Record<string, string>, cwd: string | undefined, redirect: boolean, meta: string) => {
      // One value per variable (PATH may be the step's own).
      const vars = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/box", LANG: "C.UTF-8", ...env };
      return [
          "--cg",
          `--box-id=${id}`,
          `--meta=${meta}`,
          `--time=${limits.cpuS}`,
          `--wall-time=${limits.wallS}`,
          "--extra-time=0.5",
          `--cg-mem=${limits.memoryMb * 1024}`,
          `--processes=${limits.processes}`,
          `--fsize=${limits.fileKb ?? Math.max(limits.outputKb * 2, 1024)}`,
          ...(redirect ? ["--stdin=.stdin", "--stdout=.stdout", "--stderr=.stderr"] : []),
          ...Object.entries(vars).map(([k, v]) => `--env=${k}=${v}`),
          // Read-only system config (the JVM reads /etc/java-*); the sandbox user can't read root-only files.
          "--dir=/etc:noexec",
          // Toolchains and cache layers: read-only (isolate's default for --dir).
          ...topDirs([...dirs, ...extraMounts(argv[0])]).map((d) => `--dir=${d}`),
          ...mounts.map((m) => `--dir=${m.inside}=${m.host}`),
          ...(cwd && cwd !== "." ? [`--chdir=/box/${cwd}`] : []),
          "--run",
          "--",
          ...argv,
      ];
    };

    return {
      write: (path, content, mode, mtimeMs) => writeInto(boxDir, path, content, mode, mtimeMs),
      link: (path, target) => linkInto(boxDir, path, target),
      read: (path) => readFrom(boxDir, path),
      list: (dir) => listIn(boxDir, dir),
      visible: (path) => path,
      snapshot: () => listFiles(boxDir),
      async reset() {
        // Same box id: cleanup kills anything left running and wipes the folder.
        await run(iso, ["--cg", `--box-id=${id}`, "--cleanup"]);
        const again = await run(iso, ["--cg", `--box-id=${id}`, "--init"]);
        if (again.code !== 0) throw new Error(`isolate --init failed: ${again.stderr.trim()}`);
        boxDir = join(again.stdout.trim(), "box");
      },
      spawn(argv, { limits, env = {}, cwd }) {
        const started = Date.now();
        const meta = `${metaFile}.session`;
        const child = spawn(iso, isolateArgs(argv, limits, env, cwd, false, meta), { stdio: ["pipe", "pipe", "pipe"] });
        // isolate ends the box on SIGINT/SIGTERM (it doesn't forward signals to the program).
        const kill = (sig: SessionSignal) => {
          try {
            child.kill(sig === "SIGKILL" ? "SIGTERM" : sig);
          } catch {
            /* gone */
          }
        };
        return procOf(child, kill, async (code) => {
          const m = parseMeta(await readFile(meta, "utf8").catch(() => ""));
          await rm(meta, { force: true });
          const status = code === null && !m.status ? "internal" : statusFromMeta(m, false, limits);
          return {
            status,
            exitCode: m.exitcode !== undefined ? Number(m.exitcode) : status === "ok" ? 0 : null,
            stdout: "",
            stderr: "",
            timeMs: m.time ? Math.round(Number(m.time) * 1000) : Date.now() - started,
            memoryKb: m["cg-mem"] ? Number(m["cg-mem"]) : m["max-rss"] ? Number(m["max-rss"]) : null,
            message: m.message || undefined,
          };
        });
      },
      async exec(argv, { stdin, limits, env = {}, cwd }) {
        await writeFile(join(boxDir, ".stdin"), stdin);
        await rm(metaFile, { force: true });
        const args = isolateArgs(argv, limits, env, cwd, true, metaFile);
        const started = Date.now();
        const r = await run(iso, args, { timeoutMs: (limits.wallS + 10) * 1000 });
        const meta = parseMeta(await readFile(metaFile, "utf8").catch(() => ""));
        const out = await readCapped(join(boxDir, ".stdout"), limits.outputKb * 1024);
        const err = await readCapped(join(boxDir, ".stderr"), 64 * 1024);
        const status = r.code === null && !meta.status ? "internal" : statusFromMeta(meta, out.over, limits);
        return {
          status,
          exitCode: meta.exitcode !== undefined ? Number(meta.exitcode) : status === "ok" ? 0 : null,
          stdout: out.text,
          stderr: err.text,
          timeMs: meta.time ? Math.round(Number(meta.time) * 1000) : Date.now() - started,
          memoryKb: meta["cg-mem"] ? Number(meta["cg-mem"]) : meta["max-rss"] ? Number(meta["max-rss"]) : null,
          message: meta.message || (status === "internal" ? r.stderr.trim() : undefined),
          stderrTruncated: err.over,
        };
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        await run(iso, ["--cg", `--box-id=${id}`, "--cleanup"]);
        give();
      },
    };
  }
}

// ───────────────────────── local (development only) ─────────────────────────

/** rm -rf that also removes read-only trees (a Go module cache, chmod'ed npm files). */
export async function removeTree(path: string) {
  try {
    await rm(path, { recursive: true, force: true });
  } catch {
    await run("chmod", ["-R", "u+w", path]);
    await rm(path, { recursive: true, force: true });
  }
}

export class LocalSandbox implements Sandbox {
  kind = "none" as const;

  async acquire(opts: AcquireOptions = {}): Promise<Box> {
    const dir = await mkdtemp(join(tmpdir(), "tm-judge-"));
    // The box's /tmp lives next to the box (not in it: it is never part of a snapshot).
    const tmp = `${dir}-tmp`;
    await mkdir(tmp, { recursive: true });
    const mounts = opts.mounts ?? [];
    const visible = (s: string) => localPath(s, dir, tmp, mounts);
    return {
      write: (path, content, mode, mtimeMs) => writeInto(dir, path, content, mode, mtimeMs),
      link: (path, target) => linkInto(dir, path, target),
      read: (path) => readFrom(dir, path),
      list: (d) => listIn(dir, d),
      visible,
      snapshot: () => listFiles(dir),
      async reset() {
        await removeTree(dir);
        await removeTree(tmp);
        await mkdir(dir, { recursive: true });
        await mkdir(tmp, { recursive: true });
      },
      spawn(argv, { limits, env = {}, cwd }) {
        const started = Date.now();
        const clean = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", NO_COLOR: "1" };
        const vars: Record<string, string> = { ...clean };
        for (const [k, v] of Object.entries(env)) vars[k] = k === "PATH" ? v : visible(v);
        const child = spawn(argv[0], argv.slice(1).map(visible), { cwd: cwd && cwd !== "." ? safeJoin(dir, cwd) : dir, env: vars, detached: true, stdio: ["pipe", "pipe", "pipe"] });
        let timedOut = false;
        const kill = (sig: SessionSignal) => {
          try {
            process.kill(-child.pid!, sig);
          } catch {
            child.kill(sig);
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          kill("SIGKILL");
        }, limits.wallS * 1000);
        return procOf(child, kill, async (code, signal) => {
          clearTimeout(timer);
          return {
            status: timedOut ? "timeout" : signal ? "signal" : code === 0 ? "ok" : "runtime-error",
            exitCode: code,
            stdout: "",
            stderr: "",
            timeMs: Date.now() - started,
            memoryKb: null,
            message: signal ? `Killed by ${signal}` : undefined,
          };
        });
      },
      exec(argv, { stdin, limits, env = {}, cwd }) {
        return new Promise((resolve) => {
          const started = Date.now();
          // A minimal environment, like isolate's: nothing inherited may change a program's output.
          const clean = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C.UTF-8", NO_COLOR: "1" };
          // Sandbox paths (/box, /tmp, /caches/<id>) in arguments and variables point at this box's folders.
          const vars: Record<string, string> = { ...clean };
          for (const [k, v] of Object.entries(env)) vars[k] = k === "PATH" ? v : visible(v);
          const args = argv.slice(1).map(visible);
          const child = spawn(argv[0], args, { cwd: cwd && cwd !== "." ? safeJoin(dir, cwd) : dir, env: vars, detached: true, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          let over = false;
          let stderrCut = false;
          let timedOut = false;
          const killTree = () => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          };
          child.stdout.on("data", (d: Buffer) => {
            if (stdout.length + d.length > limits.outputKb * 1024) {
              over = true;
              killTree();
            } else stdout += d.toString("utf8");
          });
          child.stderr.on("data", (d: Buffer) => {
            if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
            else stderrCut = true;
          });
          const timer = setTimeout(() => {
            timedOut = true;
            killTree();
          }, limits.wallS * 1000);
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({
              status: over ? "output-limit" : timedOut ? "timeout" : signal ? "signal" : code === 0 ? "ok" : "runtime-error",
              exitCode: code,
              stdout,
              stderr,
              timeMs: Date.now() - started,
              memoryKb: null,
              stderrTruncated: stderrCut,
            });
          });
          child.on("error", (e) => {
            clearTimeout(timer);
            resolve({ status: "internal", exitCode: null, stdout, stderr: String(e), timeMs: 0, memoryKb: null, message: String(e) });
          });
          child.stdin.on("error", () => {});
          child.stdin.end(stdin);
        });
      },
      async dispose() {
        await removeTree(dir);
        await removeTree(tmp);
      },
    };
  }
}

/**
 * LocalSandbox only: maps the paths a program would see inside an isolate box
 * to this box's folders. `/box` and `/tmp` match at the start of a value or
 * after `=`, `:` or `,` (so `-Dx=/tmp/m2` and `a:/box/b` work); cache mounts
 * match anywhere (`file:///caches/go-mod-school/...`). An unmounted cache path
 * stays as it is (and doesn't exist), like a missing layer under isolate.
 */
export function localPath(s: string, box: string, tmp: string, mounts: Mount[]): string {
  let out = s;
  for (const m of mounts) out = out.split(m.inside).join(m.host);
  return out.replace(/(^|[=:,])\/(box|tmp)(?=\/|$|[:,])/g, (_, pre: string, which: string) => `${pre}${which === "box" ? box : tmp}`);
}

export async function isolateAvailable(bin: string) {
  const r = await run(bin, ["--version"]).catch(() => null);
  return !!r && r.code === 0;
}

