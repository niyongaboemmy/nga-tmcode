import { create } from "zustand";
import { getPlatform, notify, openEditorInput, useWorkbench } from "../state/store";
import type { ApiResponse } from "../platform/types";
import { useRunHub } from "../run/runHub";
import { exampleUrl, findRoutes, ROUTE_FILE, type Route } from "./routes";

/**
 * The API Tester: requests to the student's running server (or any API),
 * the routes their code declares, and a short history per folder.
 */

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];

export interface Draft {
  method: Method;
  url: string;
  headers: [string, string][];
  body: string;
}

export interface HistoryItem extends Draft {
  at: number;
  status: number | null;
  ms: number | null;
}

interface ApiState {
  draft: Draft;
  response: ApiResponse | null;
  error: string | null;
  sending: boolean;
  routes: Route[] | null;
  history: HistoryItem[];
}

const DEFAULT_HEADERS: [string, string][] = [
  ["Content-Type", "application/json"],
  ["Accept", "application/json"],
];

export const useApi = create<ApiState>(() => ({
  draft: { method: "GET", url: "", headers: DEFAULT_HEADERS, body: "" },
  response: null,
  error: null,
  sending: false,
  routes: null,
  history: [],
}));
const set = useApi.setState;
const get = useApi.getState;

const historyKey = () => `api.history:${useWorkbench.getState().workspace?.root ?? ""}`;

/** The running dev server's origin, else a usual one for the project. */
export function baseUrl(): string {
  const url = useRunHub.getState().session?.url;
  if (url) {
    try {
      return new URL(url).origin;
    } catch {
      /* fall through */
    }
  }
  const port = useRunHub.getState().projects.flatMap((p) => p.actions).find((a) => a.kind === "devServer" && a.port)?.port;
  return `http://localhost:${port ?? 3000}`;
}

export function setDraft(patch: Partial<Draft>) {
  set({ draft: { ...get().draft, ...patch } });
}

export async function openApiTester() {
  if (!get().draft.url) setDraft({ url: `${baseUrl()}/` });
  openEditorInput({ kind: "api", id: "api", preview: false }, { toSide: false });
  const saved = await getPlatform().store.get<HistoryItem[]>(historyKey()).catch(() => undefined);
  if (saved) set({ history: saved });
  void scanRoutes();
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".dart_tool", ".tmcode"]);

export async function scanRoutes() {
  const fs = getPlatform().fs;
  const out: Route[] = [];
  let files = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || files > 400) return;
    const entries = await fs.readDir(dir).catch(() => []);
    for (const e of entries) {
      if (e.kind === "dir") {
        if (!SKIP.has(e.name) && !e.name.startsWith(".")) await walk(e.path, depth + 1);
      } else if (ROUTE_FILE.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        files++;
        const text = await fs.readFile(e.path).catch(() => "");
        if (text.length < 300_000) out.push(...findRoutes(e.path, text));
      }
    }
  };
  if (useWorkbench.getState().workspace) await walk("", 0);
  set({ routes: out });
}

export async function send() {
  const host = getPlatform().http;
  const d = get().draft;
  if (!host) return notify("info", "The API Tester needs the TMCode desktop app.");
  let url = d.url.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url.replace(/^\/+/, "")}`;
  const withBody = !["GET", "HEAD"].includes(d.method);
  if (withBody && d.body.trim() && d.headers.some(([k, v]) => /^content-type$/i.test(k) && /json/i.test(v))) {
    try {
      JSON.parse(d.body);
    } catch (e) {
      set({ error: `The body isn't valid JSON: ${(e as Error).message}`, response: null });
      return;
    }
  }
  set({ sending: true, error: null });
  try {
    const response = await host.request({ method: d.method, url, headers: d.headers.filter(([k]) => k.trim()), body: withBody ? d.body : null });
    set({ response, sending: false });
    remember({ ...d, url, at: Date.now(), status: response.status, ms: response.ms });
  } catch (e) {
    set({ error: String((e as Error)?.message ?? e), response: null, sending: false });
    remember({ ...d, url, at: Date.now(), status: null, ms: null });
  }
}

function remember(item: HistoryItem) {
  const history = [item, ...get().history.filter((h) => !(h.method === item.method && h.url === item.url && h.body === item.body))].slice(0, 30);
  set({ history });
  void getPlatform().store.set(historyKey(), history).catch(() => {});
}

/** Fills the request from a route of the project (path parameters get an example value). */
export function applyRoute(r: Route) {
  const method = (r.method === "ANY" ? "GET" : r.method) as Method;
  setDraft({ method, url: `${baseUrl()}${exampleUrl(r.path)}`, body: method === "POST" || method === "PUT" || method === "PATCH" ? get().draft.body || "{\n  \n}" : get().draft.body });
}
