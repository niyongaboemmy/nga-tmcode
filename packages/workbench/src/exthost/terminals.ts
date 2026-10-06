import type { OwnedTerminal } from "../parts/panel/TerminalView";
import { useWorkbench } from "../state/store";

/**
 * Terminals that extensions create (window.createTerminal): each is a named
 * TMCode terminal owned by its host. Text sent before the shell is ready is
 * queued; "ready" and "exit" go back to the host.
 */

interface Entry {
  handle: OwnedTerminal | null;
  queue: string[];
  exited: boolean;
}

const entries = new Map<string, Entry>();

export function terminalOp(host: string, notify: (method: string, params: unknown[]) => void, op: string, id: number, arg: unknown) {
  const key = `${host}:${id}`;
  if (op === "create") {
    if (useWorkbench.getState().policy.terminal === "off") {
      notify("$terminalEvent", [id, "exit", undefined]);
      return;
    }
    const opts = (arg ?? {}) as { name?: string; cwd?: string };
    const entry: Entry = { handle: null, queue: [], exited: false };
    entries.set(key, entry);
    window.dispatchEvent(
      new CustomEvent("tmcode:new-terminal", {
        detail: {
          name: opts.name,
          cwd: opts.cwd || "",
          owner: {
            onReady: (h: OwnedTerminal) => {
              entry.handle = h;
              for (const text of entry.queue.splice(0)) h.write(text);
              notify("$terminalEvent", [id, "ready", h.id]);
            },
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
