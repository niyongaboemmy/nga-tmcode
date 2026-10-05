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
  questions?: { question_id: number; points: number; max_points: number; tests: { id: string; name?: string; hidden: boolean; passed: boolean }[] }[];
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
      const d = (data ?? {}) as { error_code?: string; message?: string };
      throw new ApiError(res.status, d.error_code ?? `HTTP_${res.status}`, d.message ?? `Task Mentor answered ${res.status}.`);
    }
    return data as T;
  }

  async redeem(ticket: string, device: DeviceInfo, envReport: unknown): Promise<SessionGrant> {
    const g = await this.call<SessionGrant>("POST", "/sessions", { ticket, device, env_report: envReport });
    this.token = g.token;
    this.sid = g.session_id;
    return g;
  }

  async examPackage(): Promise<ExamPackage> {
    return ExamPackageSchema.parse(await this.call("GET", `/sessions/${this.sid}/package`));
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
    return this.call<{ tests: { id: string; verdict: string; passed: boolean | null; stdout: string; stderr: string; time_ms: number }[] }>(
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
