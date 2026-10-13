/**
 * A small Docker Engine API client over the unix socket (node:http only, no
 * new dependencies). Tier 3 (containers.ts, services.ts, previews.ts) talks to
 * Docker through `Docker`, whose transport is injectable so the request
 * building is unit-tested without a daemon.
 *
 * Engine API reference: https://docs.docker.com/reference/api/engine/. API 1.44 = Docker 25+
 * (Docker 29 dropped older API versions); JUDGE_DOCKER_API overrides it.
 */
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";

export const DOCKER_API = `/${process.env.JUDGE_DOCKER_API ?? "v1.44"}`;

export interface DockerResponse {
  status: number;
  body: Buffer;
}

/** How requests reach the daemon. Tests pass a fake. */
export interface DockerTransport {
  request(method: string, path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<DockerResponse>;
  /** An upgraded (hijacked) connection: attach and interactive exec. */
  hijack(method: string, path: string, body?: unknown): Promise<Duplex>;
}

export class DockerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The real transport: HTTP over /var/run/docker.sock (DOCKER_HOST=unix:///… is honoured). */
export function unixTransport(socketPath = defaultSocket()): DockerTransport {
  return {
    request(method, path, body, opts = {}) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
        const req = httpRequest(
          {
            socketPath,
            method,
            path: `${DOCKER_API}${path}`,
            headers: { Host: "docker", ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}) },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (c: Buffer) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
            res.on("error", reject);
          },
        );
        if (opts.timeoutMs) req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`Docker ${method} ${path} timed out`)));
        req.on("error", reject);
        req.end(payload);
      });
    },
    hijack(method, path, body) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
        const req = httpRequest({
          socketPath,
          method,
          path: `${DOCKER_API}${path}`,
          headers: { Host: "docker", Connection: "Upgrade", Upgrade: "tcp", "Content-Type": "application/json", "Content-Length": payload.length },
        });
        req.on("upgrade", (_res, socket, head) => {
          if (head.length) socket.unshift(head);
          resolve(socket);
        });
        req.on("response", (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => reject(new DockerError(res.statusCode ?? 0, `Docker ${method} ${path}: ${Buffer.concat(chunks).toString("utf8").trim()}`)));
        });
        req.on("error", reject);
        req.end(payload);
      });
    },
  };
}

export function defaultSocket() {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  return "/var/run/docker.sock";
}

/** Docker's multiplexed stdout/stderr stream (Tty: false): 8-byte headers [stream, 0, 0, 0, size BE32]. */
export class Demuxer {
  private buf: Buffer = Buffer.alloc(0);
  private onOut: (b: Buffer) => void;
  private onErr: (b: Buffer) => void;
  constructor(onOut: (b: Buffer) => void, onErr: (b: Buffer) => void) {
    this.onOut = onOut;
    this.onErr = onErr;
  }
  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 8) {
      const size = this.buf.readUInt32BE(4);
      if (this.buf.length < 8 + size) break;
      const frame = this.buf.subarray(8, 8 + size);
      if (this.buf[0] === 2) this.onErr(frame);
      else this.onOut(frame); // 0 (stdin echo) and 1 → stdout
      this.buf = this.buf.subarray(8 + size);
    }
  }
}

/** Splits a whole multiplexed body into stdout and stderr. */
export function demux(body: Buffer) {
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  new Demuxer((b) => out.push(b), (b) => err.push(b)).push(body);
  return { stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const s = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return s ? `?${s}` : "";
};

export interface ContainerState {
  Running: boolean;
  ExitCode: number;
  OOMKilled: boolean;
  Error?: string;
}

/** The calls tier 3 needs. Every method maps to one Engine API endpoint. */
export class Docker {
  readonly transport: DockerTransport;
  constructor(transport: DockerTransport) {
    this.transport = transport;
  }

  private async call<T = unknown>(method: string, path: string, body?: unknown, ok: number[] = [200, 201, 204], timeoutMs?: number): Promise<T> {
    const r = await this.transport.request(method, path, body, { timeoutMs });
    if (!ok.includes(r.status)) {
      let message = r.body.toString("utf8").trim();
      try {
        message = (JSON.parse(message) as { message?: string }).message ?? message;
      } catch {
        /* plain text */
      }
      throw new DockerError(r.status, `Docker ${method} ${path.split("?")[0]}: ${r.status} ${message}`);
    }
    if (!r.body.length) return undefined as T;
    try {
      return JSON.parse(r.body.toString("utf8")) as T;
    } catch {
      return r.body as unknown as T;
    }
  }

  ping() {
    return this.call<Buffer | string>("GET", "/_ping", undefined, [200], 3000);
  }

  info() {
    return this.call<{ Runtimes?: Record<string, unknown>; DefaultRuntime?: string; Architecture?: string; ServerVersion?: string }>("GET", "/info", undefined, [200], 5000);
  }

  /** null when the image isn't present. */
  async imageId(name: string): Promise<string | null> {
    try {
      return (await this.call<{ Id: string }>("GET", `/images/${encodeURIComponent(name)}/json`, undefined, [200], 5000)).Id;
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  }

  async create(body: unknown, name?: string): Promise<string> {
    return (await this.call<{ Id: string }>("POST", `/containers/create${q({ name })}`, body, [201])).Id;
  }

  /** Attach before start so no output is lost. */
  attach(id: string, stdin: boolean) {
    return this.transport.hijack("POST", `/containers/${id}/attach${q({ stream: 1, stdin: stdin ? 1 : 0, stdout: 1, stderr: 1 })}`);
  }

  start(id: string) {
    return this.call("POST", `/containers/${id}/start`, undefined, [204, 304]);
  }

  async wait(id: string): Promise<number> {
    return (await this.call<{ StatusCode: number }>("POST", `/containers/${id}/wait`, undefined, [200])).StatusCode;
  }

  async kill(id: string, signal = "SIGKILL") {
    try {
      await this.call("POST", `/containers/${id}/kill${q({ signal })}`, undefined, [204]);
    } catch (e) {
      // 404: gone; 409: not running.
      if (!(e instanceof DockerError) || (e.status !== 404 && e.status !== 409)) throw e;
    }
  }

  resize(id: string, cols: number, rows: number) {
    return this.call("POST", `/containers/${id}/resize${q({ h: rows, w: cols })}`, undefined, [200]);
  }

  inspect(id: string) {
    return this.call<{ State: ContainerState; NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> } }>("GET", `/containers/${id}/json`);
  }

  async remove(id: string) {
    try {
      await this.call("DELETE", `/containers/${id}${q({ force: true, v: true })}`, undefined, [204]);
    } catch (e) {
      if (!(e instanceof DockerError) || e.status !== 404) throw e;
    }
  }

  async createNetwork(body: unknown): Promise<string> {
    return (await this.call<{ Id: string }>("POST", "/networks/create", body, [201])).Id;
  }

  async removeNetwork(id: string) {
    try {
      await this.call("DELETE", `/networks/${id}`, undefined, [204]);
    } catch (e) {
      if (!(e instanceof DockerError) || e.status !== 404) throw e;
    }
  }

  /** Runs a command in a running container; returns its exit code and output (no stdin). */
  async exec(id: string, cmd: string[], opts: { user?: string; env?: string[]; timeoutMs?: number } = {}) {
    const ex = await this.call<{ Id: string }>("POST", `/containers/${id}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true, User: opts.user, Env: opts.env }, [201]);
    const r = await this.transport.request("POST", `/exec/${ex.Id}/start`, { Detach: false, Tty: false }, { timeoutMs: opts.timeoutMs ?? 60_000 });
    const out = demux(r.body);
    const st = await this.call<{ ExitCode: number | null; Running: boolean }>("GET", `/exec/${ex.Id}/json`);
    return { exitCode: st.ExitCode, ...out };
  }

  /** Containers (or networks) carrying a label, for clean-up after a crash. */
  listContainers(label: string) {
    return this.call<{ Id: string }[]>("GET", `/containers/json${q({ all: true, filters: JSON.stringify({ label: [label] }) })}`);
  }

  listNetworks(label: string) {
    return this.call<{ Id: string }[]>("GET", `/networks${q({ filters: JSON.stringify({ label: [label] }) })}`);
  }
}
