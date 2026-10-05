import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onConsole, sendRunInput, setConsoleSize, type ConsoleEvent } from "../../run/runService";
import { defaultFontFamily } from "../../state/settings";
import { getPlatform, useWorkbench } from "../../state/store";
import { terminalTheme } from "./TerminalView";
import { enhanceTerminal } from "../../terminal/enhance";

const DIM = "\x1b[90m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";

function seconds(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** Turns runner events into console text (pipe output needs \r\n for xterm). */
export function renderConsoleEvent(e: ConsoleEvent, interactive: boolean): string | "clear" | null {
  const nl = (s: string) => (interactive ? s : s.replace(/\r?\n/g, "\r\n"));
  switch (e.type) {
    case "clear":
      return "clear";
    case "step":
      return `${DIM}> ${e.phase === "build" ? "Building: " : ""}${e.command}${RESET}\r\n`;
    case "stdout":
      return nl(e.data);
    case "stderr":
      return `${RED}${nl(e.data)}${RESET}`;
    case "error":
      return `\r\n${RED}${e.message}${RESET}\r\n`;
    case "info":
      return `${DIM}${e.text}${RESET}\r\n`;
    case "exit": {
      if (e.phase === "build") return e.code === 0 ? "" : `\r\n${RED}Build failed (exit code ${e.code}). See Problems for the errors.${RESET}\r\n`;
      const why = e.killed
        ? "stopped"
        : e.timed_out
          ? "timed out"
          : e.truncated
            ? "stopped: too much output"
            : `exited with code ${e.code ?? "?"}`;
      const colour = !e.killed && !e.timed_out && e.code === 0 ? GREEN : e.killed ? DIM : RED;
      return `\r\n${colour}[${why} in ${seconds(e.duration_ms)}]${RESET}\r\n`;
    }
  }
}

export function RunConsole({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const theme = useWorkbench((s) => s.previewTheme ?? s.settings["workbench.colorTheme"]);
  const fontSize = useWorkbench((s) => s.settings["terminal.integrated.fontSize"]);
  const platform = getPlatform();
  const interactive = !!platform.runner?.interactive;

  useEffect(() => {
    const term = new Terminal({
      fontFamily: defaultFontFamily(platform.os),
      fontSize: useWorkbench.getState().settings["terminal.integrated.fontSize"],
      convertEol: false,
      cursorBlink: interactive,
      disableStdin: !interactive,
      scrollback: 10000,
      allowProposedApi: true,
      theme: terminalTheme(useWorkbench.getState().settings["workbench.colorTheme"]),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const extras = enhanceTerminal(term);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    const off = onConsole((e) => {
      const out = renderConsoleEvent(e, interactive);
      if (out === "clear") term.reset();
      else if (out) {
        term.write(out);
        if (e.type === "stdout" || e.type === "stderr") extras.observe(out);
      }
    });
    const input = term.onData((d) => {
      if (useWorkbench.getState().run.status === "running") sendRunInput(d);
    });
    const ro = new ResizeObserver(() => {
      if (!host.current?.offsetParent) return;
      try {
        fit.fit();
        setConsoleSize(term.cols, term.rows);
      } catch {
        /* not laid out */
      }
    });
    ro.observe(host.current!);
    return () => {
      ro.disconnect();
      off();
      input.dispose();
      extras.dispose();
      term.dispose();
    };
  }, [interactive, platform.os]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = terminalTheme(theme);
    term.options.fontSize = fontSize;
  }, [theme, fontSize]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      if (interactive) termRef.current?.focus();
    });
  }, [visible, interactive]);

  return (
    <div className="tm-terminal" hidden={!visible}>
      <div ref={host} className="tm-terminal-host" data-testid="run-console" />
    </div>
  );
}
