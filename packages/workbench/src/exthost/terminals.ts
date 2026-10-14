import type { OwnedTerminal } from "../parts/panel/TerminalView";
import type { TerminalEnvMutation } from "../platform/types";
import { useWorkbench } from "../state/store";
import { terminalAllowed } from "@tmcode/protocol";

/**
 * Terminals that extensions create (window.createTerminal): each is a named
 * TMCode terminal owned by its host. Text sent before the shell is ready is
 * queued; "ready" and "exit" go back to the host.
 *
 * Shell integration (executeCommand): the command runs between OSC 633 C and
 * D markers that the shell itself prints, so its output and exit code reach
 * the extension (execStart / execData / execEnd), one command at a time.
 */

interface Exec {
  id: number;
  command: string;
  started: boolean;
  /** Its start marker was seen: output now belongs to it. */
  inside: boolean;
}

export interface Entry {
  handle: OwnedTerminal | null;
  queue: string[];
  exited: boolean;
  execs: Exec[];
  /** Output not yet matched against the markers (a marker can be split across chunks). */
  pending: string;
}

const entries = new Map<string, Entry>();
const C_MARK = "\x1b]633;C\x07";
const D_MARK = /\x1b\]633;D(?:;(-?\d*))?\x07/;

/** The command wrapped so the shell prints the markers around it (and its exit code). */
export function wrapCommand(shell: string, command: string): string {
  const s = shell.toLowerCase();
  if (s.includes("powershell") || s === "pwsh") {
    return `Write-Host -NoNewline ([char]27+']633;C'+[char]7); ${command}; Write-Host -NoNewline ([char]27+']633;D;'+$(if ($?) { 0 } elseif ($LASTEXITCODE) { $LASTEXITCODE } else { 1 })+[char]7)`;
  }
  if (s.includes("fish")) return ` printf '\\e]633;C\\a'; ${command}; printf '\\e]633;D;%s\\a' $status`;
  if (s.includes("cmd")) return command;
  // zsh, bash, sh, Git Bash: a leading space keeps it out of the history.
  return ` printf '\\033]633;C\\007'; ${command}; printf '\\033]633;D;%s\\007' $?`;
}

function startNext(entry: Entry) {
  const ex = entry.execs[0];
  if (!ex || ex.started || !entry.handle) return;
  ex.started = true;
  entry.handle.write(`${wrapCommand(entry.handle.shell, ex.command)}\r`);
}

export function onOutput(entry: Entry, data: string, notify: (method: string, params: unknown[]) => void, id: number) {
  const ex = entry.execs[0];
  if (!ex?.started) return;
  let text = entry.pending + data;
  entry.pending = "";
  if (!ex.inside) {
    const at = text.indexOf(C_MARK);
    if (at < 0) {
      // Keep a possible partial marker for the next chunk.
      entry.pending = text.slice(-C_MARK.length);
      return;
    }
    ex.inside = true;
    notify("$terminalEvent", [id, "execStart", { exec: ex.id }]);
    text = text.slice(at + C_MARK.length);
  }
  const m = D_MARK.exec(text);
  if (!m) {
    // Hold back a tail that could be the start of the end marker.
    const esc = text.lastIndexOf("\x1b");
    const keep = esc >= 0 && text.length - esc < 16 ? text.slice(esc) : "";
    const out = keep ? text.slice(0, esc) : text;
    if (out) notify("$terminalEvent", [id, "execData", { exec: ex.id, data: out }]);
    entry.pending = keep;
    return;
  }
  const before = text.slice(0, m.index);
  if (before) notify("$terminalEvent", [id, "execData", { exec: ex.id, data: before }]);
  const code = m[1] ? Number(m[1]) : undefined;
  notify("$terminalEvent", [id, "execEnd", { exec: ex.id, code }]);
  entry.execs.shift();
  entry.pending = "";
  startNext(entry);
}

export function terminalOp(host: string, notify: (method: string, params: unknown[]) => void, op: string, id: number, arg: unknown) {
  const key = `${host}:${id}`;
  if (op === "create") {
    if (!terminalAllowed(useWorkbench.getState().policy)) {
      notify("$terminalEvent", [id, "exit", undefined]);
      return;
    }
    const opts = (arg ?? {}) as { name?: string; cwd?: string; env?: TerminalEnvMutation[] };
    const entry: Entry = { handle: null, queue: [], exited: false, execs: [], pending: "" };
    entries.set(key, entry);
    window.dispatchEvent(
      new CustomEvent("tmcode:new-terminal", {
        detail: {
          name: opts.name,
          cwd: opts.cwd || "",
          env: Array.isArray(opts.env) ? opts.env : undefined,
          owner: {
            onReady: (h: OwnedTerminal) => {
              entry.handle = h;
              for (const text of entry.queue.splice(0)) h.write(text);
              notify("$terminalEvent", [id, "ready", { pid: h.id, shell: h.shell }]);
              startNext(entry);
            },
            onData: (d: string) => onOutput(entry, d, notify, id),
            onExit: (code: number | null) => {
              entry.exited = true;
              entries.delete(key);
              notify("$terminalEvent", [id, "exit", code ?? undefined]);
            },
            onError: () => {
              entries.delete(key);
              notify("$terminalEvent", [id, "exit", undefined]);
            },
          },
        },
      }),
    );
    return;
  }
  const entry = entries.get(key);
  if (!entry) return;
  if (op === "send") {
    const text = String(arg ?? "");
    if (entry.handle) entry.handle.write(text);
    else entry.queue.push(text);
  } else if (op === "exec") {
    const a = (arg ?? {}) as { exec?: number; command?: string };
    if (typeof a.exec !== "number" || !a.command) return;
    entry.execs.push({ id: a.exec, command: a.command, started: false, inside: false });
    startNext(entry);
  } else if (op === "show") {
    if (entry.handle) entry.handle.reveal();
    else {
      const reveal = setInterval(() => {
        if (entry.handle) {
          clearInterval(reveal);
          entry.handle.reveal();
        } else if (!entries.has(key)) clearInterval(reveal);
      }, 100);
    }
  } else if (op === "dispose") {
    entry.handle?.kill();
    entries.delete(key);
  }
}

/** A host restarted or stopped: its terminals stay open as ordinary shells. */
export function forgetTerminalsOf(host: string) {
  for (const key of [...entries.keys()]) if (key.startsWith(`${host}:`)) entries.delete(key);
}
