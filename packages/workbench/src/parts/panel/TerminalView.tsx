import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
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
import { defaultProfileSetting, fallbackShellName, loadTerminalProfiles, pickProfile } from "../../terminal/profiles";

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
  /** Split terminals share a group and show side by side. */
  group: number;
  /** Its own name (renamed, or a task's); "" = the shell's. */
  name: string;
  /** The shell's name: "zsh", "bash", "PowerShell", "Git Bash"… */
  shell: string;
  profile?: string;
  cwd?: string;
  /** Started for a task or the Run hub: probably running a program. */
  owned: boolean;
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
  /** A shell profile id (terminal/profiles.ts); absent = the default profile. */
  profile?: string;
  /** Split this terminal: the new one shows beside it. */
  splitOf?: number;
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

/** Terminals in the panel, for the panel header (the ⌄ menu, split and kill act on the active one). */
export const useTerminalPanel = create<{ count: number; activeName: string | null }>(() => ({ count: 0, activeName: null }));

/** Asks the terminal view to do something (from the panel header and the Terminal commands). */
export function terminalAction(action: "split" | "kill" | "rename", detail?: unknown) {
  window.dispatchEvent(new CustomEvent(`tmcode:terminal-${action}`, { detail }));
}

/** The name on a terminal's tab: its own (renamed, task), else the shell's ("zsh", "PowerShell"). */
function labelOf(i: Instance) {
  return i.name || i.shell;
}

export function TerminalView({ visible }: { visible: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const hosts = useRef(new Map<number, HTMLDivElement>());
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
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
  const activeRef = useRef<number | null>(null);
  activeRef.current = activeId;
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
      if (req.command || req.owner || req.splitOf != null) queued.current.push(req);
      return;
    }
    spawning.current = true;
    const myEpoch = epoch.current;
    const profiles = await loadTerminalProfiles();
    const parent = req.splitOf != null ? live.current.find((i) => i.id === req.splitOf) : undefined;
    // A split starts the same shell as the terminal it splits, as in VS Code.
    const profile = pickProfile(profiles, req.profile ?? parent?.profile, defaultProfileSetting());
    const term = new Terminal({
      fontFamily: defaultFontFamily(platform.os),
      fontSize: useWorkbench.getState().settings["terminal.integrated.fontSize"],
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
    const id = ++seq;
    const inst: Instance = {
      id,
      group: parent?.group ?? id,
      name: req.name ?? "",
      shell: profile?.name ?? fallbackShellName(platform.os),
      profile: profile?.id,
      owned: !!req.owner || !!req.command,
      term,
      fit,
      extras,
      session: null,
      exited: false,
    };
    setInstances((list) => {
      if (!parent) return [...list, inst];
      // After the last terminal of the parent's group, so split panes stay together.
      const last = list.map((x) => x.group).lastIndexOf(parent.group);
      const next = [...list];
      next.splice(last + 1, 0, inst);
      return next;
    });
    setActiveId(inst.id);
    try {
      const session = await platform.terminal.spawn({
        cols: 80,
        rows: 24,
        cwd: req.cwd ?? parent?.cwd,
        profile: profile?.id,
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
      inst.cwd = req.cwd ?? parent?.cwd;
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
      log("Terminal", `Started terminal ${inst.id} (${inst.shell})`);
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

  const active = instances.find((i) => i.id === activeId) ?? null;
  // The active terminal's group: split terminals show side by side.
  const shown = active ? instances.filter((i) => i.group === active.group) : [];

  useEffect(() => {
    useTerminalPanel.setState({ count: instances.length, activeName: active ? labelOf(active) : null });
  }, [instances, active]);

  // Mount the shown terminals into their hosts.
  useEffect(() => {
    for (const inst of shown) {
      const el = hosts.current.get(inst.id);
      if (!el) continue;
      if (!inst.term.element) inst.term.open(el);
      else if (inst.term.element.parentElement !== el) el.replaceChildren(inst.term.element);
    }
    if (active) {
      setActiveTerminal(active.term);
      // Dev builds: the UI probe drives the active terminal directly (selection drawing vs mouse input).
      if (import.meta.env?.DEV) (window as unknown as { __TMCODE_TERM__?: Terminal }).__TMCODE_TERM__ = active.term;
    }
    requestAnimationFrame(() => {
      for (const inst of shown) {
        try {
          inst.fit.fit();
          inst.session?.resize(inst.term.cols, inst.term.rows);
        } catch {
          /* host not laid out yet */
        }
      }
      if (visible && active && !renaming) active.term.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, instances, visible]);

  // Re-fit on panel resize.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!el.offsetParent) return;
      for (const inst of live.current.filter((i) => hosts.current.has(i.id))) {
        try {
          inst.fit.fit();
        } catch {
          /* ignore */
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    const onSplit = () => (activeRef.current != null ? void create({ splitOf: activeRef.current }) : void create());
    const onKill = () => activeRef.current != null && kill(activeRef.current);
    const onRename = (e: Event) => {
      const name = (e as CustomEvent<string | undefined>).detail;
      const id = activeRef.current;
      if (id == null) return;
      if (typeof name === "string") rename(id, name);
      else setRenaming(id);
    };
    window.addEventListener("tmcode:new-terminal", onNew);
    window.addEventListener("tmcode:terminal-run", onRun);
    window.addEventListener("tmcode:terminal-find", onFind);
    window.addEventListener("tmcode:terminal-split", onSplit);
    window.addEventListener("tmcode:terminal-kill", onKill);
    window.addEventListener("tmcode:terminal-rename", onRename);
    return () => {
      window.removeEventListener("tmcode:new-terminal", onNew);
      window.removeEventListener("tmcode:terminal-run", onRun);
      window.removeEventListener("tmcode:terminal-find", onFind);
      window.removeEventListener("tmcode:terminal-split", onSplit);
      window.removeEventListener("tmcode:terminal-kill", onKill);
      window.removeEventListener("tmcode:terminal-rename", onRename);
    };
  });

  // A new folder means a new cwd: close shells from the old one (and all of them on unmount), as VS Code does.
  useEffect(() => {
    const root = workspace?.root;
    return () => {
      const closing = live.current;
      live.current = [];
      setInstances([]);
      setActiveId(null);
      // A spawn in flight is now stale; let the new folder start its own shell right away.
      epoch.current++;
      spawning.current = false;
      const folderChanged = useWorkbench.getState().workspace?.root !== root;
      void (async () => {
        // Ask before killing: a program still running is worth a word (Windows can't tell, so tasks count).
        const busy = folderChanged
          ? (await Promise.all(closing.map(async (i) => !i.exited && ((await i.session?.busy?.().catch(() => false)) || (i.owned && !i.session?.busy))))).filter(Boolean).length
          : 0;
        for (const i of closing) {
          i.session?.kill();
          i.extras.dispose();
          i.term.dispose();
        }
        if (busy) notify("info", `${busy === 1 ? "A terminal was" : `${busy} terminals were`} still running a program and ${busy === 1 ? "was" : "were"} closed. Terminals don't move to a new folder.`);
      })();
    };
  }, [workspace?.root]);

  const kill = (id: number) => {
    const list = live.current;
    const inst = list.find((i) => i.id === id);
    inst?.session?.kill();
    inst?.extras.dispose();
    inst?.term.dispose();
    hosts.current.delete(id);
    const rest = list.filter((i) => i.id !== id);
    // The split's other pane, else the last terminal, becomes active.
    const siblings = inst ? rest.filter((i) => i.group === inst.group) : [];
    setInstances(rest);
    setActiveId(siblings[siblings.length - 1]?.id ?? rest[rest.length - 1]?.id ?? null);
  };

  const rename = (id: number, name: string) => {
    setRenaming(null);
    setInstances((list) => list.map((i) => (i.id === id ? Object.assign(i, { name: name.trim() }) : i)));
  };

  if (!supported) {
    return (
      <div className="tm-panel-empty" hidden={!visible}>
        <Codicon name="terminal" /> The integrated terminal is available in the TMCode desktop app.
      </div>
    );
  }

  const groupsInOrder = [...new Set(instances.map((i) => i.group))];
  return (
    <div className="tm-terminal" hidden={!visible}>
      <div ref={area} className="tm-terminal-area">
        {shown.map((inst) => (
          <div
            key={inst.id}
            className={`tm-terminal-pane ${inst.id === activeId && shown.length > 1 ? "is-active" : ""}`}
            onMouseDown={() => inst.id !== activeId && setActiveId(inst.id)}
          >
            <div
              ref={(el) => {
                if (el) hosts.current.set(inst.id, el);
                else hosts.current.delete(inst.id);
              }}
              className="tm-terminal-host"
              data-testid={inst.id === activeId ? "integrated-terminal" : "integrated-terminal-split"}
              aria-label={`Terminal ${labelOf(inst)}`}
            />
            {!started.has(inst.id) && <ShellStarting />}
          </div>
        ))}
      </div>
      {finding && active && <TerminalFind key={active.id} inst={active} onClose={() => setFinding(false)} />}
      {renaming != null && instances.length <= 1 && (
        <div className="tm-terminal-rename-float">
          <RenameInput initial={labelOf(instances.find((i) => i.id === renaming) ?? instances[0])} onDone={(v) => (v === null ? setRenaming(null) : rename(renaming, v))} />
        </div>
      )}
      {instances.length > 1 && (
        <ul className="tm-terminal-list" aria-label="Terminals">
          {groupsInOrder.flatMap((g, gi) => {
            const members = instances.filter((i) => i.group === g);
            return members.map((i, mi) => (
              <li key={i.id} className={i.id === activeId ? "is-active" : ""} data-terminal={i.id}>
                {renaming === i.id ? (
                  <RenameInput initial={labelOf(i)} onDone={(v) => (v === null ? setRenaming(null) : rename(i.id, v))} />
                ) : (
                  <button type="button" onClick={() => setActiveId(i.id)} onDoubleClick={() => setRenaming(i.id)} title={`${labelOf(i)} (double-click to rename)`}>
                    {members.length > 1 && <span className="tm-terminal-tree">{mi === members.length - 1 ? "└" : mi === 0 ? "┌" : "├"}</span>}
                    <Codicon name={i.owned ? "tools" : "terminal"} /> {members.length > 1 || mi > 0 ? "" : `${gi + 1}: `}
                    {labelOf(i)}
                  </button>
                )}
                <button type="button" className="tm-terminal-kill" aria-label={`Split ${labelOf(i)}`} title="Split Terminal" onClick={() => void create({ splitOf: i.id })}>
                  <Codicon name="split-horizontal" />
                </button>
                <button type="button" className="tm-terminal-kill" aria-label="Kill terminal" title="Kill Terminal" onClick={() => kill(i.id)}>
                  <Codicon name="trash" />
                </button>
              </li>
            ));
          })}
        </ul>
      )}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="tm-input tm-terminal-rename"
      aria-label="Terminal name"
      autoFocus
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(value);
        else if (e.key === "Escape") onDone(null);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    />
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
