import { monaco } from "../monaco/setup";
import { getPlatform, log, notify, notifyProgress, onWorkspaceChanged, useWorkbench } from "../state/store";
import { beginActivity } from "../state/activity";
import type { LanguageServerConnection, LanguageServerHost } from "../platform/types";
import { LanguageClient } from "./client";
import { downloadAllowed, pyrightSettings, serverAllowed, serverFor, type ServerSpec } from "./manifest";

/**
 * Starts the built-in language server for a language the first time one of
 * its files opens (Pyright for Python), offers the one-time download, and
 * stops servers when the folder changes or an exam policy forbids them.
 */

interface Running {
  spec: ServerSpec;
  client: LanguageClient;
  conn: LanguageServerConnection;
  root: string;
  /** Set when TMCode stopped it (no restart). */
  stopping: boolean;
}

const running = new Map<string, Running>();
const starting = new Map<string, Promise<void>>();
/** Servers the student said "Not now" to in this session. */
const declined = new Set<string>();
/** Recent crashes per server (restart at most 3 times in 5 minutes, like the extension host). */
const crashes = new Map<string, number[]>();
let wired = false;

const STORE_DECLINED = "lsp.neverAsk";

function host(): LanguageServerHost | null {
  try {
    return getPlatform().languageServers ?? null;
  } catch {
    return null;
  }
}

function hasModelFor(spec: ServerSpec) {
  return monaco.editor.getModels().some((m) => m.uri.scheme === "tmcode" && spec.languages.includes(m.getLanguageId()));
}

/** A file of `languageId` is open: make sure its server runs (or is offered). */
export function ensureServerFor(languageId: string) {
  const spec = serverFor(languageId);
  const h = host();
  if (!spec || !h) return;
  const { policy, workspace } = useWorkbench.getState();
  if (!workspace || !serverAllowed(policy)) return;
  if (running.has(spec.id) || starting.has(spec.id)) return;
  const p = startServer(spec, h, workspace.root).finally(() => starting.delete(spec.id));
  starting.set(spec.id, p);
}

async function startServer(spec: ServerSpec, h: LanguageServerHost, root: string) {
  const probe = await h.probe(spec.id).catch((e) => ({ available: false, install: null, detail: null, message: String((e as Error)?.message ?? e), python: null }));
  if (!probe.available) {
    const policy = useWorkbench.getState().policy;
    if (probe.install && downloadAllowed(policy) && !declined.has(spec.id)) {
      const never = ((await getPlatform().store.get<string[]>(STORE_DECLINED).catch(() => undefined)) ?? []).includes(spec.id);
      if (!never) offerDownload(spec, h);
    } else if (probe.message) log(spec.label, probe.message);
    return;
  }
  if (useWorkbench.getState().workspace?.root !== root) return;
  const end = beginActivity(`Starting ${spec.label}…`);
  try {
    let client: LanguageClient | null = null;
    const pendingMessages: string[] = [];
    const conn = await h.start(spec.id, (e) => {
      if (e.type === "message") {
        if (client) client.receive(e.message);
        else pendingMessages.push(e.message);
      } else if (e.type === "stderr") log(spec.label, e.data.replace(/\n$/, ""));
      else onExit(spec, e.code);
    });
    client = new LanguageClient({ id: spec.id, label: spec.label, languages: spec.languages, root, settings: spec.id === "pyright" ? pyrightSettings(probe.python) : {} }, { send: (t) => conn.send(t) });
    pendingMessages.splice(0).forEach((m) => client!.receive(m));
    running.set(spec.id, { spec, client, conn, root, stopping: false });
    await client.start();
    log(spec.label, `${probe.detail ?? spec.label} is running.`);
  } catch (e) {
    const r = running.get(spec.id);
    running.delete(spec.id);
    r?.conn.stop();
    log(spec.label, `Could not start: ${String((e as Error)?.message ?? e)}`, "error");
  } finally {
    end();
  }
}

function onExit(spec: ServerSpec, code: number | null) {
  const r = running.get(spec.id);
  if (!r) return;
  running.delete(spec.id);
  void r.client.dispose({ graceful: false });
  if (r.stopping) return;
  log(spec.label, `The server stopped (exit code ${code ?? "?"}).`, "warn");
  const now = Date.now();
  const recent = (crashes.get(spec.id) ?? []).filter((t) => now - t < 5 * 60_000);
  recent.push(now);
  crashes.set(spec.id, recent);
  if (recent.length <= 3) {
    if (hasModelFor(spec)) ensureServerFor(spec.languages[0]);
    return;
  }
  notify("warning", `${spec.label} stopped several times. Python IntelliSense is off until you reopen the folder.`);
}

function offerDownload(spec: ServerSpec, h: LanguageServerHost) {
  const id = notify("info", spec.offer, [
    { label: "Download", run: () => void download(spec, h) },
    { label: "Not now", run: () => void declined.add(spec.id) },
    {
      label: "Don't ask again",
      run: () => {
        declined.add(spec.id);
        void (async () => {
          const list = (await getPlatform().store.get<string[]>(STORE_DECLINED).catch(() => undefined)) ?? [];
          await getPlatform().store.set(STORE_DECLINED, [...new Set([...list, spec.id])]);
        })().catch(() => {});
      },
    },
  ]);
  return id;
}

async function download(spec: ServerSpec, h: LanguageServerHost) {
  const progress = notifyProgress(`Downloading ${spec.label}…`);
  try {
    await h.install(spec.id, (e) => {
      if (e.type === "progress" && e.total) progress.update({ progress: Math.round((e.downloaded / e.total) * 100) });
    });
    progress.close();
    notify("info", `${spec.label} is ready.`);
    if (hasModelFor(spec)) ensureServerFor(spec.languages[0]);
  } catch (e) {
    progress.close();
    notify("error", `Could not download ${spec.label}: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Stops every built-in server (folder changed, policy forbids them). */
export function stopLanguageServers() {
  for (const r of running.values()) {
    r.stopping = true;
    void r.client.dispose().finally(() => r.conn.stop());
  }
  running.clear();
}

/** Whether a built-in server serves `languageId` right now (status, tests). */
export function languageServerRunning(languageId: string) {
  const spec = serverFor(languageId);
  return !!spec && running.has(spec.id);
}

/** Connects servers to workbench events. Idempotent. */
export function wireLanguageServers() {
  if (wired) return;
  wired = true;
  const check = (m: monaco.editor.ITextModel) => {
    if (m.uri.scheme === "tmcode") ensureServerFor(m.getLanguageId());
  };
  monaco.editor.onDidCreateModel(check);
  monaco.editor.onDidChangeModelLanguage((e) => check(e.model));
  monaco.editor.getModels().forEach(check);
  onWorkspaceChanged(() => {
    stopLanguageServers();
    crashes.clear();
  });
  let lastAllowed = serverAllowed(useWorkbench.getState().policy);
  host()?.setExamPolicy?.(lastAllowed);
  useWorkbench.subscribe((s, prev) => {
    if (s.policy === prev.policy) return;
    const allowed = serverAllowed(s.policy);
    host()?.setExamPolicy?.(allowed);
    if (allowed === lastAllowed) return;
    lastAllowed = allowed;
    if (!allowed) stopLanguageServers();
    else monaco.editor.getModels().forEach(check);
  });
}
