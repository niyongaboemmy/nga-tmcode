import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { defaultFontFamily } from "../../state/settings";
import { getPlatform, log, notify, useWorkbench } from "../../state/store";
import type { TerminalSession } from "../../platform/types";
import { Codicon } from "../../widgets/icons";

/** Terminal colours from VS Code's Dark Modern / Light Modern. */
export function terminalTheme(theme: string): ITheme {
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
  term: Terminal;
  fit: FitAddon;
  session: TerminalSession | null;
  exited: boolean;
}

let seq = 0;

export function TerminalView({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const theme = useWorkbench((s) => s.previewTheme ?? s.settings["workbench.colorTheme"]);
  const fontSize = useWorkbench((s) => s.settings["terminal.integrated.fontSize"]);
  const workspace = useWorkbench((s) => s.workspace);
  const platform = getPlatform();
  const supported = !!platform.terminal;

  const live = useRef<Instance[]>([]);
  live.current = instances;
  // One spawn at a time (StrictMode runs effects twice in development).
  const spawning = useRef(false);
  const create = async () => {
    if (!platform.terminal || spawning.current) return;
    spawning.current = true;
    const term = new Terminal({
      fontFamily: defaultFontFamily(platform.os),
      fontSize,
      // VS Code: a blinking bar while focused, an outline when not, so the cursor is always visible.
      cursorBlink: true,
      cursorStyle: "bar",
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      allowProposedApi: false,
      scrollback: 5000,
      theme: terminalTheme(useWorkbench.getState().settings["workbench.colorTheme"]),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const inst: Instance = { id: ++seq, term, fit, session: null, exited: false };
    setInstances((list) => [...list, inst]);
    setActiveId(inst.id);
    try {
      inst.session = await platform.terminal.spawn({
        cols: 80,
        rows: 24,
        onData: (d) => term.write(d),
        onExit: (code) => {
          inst.exited = true;
          term.write(`\r\n\x1b[90m[process exited with code ${code ?? "?"}]\x1b[0m\r\n`);
        },
      });
      term.onData((d) => inst.session?.write(d));
      term.onResize(({ cols, rows }) => inst.session?.resize(cols, rows));
      log("Terminal", `Started terminal ${inst.id}`);
    } catch (e) {
      term.write(`\x1b[31mCould not start a shell: ${String((e as Error)?.message ?? e)}\x1b[0m\r\n`);
      notify("error", "The terminal could not be started.");
    } finally {
      spawning.current = false;
    }
  };

  // Mount the active instance into the host element.
  useEffect(() => {
    const el = host.current;
    const inst = instances.find((i) => i.id === activeId);
    if (!el || !inst) return;
    el.replaceChildren();
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
    const onNew = () => void create();
    window.addEventListener("tmcode:new-terminal", onNew);
    return () => window.removeEventListener("tmcode:new-terminal", onNew);
  });

  // A new workspace means a new cwd: close shells from the old one (and all of them on unmount).
  useEffect(() => {
    return () => {
      for (const i of live.current) {
        i.session?.kill();
        i.term.dispose();
      }
      live.current = [];
      setInstances([]);
      setActiveId(null);
    };
  }, [workspace?.root]);

  const kill = (id: number) => {
    const inst = instances.find((i) => i.id === id);
    inst?.session?.kill();
    inst?.term.dispose();
    const rest = instances.filter((i) => i.id !== id);
    setInstances(rest);
    setActiveId(rest[rest.length - 1]?.id ?? null);
  };

  if (!supported) {
    return (
      <div className="tm-panel-empty" hidden={!visible}>
        <Codicon name="terminal" /> The integrated terminal is available in the TMCode desktop app.
      </div>
    );
  }

  return (
    <div className="tm-terminal" hidden={!visible}>
      <div ref={host} className="tm-terminal-host" />
      {instances.length > 1 && (
        <ul className="tm-terminal-list" aria-label="Terminals">
          {instances.map((i, n) => (
            <li key={i.id} className={i.id === activeId ? "is-active" : ""}>
              <button type="button" onClick={() => setActiveId(i.id)}>
                <Codicon name="terminal" /> {n + 1}: shell
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
