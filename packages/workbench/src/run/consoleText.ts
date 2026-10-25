import { ansiCommand, formatDuration } from "../activity/format";
import type { RunEvent } from "../platform/types";

/**
 * The Run console's own lines (xterm ANSI): the command as a bold, coloured
 * `$ …` prompt, notes dimmed, and how the program ended as one status line
 * (✓ green, ✗ red, ■ stopped). Pure, so it is unit-tested.
 */

export type ConsoleTextEvent = RunEvent | { type: "clear" } | { type: "info"; text: string };

const DIM = "\x1b[90m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** "node sum.js (browser sandbox)" → the command, and the note in brackets after it. */
function splitNote(command: string): [string, string] {
  const m = /^(.*?)(\s+\([^()]*\))$/.exec(command);
  return m ? [m[1], m[2]] : [command, ""];
}

/**
 * Turns runner events into console text (pipe output needs \r\n for xterm). `atLineStart`: the
 * program's last output ended its line, so the status line needs one line break less to stand apart.
 */
export function renderConsoleEvent(e: ConsoleTextEvent, interactive: boolean, atLineStart = true): string | "clear" | null {
  const nl = (s: string) => (interactive ? s : s.replace(/\r?\n/g, "\r\n"));
  const gap = atLineStart ? "\r\n" : "\r\n\r\n";
  switch (e.type) {
    case "clear":
      return "clear";
    case "step": {
      const [cmd, note] = splitNote(e.command);
      const label = e.phase === "build" ? `${DIM}build${RESET} ` : "";
      return `${label}${GREEN}${BOLD}$${RESET} ${ansiCommand(cmd)}${note ? `${DIM}${note}${RESET}` : ""}\r\n`;
    }
    case "stdout":
      return nl(e.data);
    case "stderr":
      return `${RED}${nl(e.data)}${RESET}`;
    case "error":
      return `${atLineStart ? "" : "\r\n"}${RED}✗ ${e.message}${RESET}\r\n`;
    case "info":
      return e.text.startsWith("▶ ") ? `${CYAN}▶${RESET} ${DIM}${e.text.slice(2)}${RESET}\r\n` : `${DIM}${e.text}${RESET}\r\n`;
    case "exit": {
      if (e.phase === "build") return e.code === 0 ? "" : `${gap}${RED}${BOLD}✗${RESET}${RED} Build failed (exit code ${e.code}). See Problems for the errors.${RESET}\r\n`;
      const time = formatDuration(e.duration_ms);
      if (e.killed) return `${gap}${DIM}■ Process stopped after ${time}${RESET}\r\n`;
      if (e.timed_out) return `${gap}${RED}${BOLD}✗${RESET}${RED} Process timed out after ${time} and was stopped${RESET}\r\n`;
      if (e.truncated) return `${gap}${RED}${BOLD}✗${RESET}${RED} Process stopped: too much output (after ${time})${RESET}\r\n`;
      const ok = e.code === 0;
      return `${gap}${ok ? GREEN : RED}${BOLD}${ok ? "✓" : "✗"}${RESET}${ok ? GREEN : RED} Process exited with code ${e.code ?? "?"}${RESET}${DIM} in ${time}${RESET}\r\n`;
    }
  }
}
