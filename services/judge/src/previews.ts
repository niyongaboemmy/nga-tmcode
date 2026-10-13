/**
 * Server previews (tier 3, docs/PROTOCOL.md §5.8): a project's web server
 * (Express, Flask, FastAPI, Django, Spring Boot, ASP.NET, Laravel, Rails…)
 * built and started in a container on its own internal Docker network (no
 * egress), reachable only through this judge's HTTP proxy.
 *
 *   POST   /v1/previews                  {kind?, language?, files, entry?, services?} → 201 {id}
 *   GET    /v1/previews/:id/events       text/event-stream: stage, log, ready, exit, error
 *   DELETE /v1/previews/:id              → 204
 *   ANY    /v1/previews/:id/http/*       proxy (bearer auth)
 *   ANY    /p/:id/:token/*               public proxy (signed token, no bearer),
 *                                        served from a separate preview origin
 *
 * token = `<exp>.<sig>`, exp = unix seconds, sig = base64url(HMAC-SHA256(
 * JUDGE_PREVIEW_SECRET, `${id}.${exp}`)). Task Mentor mints it.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { capBytes, RequestError, STDERR_CAP, type SubmissionFile } from "./judge.ts";
import { LABEL, type ContainerSandbox } from "./containers.ts";
import { networkBody } from "./services.ts";
import { boxSetup, buildLimits, cacheFiles, mainClassOf, placement, quiet, resolveProject, startServices, stepArgv, stepFailureText, type ProjectRequest } from "./project.ts";
import type { Box, Limits, Proc } from "./sandbox.ts";
import { testFilterArgs, type TokenContext } from "./tokens.ts";
import { stepRuns, type Toolchains } from "./toolchains.ts";
import type { ServiceHandle } from "./services.ts";

/** The sandbox flags Task Mentor's iframe uses too. The preview is on its own origin, so allow-same-origin is that origin. */
export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-same-origin";

// ───────────────────────── tokens ─────────────────────────

export function signPreviewToken(id: string, exp: number, secret: string) {
  const sig = createHmac("sha256", secret).update(`${id}.${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

export type TokenCheck = { ok: true } | { ok: false; reason: "malformed" | "expired" | "bad-signature" };

/** Checks `<exp>.<sig>` for this preview id: not expired, signature equal in constant time. */
export function verifyPreviewToken(id: string, token: string, secret: string, nowS = Math.floor(Date.now() / 1000)): TokenCheck {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m || !secret) return { ok: false, reason: "malformed" };
  const exp = Number(m[1]);
  const want = Buffer.from(createHmac("sha256", secret).update(`${id}.${m[1]}`).digest("base64url"));
  const got = Buffer.from(m[2]);
  const sigOk = got.length === want.length && timingSafeEqual(got, want);
  if (!sigOk) return { ok: false, reason: "bad-signature" };
  if (exp <= nowS) return { ok: false, reason: "expired" };
  return { ok: true };
}

// ───────────────────────── paths and headers ─────────────────────────

export interface ProxyRoute {
  id: string;
  /** Present on the public path. */
  token?: string;
  /** The path prefix the browser sees ("/p/<id>/<token>" or "/v1/previews/<id>/http"). */
  prefix: string;
  /** Path + query for the upstream server ("/" at least). */
  upstream: string;
  /** "/p/<id>/<token>" without the trailing slash: redirect so relative links resolve under the prefix. */
  needsSlash: boolean;
}

const ID = "[A-Za-z0-9_-]{1,64}";
const PUBLIC = new RegExp(`^/p/(${ID})/([^/?#]{1,128})(/[^?#]*)?(\\?[^#]*)?$`);
const PRIVATE = new RegExp(`^/v1/previews/(${ID})/http(/[^?#]*)?(\\?[^#]*)?$`);

/** Maps a request URL to a preview and the upstream path (pure). null = not a proxy URL. */
export function proxyRoute(url: string): ProxyRoute | null {
  let m = PUBLIC.exec(url);
  if (m) {
    const [, id, token, rest, query] = m;
    return { id, token: decodeURIComponent(token), prefix: `/p/${id}/${token}`, upstream: `${rest || "/"}${query ?? ""}`, needsSlash: !rest };
  }
  m = PRIVATE.exec(url);
  if (m) {
    const [, id, rest, query] = m;
    return { id, prefix: `/v1/previews/${id}/http`, upstream: `${rest || "/"}${query ?? ""}`, needsSlash: !rest };
  }
  return null;
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "http2-settings"]);

/** Headers for the upstream request: hop-by-hop gone, the judge's bearer never forwarded, Host = the server's own. */
export function upstreamHeaders(h: IncomingHttpHeaders, target: { host: string; port: number }, prefix: string, isPrivate: boolean) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP.has(k)) continue;
    if (isPrivate && k === "authorization") continue;
    if (k === "host" || k.startsWith("x-forwarded-")) continue;
    out[k] = v;
  }
  // Frameworks that check Host (Django, Rails) accept localhost in development mode.
  out.host = `localhost:${target.port}`;
  if (h.host) out["x-forwarded-host"] = String(h.host);
  out["x-forwarded-proto"] = String(h["x-forwarded-proto"] ?? "https");
  out["x-forwarded-prefix"] = prefix;
  return out;
}

/** Location: absolute paths and URLs pointing at the server itself stay under the prefix. */
export function rewriteLocation(location: string, prefix: string, target: { host: string; port: number }) {
  if (location.startsWith("/") && !location.startsWith("//")) return `${prefix}${location}`;
  const m = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(location);
  if (m) {
    const host = m[1].toLowerCase();
    const own = [`localhost:${target.port}`, `127.0.0.1:${target.port}`, `0.0.0.0:${target.port}`, `${target.host}:${target.port}`];
    if (own.includes(host)) return `${prefix}${m[2] ?? "/"}`;
  }
  return location;
}

/** Set-Cookie: no Domain (the cookie stays on the preview origin) and a Path under this preview's prefix. */
export function rewriteSetCookie(cookie: string, prefix: string) {
  const parts = cookie.split(";").map((p) => p.trim()).filter(Boolean);
  const [pair, ...attrs] = parts;
  const kept: string[] = [];
  let path: string | null = null;
  for (const a of attrs) {
    const name = a.split("=")[0].trim().toLowerCase();
    if (name === "domain") continue;
    if (name === "path") {
      path = a.slice(a.indexOf("=") + 1).trim() || "/";
      continue;
    }
    kept.push(a);
  }
  const p = path && path.startsWith("/") ? path : "/";
  return [pair, ...kept, `Path=${prefix}${p}`].join("; ");
}

/** Response headers for the browser (pure). */
export function downstreamHeaders(h: IncomingHttpHeaders, prefix: string, target: { host: string; port: number }) {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP.has(k)) continue;
    // The preview must frame inside Task Mentor; our CSP sandbox replaces the app's frame rules.
    if (k === "x-frame-options") continue;
    if (k === "location") out[k] = rewriteLocation(String(v), prefix, target);
    else if (k === "set-cookie") out[k] = (Array.isArray(v) ? v : [v]).map((c) => rewriteSetCookie(c, prefix));
    else out[k] = v;
  }
  const csp = h["content-security-policy"];
  out["content-security-policy"] = csp ? [...(Array.isArray(csp) ? csp : [csp]), PREVIEW_CSP] : PREVIEW_CSP;
  // The token is in the path: never send it to other sites.
  out["referrer-policy"] = "no-referrer";
  out["x-content-type-options"] = "nosniff";
  return out;
}

// ───────────────────────── the manager ─────────────────────────

export type PreviewEvent =
  | { event: "stage"; data: { name: "build" | "start" } }
  | { event: "log"; data: { stream: "stdout" | "stderr"; data: string } }
  | { event: "ready"; data: { path: string } }
  | { event: "exit"; data: { code: number | null; signal: string | null; reason: string } }
  | { event: "error"; data: { message: string } };

export interface PreviewRequest {
  kind?: string;
  language?: string;
  files: SubmissionFile[];
  entry?: string;
  services?: string[];
}

export interface PreviewTarget {
  host: string;
  port: number;
}

/** A started preview, from the launcher (containers in production, fakes in tests). */
export interface PreviewLaunch {
  /** Resolves when the server answers on its port; rejects when it can't start (the reason was logged). */
  ready: Promise<PreviewTarget>;
  /** Resolves when the server process ends. */
  exited: Promise<{ code: number | null; signal: string | null }>;
  /** Kills everything and frees the network/box/database. Idempotent. */
  stop(): Promise<void>;
}

export interface LaunchHooks {
  stage(name: "build" | "start"): void;
  log(stream: "stdout" | "stderr", data: string): void;
}

export type Launcher = (req: PreviewRequest, id: string, hooks: LaunchHooks) => PreviewLaunch;

export interface PreviewOptions {
  /** JUDGE_PREVIEWS (4). */
  max?: number;
  /** 15 minutes. */
  lifetimeMs?: number;
  /** 5 minutes without a proxied request. */
  idleMs?: number;
  /** Log bytes kept for replay (256 KB). */
  logBytes?: number;
  /** How long a finished preview's events stay readable. */
  keepMs?: number;
}

class Preview {
  readonly id: string;
  readonly events: PreviewEvent[] = [];
  readonly listeners = new Set<(e: PreviewEvent) => void>();
  state: "starting" | "ready" | "ended" = "starting";
  target: PreviewTarget | null = null;
  launch: PreviewLaunch | null = null;
  timers: NodeJS.Timeout[] = [];
  idle: NodeJS.Timeout | null = null;
  logBytes = 0;
  constructor(id: string) {
    this.id = id;
  }
  emit(e: PreviewEvent) {
    if (this.state === "ended") return;
    this.events.push(e);
    for (const l of this.listeners) l(e);
  }
}

function previewError(status: number, code: string, message: string) {
  return Object.assign(new RequestError(message), { status, code });
}

export class PreviewManager {
  private previews = new Map<string, Preview>();
  private live = 0;
  readonly max: number;
  private lifetimeMs: number;
  private idleMs: number;
  private logCap: number;
  private keepMs: number;
  private launcher: Launcher;

  constructor(launcher: Launcher, opts: PreviewOptions = {}) {
    this.launcher = launcher;
    this.max = opts.max ?? 4;
    this.lifetimeMs = opts.lifetimeMs ?? 15 * 60_000;
    this.idleMs = opts.idleMs ?? 5 * 60_000;
    this.logCap = opts.logBytes ?? 256 * 1024;
    this.keepMs = opts.keepMs ?? 60_000;
  }

  get running() {
    return this.live;
  }

  create(body: unknown): { id: string } {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("Body must be a JSON object.");
    const req = body as PreviewRequest;
    if (!Array.isArray(req.files) || !req.files.length) throw new RequestError("files must be a non-empty list of { path, content }.");
    if (this.live >= this.max) throw previewError(429, "BUSY", `At most ${this.max} previews at a time. Stop one or try again shortly.`);
    const p = new Preview(randomUUID());
    this.previews.set(p.id, p);
    this.live++;
    p.timers.push(setTimeout(() => void this.end(p, `The preview reached its ${Math.round(this.lifetimeMs / 60_000)}-minute limit.`), this.lifetimeMs));
    let launch: PreviewLaunch;
    try {
      launch = this.launcher(req, p.id, {
        stage: (name) => p.emit({ event: "stage", data: { name } }),
        log: (stream, data) => {
          if (p.logBytes >= this.logCap) return;
          const part = capBytes(data, this.logCap - p.logBytes);
          p.logBytes += Buffer.byteLength(part.text);
          p.emit({ event: "log", data: { stream, data: part.text } });
          if (part.cut) p.emit({ event: "log", data: { stream: "stderr", data: "\n[tm-judge] log output truncated\n" } });
        },
      });
    } catch (e) {
      this.previews.delete(p.id);
      this.live--;
      for (const t of p.timers) clearTimeout(t);
      throw e;
    }
    p.launch = launch;
    launch.ready.then(
      (target) => {
        if (p.state !== "starting") return;
        p.target = target;
        p.state = "ready";
        p.emit({ event: "ready", data: { path: "/" } });
        this.touchPreview(p);
      },
      (e: Error) => void this.end(p, e?.message || "The server could not start.", true),
    );
    launch.exited.then((x) => void this.end(p, x.code === 0 ? "The server stopped." : `The server exited (code ${x.code ?? "?"}${x.signal ? `, ${x.signal}` : ""}).`, false, x));
    return { id: p.id };
  }

  private get(id: string) {
    const p = this.previews.get(id);
    if (!p) throw previewError(404, "NOT_FOUND", "No such preview.");
    return p;
  }

  /** Where to proxy to; 409 while it is still starting, 410 once it has ended. */
  target(id: string): PreviewTarget {
    const p = this.get(id);
    if (p.state === "ended") throw previewError(410, "PREVIEW_ENDED", "This preview has stopped.");
    if (p.state !== "ready" || !p.target) throw previewError(409, "PREVIEW_NOT_READY", "The preview is still starting.");
    this.touchPreview(p);
    return p.target;
  }

  /** A proxied request or WebSocket frame: the preview isn't idle. */
  touch(id: string) {
    const p = this.previews.get(id);
    if (p) this.touchPreview(p);
  }

  private touchPreview(p: Preview) {
    if (p.state !== "ready") return;
    if (p.idle) clearTimeout(p.idle);
    p.idle = setTimeout(() => void this.end(p, `No requests for ${Math.round(this.idleMs / 60_000)} minutes; the preview was stopped.`), this.idleMs);
  }

  private async end(p: Preview, reason: string, isError = true, exit?: { code: number | null; signal: string | null }) {
    if (p.state === "ended") return;
    if (isError) p.emit({ event: "error", data: { message: reason } });
    p.emit({ event: "exit", data: { code: exit?.code ?? null, signal: exit?.signal ?? null, reason } });
    p.state = "ended";
    p.listeners.clear();
    for (const t of p.timers) clearTimeout(t);
    if (p.idle) clearTimeout(p.idle);
    this.live--;
    await p.launch?.stop().catch(() => {});
    const t = setTimeout(() => this.previews.delete(p.id), this.keepMs);
    t.unref?.();
  }

  async remove(id: string) {
    const p = this.get(id);
    await this.end(p, "Stopped.", false);
    this.previews.delete(id);
  }

  subscribe(id: string, res: ServerResponse) {
    const p = this.get(id);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const write = (e: PreviewEvent) => res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    for (const e of p.events) write(e);
    if (p.state === "ended") return void res.end();
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    ping.unref?.();
    const listener = (e: PreviewEvent) => {
      write(e);
      if (e.event === "exit") {
        p.listeners.delete(listener);
        res.end();
      }
    };
    p.listeners.add(listener);
    // Unlike sessions, closing the stream doesn't stop the preview (the iframe keeps using it).
    res.on("close", () => {
      clearInterval(ping);
      p.listeners.delete(listener);
    });
  }

  async closeAll() {
    for (const p of [...this.previews.values()]) await this.end(p, "The judge is shutting down.");
  }
}

// ───────────────────────── the proxy ─────────────────────────

export interface ProxyOptions {
  /** Largest response body passed through (JUDGE_PREVIEW_RESPONSE_MB, 10). */
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  timeoutMs?: number;
}

/** Streams one HTTP request to the preview's server and its answer back, with the header rules above. */
export function proxyHttp(req: IncomingMessage, res: ServerResponse, route: ProxyRoute, target: PreviewTarget, opts: ProxyOptions = {}) {
  const maxRes = opts.maxResponseBytes ?? 10 * 1024 * 1024;
  const maxReq = opts.maxRequestBytes ?? 10 * 1024 * 1024;
  const up = httpRequest({ host: target.host, port: target.port, method: req.method, path: route.upstream, headers: upstreamHeaders(req.headers, target, route.prefix, !route.token) });
  up.setTimeout(opts.timeoutMs ?? 30_000, () => up.destroy(new Error("timeout")));
  up.on("response", (r) => {
    res.writeHead(r.statusCode ?? 502, downstreamHeaders(r.headers, route.prefix, target));
    let size = 0;
    r.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxRes) {
        r.destroy();
        res.destroy();
        return;
      }
      res.write(c);
    });
    r.on("end", () => res.end());
    r.on("error", () => res.destroy());
  });
  up.on("error", (e) => {
    if (res.headersSent) return void res.destroy();
    const text = JSON.stringify({ error: `The preview server did not answer (${e.message}).`, code: "PREVIEW_UPSTREAM" });
    res.writeHead(502, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  });
  let sent = 0;
  req.on("data", (c: Buffer) => {
    sent += c.length;
    if (sent > maxReq) {
      up.destroy(new Error("request body too large"));
      req.destroy();
      return;
    }
    up.write(c);
  });
  req.on("end", () => up.end());
  req.on("error", () => up.destroy());
}

/** WebSocket (and any Upgrade) requests: a raw TCP tunnel after rewriting the request head. */
export function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, route: ProxyRoute, target: PreviewTarget, onActivity: () => void, connectTo: (port: number, host: string) => Socket = (port, host) => connect(port, host)) {
  const headers = upstreamHeaders(req.headers, target, route.prefix, !route.token);
  // Keep the upgrade itself.
  headers.connection = "Upgrade";
  if (req.headers.upgrade) headers.upgrade = req.headers.upgrade;
  const lines = [`${req.method} ${route.upstream} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
  const up = connectTo(target.port, target.host);
  up.on("connect", () => {
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) up.write(head);
    up.on("data", onActivity);
    socket.on("data", onActivity);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => {
    up.destroy();
    socket.destroy();
  };
  up.on("error", close);
  socket.on("error", close);
  up.on("close", close);
  socket.on("close", close);
}

// ───────────────────────── the container launcher ─────────────────────────

export interface LauncherEnv {
  toolchains: Toolchains;
  containers: ContainerSandbox;
  /** JUDGE_PREVIEW_MEMORY_MB (768). */
  memoryMb?: number;
  /** How long a server may take to answer on its port (JUDGE_PREVIEW_READY_S, 120). */
  readyMs?: number;
  /** Server lifetime + margin (the container's own wall clock). */
  lifetimeMs?: number;
}

/** Builds the project in a container box, then starts its serve step on an internal network and waits for the port. */
export function containerLauncher(env: LauncherEnv): Launcher {
  return (req, id, hooks) => {
    const resolved = resolveProject(env.toolchains, { ...(req as ProjectRequest), actions: ["build"], tests: [] });
    const { kind, entry } = resolved;
    const serve = kind.steps.serve;
    if (!serve) throw Object.assign(new RequestError(`${kind.label} has no web server to preview.`), { status: 409, code: "KIND_UNSUPPORTED" });
    const where = placement(env.containers, env, { kind, container: true });
    const tc = where.toolchains;
    const setup = boxSetup(tc, kind);
    const docker = env.containers.docker;
    const network = `tmj-pv-${id}`;
    const ctx: TokenContext = { entry: entry ?? "", files: req.files.map((f) => f.path), mainClass: mainClassOf(entry, req.files), testFilter: testFilterArgs("", null), reportPath: null };
    const exists = (p: string) => req.files.some((f) => f.path === p);
    let box: Box | null = null;
    let db: ServiceHandle | null = null;
    let proc: Proc | null = null;
    let networkMade = false;
    let stopped = false;
    let resolveExit!: (x: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveExit = r));

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      proc?.kill("SIGKILL");
      await proc?.done.catch(() => null);
      await box?.dispose().catch(() => {});
      await db?.dispose().catch(() => {});
      if (networkMade) await docker.removeNetwork(network).catch(() => {});
    };

    const ready = (async (): Promise<PreviewTarget> => {
      await docker.createNetwork({ ...networkBody(network), Labels: { [LABEL]: "preview" } });
      networkMade = true;
      if (stopped) throw new Error("Stopped.");
      db = await startServices({ containers: env.containers }, resolved.services, req.files, network);
      await db?.fresh();
      box = await env.containers.acquire({ mounts: setup.mounts, image: where.image, network });
      for (const f of req.files) await box.write(f.path, f.content);
      for (const f of cacheFiles(kind, setup.mounts, box, req.files)) await box.write(f.path, f.content);
      const steps = (["restore", "build"] as const).map((n) => [n, kind.steps[n]] as const).filter(([, s]) => stepRuns(tc, kind, s, exists));
      if (steps.length) hooks.stage("build");
      for (const [name, s] of steps) {
        if (stopped) throw new Error("Stopped.");
        const limits = buildLimits(kind, name);
        const r = quiet(await box.exec(stepArgv(tc, kind, s!, ctx), { stdin: "", limits, env: { ...setup.env, ...(db?.env ?? {}), ...(s!.env ?? {}) }, cwd: s!.cwd }));
        if (r.status !== "ok" || r.exitCode !== 0) {
          const text = capBytes(stepFailureText(name, r, limits), STDERR_CAP).text;
          if (text) hooks.log("stderr", `${text}\n`);
          throw new Error(`The ${name} step failed.`);
        }
      }
      if (stopped) throw new Error("Stopped.");
      hooks.stage("start");
      const port = serve.port;
      const serveLimits = buildLimits(kind, "serve");
      const limits: Limits = { ...serveLimits, memoryMb: Math.min(serveLimits.memoryMb, env.memoryMb ?? 768), wallS: Math.ceil((env.lifetimeMs ?? 15 * 60_000) / 1000) + 60, outputKb: 1024 };
      proc = box.spawn(stepArgv(tc, kind, serve, ctx), { limits, env: { ...setup.env, ...(db?.env ?? {}), ...(serve.env ?? {}), PORT: String(port), HOST: "0.0.0.0" }, cwd: serve.cwd });
      proc.onStdout((b) => hooks.log("stdout", b.toString("utf8")));
      proc.onStderr((b) => hooks.log("stderr", b.toString("utf8")));
      let ended = false;
      proc.done.then((r) => {
        ended = true;
        resolveExit({ code: r.exitCode, signal: /Killed by (SIG\w+)/.exec(r.message ?? "")?.[1] ?? null });
      });
      const info = await proc.container!;
      if (!info.ip) throw new Error("The server's container has no address on the preview network.");
      const deadline = Date.now() + (env.readyMs ?? 120_000);
      while (!(await portOpen(info.ip, port))) {
        if (ended || stopped) throw new Error("The server stopped before it answered on its port.");
        if (Date.now() > deadline) throw new Error(`The server did not answer on port ${port} within ${Math.round((env.readyMs ?? 120_000) / 1000)} s.`);
        await new Promise((r) => setTimeout(r, 300));
      }
      return { host: info.ip, port };
    })();
    ready.catch(() => {});
    return { ready, exited, stop };
  };
}

function portOpen(host: string, port: number) {
  return new Promise<boolean>((resolve) => {
    const s = connect(port, host);
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1000, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}
