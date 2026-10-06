import { RpcConnection, activationEventsOf, type ExtensionDescription, type InitData, type RpcMessage, type TextEditDTO } from "@tmcode/exthost";
import { monaco, setupMonaco } from "../monaco/setup";
import { getPlatform, log, notify, useWorkbench } from "../state/store";
import { activeExtensions, extensionsBlocked, useExtensions, type InstalledExtension } from "../extensions/service";
import { useExam } from "../exam/state";
import type { ExtensionManifest } from "../extensions/manifest";
import { documentSnapshot, editorSnapshot, wireDocumentSync } from "./documentSync";
import { wireWorkbenchDiagnostics, workbenchDiagnosticsSnapshot } from "./workbenchDiagnostics";
import { disposeProviders, editApplier, setHostLink, textEdits } from "./languageBridge";
import { willSaveParticipants } from "../monaco/documents";
import { applyWorkspaceEdit, clearDiagnosticsOf, installMainThread, type MainContext } from "./mainThread";
import { builtinDefaults, loadExtensionSettings, onConfigurationChanged, useExtConfig } from "./config";
import { applyCodeContributions, contributedCommand } from "./contributions";
import { clearAllDecorations } from "./decorations";
import { HOST_CHANNEL } from "./output";
import { useExtHost, useExtStatusBar, type HostKind, type RuntimeInfo } from "./state";

/**
 * Starts, stops and restarts the extension hosts:
 * - Node.js (desktop, `platform.extensions.startNodeHost`) for extensions with
 *   a `main` entry point;
 * - a Web Worker for extensions that only have a `browser` entry point (and,
 *   in the browser build, for every extension that has one).
 * A host that crashes is restarted (up to 3 times in 5 minutes, then the user
 * is asked). Hosts never run while extensions are blocked (exams, any
 * non-practice policy); the Rust side refuses too.
 */

interface Conn {
  kind: HostKind;
  rpc: RpcConnection;
  extensions: InstalledExtension[];
  ctx: MainContext;
  /** Notifications may flow (after $init was sent). */
  live: boolean;
  stopping: boolean;
  stop(): void;
}

const conns = new Map<HostKind, Conn>();
const crashes: number[] = [];
let startSeq = 0;
let wired = false;
let globalState: Record<string, Record<string, unknown>> = {};
let workspaceState: Record<string, Record<string, unknown>> = {};
let stateTimer: ReturnType<typeof setTimeout> | null = null;
let machineId = "";
const sessionId = Math.random().toString(16).slice(2) + Date.now().toString(16);

function broadcast(method: string, params: unknown[]) {
  for (const c of conns.values()) if (c.live) c.rpc.notify(method, params);
}

/** Which host would run this extension here, or why none can. */
export function hostFor(m: ExtensionManifest): { host: HostKind } | { reason: string } {
  const nodeHost = !!getPlatform().extensions?.startNodeHost;
  if (m.main && nodeHost) return { host: "node" };
  if (m.browser) return { host: "worker" };
  if (m.main) return { reason: "This extension needs Node.js, which only the TMCode desktop app provides." };
  return { reason: "This extension has no code to run." };
}

function codeExtensions(): { node: InstalledExtension[]; worker: InstalledExtension[]; cannotRun: Record<string, string> } {
  const out = { node: [] as InstalledExtension[], worker: [] as InstalledExtension[], cannotRun: {} as Record<string, string> };
  for (const e of activeExtensions()) {
    if (!e.manifest.hasCode) continue;
    const h = hostFor(e.manifest);
    if ("host" in h) out[h.host].push(e);
    else out.cannotRun[e.id] = h.reason;
  }
  return out;
}

function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

const wsKey = () => `exthost.state.ws:${useWorkbench.getState().workspace?.root ?? ""}`;

async function loadState() {
  const store = getPlatform().store;
  globalState = (await store.get<typeof globalState>("exthost.state.global").catch(() => undefined)) ?? {};
  workspaceState = useWorkbench.getState().workspace ? ((await store.get<typeof workspaceState>(wsKey()).catch(() => undefined)) ?? {}) : {};
  machineId = (await store.get<string>("exthost.machineId").catch(() => undefined)) ?? "";
  if (!machineId) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    machineId = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await store.set("exthost.machineId", machineId).catch(() => {});
  }
}

function persistState(scope: "global" | "workspace", extensionId: string, key: string, value: unknown) {
  const target = scope === "global" ? globalState : workspaceState;
  const bag = (target[extensionId] ??= {});
  if (value === null || value === undefined) delete bag[key];
  else bag[key] = value;
  if (stateTimer) clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    const store = getPlatform().store;
    void store.set("exthost.state.global", globalState).catch(() => {});
    if (useWorkbench.getState().workspace) void store.set(wsKey(), workspaceState).catch(() => {});
  }, 300);
}

function joinPath(dir: string, name: string) {
  const sep = getPlatform().os === "windows" ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

function describe(kind: HostKind, ext: InstalledExtension, extensionsDir?: string): ExtensionDescription {
  const m = ext.manifest;
  return {
    id: ext.id,
    name: m.name,
    publisher: m.publisher,
    displayName: m.displayName,
    version: m.version,
    location: kind === "node" ? joinPath(extensionsDir ?? "", ext.id) : ext.id,
    entry: (kind === "node" ? m.main : m.browser) ?? "",
    activationEvents: activationEventsOf(m.raw),
    manifest: m.raw,
  };
}

function initData(kind: HostKind, exts: InstalledExtension[], dirs?: { extensionsDir: string; storageDir: string }): InitData {
  setupMonaco();
  const p = getPlatform();
  const s = useWorkbench.getState();
  const snap = editorSnapshot();
  return {
    hostKind: kind,
    extensions: exts.map((e) => describe(kind, e, dirs?.extensionsDir)),
    workspace: s.workspace ? { name: s.workspace.name, root: s.workspace.root } : null,
    configuration: { defaults: builtinDefaults(), user: useExtConfig.getState().user },
    state: { global: structuredClone(globalState), workspace: structuredClone(workspaceState) },
    env: {
      appName: "TMCode",
      appRoot: "",
      appHost: p.kind === "desktop" ? "desktop" : "web",
      language: "en",
      machineId,
      sessionId,
      uiKind: p.kind === "desktop" ? 1 : 2,
      shell: p.os === "windows" ? "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" : p.os === "mac" ? "/bin/zsh" : "/bin/bash",
      version: p.version,
      storagePath: dirs?.storageDir,
      workspaceKey: s.workspace ? hashString(s.workspace.root) : undefined,
      os: p.os,
    },
    documents: documentSnapshot(),
    editors: snap.editors,
    activeEditor: snap.active,
    languages: monaco.languages.getLanguages().map((l) => l.id),
  };
}

function setRuntime(kind: HostKind, exts: InstalledExtension[]) {
  useExtHost.setState((st) => {
    const runtime: Record<string, RuntimeInfo> = {};
    for (const [id, r] of Object.entries(st.runtime)) if (r.host !== kind) runtime[id] = r;
    for (const e of exts) runtime[e.id] = { id: e.id, host: kind, unsupported: [] };
    return { runtime };
  });
}

function cleanup(kind: HostKind) {
  disposeProviders(kind);
  clearDiagnosticsOf(kind);
  setHostLink(null, kind);
  useExtStatusBar.setState((s) => ({ items: Object.fromEntries(Object.entries(s.items).filter(([, v]) => v.host !== kind)) }));
  const c = conns.get(kind);
  c?.ctx.commands.forEach((d) => d());
  c?.ctx.commands.clear();
}

/** Runs an extension command in the host that owns it (activating the extension first). */
export async function executeExtensionCommand(id: string, args: unknown[] = []): Promise<unknown> {
  if (extensionsBlocked()) {
    notify("warning", "Extensions are disabled during exams.");
    return;
  }
  const owner = contributedCommand(id)?.extensionId;
  const find = () => (owner ? [...conns.values()].find((c) => c.extensions.some((e) => e.id === owner)) : [...conns.values()].find((c) => c.ctx.commands.has(id)));
  let conn = find();
  if (!conn && owner) {
    const reason = useExtHost.getState().cannotRun[owner];
    if (reason) {
      notify("warning", `Command '${contributedCommand(id)?.title ?? id}' cannot run: ${reason}`);
      return;
    }
    await startExtensionHosts();
    conn = find();
  }
  if (!conn) {
    notify("error", `command '${id}' not found`);
    return;
  }
  try {
    return await conn.rpc.request("$executeCommand", [id, args]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    notify("error", `Running the contributed command: '${id}' failed. ${msg}`);
    log(HOST_CHANNEL, `Command '${id}' failed: ${msg}`, "error");
  }
}

function makeContext(kind: HostKind, rpc: RpcConnection): MainContext {
  return { kind, rpc, runCommand: (id, args) => executeExtensionCommand(id, args), commands: new Map(), persistState };
}

async function startNode(exts: InstalledExtension[], seq: number): Promise<void> {
  let rpc: RpcConnection | null = null;
  let conn: Conn | null = null;
  const proc = await getPlatform().extensions!.startNodeHost!((e) => {
    if (e.type === "message") rpc?.handleMessage(e.message);
    else if (e.type === "stderr") {
      for (const line of e.data.split("\n")) if (line.trim()) log(HOST_CHANNEL, line.replace(/^\[(info|warn|error)\] /, ""), line.startsWith("[error]") ? "error" : line.startsWith("[warn]") ? "warn" : "info");
    } else if (e.type === "exit") onExit("node", conn, e.code);
  });
  if (seq !== startSeq || extensionsBlocked()) {
    proc.stop();
    return;
  }
  rpc = new RpcConnection((m: RpcMessage) => proc.send(JSON.stringify(m)));
  conn = { kind: "node", rpc, extensions: exts, ctx: makeContext("node", rpc), live: false, stopping: false, stop: () => proc.stop() };
  await connect(conn, initData("node", exts, proc), `Node.js ${proc.nodeVersion} (${proc.node})`);
}

async function startWorker(exts: InstalledExtension[], seq: number): Promise<void> {
  const { default: HostWorker } = await import("@tmcode/exthost/src/worker/main.ts?worker");
  if (seq !== startSeq || extensionsBlocked()) return;
  const worker: Worker = new HostWorker();
  const rpc = new RpcConnection((m: RpcMessage) => worker.postMessage(m));
  const conn: Conn = { kind: "worker", rpc, extensions: exts, ctx: makeContext("worker", rpc), live: false, stopping: false, stop: () => worker.terminate() };
  worker.onmessage = (e) => rpc.handleMessage(e.data as RpcMessage);
  worker.onerror = (e) => {
    log(HOST_CHANNEL, `Web Worker extension host error: ${e.message}`, "error");
    e.preventDefault();
  };
  await connect(conn, initData("worker", exts), null);
}

async function connect(conn: Conn, data: InitData, nodeInfo: string | null) {
  conns.set(conn.kind, conn);
  installMainThread(conn.ctx);
  setHostLink({ kind: conn.kind, request: (m, p, t) => conn.rpc.request(m, p, t), notify: (m, p) => conn.rpc.notify(m, p) }, conn.kind);
  setRuntime(conn.kind, conn.extensions);
  const init = conn.rpc.request("$init", [data]);
  // Changes after this snapshot reach the host in order, after $init.
  conn.live = true;
  await init;
  if (extensionsBlocked()) return;
  if (nodeInfo) useExtHost.setState({ nodeInfo });
  log(HOST_CHANNEL, `Started the ${conn.kind === "node" ? "Node.js" : "Web Worker"} extension host${nodeInfo ? ` (${nodeInfo})` : ""} for ${conn.extensions.map((e) => e.id).join(", ")}`);
  // The workbench's own problems so far (later changes stream through wireWorkbenchDiagnostics).
  conn.rpc.notify("$workbenchDiagnostics", [workbenchDiagnosticsSnapshot()]);
  // Activation runs in the background; the UI follows $main.extensionState.
  void conn.rpc.request("$startup", []).catch((e) => log(HOST_CHANNEL, `Startup activation failed: ${String((e as Error)?.message ?? e)}`, "error"));
}

function onExit(kind: HostKind, conn: Conn | null, code: number | null) {
  if (!conn || conns.get(kind) !== conn) return;
  conn.rpc.close("The extension host stopped");
  cleanup(kind);
  conns.delete(kind);
  if (conn.stopping) return;
  // Crashed: mark its extensions and restart (bounded).
  log(HOST_CHANNEL, `The ${kind === "node" ? "Node.js" : "Web Worker"} extension host terminated unexpectedly (code ${code ?? "?"}).`, "error");
  useExtHost.setState((st) => ({ runtime: Object.fromEntries(Object.entries(st.runtime).map(([id, r]) => [id, r.host === kind ? { ...r, state: "failed" as const, error: "The extension host terminated unexpectedly." } : r])) }));
  const now = Date.now();
  crashes.push(now);
  while (crashes.length && now - crashes[0] > 5 * 60_000) crashes.shift();
  if (crashes.length <= 3) {
    useExtHost.setState({ status: "starting" });
    setTimeout(() => void startExtensionHosts(), 1000);
  } else {
    useExtHost.setState({ status: "crashed", message: "The extension host terminated unexpectedly 3 times within the last 5 minutes." });
    notify("error", "Extension host terminated unexpectedly 3 times within the last 5 minutes.", [{ label: "Restart Extension Host", run: () => void restartExtensionHosts(true) }]);
  }
}

let starting: Promise<void> | null = null;

/** Starts the hosts the enabled extensions need (a no-op for hosts already running). */
export function startExtensionHosts(): Promise<void> {
  if (!starting) starting = doStart().finally(() => (starting = null));
  return starting;
}

async function doStart() {
  const { node, worker, cannotRun } = codeExtensions();
  applyCodeContributions(extensionsBlocked() ? [] : [...node, ...worker], (id, args) => void executeExtensionCommand(id, args ?? []));
  useExtHost.setState({ cannotRun });
  if (extensionsBlocked()) {
    useExtHost.setState({ status: "stopped", message: "Extensions are disabled during exams." });
    return;
  }
  if (!node.length && !worker.length) {
    useExtHost.setState({ status: "stopped", message: null });
    return;
  }
  const seq = startSeq;
  useExtHost.setState({ status: "starting", message: null });
  await Promise.all([loadState(), useExtConfig.getState().loaded ? null : loadExtensionSettings()]);
  if (seq !== startSeq || extensionsBlocked()) return;
  wireOnce();
  getPlatform().extensions?.setHostPolicy?.(true);
  const jobs: Promise<void>[] = [];
  if (node.length && !conns.has("node")) jobs.push(startNode(node, seq));
  if (worker.length && !conns.has("worker")) jobs.push(startWorker(worker, seq));
  const results = await Promise.allSettled(jobs);
  if (seq !== startSeq) return;
  if (extensionsBlocked()) {
    // An exam began while the hosts were starting.
    await stopExtensionHosts(false);
    return;
  }
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    const msg = String((failed.reason as Error)?.message ?? failed.reason);
    log(HOST_CHANNEL, `Could not start the extension host: ${msg}`, "error");
    const next = { ...cannotRun };
    if (!conns.has("node")) for (const e of node) next[e.id] = msg;
    if (!conns.has("worker")) for (const e of worker) next[e.id] = msg;
    useExtHost.setState({ status: conns.size ? "running" : "stopped", message: msg, cannotRun: next });
    notify("warning", `Extensions that run code could not start: ${msg}`);
    return;
  }
  useExtHost.setState((st) => ({ status: "running", generation: st.generation + 1 }));
}

/** Stops every host (asking extensions to deactivate first when `graceful`). */
export async function stopExtensionHosts(graceful = true) {
  startSeq++;
  await Promise.all(
    [...conns.values()].map(async (c) => {
      c.stopping = true;
      if (graceful) await Promise.race([c.rpc.request("$deactivate", []).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
      c.rpc.close();
      c.stop();
      cleanup(c.kind);
      conns.delete(c.kind);
    }),
  );
  clearAllDecorations();
  useExtHost.setState((st) => ({ status: "stopped", runtime: Object.fromEntries(Object.entries(st.runtime).map(([id, r]) => [id, { ...r, state: undefined, activationTime: undefined, error: undefined }])) }));
}

/** "Developer: Restart Extension Host". */
export async function restartExtensionHosts(resetCrashes = false) {
  if (resetCrashes) crashes.length = 0;
  await stopExtensionHosts();
  await startExtensionHosts();
}

/** The code extensions that would run now (and the folder), as a comparable key. */
function codeKey(): string {
  if (extensionsBlocked()) return "blocked";
  const { node, worker } = codeExtensions();
  return [...node.map((e) => `n:${e.id}@${e.version}`), ...worker.map((e) => `w:${e.id}@${e.version}`)].sort().join(",") + `|${useWorkbench.getState().workspace?.root ?? ""}`;
}

let lastKey = "";
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconcile() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    const key = codeKey();
    if (key === "blocked") {
      lastKey = key;
      // Exams: no extension code at all, on either side.
      getPlatform().extensions?.setHostPolicy?.(false);
      void stopExtensionHosts(false).then(() => {
        applyCodeContributions([], () => {});
        useExtHost.setState({ message: "Extensions are disabled during exams." });
      });
      return;
    }
    if (key === lastKey) return;
    lastKey = key;
    // An extension with code was installed, enabled or removed, or another folder opened: restart, as VS Code reloads.
    void restartExtensionHosts();
  }, 300);
}

function wireOnce() {
  if (wired) return;
  wired = true;
  wireDocumentSync(broadcast);
  wireWorkbenchDiagnostics(broadcast);
  editApplier.apply = applyWorkspaceEdit;
  onConfigurationChanged(({ user, defaults, keys }) => {
    broadcast("$defaultsChanged", [defaults]);
    broadcast("$configurationChanged", [user, keys]);
  });
}

let initialised = false;
/** Called once by the workbench after the installed extensions were loaded. */
export function initExtensionHost() {
  if (initialised) return;
  initialised = true;
  lastKey = codeKey();
  void loadExtensionSettings();
  void startExtensionHosts();
  useExtensions.subscribe((s, prev) => {
    if (s.version !== prev.version) scheduleReconcile();
  });
  useExam.subscribe(() => {
    // Exams lock extensions down at once (no debounce), on both sides.
    if (extensionsBlocked() && (conns.size || starting)) {
      getPlatform().extensions?.setHostPolicy?.(false);
      void stopExtensionHosts(false);
      applyCodeContributions([], () => {});
    }
    scheduleReconcile();
  });
  useWorkbench.subscribe((s, prev) => {
    if (s.policy !== prev.policy || s.workspace?.root !== prev.workspace?.root) scheduleReconcile();
  });
}

/** onWillSaveTextDocument: each running host may return edits before TMCode writes the file. */
willSaveParticipants.push(async (path, model) => {
  for (const c of conns.values()) {
    if (!c.live) continue;
    const edits = (await Promise.race([c.rpc.request("$willSaveTextDocument", [path, 1]).catch(() => []), new Promise((r) => setTimeout(() => r([]), 2000))])) as TextEditDTO[];
    if (edits?.length) model.pushEditOperations([], textEdits(edits).map((e) => ({ range: e.range, text: e.text })), () => null);
  }
});

export function runningHosts(): HostKind[] {
  return [...conns.keys()];
}
