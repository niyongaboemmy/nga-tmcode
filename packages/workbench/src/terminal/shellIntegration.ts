import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

/**
 * Shell integration, as VS Code's terminal reads it: the shell scripts TMCode
 * injects (src-tauri/src/shell_integration) mark each prompt and command with
 * OSC 633 sequences:
 *   A  prompt starts        B  prompt ends (the command is typed after it)
 *   E;<command line>        C  the command's output starts
 *   D;<exit code>           P;Cwd=<folder>
 * From them each terminal knows its commands (where they are, what they were,
 * how they ended), draws a dot beside each one and can jump between them.
 */

export interface TerminalCommand {
  /** The prompt's first line. */
  prompt: IMarker;
  /** Where the command is typed (end of the prompt), and its column. */
  input?: IMarker;
  inputX?: number;
  /** First line of the output. */
  output?: IMarker;
  /** The line after the output (the next prompt). */
  end?: IMarker;
  command: string;
  exitCode?: number;
  cwd?: string;
  decoration?: IDecoration;
}

export type CommandState = "running" | "success" | "error";

export function stateOf(c: TerminalCommand): CommandState {
  if (c.exitCode === undefined) return "running";
  return c.exitCode === 0 ? "success" : "error";
}

/** 633 text: "\\\\" is a backslash and "\\xNN" a character (";" arrives as "\\x3b"). */
export function decode633(value: string): string {
  return value.replace(/\\\\|\\x([0-9a-fA-F]{2})/g, (_m, hex: string | undefined) => (hex ? String.fromCharCode(parseInt(hex, 16)) : "\\"));
}

export type Osc633 =
  | { kind: "A" | "B" | "C" }
  | { kind: "D"; exitCode?: number }
  | { kind: "E"; command: string }
  | { kind: "P"; key: string; value: string }
  | { kind: "unknown" };

export function parse633(data: string): Osc633 {
  const [kind, ...rest] = data.split(";");
  switch (kind) {
    case "A":
    case "B":
    case "C":
      return { kind };
    case "D": {
      const n = rest.length ? Number(rest[0]) : NaN;
      return { kind: "D", exitCode: Number.isFinite(n) ? n : undefined };
    }
    case "E":
      // A nonce may follow (VS Code's); the command line is the first field.
      return { kind: "E", command: decode633(rest[0] ?? "") };
    case "P": {
      const prop = rest.join(";");
      const eq = prop.indexOf("=");
      return eq < 0 ? { kind: "unknown" } : { kind: "P", key: prop.slice(0, eq), value: decode633(prop.slice(eq + 1)) };
    }
    default:
      return { kind: "unknown" };
  }
}

/** Keeps the last commands only (their markers go with the scrollback anyway). */
const MAX_COMMANDS = 500;

export interface ShellIntegration extends IDisposable {
  /** True once the shell sent its first 633 mark. */
  readonly active: boolean;
  readonly commands: readonly TerminalCommand[];
  readonly cwd: string | undefined;
  /** The command still running, if any. */
  readonly current: TerminalCommand | undefined;
  /** A command started, finished, or the list changed. */
  onChange(listener: () => void): IDisposable;
  /** The text a command printed. */
  outputOf(c: TerminalCommand): string;
  /** What is typed at the prompt now (null: a command runs, or no prompt is known). */
  promptInput(): string | null;
}

/**
 * Reads OSC 633 from `term`; `decorate` draws a command's dot when it starts
 * and again when it ends (the caller owns the look).
 */
export function attachShellIntegration(term: Terminal, decorate?: (c: TerminalCommand, term: Terminal) => void): ShellIntegration {
  const commands: TerminalCommand[] = [];
  const listeners = new Set<() => void>();
  let active = false;
  let cwd: string | undefined;
  let pending: TerminalCommand | undefined;
  let current: TerminalCommand | undefined;
  const changed = () => listeners.forEach((l) => l());

  const finish = (exitCode: number | undefined) => {
    const c = current;
    if (!c) return;
    current = undefined;
    // "D" without a code: the command was cancelled before it ran (an empty line, Ctrl+C at the prompt).
    c.exitCode = exitCode ?? 0;
    c.end = term.registerMarker(0);
    decorate?.(c, term);
    changed();
  };

  const handler = term.parser.registerOscHandler(633, (data) => {
    const mark = parse633(data);
    if (mark.kind === "unknown") return true;
    active = true;
    switch (mark.kind) {
      case "A": {
        // A prompt while a command is still open: it ended without telling (the shell was replaced).
        if (current) finish(undefined);
        const prompt = term.registerMarker(0);
        if (prompt) pending = { prompt, command: "", cwd };
        break;
      }
      case "B":
        if (pending) {
          pending.input = term.registerMarker(0);
          pending.inputX = term.buffer.active.cursorX;
        }
        break;
      case "E":
        if (pending) pending.command = mark.command;
        else if (current) current.command = mark.command;
        break;
      case "C": {
        const c = pending;
        pending = undefined;
        if (!c) break;
        if (!c.command) c.command = readInput(term, c);
        c.output = term.registerMarker(0);
        current = c;
        commands.push(c);
        while (commands.length > MAX_COMMANDS) commands.shift()?.decoration?.dispose();
        decorate?.(c, term);
        changed();
        break;
      }
      case "D":
        finish(mark.exitCode);
        break;
      case "P":
        if (mark.key === "Cwd") {
          cwd = mark.value;
          changed();
        }
        break;
    }
    return true;
  });

  return {
    get active() {
      return active;
    },
    get commands() {
      // Markers dispose when their line leaves the scrollback: those commands are gone.
      return commands.filter((c) => !c.prompt.isDisposed);
    },
    get cwd() {
      return cwd;
    },
    get current() {
      return current;
    },
    onChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    outputOf(c) {
      if (!c.output || c.output.isDisposed) return "";
      const last = (c.end && !c.end.isDisposed ? c.end.line : term.buffer.active.baseY + term.buffer.active.cursorY) - 1;
      const lines: string[] = [];
      for (let y = c.output.line; y <= last; y++) {
        const line = term.buffer.active.getLine(y);
        if (!line) break;
        const text = line.translateToString(true);
        // A wrapped line continues the one before it.
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      return lines.join("\n").replace(/\s+$/, "");
    },
    promptInput() {
      if (current || !pending?.input || pending.input.isDisposed) return null;
      const buf = term.buffer.active;
      let text = lineText(term, pending.input.line).slice(pending.inputX ?? 0);
      // A long line wraps onto the next rows.
      for (let y = pending.input.line + 1; y <= buf.baseY + buf.cursorY; y++) {
        const line = buf.getLine(y);
        if (!line?.isWrapped) break;
        text += line.translateToString(true);
      }
      return text.trimEnd();
    },
    dispose() {
      handler.dispose();
      for (const c of commands) c.decoration?.dispose();
      commands.length = 0;
      listeners.clear();
    },
  };
}

function lineText(term: Terminal, y: number) {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? "";
}

/** The typed command when the shell sent no E: the text after the prompt on the input line. */
function readInput(term: Terminal, c: TerminalCommand) {
  if (!c.input || c.input.isDisposed) return "";
  return lineText(term, c.input.line).slice(c.inputX ?? 0).trim();
}

/** The command whose prompt is nearest above (`dir` -1) or below (+1) `line`. */
export function neighbourCommand(commands: readonly TerminalCommand[], line: number, dir: -1 | 1): TerminalCommand | undefined {
  const sorted = commands.filter((c) => !c.prompt.isDisposed);
  if (dir < 0) {
    for (let i = sorted.length - 1; i >= 0; i--) if (sorted[i].prompt.line < line) return sorted[i];
    return undefined;
  }
  return sorted.find((c) => c.prompt.line > line);
}

/** The command a viewport starting at `top` is inside of (its prompt above the top, its output still showing). */
export function stickyCommand(commands: readonly TerminalCommand[], top: number): TerminalCommand | undefined {
  for (let i = commands.length - 1; i >= 0; i--) {
    const c = commands[i];
    if (c.prompt.isDisposed) continue;
    if (c.prompt.line >= top) continue;
    const end = c.end && !c.end.isDisposed ? c.end.line : Infinity;
    // Only while some of its output is still on screen, below the pinned line.
    return end > top + 1 ? c : undefined;
  }
  return undefined;
}
