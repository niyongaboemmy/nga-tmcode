import { ExamPackageSchema, type ExamPackage, type TelemetryEvent } from "@tmcode/protocol";

/**
 * Typed client for Task Mentor's /api/tmcode endpoints (docs/PROTOCOL.md).
 * `fetchImpl` is the platform's fetch (Rust-side HTTP on the desktop, so no
 * CORS and a host allow-list; window.fetch in the browser build).
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Extra fields of the error body ({ retry_after_s }, { question_ids }, …). */
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
  /** Network failure (offline, DNS, TLS) rather than a server answer. */
  get offline() {
    return this.status === 0;
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DeviceInfo {
  id: string;
  os: string;
  os_version: string;
  arch: string;
  app_version: string;
}

export interface SessionGrant {
  session_id: string;
  token: string;
  expires_at: string;
  submission_id: number;
}

export interface SnapshotUpload {
  seq: number;
  question_id: number;
  kind: "auto" | "run" | "final" | "offline_final";
  client_ts: string;
  files: { path: string; content: string }[];
  files_hash: string;
  hmac: string;
}

export interface Heartbeat {
  server_time: string;
  deadline: string;
  status: "active" | "superseded" | "revoked" | "ended";
  paused: boolean;
  message: string | null;
}

export interface Results {
  status: "grading" | "hidden" | "released";
  score?: number;
  max_score?: number;
  /** `verdict` (accepted, wrong-answer, time-limit, …) when Task Mentor sends it. */
  questions?: { question_id: number; points: number; max_points: number; tests: { id: string; name?: string; hidden: boolean; passed: boolean; verdict?: string }[] }[];
}

/** One visible test run on Task Mentor (`POST /sessions/:sid/server-run`). */
export interface ServerRunTest {
  id: string;
  verdict: string;
  passed: boolean | null;
  stdout: string;
  stderr: string;
  time_ms: number;
}

/** Plain words for a judge verdict (docs/PROTOCOL.md §3). */
export function verdictLabel(verdict: string | undefined): string | null {
  switch (verdict) {
    case undefined:
    case "":
      return null;
    case "accepted":
    case "ok":
      return "Passed";
    case "wrong-answer":
      return "Wrong answer";
    case "runtime-error":
      return "Crashed (runtime error)";
    case "compile-error":
      return "Did not compile";
    case "time-limit":
      return "Too slow (time limit)";
    case "memory-limit":
      return "Used too much memory";
    case "output-limit":
      return "Printed too much";
    case "internal-error":
      return "Task Mentor could not run it";
    default:
      return verdict.replace(/[-_]/g, " ");
  }
}

/** "0.9.2" < "0.10.0" (numeric parts; anything after "-" or "+" is ignored). */
export function versionLess(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/** Cuts a long task title at a word boundary: "Write a function that…". */
export function shortTitle(title: string, max = 60): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** Hosts a deep link may point TMCode at (a crafted link must not reach a fake server). */
export const ALLOWED_APIS = ["https://taskmentor-api.amashuri.com"];

export function isAllowedApi(api: string, dev: boolean) {
  const base = api.replace(/\/+$/, "");
  return ALLOWED_APIS.includes(base) || (dev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base));
}

export class TmApi {
  token: string | null = null;
  sid: string | null = null;

  constructor(
    private base: string,
    private fetchImpl: FetchLike,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/tmcode${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(0, "OFFLINE", `Can't reach Task Mentor (${(e as Error)?.message ?? e}).`);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const d = (data ?? {}) as { error_code?: string; message?: string } & Record<string, unknown>;
      const retry = Number(res.headers?.get?.("Retry-After") ?? res.headers?.get?.("RateLimit-Reset"));
      if (d.retry_after_s === undefined && Number.isFinite(retry) && retry > 0) d.retry_after_s = retry;
      throw new ApiError(res.status, d.error_code ?? `HTTP_${res.status}`, d.message ?? `Task Mentor answered ${res.status}.`, d);
    }
    return data as T;
  }

  /**
   * "Is Task Mentor reachable, and what time is it there?" Any HTTP answer
   * counts as reachable; the time comes from `{ server_time }` if sent, else
   * the Date header of `GET /profiles` (no auth). Throws ApiError OFFLINE when there is no answer.
   */
  async ping(timeoutMs = 8_000): Promise<{ ms: number; serverTime: number | null }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(`${this.base}/api/tmcode/profiles`, { method: "GET", headers: { Accept: "application/json" }, signal: ctrl.signal });
      const ms = Date.now() - t0;
      let serverTime: number | null = null;
      try {
        const d = JSON.parse(await res.text()) as { server_time?: string };
        if (d?.server_time) serverTime = Date.parse(d.server_time);
      } catch {
        /* not JSON */
      }
      if (serverTime === null || Number.isNaN(serverTime)) {
        const date = res.headers?.get?.("Date");
        serverTime = date ? Date.parse(date) : null;
        if (serverTime !== null && Number.isNaN(serverTime)) serverTime = null;
      }
      // Half the round trip: the server stamped its time about then.
      return { ms, serverTime: serverTime === null ? null : serverTime + ms / 2 };
    } catch (e) {
      throw new ApiError(0, "OFFLINE", `Can't reach Task Mentor (${(e as Error)?.message ?? e}).`);
    } finally {
      clearTimeout(timer);
    }
  }

  async redeem(ticket: string, device: DeviceInfo, envReport: unknown): Promise<SessionGrant> {
    const g = await this.call<SessionGrant>("POST", "/sessions", { ticket, device, env_report: envReport });
    this.token = g.token;
    this.sid = g.session_id;
    return g;
  }

  /**
   * The exam package. An exam this TMCode can't read (a newer package format,
   * or `min_app_version` above this app) is APP_TOO_OLD, never a schema dump.
   */
  async examPackage(appVersion?: string): Promise<ExamPackage> {
    const raw = await this.call<Record<string, unknown> | null>("GET", `/sessions/${this.sid}/package`);
    const min = typeof raw?.min_app_version === "string" ? raw.min_app_version : null;
    if (min && appVersion && versionLess(appVersion, min)) {
      throw new ApiError(200, "APP_TOO_OLD", `This exam needs TMCode ${min} or newer.`, { min_app_version: min });
    }
    const parsed = ExamPackageSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new ApiError(200, "APP_TOO_OLD", "TMCode is out of date for this exam.", { detail });
    }
    return parsed.data;
  }

  snapshot(s: SnapshotUpload) {
    return this.call<{ accepted_seq: number; server_ts: string }>("POST", `/sessions/${this.sid}/snapshots`, s, 30_000);
  }

  telemetry(seq: number, events: TelemetryEvent[]) {
    return this.call<{ ok: boolean }>("POST", `/sessions/${this.sid}/telemetry`, { seq, events });
  }

  heartbeat(body: { synced_seq: number; current_question: number | null; focus: "in" | "out" }) {
    return this.call<Heartbeat>("POST", `/sessions/${this.sid}/heartbeat`, body, 10_000);
  }

  serverRun(question_id: number, files: { path: string; content: string }[]) {
    return this.call<{ tests: ServerRunTest[] }>(
      "POST",
      `/sessions/${this.sid}/server-run`,
      { question_id, files },
      60_000,
    );
  }

  submit(final: { question_id: number; seq: number }[]) {
    return this.call<{ status: string }>("POST", `/sessions/${this.sid}/submit`, { final }, 30_000);
  }

  results() {
    return this.call<Results>("GET", `/sessions/${this.sid}/results`);
  }
}
