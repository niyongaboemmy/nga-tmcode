import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onConsole, sendRunInput, setConsoleSize, stopRun } from "../../run/runService";
import { renderConsoleEvent } from "../../run/consoleText";
import { endRemoteInput, interruptRemoteRun, sendRemoteLine } from "../../run/serverRun";
import { defaultFontFamily } from "../../state/settings";
import { useThemes } from "../../themes/themeService";
import { getPlatform, useWorkbench } from "../../state/store";
import { terminalTheme } from "./TerminalView";
import { enhanceTerminal } from "../../terminal/enhance";

export function RunConsole({ visible }: { visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const theme = useThemes((s) => s.active?.id ?? "dark-modern");
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
      theme: terminalTheme(useThemes.getState().active?.id ?? "dark-modern"),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const extras = enhanceTerminal(term);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    // Whether the program's output ended its line (the status line then needs one break less).
    let atLineStart = true;
    const off = onConsole((e) => {
      const out = renderConsoleEvent(e, interactive, atLineStart);
      if (out === "clear") {
        term.reset();
        atLineStart = true;
      } else if (out) {
        term.write(out);
        atLineStart = /\n$/.test(out.replace(/\x1b\[[0-9;]*m/g, ""));
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
      <RemoteRunBar />
    </div>
  );
}

/** A run on Task Mentor: the program reads what is typed here, line by line. */
function RemoteRunBar() {
  const run = useWorkbench((s) => s.run);
  const [text, setText] = useState("");
  if (!run.remote || run.status === "idle") return null;
  return (
    <form
      className="tm-remote-run"
      data-testid="remote-run-bar"
      onSubmit={(e) => {
        e.preventDefault();
        sendRemoteLine(text);
        setText("");
      }}
    >
      <span className="tm-remote-run-where">On Task Mentor</span>
      <input className="tm-input" aria-label="Input for the program" placeholder="Type input, then press Enter" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      <button type="button" className="tm-button tm-button--secondary" onClick={interruptRemoteRun} title="Send Ctrl+C to the program">
        Ctrl+C
      </button>
      <button type="button" className="tm-button tm-button--secondary" onClick={endRemoteInput} title="Tell the program there is no more input (Ctrl+D)">
        End of Input
      </button>
      <button type="button" className="tm-button tm-button--secondary" onClick={stopRun}>
        Stop
      </button>
    </form>
  );
}
