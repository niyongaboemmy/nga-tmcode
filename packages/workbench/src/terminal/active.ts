import type { Terminal } from "@xterm/xterm";

/** The terminal shown in the panel (for Edit › Select All and the clipboard commands). */
let active: Terminal | null = null;

export function setActiveTerminal(term: Terminal | null) {
  active = term;
}

export function activeTerminal() {
  return active;
}
