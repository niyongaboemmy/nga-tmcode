import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
}

export interface ExecResult {
  status: "ok" | "runtime-error" | "signal" | "timeout" | "memory" | "output-limit" | "internal";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timeMs: number;
  memoryKb: number | null;
  message?: string;
}

export interface Box {
  write(path: string, content: string): Promise<void>;
  exec(argv: string[], opts: { stdin: string; limits: Limits; env?: Record<string, string> }): Promise<ExecResult>;
  dispose(): Promise<void>;
}

export interface Sandbox {
  kind: "isolate" | "none";
  acquire(): Promise<Box>;
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
    child.stdin.end(opts.input ?? "");
  });
}

function safeJoin(root: string, rel: string) {
  if (!rel || rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "")) throw new Error(`Invalid file path '${rel}'`);
  return join(root, rel);
}

// ───────────────────────── isolate ─────────────────────────

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

  constructor(
    private isolate: string,
    boxes: number,
    private firstBox = 0,
  ) {
    this.free = Array.from({ length: boxes }, (_, i) => this.firstBox + i);
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

  async acquire(): Promise<Box> {
    const id = await this.take();
    const iso = this.isolate;
    await run(iso, ["--cg", `--box-id=${id}`, "--cleanup"]);
    const init = await run(iso, ["--cg", `--box-id=${id}`, "--init"]);
    if (init.code !== 0) {
      this.give(id);
      throw new Error(`isolate --init failed: ${init.stderr.trim()}`);
    }
    const boxDir = join(init.stdout.trim(), "box");
    const metaFile = join(tmpdir(), `tm-judge-meta-${id}.txt`);
    const give = () => this.give(id);
    let disposed = false;

    return {
      async write(path, content) {
        const full = safeJoin(boxDir, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      },
      async exec(argv, { stdin, limits, env = {} }) {
        await writeFile(join(boxDir, ".stdin"), stdin);
        await rm(metaFile, { force: true });
        const args = [
          "--cg",
          `--box-id=${id}`,
          `--meta=${metaFile}`,
          `--time=${limits.cpuS}`,
          `--wall-time=${limits.wallS}`,
          "--extra-time=0.5",
          `--cg-mem=${limits.memoryMb * 1024}`,
          `--processes=${limits.processes}`,
          `--fsize=${Math.max(limits.outputKb * 2, 1024)}`,
          "--stdin=.stdin",
          "--stdout=.stdout",
          "--stderr=.stderr",
          "--env=PATH=/usr/local/bin:/usr/bin:/bin",
          "--env=HOME=/box",
          "--env=LANG=C.UTF-8",
          ...Object.entries(env).map(([k, v]) => `--env=${k}=${v}`),
          // Read-only system config (the JVM reads /etc/java-*); the sandbox user can't read root-only files.
          "--dir=/etc:noexec",
          "--run",
          "--",
          ...argv,
        ];
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

export class LocalSandbox implements Sandbox {
  kind = "none" as const;

  async acquire(): Promise<Box> {
    const dir = await mkdtemp(join(tmpdir(), "tm-judge-"));
    return {
      async write(path, content) {
        const full = safeJoin(dir, path);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, content);
      },
      exec(argv, { stdin, limits, env = {} }) {
        return new Promise((resolve) => {
          const started = Date.now();
          const child = spawn(argv[0], argv.slice(1), { cwd: dir, env: { ...process.env, ...env }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
          let stdout = "";
          let stderr = "";
          let over = false;
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
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
}

export async function isolateAvailable(bin: string) {
  const r = await run(bin, ["--version"]).catch(() => null);
  return !!r && r.code === 0;
}

