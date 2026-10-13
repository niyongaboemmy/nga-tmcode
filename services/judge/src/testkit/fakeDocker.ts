/**
 * An in-memory Docker Engine for unit tests: records every API call and lets a
 * test script what a container prints and how it exits. No daemon needed.
 */
import { Duplex } from "node:stream";
import type { DockerResponse, DockerTransport } from "../docker.ts";

export interface FakeContainer {
  id: string;
  name?: string;
  body: Record<string, any>;
  stdin: Buffer[];
  stdinEnded: boolean;
  started: boolean;
  running: boolean;
  code: number | null;
  oom: boolean;
  /** All of stdin, once the judge closed it. */
  input(): Promise<string>;
  /** Writes to the attached stream (multiplexed unless Tty). */
  stdout(text: string | Buffer): void;
  stderr(text: string | Buffer): void;
  exit(code: number, opts?: { oom?: boolean }): void;
}

export interface Call {
  method: string;
  path: string;
  body?: any;
}

/** One multiplexed frame (stream 1 = stdout, 2 = stderr). */
export function frame(stream: 1 | 2, data: string | Buffer) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(b.length, 4);
  return Buffer.concat([h, b]);
}

const json = (status: number, body?: unknown): DockerResponse => ({ status, body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body)) });

export class FakeDocker implements DockerTransport {
  calls: Call[] = [];
  containers = new Map<string, FakeContainer>();
  images = new Set<string>();
  runtimes: Record<string, unknown> = { runc: {}, runsc: {} };
  reachable = true;
  arch = "aarch64";
  networks = new Set<string>();
  /** What a started container does (default: exits 0 at once). */
  program: (c: FakeContainer) => void = (c) => c.exit(0);
  /** Exit code and output of `exec` calls, by command. */
  execResult: (cmd: string[]) => { exitCode: number; stdout?: string; stderr?: string } = () => ({ exitCode: 0 });
  private seq = 0;
  private streams = new Map<string, Duplex>();
  private waiters = new Map<string, ((code: number) => void)[]>();
  private execs = new Map<string, number>();
  private stdinDone = new Map<string, () => void>();

  callsTo(re: RegExp) {
    return this.calls.filter((c) => re.test(`${c.method} ${c.path}`));
  }

  private container(id: string) {
    const c = this.containers.get(id);
    if (!c) throw new Error(`no container ${id}`);
    return c;
  }

  private make(body: Record<string, any>, name?: string): FakeContainer {
    const id = `c${++this.seq}`;
    const self = this;
    const push = (b: Buffer) => this.streams.get(id)?.push(b);
    let stdinDone!: () => void;
    const stdinEnded = new Promise<void>((r) => (stdinDone = r));
    this.stdinDone.set(id, () => stdinDone());
    const c: FakeContainer = {
      input: () => stdinEnded.then(() => Buffer.concat(c.stdin).toString()),
      id,
      name,
      body,
      stdin: [],
      stdinEnded: false,
      started: false,
      running: false,
      code: null,
      oom: false,
      stdout: (t) => push(body.Tty ? (Buffer.isBuffer(t) ? t : Buffer.from(t)) : frame(1, t)),
      stderr: (t) => push(body.Tty ? (Buffer.isBuffer(t) ? t : Buffer.from(t)) : frame(2, t)),
      exit(code, opts = {}) {
        if (!c.running && c.code !== null) return;
        c.running = false;
        c.code = code;
        c.oom = !!opts.oom;
        self.streams.get(id)?.push(null);
        for (const w of self.waiters.get(id) ?? []) w(code);
        self.waiters.delete(id);
      },
    };
    this.containers.set(id, c);
    return c;
  }

  async request(method: string, path: string, body?: unknown): Promise<DockerResponse> {
    this.calls.push({ method, path, body });
    if (!this.reachable) throw new Error("connect ENOENT /var/run/docker.sock");
    const [p, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    let m: RegExpExecArray | null;
    if (p === "/_ping") return { status: 200, body: Buffer.from("OK") };
    if (p === "/info") return json(200, { Runtimes: this.runtimes, Architecture: this.arch, ServerVersion: "27.3.1" });
    if ((m = /^\/images\/(.+)\/json$/.exec(p))) return this.images.has(decodeURIComponent(m[1])) ? json(200, { Id: `sha256:${m[1]}` }) : json(404, { message: "No such image" });
    if (p === "/containers/create") {
      const b = body as Record<string, any>;
      if (!this.images.has(b.Image)) return json(404, { message: `No such image: ${b.Image}` });
      return json(201, { Id: this.make(b, params.get("name") ?? undefined).id });
    }
    if ((m = /^\/containers\/([^/]+)\/start$/.exec(p))) {
      const c = this.container(m[1]);
      c.started = true;
      c.running = true;
      queueMicrotask(() => this.program(c));
      return json(204);
    }
    if ((m = /^\/containers\/([^/]+)\/wait$/.exec(p))) {
      const c = this.container(m[1]);
      if (c.code !== null && !c.running) return json(200, { StatusCode: c.code });
      const code = await new Promise<number>((r) => this.waiters.set(c.id, [...(this.waiters.get(c.id) ?? []), r]));
      return json(200, { StatusCode: code });
    }
    if ((m = /^\/containers\/([^/]+)\/kill$/.exec(p))) {
      const c = this.containers.get(m[1]);
      if (!c) return json(404, { message: "gone" });
      if (!c.running) return json(409, { message: "not running" });
      const sig = params.get("signal") ?? "SIGKILL";
      const n = { SIGKILL: 9, SIGINT: 2, SIGTERM: 15 }[sig] ?? 9;
      queueMicrotask(() => c.exit(128 + n));
      return json(204);
    }
    if ((m = /^\/containers\/([^/]+)\/resize$/.exec(p))) return json(200);
    if ((m = /^\/containers\/([^/]+)\/json$/.exec(p))) {
      const c = this.container(m[1]);
      const net = c.body.HostConfig?.NetworkMode;
      return json(200, {
        State: { Running: c.running, ExitCode: c.code ?? 0, OOMKilled: c.oom },
        NetworkSettings: { Networks: net && net !== "none" ? { [net]: { IPAddress: `172.30.0.${c.id.slice(1)}` } } : {} },
      });
    }
    if ((m = /^\/containers\/([^/]+)$/.exec(p)) && method === "DELETE") {
      const c = this.containers.get(m[1]);
      if (!c) return json(404, { message: "gone" });
      c.exit(137);
      this.containers.delete(m[1]);
      return json(204);
    }
    if ((m = /^\/containers\/([^/]+)\/exec$/.exec(p))) {
      const id = `e${++this.seq}`;
      const r = this.execResult((body as { Cmd: string[] }).Cmd);
      this.execs.set(id, r.exitCode);
      (this as any)[`out_${id}`] = Buffer.concat([r.stdout ? frame(1, r.stdout) : Buffer.alloc(0), r.stderr ? frame(2, r.stderr) : Buffer.alloc(0)]);
      return json(201, { Id: id });
    }
    if ((m = /^\/exec\/([^/]+)\/start$/.exec(p))) return { status: 200, body: (this as any)[`out_${m[1]}`] ?? Buffer.alloc(0) };
    if ((m = /^\/exec\/([^/]+)\/json$/.exec(p))) return json(200, { ExitCode: this.execs.get(m[1]) ?? 0, Running: false });
    if (p === "/networks/create") {
      const name = (body as { Name: string }).Name;
      this.networks.add(name);
      return json(201, { Id: name });
    }
    if ((m = /^\/networks\/([^/]+)$/.exec(p)) && method === "DELETE") {
      if (!this.networks.delete(m[1])) return json(404, { message: "gone" });
      return json(204);
    }
    if (p === "/containers/json" || p === "/networks") return json(200, []);
    return json(404, { message: `fake: no route ${method} ${path}` });
  }

  async hijack(method: string, path: string): Promise<Duplex> {
    this.calls.push({ method, path });
    const m = /^\/containers\/([^/]+)\/attach/.exec(path);
    if (!m) throw new Error(`fake: no hijack route ${path}`);
    const c = this.container(m[1]);
    const d = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        c.stdin.push(Buffer.from(chunk));
        cb();
      },
      final: (cb) => {
        c.stdinEnded = true;
        this.stdinDone.get(c.id)?.();
        cb();
      },
    });
    this.streams.set(c.id, d);
    return d;
  }
}
