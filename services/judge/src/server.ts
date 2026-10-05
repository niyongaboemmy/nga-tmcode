import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { judge, languageVersions, RequestError, resolvePrograms, type RunRequest } from "./judge.ts";
import { IsolateSandbox, isolateAvailable, LocalSandbox, type Sandbox } from "./sandbox.ts";

/**
 * tm-judge HTTP API (private: loopback + bearer token).
 *   GET  /v1/health  → { ok, sandbox, languages: { id: version|null }, queue }
 *   POST /v1/run     → RunResponse (see judge.ts)
 *
 * Env: JUDGE_TOKEN (required), JUDGE_PORT (5010), JUDGE_HOST (127.0.0.1),
 * JUDGE_CONCURRENCY (2), JUDGE_QUEUE (100), JUDGE_SANDBOX (isolate|none),
 * ISOLATE_BIN (isolate), JUDGE_FIRST_BOX (0).
 */

const env = process.env;
const TOKEN = env.JUDGE_TOKEN ?? "";
const PORT = Number(env.JUDGE_PORT ?? 5010);
const HOST = env.JUDGE_HOST ?? "127.0.0.1";
const CONCURRENCY = Math.max(1, Number(env.JUDGE_CONCURRENCY ?? 2));
const QUEUE = Number(env.JUDGE_QUEUE ?? 100);
const MAX_BODY = 2 * 1024 * 1024;

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

function send(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
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
        return send(res, 200, { ok: true, sandbox: sandbox.kind, languages: versions, queue: { running, waiting, concurrency: CONCURRENCY } });
      }
      if (req.method === "POST" && req.url === "/v1/run") {
        if (waiting >= QUEUE) return send(res, 503, { error: "The judge is busy. Try again shortly." });
        const body = (await readJson(req)) as RunRequest;
        await acquire();
        try {
          const result = await judge(sandbox, programs, body);
          console.log(`[tm-judge] ${body.language} tests=${body.tests.length} ${result.tests.map((t) => t.verdict[0]).join("")} ${Date.now() - started}ms`);
          return send(res, 200, result);
        } finally {
          release();
        }
      }
      send(res, 404, { error: "not found" });
    } catch (e) {
      const status = e instanceof RequestError ? (e as RequestError).status : 500;
      if (status === 500) console.error("[tm-judge]", e);
      send(res, status, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((r) => server.listen(PORT, HOST, r));
  console.log(`[tm-judge] listening on ${HOST}:${PORT}; sandbox=${sandbox.kind}; concurrency=${CONCURRENCY}; languages=${JSON.stringify(versions)}`);
  return server;
}

