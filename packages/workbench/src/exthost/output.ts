import { create } from "zustand";
import { log, showPanel, workbench } from "../state/store";

/**
 * Extensions' Output channels (`window.createOutputChannel`) in TMCode's
 * Output panel. The panel is one log with a channel per line; the channel
 * picker narrows it to one channel, as VS Code's dropdown does. `append`
 * without a newline is buffered until the line ends.
 */

export const useOutputChannel = create<{ selected: string | null }>()(() => ({ selected: null }));

interface Channel {
  name: string;
  partial: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const channels = new Map<string, Channel>();

/** The "Extension Host" channel: host diagnostics and extensions' console output. */
export const HOST_CHANNEL = "Extension Host";

function flush(c: Channel) {
  if (c.timer) clearTimeout(c.timer);
  c.timer = null;
  if (c.partial) {
    log(c.name, c.partial);
    c.partial = "";
  }
}

function clearChannel(name: string) {
  workbench.set({ output: workbench.get().output.filter((l) => l.channel !== name) });
}

export function outputOp(op: string, id: string, arg: unknown) {
  const c = channels.get(id);
  if (op === "create") {
    if (!c) channels.set(id, { name: String(arg), partial: "", timer: null });
    return;
  }
  if (!c) return;
  switch (op) {
    case "append": {
      const lines = (c.partial + String(arg ?? "")).split(/\r?\n/);
      c.partial = lines.pop() ?? "";
      for (const l of lines) log(c.name, l);
      if (c.partial) {
        if (c.timer) clearTimeout(c.timer);
        c.timer = setTimeout(() => flush(c), 250);
      }
      break;
    }
    case "replace":
      c.partial = "";
      clearChannel(c.name);
      outputOp("append", id, arg);
      break;
    case "clear":
      c.partial = "";
      clearChannel(c.name);
      break;
    case "show":
      flush(c);
      useOutputChannel.setState({ selected: c.name });
      showPanel("output");
      break;
    case "dispose":
      flush(c);
      channels.delete(id);
      break;
  }
}
