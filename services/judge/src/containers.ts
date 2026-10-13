/**
 * Tier 3 (CODE_RUNNER_PLAN §12, docs/PROTOCOL.md §5.7): Docker + gVisor.
 *
 * A container box is a host folder (under JUDGE_CONTAINER_WORKDIR, a tmpfs on
 * the runner host) bound at /box. Every step, test or interactive program is a
 * fresh container from the runtime's image with:
 *   --runtime runsc, --network none (or a per-run internal network),
 *   --read-only rootfs, --tmpfs /tmp, --cap-drop ALL,
 *   --security-opt no-new-privileges, --pids-limit, --memory = --memory-swap,
 *   --cpus, --user <judge uid:gid> (never root), --init,
 *   cache layers bound read-only at /caches/<id>, wall-clock kill, output caps.
 * The box's files persist between steps (build → test), and project.ts resets
 * the folder to the build snapshot before every I/O test, exactly as with isolate.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { CATALOG, type KindDef } from "../../../packages/runtimes/src/index.ts";
import { Demuxer, Docker, unixTransport } from "./docker.ts";
import {
  linkInto,
  listFiles,
  listIn,
  readFrom,
  removeTree,
  writeInto,
  type AcquireOptions,
  type Box,
  type ExecResult,
  type Limits,
  type Mount,
  type Proc,
  type Sandbox,
  type SessionSignal,
} from "./sandbox.ts";
import type { RuntimeState, Toolchains } from "./toolchains.ts";

/** Bumped with services/judge/images/build-images.sh IMAGE_TAG. */
export const IMAGE_TAG = "2026.10.1";
export const LABEL = "rw.ac.nga.tm-judge";
export const DEFAULT_TTY = { cols: 120, rows: 30 };

/**
 * Runtime id → image folder under services/judge/images/. A runtime that
 * builds on another (typescript → node-22, kotlin-2 → jdk-21, dart-3 →
 * flutter-3) shares its image. Runtimes not listed have no container image.
 */
export const IMAGE_DIRS: Record<string, string> = {
  "dotnet-8": "dotnet-8",
  "jdk-21": "jdk-21",
  "kotlin-2": "jdk-21",
  "flutter-3": "flutter-3",
  "dart-3": "flutter-3",
  "node-22": "node-22",
  typescript: "node-22",
  "python-3.12": "python-3.12",
  "go-1.25": "go-1.25",
  "rust-stable": "rust-stable",
  "php-8.3": "php-8.3",
  "ruby-3.2": "ruby-3.2",
  "postgres-16": "postgres-16",
  "mysql-8.4": "mysql-8.4",
};

export interface ContainerConfig {
  /** JUDGE_CONTAINERS=1 turns tier 3 on (default off: the shared host has no Docker). */
  enabled: boolean;
  /** JUDGE_CONTAINER_RUNTIME (runsc). */
  runtime: string;
  /** JUDGE_DOCKER_SOCKET (/var/run/docker.sock). */
  socket: string;
  /** The judge's own uid:gid; containers never run as root. */
  uid: number;
  gid: number;
  /** JUDGE_CONTAINER_WORKDIR: host folder for box folders (a tmpfs on the runner host). */
  workdir: string;
  /** JUDGE_CONTAINER_CONCURRENCY (2): containers running batch steps at once. */
  concurrency: number;
  /** JUDGE_CONTAINER_CPUS (1.0) per container. */
  cpus: number;
  /** JUDGE_CONTAINER_MEMORY_MB (1536): no container gets more. */
  memoryCapMb: number;
  /** JUDGE_CONTAINER_TMP_MB (256): the /tmp tmpfs. */
  tmpMb: number;
  /** runtime id → image name (defaults + JUDGE_CONTAINER_IMAGES JSON). */
  images: Record<string, string>;
  /** JUDGE_CONTAINER_CGROUP_PARENT: a systemd slice capping all student containers together (e.g. tm-judge-containers.slice). */
  cgroupParent: string | null;
  /** Database sidecars. */
  postgresImage: string;
  mysqlImage: string;
}

export class ContainerConfigError extends Error {}

/** Reads the tier-3 settings. Throws when the settings are unsafe (runc without JUDGE_ALLOW_RUNC=1, root). */
export function containerConfig(env: Record<string, string | undefined> = process.env): ContainerConfig {
  const enabled = env.JUDGE_CONTAINERS === "1";
  const runtime = env.JUDGE_CONTAINER_RUNTIME || "runsc";
  const prefix = env.JUDGE_IMAGE_PREFIX || "nga-runner";
  const tag = env.JUDGE_IMAGE_TAG || IMAGE_TAG;
  const images: Record<string, string> = Object.fromEntries(Object.entries(IMAGE_DIRS).map(([rt, dir]) => [rt, `${prefix}/${dir}:${tag}`]));
  if (env.JUDGE_CONTAINER_IMAGES) {
    let extra: unknown;
    try {
      extra = JSON.parse(env.JUDGE_CONTAINER_IMAGES);
    } catch {
      throw new ContainerConfigError("JUDGE_CONTAINER_IMAGES must be a JSON object { \"<runtime id>\": \"<image>\" }.");
    }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) throw new ContainerConfigError("JUDGE_CONTAINER_IMAGES must be a JSON object.");
    for (const [k, v] of Object.entries(extra as Record<string, unknown>)) if (typeof v === "string" && v) images[k] = v;
  }
  const uid = env.JUDGE_CONTAINER_UID !== undefined ? Number(env.JUDGE_CONTAINER_UID) : (process.getuid?.() ?? 65534);
  const gid = env.JUDGE_CONTAINER_GID !== undefined ? Number(env.JUDGE_CONTAINER_GID) : (process.getgid?.() ?? 65534);
  const cfg: ContainerConfig = {
    enabled,
    runtime,
    socket: env.JUDGE_DOCKER_SOCKET || (env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice(7) : "/var/run/docker.sock"),
    uid,
    gid,
    workdir: env.JUDGE_CONTAINER_WORKDIR || join(tmpdir(), "tm-judge-boxes"),
    concurrency: Math.max(1, Number(env.JUDGE_CONTAINER_CONCURRENCY ?? 2)),
    cpus: Math.min(Math.max(Number(env.JUDGE_CONTAINER_CPUS ?? 1), 0.1), 8),
    memoryCapMb: Math.max(128, Number(env.JUDGE_CONTAINER_MEMORY_MB ?? 1536)),
    tmpMb: Math.max(16, Number(env.JUDGE_CONTAINER_TMP_MB ?? 256)),
    images,
    cgroupParent: env.JUDGE_CONTAINER_CGROUP_PARENT || null,
    postgresImage: env.JUDGE_POSTGRES_IMAGE || "postgres:16",
    mysqlImage: env.JUDGE_MYSQL_IMAGE || "mysql:8.4",
  };
  if (enabled) checkSafe(cfg, env);
  return cfg;
}

export function checkSafe(cfg: Pick<ContainerConfig, "runtime" | "uid" | "gid">, env: Record<string, string | undefined>) {
  if (cfg.runtime !== "runsc" && env.JUDGE_ALLOW_RUNC !== "1") {
    throw new ContainerConfigError(`JUDGE_CONTAINER_RUNTIME=${cfg.runtime} is refused: student containers run under gVisor (runsc). Set JUDGE_ALLOW_RUNC=1 only on a development machine.`);
  }
  if (!Number.isInteger(cfg.uid) || !Number.isInteger(cfg.gid) || cfg.uid <= 0 || cfg.gid <= 0) {
    throw new ContainerConfigError("Containers never run as root: run tm-judge as its own user (the containers use its uid:gid) or set JUDGE_CONTAINER_UID/GID to a non-root id.");
  }
}

// ───────────────────────── availability ─────────────────────────

/** What the startup probe found (GET /v1/health `containers`). */
export interface ContainerStatus {
  enabled: boolean;
  /** Docker answered on the socket. */
  reachable: boolean;
  runtime: string;
  /** The runtime is registered with Docker (/etc/docker/daemon.json "runtimes"). */
  runtime_registered: boolean;
  arch: string | null;
  /** image name → present. */
  images: Record<string, boolean>;
  /** null when usable; else why tier 3 is off. */
  reason: string | null;
  usable: boolean;
}

export function offStatus(cfg: Pick<ContainerConfig, "enabled" | "runtime">, reason: string): ContainerStatus {
  return { enabled: cfg.enabled, reachable: false, runtime: cfg.runtime, runtime_registered: false, arch: null, images: {}, reason, usable: false };
}

/** Asks Docker what it has: reachable, the runtime registered, which images exist. */
export async function probeContainers(docker: Docker, cfg: ContainerConfig): Promise<ContainerStatus> {
  if (!cfg.enabled) return offStatus(cfg, "containers are off on this runner (JUDGE_CONTAINERS is not 1)");
  let info: Awaited<ReturnType<Docker["info"]>>;
  try {
    await docker.ping();
    info = await docker.info();
  } catch (e) {
    return offStatus(cfg, `Docker is not reachable (${e instanceof Error ? e.message : String(e)})`);
  }
  const registered = !!info.Runtimes && Object.hasOwn(info.Runtimes, cfg.runtime);
  const names = [...new Set([...Object.values(cfg.images), cfg.postgresImage, cfg.mysqlImage])].sort();
  const images: Record<string, boolean> = {};
  for (const n of names) images[n] = !!(await docker.imageId(n).catch(() => null));
  const status: ContainerStatus = {
    enabled: true,
    reachable: true,
    runtime: cfg.runtime,
    runtime_registered: registered,
    arch: info.Architecture ?? null,
    images,
    reason: null,
    usable: false,
  };
  if (!registered) status.reason = `the container runtime '${cfg.runtime}' is not registered with Docker`;
  else if (!Object.values(cfg.images).some((n) => images[n])) status.reason = "no runner images are built (services/judge/images/build-images.sh)";
  status.usable = !status.reason;
  return status;
}

/** Tier-3 view kept on Toolchains (availability, catalog, sessions). */
export interface ContainerTier {
  config: ContainerConfig;
  status: ContainerStatus;
}

/** The image a runtime's containers use, when it is built; else null. */
export function imageFor(t: ContainerTier | undefined, runtime: string): string | null {
  if (!t?.status.usable) return null;
  const name = t.config.images[runtime];
  return name && t.status.images[name] ? name : null;
}

/** Why a kind can't run in a container here (null = it can). */
export function containerReason(t: ContainerTier | undefined, kind: Pick<KindDef, "runtime">): string | null {
  if (!t) return "containers are off on this runner";
  if (!t.status.usable) return t.status.reason ?? "containers are off on this runner";
  const name = t.config.images[kind.runtime];
  if (!name) return `no container image for runtime ${kind.runtime}`;
  if (!t.status.images[name]) return `image ${name} is not built on this runner`;
  return null;
}

/** Databases need both sidecar images (and the matching client image for sql kinds). */
export function databasesUsable(t: ContainerTier | undefined): { postgres: boolean; mysql: boolean } {
  if (!t?.status.usable) return { postgres: false, mysql: false };
  return { postgres: !!t.status.images[t.config.postgresImage], mysql: !!t.status.images[t.config.mysqlImage] };
}

const cTc = new WeakMap<Toolchains, Toolchains>();
/**
 * Toolchains as seen inside the images: every tool at its catalog path (the
 * images are built to that layout), cache layers as on the host.
 */
export function containerToolchains(tc: Toolchains): Toolchains {
  let v = cTc.get(tc);
  if (!v) {
    const runtimes = new Map<string, RuntimeState>();
    for (const def of CATALOG.runtimes) runtimes.set(def.id, { def, tools: { ...def.tools }, version: tc.runtimes.get(def.id)?.version ?? null });
    v = { ...tc, runtimes };
    cTc.set(tc, v);
  }
  return v;
}

// ───────────────────────── container bodies ─────────────────────────

export interface ContainerSpec {
  image: string;
  argv: string[];
  env: Record<string, string>;
  /** Project-relative working folder. */
  cwd?: string;
  limits: Limits;
  /** The box's host folder, bound at /box. */
  hostBox: string;
  mounts: Mount[];
  /** A Docker network name; default none. */
  network?: string;
  tty?: boolean;
  runId?: string;
}

export const BASE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/box", TMPDIR: "/tmp", LANG: "C.UTF-8" };

/** POST /containers/create body for one sandboxed program (pure; every security flag lives here). */
export function containerBody(cfg: Pick<ContainerConfig, "runtime" | "uid" | "gid" | "cpus" | "memoryCapMb" | "tmpMb"> & { cgroupParent?: string | null }, spec: ContainerSpec) {
  const memoryMb = Math.min(Math.max(spec.limits.memoryMb, 32), cfg.memoryCapMb);
  const memory = memoryMb * 1024 * 1024;
  const fsize = (spec.limits.fileKb ?? Math.max(spec.limits.outputKb * 2, 1024)) * 1024;
  const network = spec.network ?? "none";
  const vars = { ...BASE_ENV, ...spec.env };
  const cwd = spec.cwd && spec.cwd !== "." ? `/box/${spec.cwd.replace(/^\/+|\/+$/g, "")}` : "/box";
  return {
    Image: spec.image,
    Cmd: spec.argv,
    Env: Object.entries(vars).map(([k, v]) => `${k}=${v}`),
    WorkingDir: cwd,
    User: `${cfg.uid}:${cfg.gid}`,
    Tty: !!spec.tty,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    NetworkDisabled: network === "none",
    Labels: { [LABEL]: "box", ...(spec.runId ? { [`${LABEL}.run`]: spec.runId } : {}) },
    HostConfig: {
      Runtime: cfg.runtime,
      NetworkMode: network,
      ReadonlyRootfs: true,
      Binds: [`${spec.hostBox}:/box:rw`, ...spec.mounts.map((m) => `${m.host}:${m.inside}:ro`)],
      Tmpfs: { "/tmp": `rw,nosuid,nodev,size=${cfg.tmpMb}m,mode=1777` },
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      PidsLimit: Math.max(spec.limits.processes, 16),
      Memory: memory,
      MemorySwap: memory, // = Memory: no swap
      NanoCpus: Math.round(cfg.cpus * 1e9),
      Init: true, // tini as PID 1: forwards signals, reaps zombies
      IpcMode: "private",
      ShmSize: 64 * 1024 * 1024,
      OomScoreAdj: 500,
      Ulimits: [
        { Name: "fsize", Soft: fsize, Hard: fsize },
        { Name: "nofile", Soft: 1024, Hard: 1024 },
        { Name: "core", Soft: 0, Hard: 0 },
      ],
      LogConfig: { Type: "none", Config: {} },
      AutoRemove: false,
      ...(cfg.cgroupParent ? { CgroupParent: cfg.cgroupParent } : {}),
    },
  };
}

/** A container's exit → the sandbox status (the same statuses isolate reports). */
export function statusFromExit(x: { code: number | null; oom: boolean; timedOut: boolean; outputOver: boolean; error?: string }): { status: ExecResult["status"]; message?: string } {
  if (x.outputOver) return { status: "output-limit" };
  if (x.timedOut) return { status: "timeout" };
  if (x.oom) return { status: "memory" };
  if (x.code === null) return { status: "internal", message: x.error || "the container did not report an exit code" };
  if (x.code === 0) return { status: "ok" };
  // 128 + n: killed by signal n (tini reports it that way). An unexplained
  // SIGKILL is almost always the cgroup OOM killer (gVisor doesn't always set OOMKilled).
  if (x.code === 137) return { status: "memory", message: "Killed by SIGKILL (memory limit)" };
  if (x.code > 128 && x.code < 128 + 32) return { status: "signal", message: `Killed by ${SIGNALS[x.code - 128] ?? `signal ${x.code - 128}`}` };
  return { status: "runtime-error" };
}

const SIGNALS: Record<number, string> = { 1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 6: "SIGABRT", 7: "SIGBUS", 8: "SIGFPE", 9: "SIGKILL", 11: "SIGSEGV", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM", 25: "SIGXFSZ" };

// ───────────────────────── the sandbox ─────────────────────────

class Semaphore {
  private free: number;
  private waiters: (() => void)[] = [];
  constructor(n: number) {
    this.free = n;
  }
  async take() {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
  }
  give() {
    const w = this.waiters.shift();
    if (w) w();
    else this.free++;
  }
}

export class ContainerSandbox implements Sandbox {
  kind = "container" as const;
  readonly docker: Docker;
  readonly cfg: ContainerConfig;
  private slots: Semaphore;

  constructor(docker: Docker, cfg: ContainerConfig, slots = cfg.concurrency) {
    this.docker = docker;
    this.cfg = cfg;
    this.slots = new Semaphore(slots);
  }

  static create(cfg: ContainerConfig) {
    return new ContainerSandbox(new Docker(unixTransport(cfg.socket)), cfg);
  }

  async acquire(opts: AcquireOptions = {}): Promise<Box> {
    if (!opts.image) throw new Error("A container box needs an image.");
    const image = opts.image;
    const network = opts.network;
    const mounts = opts.mounts ?? [];
    await mkdir(this.cfg.workdir, { recursive: true, mode: 0o711 });
    let dir = await mkdtemp(join(this.cfg.workdir, "box-"));
    const docker = this.docker;
    const cfg = this.cfg;
    const slots = this.slots;
    const live = new Set<string>();
    let disposed = false;

    const create = async (argv: string[], limits: Limits, env: Record<string, string>, cwd: string | undefined, tty: boolean) => {
      const body = containerBody(cfg, { image, argv, env, cwd, limits, hostBox: dir, mounts, network, tty });
      const id = await docker.create(body);
      live.add(id);
      return id;
    };
    const cleanup = async (id: string) => {
      live.delete(id);
      await docker.remove(id).catch(() => {});
    };

    return {
      write: (path, content, mode, mtimeMs) => writeInto(dir, path, content, mode, mtimeMs),
      link: (path, target) => linkInto(dir, path, target),
      read: (path) => readFrom(dir, path),
      list: (d) => listIn(dir, d),
      visible: (path) => path,
      snapshot: () => listFiles(dir),
      async reset() {
        for (const id of [...live]) await cleanup(id);
        await removeTree(dir);
        dir = await mkdtemp(join(cfg.workdir, "box-"));
      },
      async exec(argv, { stdin, limits, env = {}, cwd }) {
        await slots.take();
        const started = Date.now();
        let id: string | null = null;
        try {
          id = await create(argv, limits, env, cwd, false);
          return await runAttached(docker, id, stdin, limits, started);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return { status: "internal", exitCode: null, stdout: "", stderr: message, timeMs: Date.now() - started, memoryKb: null, message };
        } finally {
          if (id) await cleanup(id);
          slots.give();
        }
      },
      spawn(argv, { limits, env = {}, cwd, tty }) {
        return spawnContainer({ docker, create: () => create(argv, limits, env, cwd, !!tty), cleanup, limits, tty, network });
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        for (const id of [...live]) await cleanup(id);
        await removeTree(dir);
      },
    };
  }

  /** Removes containers and networks a previous run of the judge left behind (crash, restart). */
  async sweep() {
    for (const c of await this.docker.listContainers(LABEL).catch(() => [])) await this.docker.remove(c.Id).catch(() => {});
    for (const n of await this.docker.listNetworks(LABEL).catch(() => [])) await this.docker.removeNetwork(n.Id).catch(() => {});
  }
}

const STDERR_CAP = 64 * 1024;

/** Runs a created container to completion: stdin in, capped stdout/stderr out, wall-clock kill. */
async function runAttached(docker: Docker, id: string, stdin: string, limits: Limits, started: number): Promise<ExecResult> {
  const stream = await docker.attach(id, true);
  const outCap = limits.outputKb * 1024;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let outputOver = false;
  let stderrCut = false;
  let timedOut = false;
  const demux = new Demuxer(
    (b) => {
      if (outputOver) return;
      if (outBytes + b.length > outCap) {
        outputOver = true;
        out.push(b.subarray(0, Math.max(outCap - outBytes, 0)));
        void docker.kill(id).catch(() => {});
        return;
      }
      outBytes += b.length;
      out.push(b);
    },
    (b) => {
      if (errBytes >= STDERR_CAP) {
        stderrCut = true;
        return;
      }
      const part = b.subarray(0, STDERR_CAP - errBytes);
      if (part.length < b.length) stderrCut = true;
      errBytes += part.length;
      err.push(part);
    },
  );
  const ended = new Promise<void>((r) => {
    stream.on("data", (c: Buffer) => demux.push(c));
    stream.on("end", r);
    stream.on("close", r);
    stream.on("error", () => r());
  });
  await docker.start(id);
  stream.on("error", () => {});
  stream.end(stdin);
  const timer = setTimeout(() => {
    timedOut = true;
    void docker.kill(id).catch(() => {});
  }, limits.wallS * 1000);
  let code: number | null = null;
  let error: string | undefined;
  try {
    code = await docker.wait(id);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  // The stream ends right after the container; don't hang on a stuck socket.
  await Promise.race([ended, new Promise((r) => setTimeout(r, 2000).unref())]);
  stream.destroy();
  const state = code !== null ? await docker.inspect(id).then((i) => i.State).catch(() => null) : null;
  const s = statusFromExit({ code, oom: !!state?.OOMKilled, timedOut, outputOver, error });
  return {
    status: s.status,
    exitCode: s.status === "timeout" || s.status === "output-limit" ? null : code,
    stdout: Buffer.concat(out).toString("utf8"),
    stderr: Buffer.concat(err).toString("utf8"),
    timeMs: Date.now() - started,
    memoryKb: null,
    message: s.message,
    stderrTruncated: stderrCut,
  };
}

interface SpawnArgs {
  docker: Docker;
  create: () => Promise<string>;
  cleanup: (id: string) => Promise<void>;
  limits: Limits;
  tty?: { cols: number; rows: number };
  network?: string;
}

/**
 * An interactive container (sessions, previews): live output, stdin over the
 * attach stream, signals through POST /kill, PTY resize. With a TTY the
 * program's output arrives raw on stdout (ANSI included).
 */
export function spawnContainer(a: SpawnArgs): Proc {
  const outs: ((b: Buffer) => void)[] = [];
  const errs: ((b: Buffer) => void)[] = [];
  const queued: (Buffer | null)[] = [];
  let stream: Duplex | null = null;
  let id: string | null = null;
  let killed: string | null = null;
  let timedOut = false;
  const started = Date.now();
  let resolveInfo!: (v: { id: string; ip: string | null }) => void;
  let rejectInfo!: (e: Error) => void;
  const info = new Promise<{ id: string; ip: string | null }>((res, rej) => {
    resolveInfo = res;
    rejectInfo = rej;
  });
  info.catch(() => {});
  const emitOut = (b: Buffer) => outs.forEach((f) => f(b));
  const emitErr = (b: Buffer) => errs.forEach((f) => f(b));

  const done = (async (): Promise<ExecResult> => {
    try {
      id = await a.create();
      stream = await a.docker.attach(id, true);
      if (a.tty) stream.on("data", emitOut);
      else {
        const d = new Demuxer(emitOut, emitErr);
        stream.on("data", (c: Buffer) => d.push(c));
      }
      stream.on("error", () => {});
      await a.docker.start(id);
      if (a.tty) await a.docker.resize(id, a.tty.cols, a.tty.rows).catch(() => {});
      let ip: string | null = null;
      if (a.network) {
        const i = await a.docker.inspect(id).catch(() => null);
        ip = i?.NetworkSettings?.Networks?.[a.network]?.IPAddress || null;
      }
      resolveInfo({ id, ip });
      for (const q of queued.splice(0)) (q === null ? stream.end() : stream.write(q));
      if (killed) await a.docker.kill(id, killed).catch(() => {});
      const timer = setTimeout(() => {
        timedOut = true;
        void a.docker.kill(id!).catch(() => {});
      }, a.limits.wallS * 1000);
      let code: number | null = null;
      let error: string | undefined;
      try {
        code = await a.docker.wait(id);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      } finally {
        clearTimeout(timer);
      }
      const state = code !== null ? await a.docker.inspect(id).then((i) => i.State).catch(() => null) : null;
      const s = statusFromExit({ code, oom: !!state?.OOMKilled, timedOut, outputOver: false, error });
      // A signal the client asked for is the reason, not memory.
      const status = killed && code !== null && code > 128 && s.status !== "timeout" ? "signal" : s.status;
      return { status, exitCode: code, stdout: "", stderr: "", timeMs: Date.now() - started, memoryKb: null, message: killed && status === "signal" ? `Killed by ${killed}` : s.message };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      rejectInfo(e instanceof Error ? e : new Error(message));
      return { status: "internal", exitCode: null, stdout: "", stderr: message, timeMs: Date.now() - started, memoryKb: null, message };
    } finally {
      (stream as Duplex | null)?.destroy();
      if (id) await a.cleanup(id);
    }
  })();

  return {
    write(d) {
      const b = typeof d === "string" ? Buffer.from(d) : d;
      if (stream && !stream.destroyed) stream.write(b);
      else queued.push(b);
    },
    end() {
      // A terminal has no "end of input": send Ctrl-D, as a keyboard would.
      if (a.tty) return this.write("\x04");
      if (stream && !stream.destroyed) stream.end();
      else queued.push(null);
    },
    kill(signal: SessionSignal) {
      killed = signal;
      if (id) void a.docker.kill(id, signal).catch(() => {});
    },
    onStdout: (cb) => void outs.push(cb),
    onStderr: (cb) => void errs.push(cb),
    resize(cols, rows) {
      if (id && a.tty) void a.docker.resize(id, cols, rows).catch(() => {});
    },
    container: info,
    done,
  };
}

