import { create } from "zustand";
import type { IconDTO, ViewMetaDTO, WebviewCreateDTO, WebviewOptionsDTO } from "@tmcode/exthost";
import { getCommand, executeCommand as runWorkbenchCommand } from "../../commands/registry";
import { closeEditors, getPlatform, log, notify, openEditorInput, useWorkbench, activateEditor, type EditorInput } from "../../state/store";
import { useThemes } from "../../themes/themeService";
import { HOST_CHANNEL } from "../output";
import type { HostKind } from "../state";
import type { HostLink } from "./trees";
import { focusView, mimeOf } from "./model";
import { webviewDocument } from "./prelude";
import { webviewTheme } from "./themeVars";

/**
 * Extension webviews in the workbench ("MainThreadWebviews"): webview panels
 * (editor tabs) and webview views (side bar views). Each one is a sandboxed
 * iframe (scripts only when the extension enables them, never same-origin,
 * so the page cannot reach the workbench or Tauri) showing the page the
 * platform publishes at its webview origin (desktop: tmwebview://, served by
 * webview.rs from the HTML plus localResourceRoots). The browser build has
 * no such origin: the page goes into `srcdoc` with its resources inlined.
 *
 * Iframes live in one layer over the workbench (WebviewLayer) and follow the
 * slot (WebviewSlot) that shows them: moving an iframe in the DOM would reload
 * it. A webview whose slot goes away is destroyed, unless the extension asked
 * for retainContextWhenHidden; it is re-created (state from setState kept)
 * when shown again, as in VS Code.
 */

export interface WebviewEntry {
  handle: string;
  link: HostLink;
  kind: "panel" | "view";
  extensionId: string;
  viewType: string;
  title: string;
  icon: IconDTO | null;
  options: WebviewOptionsDTO;
  html: string;
  /** acquireVsCodeApi().setState(). */
  state: unknown;
  meta: ViewMetaDTO;
}

interface Runtime {
  frame: HTMLIFrameElement | null;
  slot: HTMLElement | null;
  ready: boolean;
  queue: unknown[];
  /** Messages are kept for a webview about to be shown (created, or its slot pending). */
  wanted: boolean;
  generation: number;
  published: boolean;
  lastRect: string;
  /** The page has started (see useWebviewStatus): until then its iframe stays hidden and the slot shows progress. */
  started: boolean;
  /** It started once: a re-created iframe (its slot came back) shows at once, without "Starting…" again. */
  everStarted: boolean;
  timers: ReturnType<typeof setTimeout>[];
}

/**
 * Whether each webview's page has started, for the slot's progress and error states:
 * - starting: loading; the iframe is hidden and the slot says "Starting…";
 * - running: the page posted its first message to the extension (or, for pages that never
 *   post, it loaded and 1.2 s passed without a script error); only a view's first load waits;
 * - stuck: 30 s without starting; the slot shows what went wrong on the page and Reload.
 */
export interface WebviewStatus {
  phase: "starting" | "running" | "stuck";
  /** What the page reported (prelude: errors, rejections, failed loads, CSP refusals), newest last. */
  diagnostics: { kind: string; text: string }[];
}
export const useWebviewStatus = create<Record<string, WebviewStatus>>()(() => ({}));
const START_GRACE_MS = 1200;
const STUCK_MS = 30_000;

/** The webviews by handle (title, icon… for tabs and panes). */
export const useWebviews = create<{ entries: Record<string, WebviewEntry>; viewHandles: Record<string, string> }>()(() => ({ entries: {}, viewHandles: {} }));

/** Webview view providers registered by extensions: view id → host. */
export const useWebviewViewProviders = create<{ providers: Record<string, { link: HostLink; retain: boolean }> }>()(() => ({ providers: {} }));

const runtime = new Map<string, Runtime>();
let layer: HTMLElement | null = null;
let rafId = 0;
let wired = false;

export const BROWSER_WEBVIEW_BASE = "https://tmwebview.invalid";

/** `webview.cspSource` / asWebviewUri base for this platform (sent in $init). */
export function webviewEnv(): { webviewBase: string; webviewCspSource: string } {
  const host = getPlatform().webviews;
  return host ? { webviewBase: host.base, webviewCspSource: host.cspSource } : { webviewBase: BROWSER_WEBVIEW_BASE, webviewCspSource: `${BROWSER_WEBVIEW_BASE} data:` };
}

function setStatus(handle: string, p: Partial<WebviewStatus>) {
  useWebviewStatus.setState((s) => ({ [handle]: { ...((s[handle] as WebviewStatus | undefined) ?? { phase: "starting", diagnostics: [] }), ...p } }));
}

/** A (re)loading page: progress until it starts, or "stuck" after STUCK_MS. */
function beginStart(handle: string, r: Runtime) {
  for (const t of r.timers.splice(0)) clearTimeout(t);
  if (r.everStarted) {
    r.started = true;
    r.lastRect = "";
    setStatus(handle, { phase: "running" });
    return;
  }
  r.started = false;
  r.lastRect = "";
  setStatus(handle, { phase: "starting", diagnostics: [] });
  r.timers.push(
    setTimeout(() => {
      if (!r.started && useWebviewStatus.getState()[handle]?.phase === "starting") setStatus(handle, { phase: "stuck" });
    }, STUCK_MS),
  );
}

function markStarted(handle: string) {
  const r = runtime.get(handle);
  if (!r || r.started) return;
  r.started = true;
  r.everStarted = true;
  for (const t of r.timers.splice(0)) clearTimeout(t);
  r.lastRect = "";
  setStatus(handle, { phase: "running" });
  schedule();
}

/** A script error or a script that didn't load keeps a silent page from counting as started. */
const blocking = (d: { kind: string; text: string }) => d.kind === "error" || d.kind === "rejection" || (d.kind === "load" && /^script /.test(d.text));

/** Reload (the slot's error state). */
export function reloadWebview(handle: string) {
  reload(handle);
}

/** Show the page as it is, though it hasn't started (the slot's error state). */
export function showWebviewAnyway(handle: string) {
  markStarted(handle);
}

function rt(handle: string): Runtime {
  let r = runtime.get(handle);
  if (!r) runtime.set(handle, (r = { frame: null, slot: null, ready: false, queue: [], wanted: false, generation: 0, published: false, lastRect: "", started: false, everStarted: false, timers: [] }));
  return r;
}

function entry(handle: string): WebviewEntry | undefined {
  return useWebviews.getState().entries[handle];
}

function update(handle: string, patch: Partial<WebviewEntry>) {
  useWebviews.setState((s) => (s.entries[handle] ? { entries: { ...s.entries, [handle]: { ...s.entries[handle], ...patch } } } : s));
}

const editorId = (handle: string) => `webview:${handle}`;

// ───────────── host → workbench ─────────────

export function createWebview(link: HostLink, handle: string, dto: WebviewCreateDTO) {
  wire();
  const e: WebviewEntry = { handle, link, kind: dto.kind, extensionId: dto.extensionId, viewType: dto.viewType, title: dto.title ?? "", icon: dto.iconPath ?? null, options: dto.options, html: "", state: undefined, meta: {} };
  useWebviews.setState((s) => ({ entries: { ...s.entries, [handle]: e }, viewHandles: dto.kind === "view" ? { ...s.viewHandles, [dto.viewType]: handle } : s.viewHandles }));
  const r = rt(handle);
  r.wanted = true;
  if (dto.kind === "panel") showPanelEditor(handle, dto.viewColumn, dto.preserveFocus);
}

export function webviewOp(handle: string, op: string, data: unknown) {
  const e = entry(handle);
  if (!e) return;
  switch (op) {
    case "html":
      update(handle, { html: String(data ?? "") });
      reload(handle);
      return;
    case "options": {
      const before = e.options;
      const options = { ...(data as WebviewOptionsDTO), retainContextWhenHidden: before.retainContextWhenHidden };
      update(handle, { options });
      if (before.enableScripts !== options.enableScripts || before.enableForms !== options.enableForms || before.localResourceRoots.join("\n") !== options.localResourceRoots.join("\n")) reload(handle);
      return;
    }
    case "title":
      update(handle, { title: String(data ?? "") });
      return;
    case "icon":
      update(handle, { icon: (data as IconDTO | null) ?? null });
      return;
    case "viewMeta":
      update(handle, { meta: { ...e.meta, ...(data as ViewMetaDTO) } });
      return;
    case "reveal": {
      const d = (data ?? {}) as { viewColumn?: number; preserveFocus?: boolean };
      showPanelEditor(handle, d.viewColumn, d.preserveFocus);
      return;
    }
    case "show":
      // WebviewView.show(preserveFocus): its container comes to the front, the view opens.
      focusView(e.viewType, !(data as { preserveFocus?: boolean } | null)?.preserveFocus);
      return;
    case "dispose":
      disposeWebview(handle, false);
      return;
  }
}

/** `webview.postMessage`: delivered when the page is live, queued while it loads; false when hidden. */
export function postToWebview(handle: string, message: unknown): boolean {
  const r = runtime.get(handle);
  if (!r || !entry(handle)) return false;
  trace(handle, "→page", message);
  if (r.frame && r.ready) {
    r.frame.contentWindow?.postMessage({ __tmwebview: 1, type: "message", data: message }, "*");
    return true;
  }
  if (r.frame || r.wanted) {
    if (r.queue.length < 1000) r.queue.push(message);
    return true;
  }
  return false;
}

export function disposeWebview(handle: string, notifyHost: boolean) {
  const e = entry(handle);
  if (!e) return;
  destroyFrame(handle);
  for (const t of runtime.get(handle)?.timers ?? []) clearTimeout(t);
  runtime.delete(handle);
  useWebviewStatus.setState((s) => {
    const next = { ...s };
    delete next[handle];
    return next;
  }, true);
  getPlatform().webviews?.dispose(handle);
  useWebviews.setState((s) => {
    const entries = { ...s.entries };
    delete entries[handle];
    const viewHandles = { ...s.viewHandles };
    if (e.kind === "view" && viewHandles[e.viewType] === handle) delete viewHandles[e.viewType];
    return { entries, viewHandles };
  });
  if (notifyHost) void e.link.rpc.request(e.kind === "panel" ? "$webviewPanelDisposed" : "$webviewViewDisposed", [handle]).catch(() => {});
  if (e.kind === "panel") {
    // The tab goes away with it.
    for (const g of useWorkbench.getState().groups) if (g.editors.some((x) => x.id === editorId(handle))) void closeEditors(g.id, [editorId(handle)]);
  }
}

export function disposeWebviewsOf(kind: HostKind) {
  for (const e of Object.values(useWebviews.getState().entries)) if (e.link.kind === kind) disposeWebview(e.handle, false);
  useWebviewViewProviders.setState((s) => ({ providers: Object.fromEntries(Object.entries(s.providers).filter(([, p]) => p.link.kind !== kind)) }));
}

export function registerWebviewViewProvider(link: HostLink, viewId: string, data: { retainContextWhenHidden?: boolean }) {
  useWebviewViewProviders.setState((s) => ({ providers: { ...s.providers, [viewId]: { link, retain: !!data?.retainContextWhenHidden } } }));
}

export function unregisterWebviewViewProvider(viewId: string) {
  useWebviewViewProviders.setState((s) => {
    const providers = { ...s.providers };
    delete providers[viewId];
    return { providers };
  });
  const h = useWebviews.getState().viewHandles[viewId];
  if (h) disposeWebview(h, false);
}

const resolving = new Set<string>();
/** Asks the host to resolve a webview view the first time it is shown. */
export async function ensureWebviewView(viewId: string) {
  const p = useWebviewViewProviders.getState().providers[viewId];
  if (!p || useWebviews.getState().viewHandles[viewId] || resolving.has(viewId)) return;
  resolving.add(viewId);
  try {
    await p.link.rpc.request("$resolveWebviewView", [viewId]);
  } catch (e) {
    log(HOST_CHANNEL, `Resolving the webview view '${viewId}' failed: ${String((e as Error)?.message ?? e)}`, "error");
  } finally {
    resolving.delete(viewId);
  }
}

// ───────────── panels as editors ─────────────

function showPanelEditor(handle: string, viewColumn?: number, preserveFocus?: boolean) {
  const s = useWorkbench.getState();
  const id = editorId(handle);
  const existing = s.groups.find((g) => g.editors.some((x) => x.id === id));
  if (existing && (viewColumn === undefined || viewColumn === -1)) {
    activateEditor(existing.id, id);
    return;
  }
  const input = { kind: "webview", id, handle, preview: false } as Extract<EditorInput, { kind: "webview" }>;
  // ViewColumn.Beside (-2) opens to the side; 1..3 pick a group.
  const groups = s.groups;
  const group = typeof viewColumn === "number" && viewColumn > 0 ? groups[Math.min(viewColumn, groups.length) - 1]?.id : undefined;
  const prevGroup = s.activeGroup;
  openEditorInput(input, { toSide: viewColumn === -2, group });
  if (preserveFocus) useWorkbench.setState({ activeGroup: prevGroup });
}

// ───────────── iframes ─────────────

export function setWebviewLayer(el: HTMLElement | null) {
  layer = el;
  if (el) for (const r of runtime.values()) if (r.frame && !r.frame.isConnected) el.appendChild(r.frame);
}

/** A slot (editor area, side bar view) shows the webview: its iframe is created (or reused) and follows the slot. */
export function attachSlot(handle: string, slot: HTMLElement) {
  const r = rt(handle);
  r.slot = slot;
  r.wanted = true;
  if (!r.frame) createFrame(handle);
  setVisible(handle, true);
  schedule();
}

export function detachSlot(handle: string, slot: HTMLElement) {
  const r = runtime.get(handle);
  if (!r || r.slot !== slot) return;
  r.slot = null;
  const e = entry(handle);
  if (e?.options.retainContextWhenHidden) {
    if (r.frame) r.frame.style.visibility = "hidden";
  } else {
    destroyFrame(handle);
    r.wanted = false;
  }
  setVisible(handle, false);
}

function setVisible(handle: string, visible: boolean) {
  const e = entry(handle);
  if (e?.kind === "view") void e.link.rpc.request("$webviewViewVisible", [handle, visible]).catch(() => {});
}

function sandboxFor(o: WebviewOptionsDTO) {
  return ["allow-downloads", "allow-pointer-lock", o.enableScripts ? "allow-scripts" : "", o.enableForms ? "allow-forms" : ""].filter(Boolean).join(" ");
}

function createFrame(handle: string) {
  const e = entry(handle);
  const r = rt(handle);
  if (!e) return;
  const frame = document.createElement("iframe");
  frame.className = "tm-webview-frame";
  frame.dataset.webview = handle;
  frame.dataset.viewType = e.viewType;
  frame.title = e.title || e.viewType;
  frame.setAttribute("sandbox", sandboxFor(e.options));
  frame.setAttribute("allow", "clipboard-read; clipboard-write; autoplay");
  frame.style.visibility = "hidden";
  r.frame = frame;
  r.ready = false;
  beginStart(handle, r);
  (layer ?? document.body).appendChild(frame);
  void load(handle);
}

function destroyFrame(handle: string) {
  const r = runtime.get(handle);
  if (!r?.frame) return;
  r.frame.remove();
  r.frame = null;
  r.ready = false;
  for (const t of r.timers.splice(0)) clearTimeout(t);
  r.queue = [];
}

/** html / options changed: a live page reloads. */
function reload(handle: string) {
  const r = runtime.get(handle);
  if (!r?.frame) return;
  const e = entry(handle);
  if (e) r.frame.setAttribute("sandbox", sandboxFor(e.options));
  r.ready = false;
  beginStart(handle, r);
  void load(handle);
}

async function load(handle: string) {
  const e = entry(handle);
  const r = runtime.get(handle);
  if (!e || !r?.frame) return;
  const gen = ++r.generation;
  const doc = webviewDocument(e.html, { state: e.state, theme: webviewTheme() });
  const platform = getPlatform();
  try {
    if (platform.webviews) {
      const url = await platform.webviews.publish(handle, doc, e.options.localResourceRoots);
      if (gen !== r.generation || !r.frame) return;
      r.frame.src = `${url}?v=${gen}`;
    } else {
      const inlined = await inlineResources(doc, handle);
      if (gen !== r.generation || !r.frame) return;
      r.frame.srcdoc = inlined;
    }
  } catch (err) {
    log(HOST_CHANNEL, `Webview '${e.viewType}' could not load: ${String((err as Error)?.message ?? err)}`, "error");
  }
}

/** Browser build: asWebviewUri URLs (`<base>/<handle>/file|ext/…`) become data: URLs. */
async function inlineResources(doc: string, handle: string): Promise<string> {
  const base = BROWSER_WEBVIEW_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${base}/${handle}/(file|ext)/([^"'\\s)?#]+)`, "g");
  const urls = new Set<string>();
  for (const m of doc.matchAll(re)) urls.add(m[0]);
  const ws = useWorkbench.getState().workspace;
  const platform = getPlatform();
  const map = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (url) => {
      const m = new RegExp(`${base}/${handle}/(file|ext)/(.+)$`).exec(url)!;
      const path = decodeURIComponent(m[2]);
      let b64: string | null | undefined = null;
      if (m[1] === "ext") {
        const [id, ...rest] = path.split("/");
        b64 = await platform.extensions?.readFile(id, rest.join("/"), "base64").catch(() => null);
      } else if (ws) {
        // The Web Worker host's folder is file:///<name>.
        const rel = path.startsWith(`${ws.name}/`) ? path.slice(ws.name.length + 1) : null;
        if (rel !== null) b64 = await (platform.fs.readBase64 ? platform.fs.readBase64(rel) : platform.fs.readFile(rel).then((t) => btoa(unescape(encodeURIComponent(t))))).catch(() => null);
      }
      if (b64) map.set(url, `data:${mimeOf(path)};base64,${b64}`);
    }),
  );
  return doc.replace(re, (u) => map.get(u) ?? u);
}

// ───────────── layout: iframes follow their slots ─────────────

function schedule() {
  if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick() {
  rafId = 0;
  let live = false;
  const layerRect = layer?.getBoundingClientRect();
  for (const r of runtime.values()) {
    if (!r.frame) continue;
    if (!r.slot || !r.slot.isConnected) {
      if (r.frame.style.visibility !== "hidden") r.frame.style.visibility = "hidden";
      continue;
    }
    live = true;
    const b = r.slot.getBoundingClientRect();
    const hidden = b.width < 1 || b.height < 1;
    const key = hidden ? "hidden" : `${b.left - (layerRect?.left ?? 0)},${b.top - (layerRect?.top ?? 0)},${b.width},${b.height}`;
    if (key === r.lastRect) continue;
    r.lastRect = key;
    if (hidden || !r.started) {
      r.frame.style.visibility = "hidden";
      continue;
    }
    Object.assign(r.frame.style, { visibility: "visible", left: `${b.left - (layerRect?.left ?? 0)}px`, top: `${b.top - (layerRect?.top ?? 0)}px`, width: `${b.width}px`, height: `${b.height}px` });
  }
  // Keep following while any webview is shown (side bar resizes, panel drags, editor splits).
  if (live) rafId = requestAnimationFrame(tick);
}

// ───────────── messages from pages ─────────────

function handleOf(source: MessageEventSource | null): string | null {
  for (const [h, r] of runtime) if (r.frame && r.frame.contentWindow === source) return h;
  return null;
}

/** Messages each webview posted (self-tests: proof that its page loaded and its script runs). */
export const webviewMessageCounts = new Map<string, number>();
/** The first messages each way per webview, by type ("page→ ready", "→page services"), for self-tests. */
export const webviewTrace = new Map<string, string[]>();
let traceBodies = false;
/** Self-tests: keep the start of each message's JSON in the trace too. */
export function traceWebviewBodies(on: boolean) {
  traceBodies = on;
}
function trace(handle: string, dir: "page→" | "→page", m: unknown) {
  const t = webviewTrace.get(handle) ?? [];
  if (t.length >= 60) return;
  const type = m && typeof m === "object" ? String((m as { type?: unknown }).type ?? Object.keys(m).slice(0, 3).join(",")) : typeof m;
  let body = "";
  if (traceBodies) {
    try {
      body = ` ${JSON.stringify(m).slice(0, 700)}`;
    } catch {
      body = " (unserialisable)";
    }
  }
  t.push(`${dir} ${type}${body}`);
  webviewTrace.set(handle, t);
}

function onMessage(ev: MessageEvent) {
  const d = ev.data as { __tmwebview?: number; type?: string; data?: unknown; href?: string } | null;
  if (!d || d.__tmwebview !== 1) return;
  const handle = handleOf(ev.source);
  if (!handle) return;
  const e = entry(handle);
  const r = runtime.get(handle);
  if (!e || !r) return;
  switch (d.type) {
    case "ready":
      r.ready = true;
      for (const m of r.queue.splice(0)) r.frame?.contentWindow?.postMessage({ __tmwebview: 1, type: "message", data: m }, "*");
      // A page that never posts counts as started once it has loaded and ran without a script error for a moment.
      r.timers.push(
        setTimeout(() => {
          if (!(useWebviewStatus.getState()[handle]?.diagnostics ?? []).some(blocking)) markStarted(handle);
        }, START_GRACE_MS),
      );
      return;
    case "diagnostic": {
      const dd = d as unknown as { kind?: string; text?: string };
      const item = { kind: String(dd.kind ?? "error"), text: String(dd.text ?? "").slice(0, 600) };
      setStatus(handle, { diagnostics: [...(useWebviewStatus.getState()[handle]?.diagnostics ?? []), item].slice(-40) });
      // An extension's own style policy refusing inline styles is noise; everything else is worth a line in the log.
      if (!(item.kind === "csp" && /CSP refused style-src/.test(item.text))) log(HOST_CHANNEL, `[${e.extensionId}] webview '${e.viewType}': ${item.text}`, item.kind === "csp" ? "warn" : "error");
      return;
    }
    case "message":
      markStarted(handle);
      webviewMessageCounts.set(handle, (webviewMessageCounts.get(handle) ?? 0) + 1);
      trace(handle, "page→", d.data);
      void e.link.rpc.request("$webviewMessage", [handle, d.data]).catch(() => {});
      return;
    case "setState":
      update(handle, { state: d.data });
      return;
    case "link":
      openLink(e, String(d.href ?? ""));
      return;
    case "keydown": {
      const k = d as unknown as KeyboardEventInit & { key: string };
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k.key, code: k.code, metaKey: k.metaKey, ctrlKey: k.ctrlKey, shiftKey: k.shiftKey, altKey: k.altKey, repeat: k.repeat, bubbles: true, cancelable: true }));
      return;
    }
    case "focus":
      if (e.kind === "panel") {
        const g = useWorkbench.getState().groups.find((x) => x.editors.some((i) => i.id === editorId(handle)));
        if (g && useWorkbench.getState().activeGroup !== g.id) useWorkbench.setState({ activeGroup: g.id });
      }
      return;
  }
}

function openLink(e: WebviewEntry, href: string) {
  if (/^(https?|mailto):/i.test(href)) {
    const p = getPlatform();
    if (p.openExternal) void p.openExternal(href);
    else window.open(href, "_blank", "noopener");
    return;
  }
  const m = /^command:([\w.\-:]+)(?:\?(.*))?$/i.exec(href);
  if (!m) return;
  const allowed = e.options.enableCommandUris === true || (Array.isArray(e.options.enableCommandUris) && e.options.enableCommandUris.includes(m[1]));
  if (!allowed) return;
  let args: unknown[] = [];
  if (m[2]) {
    try {
      const parsed = JSON.parse(decodeURIComponent(m[2]));
      args = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      /* no arguments */
    }
  }
  void e.link.rpc.request("$executeCommand", [m[1], args]).catch((err) => {
    if (getCommand(m[1])) runWorkbenchCommand(m[1]);
    else notify("error", String((err as Error)?.message ?? err));
  });
}

// ───────────── panel view state, theme ─────────────

function wire() {
  if (wired) return;
  wired = true;
  window.addEventListener("message", onMessage);
  let lastStates = "";
  /** Panels that had a tab: one whose tab is gone was closed by the user. */
  const seen = new Set<string>();
  useWorkbench.subscribe((s) => {
    // onDidChangeViewState and onDidDispose (tab closed) for panels.
    const entries = useWebviews.getState().entries;
    const open = new Set<string>();
    const states: string[] = [];
    s.groups.forEach((g, i) => {
      for (const ed of g.editors) {
        if (ed.kind !== "webview") continue;
        open.add(ed.handle);
        const visible = g.activeId === ed.id;
        const active = visible && s.activeGroup === g.id;
        states.push(`${ed.handle}:${visible ? 1 : 0}${active ? 1 : 0}${i + 1}`);
      }
    });
    for (const e of Object.values(entries)) if (e.kind === "panel" && !open.has(e.handle) && seen.has(e.handle)) disposeWebview(e.handle, true);
    for (const h of open) seen.add(h);
    const key = states.join(",");
    if (key === lastStates) return;
    lastStates = key;
    for (const st of states) {
      const [handle, flags] = st.split(":");
      const e = entries[handle];
      if (!e) continue;
      const r = runtime.get(handle);
      // A panel in a background tab is not live (unless retained): its messages are dropped, as in VS Code.
      if (r) r.wanted = flags[0] === "1" || !!r.frame;
      void e.link.rpc.request("$webviewPanelState", [handle, { visible: flags[0] === "1", active: flags[1] === "1", viewColumn: Number(flags.slice(2)) }]).catch(() => {});
    }
  });
  const pushTheme = () => {
    const theme = webviewTheme();
    for (const r of runtime.values()) if (r.frame && r.ready) r.frame.contentWindow?.postMessage({ __tmwebview: 1, type: "theme", theme }, "*");
  };
  useThemes.subscribe((s, p) => s.active !== p.active && requestAnimationFrame(pushTheme));
  // Dragging a sash over an iframe: the iframe must not swallow the pointer.
  window.addEventListener("pointerdown", (ev) => {
    if ((ev.target as HTMLElement)?.tagName !== "IFRAME") layer?.classList.add("is-dragging");
  }, true);
  window.addEventListener("pointerup", () => layer?.classList.remove("is-dragging"), true);
}
