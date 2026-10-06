/**
 * Commands typed into TMCode terminals, for "Run Recent Command" (VS Code's
 * Ctrl+Alt+R). Without shell integration we reconstruct the line from the
 * keystrokes sent to the shell: printable input, backspace, Ctrl+C/U to
 * discard, Enter to commit. Lines edited with arrow keys or history recall
 * are skipped rather than recorded wrongly.
 */

const KEY = "tmcode.terminal.history";
const MAX = 50;

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

let history = load();

export function recentCommands(): string[] {
  return history;
}

export function recordCommand(raw: string) {
  const cmd = raw.trim();
  if (!cmd || cmd.length > 500) return;
  history = [cmd, ...history.filter((c) => c !== cmd)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    /* private window: memory only */
  }
}

export function clearCommandHistory() {
  history = [];
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

export class CommandLineTracker {
  private line = "";
  private tainted = false;

  constructor(private readonly onCommand: (cmd: string) => void) {}

  feed(data: string) {
    // Pasted text and escape sequences arrive whole; arrows / Tab / history recall make the line unknowable.
    if (data.startsWith("\x1b")) {
      if (!data.startsWith("\x1b[200~")) this.tainted = true;
      else data = data.replace(/\x1b\[20[01]~/g, "");
      if (this.tainted) return;
    }
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        if (!this.tainted && this.line.trim()) this.onCommand(this.line);
        this.line = "";
        this.tainted = false;
      } else if (ch === "\x7f" || ch === "\b") this.line = this.line.slice(0, -1);
      else if (ch === "\x03" || ch === "\x15") {
        this.line = "";
        this.tainted = false;
      } else if (ch === "\t") this.tainted = true;
      else if (ch >= " ") this.line += ch;
    }
  }
}
