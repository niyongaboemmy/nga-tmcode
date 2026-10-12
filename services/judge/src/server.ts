import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { languageVersions, RequestError, resolvePrograms } from "./judge.ts";
import { DEFAULT_BUDGET_S } from "./project.ts";
import { run, type JudgeEnv } from "./run.ts";
import { IsolateSandbox, isolateAvailable, LocalSandbox, type Sandbox } from "./sandbox.ts";
import { catalogView, detectView, probeVersions, resolveToolchains, type DetectFile } from "./toolchains.ts";

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
 */

const env = process.env;
const TOKEN = env.JUDGE_TOKEN ?? "";
const PORT = Number(env.JUDGE_PORT ?? 5010);
const HOST = env.JUDGE_HOST ?? "127.0.0.1";
const CONCURRENCY = Math.max(1, Number(env.JUDGE_CONCURRENCY ?? 2));
const QUEUE = Number(env.JUDGE_QUEUE ?? 100);
const MAX_BODY = 2 * 1024 * 1024;
const BUDGET_S = Math.min(Math.max(Number(env.JUDGE_RUN_BUDGET_S ?? DEFAULT_BUDGET_S), 10), 600);

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

export async function start() {
  if (!TOKEN || TOKEN.length < 24) throw new Error("JUDGE_TOKEN must be set (24+ characters).");
  const sandbox = await createSandbox();
  const programs = resolvePrograms();
  const versions = languageVersions(programs);
  const toolchains = resolveToolchains({ overrides: env.JUDGE_TOOLCHAINS, caches: env.JUDGE_CACHES, lookup: env.JUDGE_TOOL_LOOKUP !== "0" });
  probeVersions(toolchains);
  const catalog = catalogView(toolchains);
  const judgeEnv: JudgeEnv = { programs, toolchains, budgetS: BUDGET_S };
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
      if (!authorised(req)) return send(res, 401, { error: "unauthorised" });
      if (req.method === "GET" && req.url === "/v1/health") {
        return send(res, 200, {
          ok: true,
          sandbox: sandbox.kind,
          languages: versions,
          catalog: toolchains.version,
          runtimes: Object.fromEntries(catalog.runtimes.map((r) => [r.id, r.healthy ? r.version ?? "unknown" : null])),
          caches: catalog.caches,
          queue: { running, waiting, concurrency: CONCURRENCY },
        });
      }
      if (req.method === "GET" && req.url === "/v1/catalog") return send(res, 200, catalog);
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
  await new Promise<void>((r) => server.listen(PORT, HOST, r));
  console.log(`[tm-judge] listening on ${HOST}:${PORT}; sandbox=${sandbox.kind}; concurrency=${CONCURRENCY}; languages=${JSON.stringify(versions)}`);
  console.log(`[tm-judge] catalog ${toolchains.version}: ${catalog.kinds.length} kinds runnable (${catalog.kinds.map((k) => k.id).join(", ")}); caches ${JSON.stringify(catalog.caches)}`);
  return server;
}

