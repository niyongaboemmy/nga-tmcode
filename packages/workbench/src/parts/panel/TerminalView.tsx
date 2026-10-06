import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { defaultFontFamily } from "../../state/settings";
import { useThemes } from "../../themes/themeService";
import { getPlatform, log, notify, showPanel, useWorkbench } from "../../state/store";
import type { TerminalSession } from "../../platform/types";
import { ActionButton, Codicon } from "../../widgets/icons";
import { enhanceTerminal, type EnhancedTerminal } from "../../terminal/enhance";
import { setActiveTerminal } from "../../terminal/active";
import { recordCommand, CommandLineTracker } from "../../terminal/history";
import { SkeletonLines } from "../../widgets/Skeleton";

/** Terminal colours of the active colour theme (its terminal.* keys); the static palettes cover the moment before it loads. */
export function terminalTheme(theme: string): ITheme {
  const active = useThemes.getState().active;
  if (active && active.id === theme) return active.terminal;
  if (theme === "light-modern") {
    return {
      background: "#f8f8f8",
      foreground: "#3b3b3b",
      cursor: "#005fb8",
      cursorAccent: "#ffffff",
      selectionBackground: "#add6ff",
      black: "#000000",
      red: "#cd3131",
      green: "#107c10",
      yellow: "#949800",
      blue: "#0451a5",
      magenta: "#bc05bc",
      cyan: "#0598bc",
      white: "#555555",
      brightBlack: "#666666",
      brightRed: "#cd3131",
      brightGreen: "#14ce14",
      brightYellow: "#b5ba00",
      brightBlue: "#0451a5",
      brightMagenta: "#bc05bc",
      brightCyan: "#0598bc",
      brightWhite: "#a5a5a5",
    };
  }
  return {
    background: theme === "dark-hc" ? "#000000" : "#181818",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#000000",
    selectionBackground: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  };
}

interface Instance {
  id: number;
  name: string;
  term: Terminal;
  fit: FitAddon;
  extras: EnhancedTerminal;
  session: TerminalSession | null;
  exited: boolean;
}

export interface NewTerminalRequest {
  /** Typed into the shell once it starts (tasks, Run Recent Command). */
  command?: string;
  cwd?: string;
  name?: string;
  // ── Run hub: a terminal the Run hub owns (dev servers), so it can follow, reveal and stop it ──
  owner?: TerminalOwner;
}

/** A terminal started for someone (the Run hub): its output, its end, and a handle to drive it. */
export interface TerminalOwner {
  onData?(data: string): void;
  onExit?(code: number | null): void;
  onReady?(handle: OwnedTerminal): void;
  /** The shell could not start. */
  onError?(message: string): void;
}

export interface OwnedTerminal {
  id: number;
  write(data: string): void;
  kill(): void;
  /** Shows this terminal in the Panel. */
  reveal(): void;
}

let seq = 0;

export function TerminalView({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  // Terminals whose shell has printed something (until then a skeleton stands in for the prompt).
  const [started, setStarted] = useState<ReadonlySet<number>>(() => new Set());
  const markStarted = (id: number) => setStarted((s) => (s.has(id) ? s : new Set(s).add(id)));
  const theme = useThemes((s) => s.active?.id ?? "dark-modern");
  const fontSize = useWorkbench((s) => s.settings["terminal.integrated.fontSize"]);
  const workspace = useWorkbench((s) => s.workspace);
  const platform = getPlatform();
  const supported = !!platform.terminal;

  const live = useRef<Instance[]>([]);
  live.current = instances;
  // One spawn at a time (StrictMode runs effects twice in development).
  const spawning = useRef(false);
  // Bumped when the workspace changes: a shell still spawning for the old folder is discarded on arrival.
  const epoch = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Requests that arrive while a shell is starting wait their turn (a task must never be dropped).
  const queued = useRef<NewTerminalRequest[]>([]);
  const create = async (req: NewTerminalRequest = {}) => {
    if (!platform.terminal) return;
    if (spawning.current) {
      if (req.command || req.owner) queued.current.push(req);
      return;
    }
    spawning.current = true;
    const myEpoch = epoch.current;
    const term = new Terminal({
      fontFamily: defaultFontFamily(platform.os),
      fontSize,
      // VS Code: a blinking bar while focused, an outline when not, so the cursor is always visible.
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      // Unicode 11 widths (emoji, CJK) are a "proposed" xterm API.
      allowProposedApi: true,
      scrollback: 5000,
      theme: terminalTheme(useThemes.getState().active?.id ?? "dark-modern"),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const extras = enhanceTerminal(term);
    const inst: Instance = { id: ++seq, name: req.name ?? "", term, fit, extras, session: null, exited: false };
    setInstances((list) => [...list, inst]);
    setActiveId(inst.id);
    try {
      const session = await platform.terminal.spawn({
        cols: 80,
        rows: 24,
        cwd: req.cwd,
        onData: (d) => {
          markStarted(inst.id);
          term.write(d);
          req.owner?.onData?.(d);
          extras.observe(d);
        },
        onExit: (code) => {
          markStarted(inst.id);
          inst.exited = true;
          term.write(`\r\n\x1b[90m[process exited with code ${code ?? "?"}]\x1b[0m\r\n`);
          req.owner?.onExit?.(code);
        },
      });
      if (epoch.current !== myEpoch) {
        // The folder changed while the shell started (session restore at launch): this one belongs to nothing.
        session.kill();
        extras.dispose();
        term.dispose();
        spawning.current = false;
        if (visibleRef.current && live.current.length === 0) void create(req);
        return;
      }
      inst.session = session;
      const tracker = new CommandLineTracker((cmd) => recordCommand(cmd));
      term.onData((d) => {
        tracker.feed(d);
        inst.session?.write(d);
      });
      req.owner?.onReady?.({
        id: inst.id,
        write: (d) => inst.session?.write(d),
        kill: () => inst.session?.kill(),
        reveal: () => {
          showPanel("terminal");
          setActiveId(inst.id);
        },
      });
      if (req.command) {
        recordCommand(req.command);
        // Give the shell a moment to print its prompt, as VS Code's task terminals do.
        setTimeout(() => inst.session?.write(`${req.command}\r`), 350);
      }
      term.onResize(({ cols, rows }) => inst.session?.resize(cols, rows));
      log("Terminal", `Started terminal ${inst.id}`);
    } catch (e) {
      markStarted(inst.id);
      term.write(`\x1b[31mCould not start a shell: ${String((e as Error)?.message ?? e)}\x1b[0m\r\n`);
      notify("error", "The terminal could not be started.");
      req.owner?.onError?.(String((e as Error)?.message ?? e));
    } finally {
      if (epoch.current === myEpoch) spawning.current = false;
    }
    const next = queued.current.shift();
    if (next) void create(next);
  };

  // Mount the active instance into the host element.
  useEffect(() => {
    const el = host.current;
    const inst = instances.find((i) => i.id === activeId);
    if (!el) return;
    el.replaceChildren();
    if (!inst) return;
    setActiveTerminal(inst.term);
    // Dev builds: the UI probe drives the active terminal directly (selection drawing vs mouse input).
    if (import.meta.env?.DEV) (window as unknown as { __TMCODE_TERM__?: Terminal }).__TMCODE_TERM__ = inst.term;
    if (!inst.term.element) inst.term.open(el);
    else el.appendChild(inst.term.element);
    requestAnimationFrame(() => {
      try {
        inst.fit.fit();
        inst.session?.resize(inst.term.cols, inst.term.rows);
      } catch {
        /* host not laid out yet */
      }
      if (visible) inst.term.focus();
    });
  }, [activeId, instances, visible]);

  // Re-fit on panel resize.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const inst = instances.find((i) => i.id === activeId);
      if (!inst || !el.offsetParent) return;
      try {
        inst.fit.fit();
      } catch {
        /* ignore */
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [activeId, instances]);

  useEffect(() => {
    for (const i of instances) {
      i.term.options.theme = terminalTheme(theme);
      i.term.options.fontSize = fontSize;
    }
  }, [theme, fontSize, instances]);

  // First show creates a terminal (again after the folder changes); "New Terminal" adds one.
  useEffect(() => {
    if (visible && supported && live.current.length === 0) void create();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, supported, workspace?.root]);
  useEffect(() => {
    const onNew = (e: Event) => void create((e as CustomEvent<NewTerminalRequest | undefined>).detail ?? {});
    const onRun = (e: Event) => {
      const cmd = (e as CustomEvent<string>).detail;
      const inst = live.current.find((i) => i.id === activeId && !i.exited);
      if (inst?.session) {
        inst.session.write(`${cmd}\r`);
        recordCommand(cmd);
        inst.term.focus();
      } else void create({ command: cmd });
    };
    const onFind = () => setFinding(true);
    window.addEventListener("tmcode:new-terminal", onNew);
    window.addEventListener("tmcode:terminal-run", onRun);
    window.addEventListener("tmcode:terminal-find", onFind);
    return () => {
      window.removeEventListener("tmcode:new-terminal", onNew);
      window.removeEventListener("tmcode:terminal-run", onRun);
      window.removeEventListener("tmcode:terminal-find", onFind);
    };
  });

  // A new workspace means a new cwd: close shells from the old one (and all of them on unmount).
  useEffect(() => {
    return () => {
      for (const i of live.current) {
        i.session?.kill();
        i.extras.dispose();
        i.term.dispose();
      }
      live.current = [];
      setInstances([]);
      setActiveId(null);
      // A spawn in flight is now stale; let the new folder start its own shell right away.
      epoch.current++;
      spawning.current = false;
    };
  }, [workspace?.root]);

  const kill = (id: number) => {
    const inst = instances.find((i) => i.id === id);
    inst?.session?.kill();
    inst?.extras.dispose();
    inst?.term.dispose();
    const rest = instances.filter((i) => i.id !== id);
    setInstances(rest);
    setActiveId(rest[rest.length - 1]?.id ?? null);
  };

  const activeInstance = instances.find((i) => i.id === activeId);

  if (!supported) {
    return (
      <div className="tm-panel-empty" hidden={!visible}>
        <Codicon name="terminal" /> The integrated terminal is available in the TMCode desktop app.
      </div>
    );
  }

  return (
    <div className="tm-terminal" hidden={!visible}>
      <div ref={host} className="tm-terminal-host" data-testid="integrated-terminal" />
      {activeInstance && !started.has(activeInstance.id) && <ShellStarting />}
      {finding && activeInstance && <TerminalFind key={activeInstance.id} inst={activeInstance} onClose={() => setFinding(false)} />}
      {instances.length > 1 && (
        <ul className="tm-terminal-list" aria-label="Terminals">
          {instances.map((i, n) => (
            <li key={i.id} className={i.id === activeId ? "is-active" : ""}>
              <button type="button" onClick={() => setActiveId(i.id)}>
                <Codicon name={i.name ? "tools" : "terminal"} /> {i.name || `${n + 1}: ${shellName(platform.os)}`}
              </button>
              <button type="button" className="tm-terminal-kill" aria-label="Kill terminal" title="Kill Terminal" onClick={() => kill(i.id)}>
                <Codicon name="trash" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown only if the shell is slow to print its prompt (login shells, cold disks), so fast starts never flash. */
function ShellStarting() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 150);
    return () => clearTimeout(t);
  }, []);
  return show ? (
    <div className="tm-terminal-starting">
      <SkeletonLines lines={3} label="Starting the shell" />
    </div>
  ) : null;
}

function shellName(os: string) {
  return os === "windows" ? "powershell" : os === "mac" ? "zsh" : "bash";
}

/** VS Code's terminal find widget: incremental, case/word/regex toggles, match count. */
function TerminalFind({ inst, onClose }: { inst: Instance; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false });
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const search = inst.extras.search;

  useEffect(() => {
    input.current?.focus();
    const sub = search.onDidChangeResults((r) => setResult(r ? { index: r.resultIndex, count: r.resultCount } : null));
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  const decorations = {
    matchOverviewRuler: "#d18616",
    activeMatchColorOverviewRuler: "#a0a0a0",
    matchBackground: "#623315",
    activeMatchBackground: "#515c6a",
  };
  const find = (dir: 1 | -1, incremental = false) => {
    if (!query) return search.clearDecorations();
    const o = { ...opts, incremental, decorations };
    if (dir > 0) search.findNext(query, o);
    else search.findPrevious(query, o);
  };
  useEffect(() => {
    find(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts]);

  const close = () => {
    onClose();
    inst.term.focus();
  };
  const toggle = (k: keyof typeof opts, icon: string, label: string) => (
    <ActionButton icon={icon} label={label} active={opts[k]} aria-pressed={opts[k]} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))} />
  );

  return (
    <div className="tm-find-widget tm-terminal-find" role="search">
      <div className="tm-input-box">
        <input
          ref={input}
          className="tm-input"
          placeholder="Find"
          aria-label="Find in terminal"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") find(e.shiftKey ? -1 : 1);
            else if (e.key === "Escape") close();
            else return;
            e.preventDefault();
          }}
        />
        {toggle("caseSensitive", "case-sensitive", "Match Case")}
        {toggle("wholeWord", "whole-word", "Match Whole Word")}
        {toggle("regex", "regex", "Use Regular Expression")}
      </div>
      <span className={`tm-find-count ${query && result?.count === 0 ? "is-empty" : ""}`}>
        {!query ? "No results" : result ? (result.count ? `${result.index + 1} of ${result.count}` : "No results") : ""}
      </span>
      <ActionButton icon="arrow-up" label="Previous Match (Shift+Enter)" onClick={() => find(-1)} />
      <ActionButton icon="arrow-down" label="Next Match (Enter)" onClick={() => find(1)} />
      <ActionButton icon="close" label="Close (Escape)" onClick={close} />
    </div>
  );
}
