import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import { executeCommand, formatKeybinding } from "../commands/registry";
import { debugAllowed, startDebugging, useDebug } from "../debug/debugService";
import { activeFilePath, getPlatform, showPanel, useWorkbench } from "../state/store";
import { basename } from "../util/paths";
import { Codicon } from "../widgets/icons";
import { useJsConsole } from "./jsConsole";
import { formatElapsed, unavailableReason, type RunAction } from "./projectKind";
import {
  activity,
  currentTarget,
  executeAction,
  pickRunTarget,
  primaryFileAction,
  restartDevServer,
  revealBrowser,
  runProject,
  runProjectKeybinding,
  showDevServerTerminal,
  stopAnything,
  targetContext,
  useRunHub,
} from "./runHub";

/** Re-renders every second while something runs (elapsed time). */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Subscribes a component to everything the hub's state depends on. */
function useHubState() {
  const hub = useRunHub();
  const run = useWorkbench((s) => s.run);
  useWorkbench((s) => s.policy);
  useWorkbench((s) => s.workspace?.root);
  useDebug((s) => s.phase);
  const js = useJsConsole((s) => s.status);
  const jsStarted = useJsConsole((s) => s.startedAt);
  const jsFile = useJsConsole((s) => s.file);
  return { hub, run, js, jsStarted, jsFile, what: activity() };
}

/** What is running: label, phase and start time, for the status bar. */
function runningInfo(h: ReturnType<typeof useHubState>) {
  if (h.what === "dev" && h.hub.session) {
    const s = h.hub.session;
    return { label: s.action.label, phase: s.status === "stopping" ? "Stopping" : s.status === "starting" ? "Starting" : "Running", since: s.startedAt, url: s.url };
  }
  if (h.what === "run") return { label: h.run.entry ? basename(h.run.entry) : (h.run.label ?? "program"), phase: h.run.status === "building" ? "Building" : "Running", since: h.run.startedAt ?? Date.now(), url: null };
  if (h.what === "js") return { label: h.jsFile ? basename(h.jsFile) : "JavaScript Console", phase: "Running", since: h.jsStarted ?? Date.now(), url: null };
  return null;
}

// ───────────── status bar ─────────────

interface Outcome {
  label: string;
  ok: boolean;
  badge: string;
  text: string;
  panel: "run" | "terminal" | "jsConsole";
}

/** The last run's result, shown for a few seconds after it ends. */
function useLastOutcome(): Outcome | null {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const show = (o: Outcome) => {
      setOutcome(o);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setOutcome(null), 10_000);
    };
    const offRun = useWorkbench.subscribe((s, prev) => {
      if (prev.run.status !== "idle" && s.run.status === "idle" && s.run.lastExit) {
        const e = s.run.lastExit;
        const ok = e.code === 0 && !e.timed_out && !e.killed;
        show({
          label: s.run.entry ? basename(s.run.entry) : "Run",
          ok,
          badge: e.killed ? "stopped" : e.timed_out ? "timeout" : `exit ${e.code ?? "?"}`,
          text: e.killed ? "stopped" : `exit code ${e.code ?? "?"} in ${(e.duration_ms / 1000).toFixed(2)} s`,
          panel: "run",
        });
      } else if (s.run.status !== "idle" && prev.run.status === "idle") setOutcome(null);
    });
    const offJs = useJsConsole.subscribe((s, prev) => {
      if (prev.status === "running" && s.status === "idle" && s.last && s.file) {
        const l = s.last;
        show({ label: basename(s.file), ok: l.ok, badge: l.stopped ? "stopped" : l.ok ? `${l.ms} ms` : "error", text: l.stopped ? "stopped" : l.ok ? `finished in ${l.ms} ms` : "failed", panel: "jsConsole" });
      }
    });
    const offDev = useRunHub.subscribe((s, prev) => {
      const a = prev.session;
      const b = s.session;
      if (a && b && a.id === b.id && b.status !== a.status && (b.status === "stopped" || b.status === "failed")) {
        show({
          label: b.action.label,
          ok: b.status === "stopped",
          badge: b.exitCode != null ? `exit ${b.exitCode}` : b.status,
          text: b.status === "failed" ? `failed${b.exitCode != null ? ` (exit code ${b.exitCode})` : ""}` : "stopped",
          panel: "terminal",
        });
      }
    });
    return () => {
      offRun();
      offJs();
      offDev();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return outcome;
}

/** The status bar's ▶ Run item: the target while idle, ■ Stop with elapsed time while running. */
export function RunStatusItems() {
  const h = useHubState();
  const ws = useWorkbench((s) => !!s.workspace);
  const info = runningInfo(h);
  const now = useNow(!!info);
  const outcome = useLastOutcome();
  if (!ws) return null;
  if (info) {
    return (
      <>
        <button
          type="button"
          className={`tm-status-item is-clickable tm-run-status is-${info.phase.toLowerCase()}`}
          title={`${info.phase} ${info.label}: click to stop (Shift+F5)`}
          aria-label={`Stop ${info.label}`}
          data-testid="run-hub-status"
          onClick={stopAnything}
        >
          <span className="tm-run-pulse" aria-hidden />
          <Codicon name="debug-stop" />
          <span className="tm-run-status-label">
            {info.phase === "Running" ? "Stop" : info.phase} {info.label}
          </span>
          <span className="tm-run-elapsed">{formatElapsed(now - info.since)}</span>
        </button>
        {h.what === "dev" && (
          <button type="button" className="tm-status-item is-clickable" title="Restart" aria-label="Restart" onClick={restartDevServer}>
            <Codicon name="debug-restart" />
          </button>
        )}
        {info.url && h.what === "dev" && getPlatform().http && (
          <button type="button" className="tm-status-item is-clickable tm-prio-mid" title="Test this server's API (send requests, see responses)" aria-label="Open API Tester" onClick={() => executeCommand("api.openTester")} data-testid="status-api-tester">
            <Codicon name="radio-tower" />
          </button>
        )}
        {info.url && (
          <button type="button" className="tm-status-item is-clickable tm-prio-mid" title={`Open ${info.url} in the built-in browser`} aria-label={`Open ${info.url}`} onClick={() => revealBrowser(info.url!)}>
            <Codicon name="globe" /> {info.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}
          </button>
        )}
      </>
    );
  }
  const target = currentTarget(h.hub);
  const kb = runProjectKeybinding();
  return (
    <>
      <span className="tm-run-split">
        <button
          type="button"
          className="tm-status-item is-clickable tm-run-status is-idle"
          title={target ? `Run Project (${kb}): ${target.label}` : "Run Project: choose what to run"}
          aria-label={target ? `Run Project: ${target.label}` : "Run Project"}
          data-testid="run-hub-status"
          onClick={() => void runProject()}
        >
          <Codicon name={target?.kind === "livePreview" ? "open-preview" : "play"} className="tm-run-play" />
          <span className="tm-run-status-label">{target ? target.label : "Run"}</span>
        </button>
        <button
          type="button"
          className="tm-status-item is-clickable tm-run-status-more"
          title="Run Menu"
          aria-label="Run Menu"
          aria-haspopup="menu"
          onClick={(e) => openRunMenu(e.currentTarget, "status")}
        >
          <Codicon name="chevron-up" />
        </button>
      </span>
      {outcome && (
        <button
          type="button"
          className={`tm-status-item is-clickable tm-run-outcome ${outcome.ok ? "is-ok" : "is-fail"}`}
          title={`${outcome.label}: ${outcome.text}`}
          aria-label={`${outcome.label}: ${outcome.text}`}
          data-testid="run-hub-outcome"
          onClick={() => showPanel(outcome.panel)}
        >
          <Codicon name={outcome.ok ? "pass-filled" : "error"} />
          {outcome.badge}
        </button>
      )}
    </>
  );
}

// ───────────── editor title ─────────────

const KIND_ICON: Record<RunAction["kind"], string> = {
  runFile: "play",
  jsConsole: "debug-console",
  livePreview: "open-preview",
  openBrowser: "link-external",
  devServer: "play-circle",
  task: "play",
  repl: "terminal",
  debug: "debug-alt",
  pickTask: "tasklist",
  markdownPreview: "open-preview",
  sqlRun: "database",
  logicPreview: "table",
};

function primaryTitle(a: RunAction) {
  const os = getPlatform().os;
  if (a.kind === "runFile") return `Run File (${formatKeybinding("ctrl+f5", os)})`;
  if (a.kind === "debug") return `Debug File (${formatKeybinding("f5", os)})`;
  if (a.kind === "livePreview") return `Live Preview (${formatKeybinding("f5", os)})`;
  if (a.kind === "jsConsole") return "Run in JavaScript Console";
  return a.label;
}

/**
 * ▶ in the editor title as a split button: the main part runs the best (or
 * last chosen) action for this file; the arrow opens the Run menu with every
 * action for the file and the project. ■ while something runs.
 */
export function RunSplitButton({ path }: { path: string }) {
  const h = useHubState();
  const lastDebug = useDebug((s) => s.lastEditorAction);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  // Markdown and SVG keep their own "Open Preview to the Side" button.
  if (ext === "md" || ext === "markdown" || ext === "svg") return null;
  let primary = primaryFileAction(h.hub);
  if (lastDebug === "debug" && primary?.kind === "runFile") primary = h.hub.fileActions.find((a) => a.kind === "debug" && !unavailableReason(a, targetContext())) ?? primary;
  if (h.what === "run" || h.what === "js") {
    return (
      <span className="tm-split-action tm-run-split">
        <button type="button" className="tm-action tm-stop" title="Stop (Shift+F5)" aria-label="Stop (Shift+F5)" data-testid="editor-run-button" onClick={stopAnything}>
          <Codicon name="debug-stop" />
        </button>
        <MoreButton />
      </span>
    );
  }
  if (!primary) return h.hub.projects.length ? <MoreButton standalone /> : null;
  const main = primary;
  return (
    <span className="tm-split-action tm-run-split">
      <button
        type="button"
        className={`tm-action tm-run is-${main.kind}`}
        title={primaryTitle(main)}
        aria-label={primaryTitle(main)}
        data-testid="editor-run-button"
        onClick={() => void executeAction(main, { remember: true })}
      >
        <Codicon name={KIND_ICON[main.kind]} />
      </button>
      <MoreButton />
    </span>
  );
}

function MoreButton({ standalone = false }: { standalone?: boolean }) {
  return (
    <button
      type="button"
      className={`tm-action ${standalone ? "tm-run" : "tm-split-action-more"}`}
      title="Run or Debug..."
      aria-label="Run or Debug..."
      aria-haspopup="menu"
      data-testid="editor-run-menu"
      onClick={(e) => openRunMenu(e.currentTarget, "title")}
    >
      <Codicon name={standalone ? "play" : "chevron-down"} />
    </button>
  );
}

// ───────────── the Run menu ─────────────

type Row =
  | { kind: "header"; label: string }
  | { kind: "sep" }
  | { kind: "item"; id: string; label: string; icon: string; detail?: string; keybinding?: string; disabled?: boolean; current?: boolean; run: () => void };

const useRunMenu = create<{ anchor: HTMLElement | null; from: "title" | "status" }>(() => ({ anchor: null, from: "title" }));

export function openRunMenu(anchor: HTMLElement, from: "title" | "status") {
  const cur = useRunMenu.getState();
  useRunMenu.setState({ anchor: cur.anchor === anchor ? null : anchor, from });
}

function closeRunMenu(refocus = false) {
  const a = useRunMenu.getState().anchor;
  useRunMenu.setState({ anchor: null });
  if (refocus) a?.focus();
}

function buildRows(): Row[] {
  const hub = useRunHub.getState();
  const ctx = targetContext();
  const os = getPlatform().os;
  const rows: Row[] = [];
  const asRow = (a: RunAction, extra: Partial<Extract<Row, { kind: "item" }>> = {}): Row => {
    const why = unavailableReason(a, ctx);
    return { kind: "item", id: a.id, label: a.label, icon: a.icon, detail: why ?? a.description ?? a.command, disabled: !!why, run: () => void executeAction(a, { remember: true }), ...extra };
  };
  const what = activity();
  if (what) {
    rows.push({ kind: "item", id: "stop", label: "Stop", icon: "debug-stop", keybinding: formatKeybinding("shift+f5", os), run: stopAnything });
    if (what === "dev") {
      rows.push({ kind: "item", id: "restart", label: "Restart", icon: "debug-restart", run: restartDevServer });
      rows.push({ kind: "item", id: "show-terminal", label: "Show Terminal", icon: "terminal", run: showDevServerTerminal });
    }
    rows.push({ kind: "sep" });
  }
  const path = activeFilePath();
  if (path && hub.fileActions.length) {
    rows.push({ kind: "header", label: basename(path) });
    for (const a of hub.fileActions) rows.push(asRow(a));
  }
  const target = currentTarget(hub);
  const project = hub.projects.find((p) => p.actions.some((a) => a.id === target?.id)) ?? hub.projects[0];
  const runLabel = (a: RunAction) => ({ current: true, keybinding: runProjectKeybinding(), label: `Run Project: ${a.label}` });
  if (project) {
    rows.push({ kind: "header", label: `${project.label}${project.dir ? ` · ${project.dir}` : ""}` });
    const list = [...project.actions].sort((a, b) => (a.id === target?.id ? -1 : b.id === target?.id ? 1 : 0)).slice(0, 7);
    for (const a of list) rows.push(asRow(a, a.id === target?.id ? runLabel(a) : {}));
  } else if (target) {
    rows.push({ kind: "header", label: "Project" });
    rows.push(asRow(target, runLabel(target)));
  }
  rows.push({ kind: "sep" });
  rows.push({ kind: "item", id: "change-target", label: "Change Run Target...", icon: "target", run: () => void pickRunTarget() });
  if (ctx.practice && ctx.terminal) rows.push({ kind: "item", id: "run-task", label: "Run Task...", icon: "tasklist", run: () => executeCommand("workbench.action.tasks.runTask") });
  if (debugAllowed() && getPlatform().debug) rows.push({ kind: "item", id: "debug", label: "Start Debugging", icon: "debug-alt", keybinding: formatKeybinding("f5", os), run: () => void startDebugging() });
  rows.push({ kind: "item", id: "js-console", label: "Show JavaScript Console", icon: "debug-console", run: () => showPanel("jsConsole") });
  if (ctx.practice && getPlatform().http) rows.push({ kind: "item", id: "api-tester", label: "Open API Tester", icon: "radio-tower", run: () => executeCommand("api.openTester") });
  return rows;
}

/** The popover for the editor title's ▾ and the status bar's ⌃ (keyboard navigable). */
export function RunMenuHost() {
  const anchor = useRunMenu((s) => s.anchor);
  const from = useRunMenu((s) => s.from);
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!anchor) return;
    const next = buildRows();
    setRows(next);
    setFocus(next.findIndex((r) => r.kind === "item" && !r.disabled));
    setPos(null);
  }, [anchor]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = from === "title" ? a.right - r.width : a.left;
    left = Math.max(4, Math.min(left, window.innerWidth - r.width - 4));
    let top = from === "status" ? a.top - r.height - 4 : a.bottom + 2;
    if (top + r.height > window.innerHeight - 4) top = a.top - r.height - 4;
    setPos({ left, top: Math.max(4, top) });
  }, [anchor, from, rows]);

  // Keyboard first: the menu takes focus once it is placed (a hidden element can't be focused).
  useEffect(() => {
    if (pos) ref.current?.focus();
  }, [pos]);

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) closeRunMenu();
    };
    const close = () => closeRunMenu();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [anchor]);

  const host = typeof document !== "undefined" ? document.querySelector(".tm-root") : null;
  if (!anchor || !host) return null;
  const actionable = rows.map((r, i) => (r.kind === "item" && !r.disabled ? i : -1)).filter((i) => i >= 0);
  const run = (r: Row | undefined) => {
    if (!r || r.kind !== "item" || r.disabled) return;
    closeRunMenu();
    r.run();
  };

  return createPortal(
    <div
      ref={ref}
      className={`tm-menu tm-run-menu ${from === "status" ? "is-up" : ""}`}
      role="menu"
      aria-label="Run"
      tabIndex={-1}
      data-testid="run-menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      onKeyDown={(e) => {
        const at = actionable.indexOf(focus);
        if (e.key === "ArrowDown") setFocus(actionable[(at + 1) % actionable.length]);
        else if (e.key === "ArrowUp") setFocus(actionable[(at - 1 + actionable.length) % actionable.length]);
        else if (e.key === "Home") setFocus(actionable[0]);
        else if (e.key === "End") setFocus(actionable[actionable.length - 1]);
        else if (e.key === "Escape" || e.key === "Tab") closeRunMenu(true);
        else if (e.key === "Enter" || e.key === " ") run(rows[focus]);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {rows.map((r, i) =>
        r.kind === "sep" ? (
          <div key={i} className="tm-menu-separator" role="separator" />
        ) : r.kind === "header" ? (
          <div key={i} className="tm-run-menu-header" role="presentation">
            {r.label}
          </div>
        ) : (
          <div
            key={r.id + i}
            role="menuitem"
            aria-disabled={r.disabled}
            title={r.detail}
            className={`tm-menu-item tm-run-menu-item ${focus === i ? "is-focused" : ""} ${r.disabled ? "is-disabled" : ""} ${r.current ? "is-current" : ""}`}
            onMouseEnter={() => !r.disabled && setFocus(i)}
            onClick={() => run(r)}
          >
            <Codicon name={r.icon} className="tm-run-menu-icon" />
            <span className="tm-run-menu-text">
              <span className="tm-menu-label">{r.label}</span>
              {r.detail && <span className="tm-run-menu-detail">{r.detail}</span>}
            </span>
            {r.keybinding && <span className="tm-menu-kb">{r.keybinding}</span>}
          </div>
        ),
      )}
    </div>,
    host,
  );
}
