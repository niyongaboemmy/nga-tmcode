import { createHmac } from "node:crypto";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  downstreamHeaders,
  PREVIEW_CSP,
  PreviewManager,
  proxyHttp,
  proxyRoute,
  proxyUpgrade,
  rewriteLocation,
  rewriteSetCookie,
  signPreviewToken,
  upstreamHeaders,
  verifyPreviewToken,
  type Launcher,
  type PreviewEvent,
  type PreviewTarget,
} from "./previews.ts";

/** Server previews: tokens, proxy rewriting, limits and timeouts (no Docker: a fake launcher and a local upstream). */

const SECRET = "s".repeat(40);
const ID = "3f2b8c1e-0d4a-4e8b-9c55-1a2b3c4d5e6f";

describe("preview tokens", () => {
  it("matches what Task Mentor mints: <exp>.<base64url HMAC-SHA256(secret, id.exp)>", () => {
    const exp = 1_900_000_000;
    const sig = createHmac("sha256", SECRET).update(`${ID}.${exp}`).digest("base64url");
    expect(signPreviewToken(ID, exp, SECRET)).toBe(`${exp}.${sig}`);
    expect(sig).not.toMatch(/=/);
  });

  it("accepts a valid token until it expires", () => {
    const t = signPreviewToken(ID, 1000, SECRET);
    expect(verifyPreviewToken(ID, t, SECRET, 999)).toEqual({ ok: true });
    expect(verifyPreviewToken(ID, t, SECRET, 1000)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses tampering: another id, another expiry, another secret, junk", () => {
    const t = signPreviewToken(ID, 2000, SECRET);
    expect(verifyPreviewToken("other-id", t, SECRET, 1)).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyPreviewToken(ID, t.replace(/^2000/, "2999"), SECRET, 1)).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyPreviewToken(ID, t, "x".repeat(40), 1)).toEqual({ ok: false, reason: "bad-signature" });
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(verifyPreviewToken(ID, flipped, SECRET, 1).ok).toBe(false);
    expect(verifyPreviewToken(ID, "abc", SECRET, 1)).toEqual({ ok: false, reason: "malformed" });
    expect(verifyPreviewToken(ID, t, "", 1)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("proxy paths and headers", () => {
  const token = signPreviewToken(ID, 2_000_000_000, SECRET);
  const target = { host: "172.30.0.5", port: 3000 };

  it("maps the public and the bearer paths to the upstream path", () => {
    expect(proxyRoute(`/p/${ID}/${token}/api/users?page=2`)).toEqual({ id: ID, token, prefix: `/p/${ID}/${token}`, upstream: "/api/users?page=2", needsSlash: false });
    expect(proxyRoute(`/p/${ID}/${token}/`)).toMatchObject({ upstream: "/", needsSlash: false });
    expect(proxyRoute(`/p/${ID}/${token}`)).toMatchObject({ upstream: "/", needsSlash: true });
    expect(proxyRoute(`/v1/previews/${ID}/http/style.css`)).toEqual({ id: ID, prefix: `/v1/previews/${ID}/http`, upstream: "/style.css", needsSlash: false });
    expect(proxyRoute(`/v1/previews/${ID}/http?x=1`)).toMatchObject({ upstream: "/?x=1", needsSlash: true });
    expect(proxyRoute(`/v1/previews/${ID}/events`)).toBeNull();
    expect(proxyRoute("/v1/run")).toBeNull();
  });

  it("keeps redirects under the prefix", () => {
    const prefix = `/p/${ID}/${token}`;
    expect(rewriteLocation("/login", prefix, target)).toBe(`${prefix}/login`);
    expect(rewriteLocation("http://localhost:3000/a?b=1", prefix, target)).toBe(`${prefix}/a?b=1`);
    expect(rewriteLocation("http://172.30.0.5:3000", prefix, target)).toBe(`${prefix}/`);
    expect(rewriteLocation("next", prefix, target)).toBe("next");
    expect(rewriteLocation("https://example.org/x", prefix, target)).toBe("https://example.org/x");
    expect(rewriteLocation("//evil.example/x", prefix, target)).toBe("//evil.example/x");
  });

  it("strips cookie domains and scopes cookie paths to the preview", () => {
    expect(rewriteSetCookie("sid=abc; Domain=example.org; Path=/; HttpOnly; SameSite=Lax", "/p/i/t")).toBe("sid=abc; HttpOnly; SameSite=Lax; Path=/p/i/t/");
    expect(rewriteSetCookie("a=1", "/p/i/t")).toBe("a=1; Path=/p/i/t/");
    expect(rewriteSetCookie("a=1; path=/admin", "/p/i/t")).toBe("a=1; Path=/p/i/t/admin");
  });

  it("adds the sandbox CSP, drops frame blocking and hop-by-hop headers", () => {
    const h = downstreamHeaders(
      { "content-type": "text/html", "x-frame-options": "DENY", connection: "keep-alive", "transfer-encoding": "chunked", "set-cookie": ["a=1; Domain=x.org"], location: "/home" },
      "/p/i/t",
      target,
    );
    expect(h["content-security-policy"]).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).toBe("sandbox allow-scripts allow-forms allow-modals allow-popups allow-same-origin");
    expect(h["x-frame-options"]).toBeUndefined();
    expect(h.connection).toBeUndefined();
    expect(h["transfer-encoding"]).toBeUndefined();
    expect(h["set-cookie"]).toEqual(["a=1; Path=/p/i/t/"]);
    expect(h.location).toBe("/p/i/t/home");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(downstreamHeaders({ "content-security-policy": "default-src 'self'" }, "/p", target)["content-security-policy"]).toEqual(["default-src 'self'", PREVIEW_CSP]);
  });

  it("never forwards the judge's bearer token upstream", () => {
    const h = upstreamHeaders({ host: "judge:5010", authorization: "Bearer secret", cookie: "a=1", connection: "close" }, target, "/v1/previews/x/http", true);
    expect(h.authorization).toBeUndefined();
    expect(h.connection).toBeUndefined();
    expect(h.host).toBe("localhost:3000");
    expect(h.cookie).toBe("a=1");
    expect(h["x-forwarded-prefix"]).toBe("/v1/previews/x/http");
    // The public path may carry the app's own Authorization (basic auth in a student app).
    expect(upstreamHeaders({ authorization: "Basic eA==" }, target, "/p/i/t", false).authorization).toBe("Basic eA==");
  });
});

/** A launcher whose server becomes ready when the test says so. */
function fakeLauncher() {
  const launches: { id: string; ready: (t: PreviewTarget) => void; fail: (e: Error) => void; exit: (code: number) => void; stopped: boolean; log: (s: "stdout" | "stderr", d: string) => void }[] = [];
  const launcher: Launcher = (_req, id, hooks) => {
    let ready!: (t: PreviewTarget) => void;
    let fail!: (e: Error) => void;
    let exit!: (code: number) => void;
    const l = { id, ready: (t: PreviewTarget) => ready(t), fail: (e: Error) => fail(e), exit: (c: number) => exit(c), stopped: false, log: hooks.log };
    launches.push(l);
    hooks.stage("build");
    return {
      ready: new Promise<PreviewTarget>((res, rej) => {
        ready = res;
        fail = rej;
      }),
      exited: new Promise((res) => (exit = (code) => res({ code, signal: null }))),
      stop: async () => {
        l.stopped = true;
      },
    };
  };
  return { launcher, launches };
}

function sse(m: PreviewManager, id: string) {
  const events: PreviewEvent[] = [];
  let closed = false;
  const res = {
    writeHead() {},
    write(chunk: string) {
      const x = /^event: (\w+)\ndata: (.*)\n\n$/s.exec(chunk);
      if (x) events.push({ event: x[1], data: JSON.parse(x[2]) } as PreviewEvent);
      return true;
    },
    end() {
      closed = true;
    },
    on() {},
  };
  m.subscribe(id, res as unknown as ServerResponse);
  return { events, closed: () => closed };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("preview limits and timeouts", () => {
  afterEach(() => vi.useRealTimers());
  const body = { kind: "js/express", files: [{ path: "server.js", content: "" }] };

  it("allows JUDGE_PREVIEWS at a time, then 429", () => {
    const { launcher } = fakeLauncher();
    const m = new PreviewManager(launcher, { max: 2 });
    m.create(body);
    m.create(body);
    expect(() => m.create(body)).toThrow(expect.objectContaining({ status: 429, code: "BUSY" }));
    expect(m.running).toBe(2);
  });

  it("streams stage, log and ready, and proxies only once ready", async () => {
    const { launcher, launches } = fakeLauncher();
    const m = new PreviewManager(launcher);
    const { id } = m.create(body);
    const s = sse(m, id);
    expect(() => m.target(id)).toThrow(expect.objectContaining({ status: 409, code: "PREVIEW_NOT_READY" }));
    launches[0].log("stdout", "listening on 3000\n");
    launches[0].ready({ host: "172.30.0.9", port: 3000 });
    await tick();
    expect(s.events.map((e) => e.event)).toEqual(["stage", "log", "ready"]);
    expect(s.events[2].data).toEqual({ path: "/" });
    expect(m.target(id)).toEqual({ host: "172.30.0.9", port: 3000 });
    await m.remove(id);
    expect(launches[0].stopped).toBe(true);
    expect(m.running).toBe(0);
    expect(() => m.target(id)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("stops an idle preview after 5 minutes and any preview after 15", async () => {
    vi.useFakeTimers();
    const { launcher, launches } = fakeLauncher();
    const m = new PreviewManager(launcher, { keepMs: 3_600_000 });
    const a = m.create(body).id;
    const b = m.create(body).id;
    launches[0].ready({ host: "h", port: 1 });
    launches[1].ready({ host: "h", port: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const sa = sse(m, a);
    // a: requests keep it alive past the idle limit; b: nobody uses it.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      m.touch(a);
    }
    expect(launches[1].stopped).toBe(true);
    expect(() => m.target(b)).toThrow(expect.objectContaining({ status: 410 }));
    expect(launches[0].stopped).toBe(false);
    // ...but not past the 15-minute lifetime.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(60_000);
      m.touch(a);
    }
    expect(launches[0].stopped).toBe(true);
    expect(sa.events.at(-2)).toEqual({ event: "error", data: { message: "The preview reached its 15-minute limit." } });
    expect(sa.events.at(-1)?.event).toBe("exit");
    expect(sa.closed()).toBe(true);
    expect(m.running).toBe(0);
  });

  it("reports a server that fails to start or exits", async () => {
    const { launcher, launches } = fakeLauncher();
    const m = new PreviewManager(launcher);
    const a = m.create(body).id;
    const s = sse(m, a);
    launches[0].log("stderr", "SyntaxError: Unexpected token\n");
    launches[0].fail(new Error("The build step failed."));
    await tick();
    expect(s.events.map((e) => e.event)).toEqual(["stage", "log", "error", "exit"]);
    const b = m.create(body).id;
    launches[1].ready({ host: "h", port: 1 });
    await tick();
    const sb = sse(m, b);
    launches[1].exit(1);
    await tick();
    expect(sb.events.at(-1)).toEqual({ event: "exit", data: { code: 1, signal: null, reason: "The server exited (code 1)." } });
  });

  it("caps the replayed log", () => {
    const { launcher, launches } = fakeLauncher();
    const m = new PreviewManager(launcher, { logBytes: 10 });
    const { id } = m.create(body);
    launches[0].log("stdout", "0123456789ABCDEF");
    launches[0].log("stdout", "more");
    const s = sse(m, id);
    expect(s.events.filter((e) => e.event === "log").map((e) => (e.data as { data: string }).data)).toEqual(["0123456789", "\n[tm-judge] log output truncated\n"]);
  });
});

describe("the proxy against a real upstream", () => {
  let upstream: Server;
  let front: Server;
  let target: PreviewTarget;
  let frontPort: number;
  const token = signPreviewToken(ID, 2_000_000_000, SECRET);

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        return res.end(Buffer.alloc(64 * 1024));
      }
      if (req.url === "/go") {
        res.writeHead(302, { Location: "/home", "Set-Cookie": "sid=1; Domain=evil.org; Path=/" });
        return res.end();
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json", "X-Frame-Options": "DENY" });
        res.end(JSON.stringify({ url: req.url, method: req.method, host: req.headers.host, auth: req.headers.authorization ?? null, body }));
      });
    });
    upstream.on("upgrade", (req, socket) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Path: ${req.url}\r\n\r\n`);
      socket.on("data", (d) => socket.write(`echo:${d}`));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    target = { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port };
    front = createServer((req, res) => {
      const route = proxyRoute(req.url ?? "")!;
      proxyHttp(req, res, route, target, { maxResponseBytes: 32 * 1024 });
    });
    front.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, proxyRoute(req.url ?? "")!, target, () => {}));
    await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
    frontPort = (front.address() as AddressInfo).port;
  });
  afterAll(() => {
    front.close();
    upstream.close();
  });

  const call = (path: string, opts: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string; aborted: boolean }>((resolve) => {
      const req = request({ host: "127.0.0.1", port: frontPort, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
        let b = "";
        let aborted = false;
        res.on("data", (c) => (b += c));
        res.on("aborted", () => (aborted = true));
        res.on("error", () => (aborted = true));
        res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, aborted: aborted || !res.complete }));
      });
      req.on("error", () => resolve({ status: 0, headers: {}, body: "", aborted: true }));
      req.end(opts.body);
    });

  it("forwards method, path and body, and rewrites the answer's headers", async () => {
    const r = await call(`/p/${ID}/${token}/api/items?x=1`, { method: "POST", body: "hello" });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ url: "/api/items?x=1", method: "POST", host: `localhost:${target.port}`, auth: null, body: "hello" });
    expect(r.headers["content-security-policy"]).toBe(PREVIEW_CSP);
    expect(r.headers["x-frame-options"]).toBeUndefined();
  });

  it("strips the bearer on the private path", async () => {
    const r = await call(`/v1/previews/${ID}/http/`, { headers: { Authorization: "Bearer judge-token" } });
    expect(JSON.parse(r.body).auth).toBeNull();
  });

  it("rewrites redirects and cookies", async () => {
    const r = await call(`/p/${ID}/${token}/go`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(`/p/${ID}/${token}/home`);
    expect(r.headers["set-cookie"]).toEqual([`sid=1; Path=/p/${ID}/${token}/`]);
  });

  it("cuts responses over the size cap", async () => {
    const r = await call(`/p/${ID}/${token}/big`);
    expect(r.aborted).toBe(true);
    expect(r.body.length).toBeLessThan(64 * 1024);
  });

  it("tunnels WebSocket upgrades with the path rewritten", async () => {
    const { connect } = await import("node:net");
    const s = connect(frontPort, "127.0.0.1");
    const got = await new Promise<string>((resolve) => {
      let buf = "";
      s.on("connect", () => s.write(`GET /p/${ID}/${token}/ws?room=1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
      s.on("data", (d) => {
        buf += d;
        if (buf.includes("\r\n\r\n") && !buf.includes("echo:")) s.write("ping");
        if (buf.includes("echo:ping")) resolve(buf);
      });
    });
    s.destroy();
    expect(got).toMatch(/^HTTP\/1\.1 101/);
    expect(got).toMatch(/X-Path: \/ws\?room=1/);
  });
});
