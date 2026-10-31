import type { Terminal } from "@xterm/xterm";
import { getPlatform, notify, openContextMenu, type ContextMenuItem } from "../state/store";
import { stateOf, type ShellIntegration, type TerminalCommand } from "./shellIntegration";

/**
 * VS Code's command decorations: a mark in the terminal's left margin beside
 * each command's prompt (hollow while it runs, blue when it succeeded, red when
 * it failed). Clicking it offers Copy Command, Copy Output and Re-run Command.
 */

export interface DecorationActions {
  /** Types a command into this terminal's shell and runs it. */
  run(command: string): void;
  integration(): ShellIntegration | undefined;
}

const ICON: Record<ReturnType<typeof stateOf>, string> = {
  running: "circle-outline",
  success: "circle-filled",
  error: "error-small",
};

export function describeCommand(c: TerminalCommand): string {
  const state = stateOf(c);
  if (state === "running") return "Command is running";
  return state === "success" ? "Command succeeded" : `Command failed (exit code ${c.exitCode})`;
}

async function copy(text: string, what: string) {
  try {
    const clip = getPlatform().clipboard;
    if (clip) await clip.writeText(text);
    else await navigator.clipboard.writeText(text);
  } catch {
    notify("warning", `Could not copy the ${what} to the clipboard.`);
  }
}

export function commandMenu(c: TerminalCommand, actions: DecorationActions): ContextMenuItem[] {
  const output = actions.integration()?.outputOf(c) ?? "";
  return [
    { kind: "item", label: describeCommand(c), disabled: true, run: () => undefined },
    { kind: "separator" },
    { kind: "item", label: "Copy Command", disabled: !c.command, run: () => void copy(c.command, "command") },
    { kind: "item", label: "Copy Output", disabled: !output, run: () => void copy(output, "output") },
    { kind: "item", label: "Re-run Command", disabled: !c.command || stateOf(c) === "running", run: () => actions.run(c.command) },
  ];
}

/** Draws (or redraws, when the command ends) a command's mark. */
export function decorateCommand(c: TerminalCommand, term: Terminal, actions: DecorationActions) {
  c.decoration?.dispose();
  if (c.prompt.isDisposed) return;
  const deco = term.registerDecoration({ marker: c.prompt, layer: "top" });
  if (!deco) return;
  c.decoration = deco;
  deco.onRender((el) => {
    const state = stateOf(c);
    el.classList.add("tm-term-cmd");
    let dot = el.firstElementChild as HTMLElement | null;
    if (!dot) {
      dot = document.createElement("span");
      dot.setAttribute("role", "button");
      dot.addEventListener("mousedown", (e) => {
        // Not a selection start in the terminal under it.
        e.preventDefault();
        e.stopPropagation();
      });
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, commandMenu(c, actions));
      });
      el.appendChild(dot);
    }
    dot.className = `tm-term-cmd-mark codicon codicon-${ICON[state]} is-${state}`;
    dot.dataset.state = state;
    const label = `${describeCommand(c)}${c.command ? `: ${c.command}` : ""}`;
    dot.title = `${label}. Click for actions.`;
    dot.setAttribute("aria-label", label);
  });
}
