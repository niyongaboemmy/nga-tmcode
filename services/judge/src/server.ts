import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { languageVersions, RequestError, resolvePrograms } from "./judge.ts";
import { DEFAULT_BUDGET_S } from "./project.ts";
import { run, type JudgeEnv } from "./run.ts";
import { SessionManager } from "./sessions.ts";
import { IsolateSandbox, isolateAvailable, LocalSandbox, type Sandbox } from "./sandbox.ts";
import { catalogView, detectView, probeVersions, resolveToolchains, type DetectFile, type Toolchains } from "./toolchains.ts";
import { containerConfig, ContainerSandbox, databasesUsable, offStatus, probeContainers, type ContainerConfig } from "./containers.ts";
import { Docker, unixTransport } from "./docker.ts";
import { containerLauncher, PreviewManager, proxyHttp, proxyRoute, proxyUpgrade, verifyPreviewToken } from "./previews.ts";

/**
 * tm-judge HTTP API (private: loopback + bearer token). docs/PROTOCOL.md §5.
 *   GET  /v1/health   → { ok, sandbox, languages: { id: version|null }, catalog, runtimes, caches, queue }
 *   GET  /v1/catalog  → the Runtime Catalog filtered to the kinds this runner can run
 *   POST /v1/detect   → { files: [{ path, content? }] } → ranked kinds + entries
 *   POST /v1/run      → RunResponse (language profile, judge.ts) or ProjectResponse (kind, project.ts)
 *
 * Env: JUDGE_TOKEN (required), JUDGE_PORT (5010), JUDGE_HOST (127.0.0.1),
 * JUDGE_CONCURRENCY (2), JUDGE_QUEUE (100), JUDGE_SANDBOX (isolate|none),
 * ISOLATE_BIN (isolate), JUDGE_FIRST_BOX (0), JUDGE_TOOLCHAINS (JSON tool
 * overrides), JUDGE_CACHES (JSON cache layer folders), JUDGE_TOOL_LOOKUP
 * (1: fall back to PATH), JUDGE_RUN_BUDGET_S (120).
 *
 * Tier 3 (docs/PROTOCOL.md §5.7–§5.9), off unless JUDGE_CONTAINERS=1:
 * JUDGE_CONTAINER_RUNTIME (runsc; runc only with JUDGE_ALLOW_RUNC=1),
 * JUDGE_CONTAINER_WORKDIR, JUDGE_CONTAINER_CONCURRENCY (2), JUDGE_CONTAINER_CPUS (1),
 * JUDGE_CONTAINER_MEMORY_MB (1536), JUDGE_CONTAINER_IMAGES (JSON), JUDGE_PREVIEWS (4),
 * JUDGE_PREVIEW_SECRET (32+ chars; previews are off without it), JUDGE_PREVIEW_MEMORY_MB (768),
 * JUDGE_PREVIEW_TTL_S (900), JUDGE_PREVIEW_IDLE_S (300), JUDGE_PREVIEW_RESPONSE_MB (10).
 */

const env = process.env;
const TOKEN = env.JUDGE_TOKEN ?? "";
const PORT = Number(env.JUDGE_PORT ?? 5010);
const HOST = env.JUDGE_HOST ?? "127.0.0.1";
const CONCURRENCY = Math.max(1, Number(env.JUDGE_CONCURRENCY ?? 2));
const QUEUE = Number(env.JUDGE_QUEUE ?? 100);
const SESSIONS = Math.max(1, Number(env.JUDGE_SESSIONS ?? 4));
/** What every runner supports; Task Mentor shows the live terminal only when "sessions" is listed. */
export const BASE_FEATURES = ["run", "projects", "catalog", "detect", "checkers", "sessions"];
const PREVIEWS = Math.max(1, Number(env.JUDGE_PREVIEWS ?? 4));
const PREVIEW_SECRET = env.JUDGE_PREVIEW_SECRET ?? "";

/**
 * Tier-3 features, listed only when usable: Docker reachable, the runtime
 * registered, the images built (and, for previews, a preview secret).
 */
export function tierFeatures(tc: Toolchains, previewSecret: string): string[] {
  const t = tc.containers;
  if (!t?.status.usable) return [];
  const out = ["containers", "pty"];
  if (previewSecret.length >= 32 && catalogView(tc).kinds.some((k) => k.steps.serve)) out.push("previews");
  const db = databasesUsable(t);
  if (db.postgres || db.mysql) out.push("databases");
  return out;
}
const MAX_BODY = 2 * 1024 * 1024;
const BUDGET_S = Math.min(Math.max(Number(env.JUDGE_RUN_BUDGET_S ?? DEFAULT_BUDGET_S), 10), 600);

/** Interactive sessions get their own box range (after the batch boxes). */
export async function createSessionSandbox(batch: Sandbox): Promise<Sandbox> {
  if (batch.kind === "none") return new LocalSandbox();
  return new IsolateSandbox(env.ISOLATE_BIN ?? "isolate", SESSIONS, Number(env.JUDGE_SESSION_FIRST_BOX ?? Number(env.JUDGE_FIRST_BOX ?? 0) + Math.max(CONCURRENCY, 16)));
}

export async function createSandbox(): Promise<Sandbox> {
  const mode = env.JUDGE_SANDBOX ?? "isolate";
  if (mode === "none") {
    if (env.NODE_ENV === "production") throw new Error("JUDGE_SANDBOX=none is refused in production: student code would run unsandboxed.");
    console.warn("[tm-judge] WARNING: running WITHOUT a sandbox (development only).");
    return new LocalSandbox();
  }
  const bin = env.ISOLATE_BIN ?? "isolate";
  if (!(await isolateAvailable(bin))) throw new Error(`isolate not found ('${bin}'). Install it or set JUDGE_SANDBOX=none for development.`);
  return new IsolateSandbox(bin, CONCURRENCY, Number(env.JUDGE_FIRST_BOX ?? 0));
}

function authorised(req: IncomingMessage) {
  const got = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && want.length > 0 && timingSafeEqual(got, want);
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text), ...headers });
  res.end(text);
}

function send204(res: ServerResponse) {
  res.writeHead(204);
  res.end();
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new RequestError("Request body is larger than 2 MB.");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestError("Body must be JSON.");
  }
}

/** Tier 3: reads the settings (refusing unsafe ones), asks Docker what it has, sweeps leftovers. */
async function setupContainers(toolchains: Toolchains): Promise<{ cfg: ContainerConfig; sandbox?: ContainerSandbox; reprobe: () => Promise<void> }> {
  const cfg = containerConfig(env);
  toolchains.containers = { config: cfg, status: offStatus(cfg, "containers are off on this runner (JUDGE_CONTAINERS is not 1)") };
  if (!cfg.enabled) return { cfg, reprobe: async () => {} };
  const docker = new Docker(unixTransport(cfg.socket));
  const sandbox = new ContainerSandbox(docker, cfg);
  const reprobe = async () => {
    toolchains.containers = { config: cfg, status: await probeContainers(docker, cfg) };
  };
  await reprobe();
  if (toolchains.containers.status.reachable) await sandbox.sweep();
  return { cfg, sandbox, reprobe };
}

export async function start() {
  if (!TOKEN || TOKEN.length < 24) throw new Error("JUDGE_TOKEN must be set (24+ characters).");
  if (PREVIEW_SECRET && PREVIEW_SECRET.length < 32) throw new Error("JUDGE_PREVIEW_SECRET must be 32+ characters (or unset: no previews).");
  const sandbox = await createSandbox();
  const programs = resolvePrograms();
  const versions = languageVersions(programs);
  const toolchains = resolveToolchains({ overrides: env.JUDGE_TOOLCHAINS, caches: env.JUDGE_CACHES, lookup: env.JUDGE_TOOL_LOOKUP !== "0" });
  probeVersions(toolchains);
  const tier = await setupContainers(toolchains);
  let catalog = catalogView(toolchains);
  let features = [...BASE_FEATURES, ...tierFeatures(toolchains, PREVIEW_SECRET)];
  // Images built (or Docker restarted) after start-up show up without a judge restart.
  if (tier.cfg.enabled) {
    const t = setInterval(async () => {
      await tier.reprobe().catch(() => {});
      catalog = catalogView(toolchains);
      features = [...BASE_FEATURES, ...tierFeatures(toolchains, PREVIEW_SECRET)];
    }, Math.max(30, Number(env.JUDGE_CONTAINER_PROBE_S ?? 300)) * 1000);
    t.unref();
  }
  const judgeEnv: JudgeEnv = { programs, toolchains, budgetS: BUDGET_S, containers: tier.sandbox };
  const sessions = new SessionManager(
    await createSessionSandbox(sandbox),
    programs,
    toolchains,
    {
      max: SESSIONS,
      wallMs: Number(env.JUDGE_SESSION_WALL_S ?? 600) * 1000,
      idleMs: Number(env.JUDGE_SESSION_IDLE_S ?? 120) * 1000,
    },
    tier.sandbox,
  );
  const previewTtlMs = Number(env.JUDGE_PREVIEW_TTL_S ?? 900) * 1000;
  const previews = new PreviewManager(
    tier.sandbox
      ? containerLauncher({ toolchains, containers: tier.sandbox, memoryMb: Number(env.JUDGE_PREVIEW_MEMORY_MB ?? 768), readyMs: Number(env.JUDGE_PREVIEW_READY_S ?? 120) * 1000, lifetimeMs: previewTtlMs })
      : () => {
          throw Object.assign(new RequestError("This runner has no container tier: previews are off."), { status: 409, code: "PREVIEWS_UNAVAILABLE" });
        },
    { max: PREVIEWS, lifetimeMs: previewTtlMs, idleMs: Number(env.JUDGE_PREVIEW_IDLE_S ?? 300) * 1000 },
  );
  const proxyOpts = { maxResponseBytes: Number(env.JUDGE_PREVIEW_RESPONSE_MB ?? 10) * 1024 * 1024 };
  /** The preview a proxy URL points at, after the token check on the public path. */
  const previewFor = (url: string) => {
    const route = proxyRoute(url);
    if (!route) return null;
    if (route.token !== undefined) {
      const check = verifyPreviewToken(route.id, route.token, PREVIEW_SECRET);
      if (!check.ok) throw Object.assign(new RequestError(check.reason === "expired" ? "This preview link has expired." : "Invalid preview link."), { status: 403, code: "PREVIEW_TOKEN" });
    }
    return route;
  };
  let running = 0;
  let waiting = 0;
  const slots: (() => void)[] = [];
  const acquire = async () => {
    if (running < CONCURRENCY) {
      running++;
      return;
    }
    waiting++;
    await new Promise<void>((r) => slots.push(r));
    waiting--;
    running++;
  };
  const release = () => {
    running--;
    slots.shift()?.();
  };

  const server = createServer(async (req, res) => {
    const started = Date.now();
    try {
      // Public preview path: signed token instead of the bearer (served from the preview origin).
      if ((req.url ?? "").startsWith("/p/")) {
        const route = previewFor(req.url ?? "");
        if (!route) return send(res, 404, { error: "not found", code: "NOT_FOUND" });
        if (route.needsSlash) {
          res.writeHead(308, { Location: `${route.token ? encodeURIComponent(route.token) : "http"}/`, "Content-Length": 0 });
          return res.end();
        }
        return proxyHttp(req, res, route, previews.target(route.id), proxyOpts);
      }
      if (!authorised(req)) return send(res, 401, { error: "unauthorised" });
      if (req.method === "GET" && req.url === "/v1/health") {
        return send(res, 200, {
          ok: true,
          sandbox: sandbox.kind,
          languages: versions,
          features,
          catalog: toolchains.version,
          runtimes: Object.fromEntries(catalog.runtimes.map((r) => [r.id, r.healthy ? r.version ?? "unknown" : null])),
          caches: catalog.caches,
          queue: { running, waiting, concurrency: CONCURRENCY },
          sessions: { running: sessions.running, max: sessions.max },
          containers: containerSummary(toolchains),
          previews: { running: previews.running, max: previews.max },
        });
      }
      if (req.method === "GET" && req.url === "/v1/catalog") return send(res, 200, catalog);
      const route = proxyRoute(req.url ?? "");
      if (route && route.token === undefined) {
        if (route.needsSlash) {
          res.writeHead(308, { Location: "http/", "Content-Length": 0 });
          return res.end();
        }
        return proxyHttp(req, res, route, previews.target(route.id), proxyOpts);
      }
      const pm = /^\/v1\/previews(?:\/([\w-]{1,64})(?:\/(events))?)?\/?$/.exec((req.url ?? "").split("?")[0]);
      if (pm) {
        const [, id, action] = pm;
        if (!id && req.method === "POST") return send(res, 201, previews.create(await readJson(req)));
        if (id && !action && req.method === "DELETE") {
          await previews.remove(id);
          return send204(res);
        }
        if (id && action === "events" && req.method === "GET") return previews.subscribe(id, res);
        return send(res, 405, { error: "method not allowed", code: "METHOD_NOT_ALLOWED" });
      }
      const sm = /^\/v1\/sessions(?:\/([\w-]{1,64})(?:\/(events|stdin|eof|signal|resize))?)?\/?$/.exec((req.url ?? "").split("?")[0]);
      if (sm) {
        const [, id, action] = sm;
        if (!id && req.method === "POST") return send(res, 201, sessions.create(await readJson(req)));
        if (id && !action && req.method === "DELETE") {
          await sessions.remove(id);
          return send204(res);
        }
        if (id && action === "events" && req.method === "GET") return sessions.subscribe(id, res);
        if (id && action === "stdin" && req.method === "POST") {
          sessions.stdin(id, await readJson(req));
          return send204(res);
        }
        if (id && action === "eof" && req.method === "POST") {
          sessions.eof(id);
          return send204(res);
        }
        if (id && action === "signal" && req.method === "POST") {
          sessions.signal(id, await readJson(req));
          return send204(res);
        }
        if (id && action === "resize" && req.method === "POST") {
          sessions.resize(id, await readJson(req));
          return send204(res);
        }
        return send(res, 405, { error: "method not allowed", code: "METHOD_NOT_ALLOWED" });
      }
      if (req.method === "POST" && req.url === "/v1/detect") {
        const body = (await readJson(req)) as { files?: DetectFile[]; language?: string };
        if (!Array.isArray(body?.files) || body.files.some((f) => !f || typeof f.path !== "string")) throw new RequestError("files must be a list of { path, content? }.");
        if (body.files.length > 2000) throw new RequestError("At most 2000 files.");
        return send(res, 200, detectView(toolchains, body.files, { language: body.language }));
      }
      if (req.method === "POST" && req.url === "/v1/run") {
        if (waiting >= QUEUE) return send(res, 503, { error: "The judge is busy. Try again shortly.", code: "BUSY" }, { "Retry-After": "5" });
        const body = (await readJson(req)) as Record<string, unknown>;
        await acquire();
        try {
          const result = await run(sandbox, judgeEnv, body);
          const what = "kind" in result ? `${result.kind} [${result.actions.join(",")}]` : result.language;
          const unit = "unit" in result && result.unit ? ` unit=${result.unit.passed}/${result.unit.total}` : "";
          console.log(`[tm-judge] ${what} tests=${result.tests.length} ${result.tests.map((t) => t.verdict[0]).join("")}${unit} ${Date.now() - started}ms`);
          return send(res, 200, result);
        } finally {
          release();
        }
      }
      send(res, 404, { error: "not found", code: "NOT_FOUND" });
    } catch (e) {
      const status = e instanceof RequestError ? (e as RequestError).status : 500;
      const code = e instanceof RequestError ? (e as RequestError).code : "INTERNAL";
      if (status === 500) console.error("[tm-judge]", e);
      send(res, status, { error: e instanceof Error ? e.message : String(e), code });
    }
  });
  // Project runs: up to JUDGE_RUN_BUDGET_S of steps, plus queueing and box setup.
  server.requestTimeout = (BUDGET_S + 60) * 1000;
  server.on("close", () => {
    void sessions.closeAll();
    void previews.closeAll();
  });
  // WebSockets to previews (both proxy paths).
  server.on("upgrade", (req, socket, head) => {
    try {
      const url = req.url ?? "";
      const route = previewFor(url);
      if (!route || route.needsSlash || (route.token === undefined && !authorised(req))) throw new Error("refused");
      proxyUpgrade(req, socket, head, route, previews.target(route.id), () => previews.touch(route.id));
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((r) => server.listen(PORT, HOST, r));
  console.log(`[tm-judge] listening on ${HOST}:${PORT}; sandbox=${sandbox.kind}; concurrency=${CONCURRENCY}; languages=${JSON.stringify(versions)}`);
  const ct = toolchains.containers?.status;
  console.log(`[tm-judge] containers: ${ct?.usable ? `on (${ct.runtime}, ${Object.values(ct.images).filter(Boolean).length} images)` : `off (${ct?.reason})`}; features ${features.join(",")}`);
  console.log(`[tm-judge] catalog ${toolchains.version}: ${catalog.kinds.length} kinds runnable (${catalog.kinds.map((k) => k.id).join(", ")}); caches ${JSON.stringify(catalog.caches)}`);
  return server;
}


/** GET /v1/health `containers`. */
export function containerSummary(tc: Toolchains) {
  const t = tc.containers;
  if (!t) return { enabled: false, usable: false, runtime: null, reason: "containers are off on this runner", images: {} };
  const s = t.status;
  return { enabled: s.enabled, usable: s.usable, runtime: s.runtime, runtime_registered: s.runtime_registered, arch: s.arch, reason: s.reason, images: s.images };
}
