import type { OsKind } from "../platform/types";

/**
 * Commands drive everything: the palette, menus, keybindings and buttons all
 * call `executeCommand(id)`. Policy can hide a command by returning false from
 * `enabled`.
 */
export interface Command {
  id: string;
  title: string;
  category?: string;
  /** e.g. "mod+shift+p" or a chord "mod+k mod+t"; "mod" = ⌘ on macOS, Ctrl elsewhere. */
  keybinding?: string;
  /** Overrides `keybinding` on macOS / elsewhere when they differ. */
  mac?: string;
  win?: string;
  /** Hidden from the command palette (still runnable). */
  hidden?: boolean;
  /**
   * A Monaco action: its keys are Monaco's own (handled inside the editor), so
   * the workbench resolver never dispatches them; user overrides become Monaco rules.
   */
  editorOwned?: boolean;
  enabled?: () => boolean;
  run: () => unknown;
}

const commands = new Map<string, Command>();

export function registerCommand(cmd: Command) {
  commands.set(cmd.id, cmd);
  return () => commands.delete(cmd.id);
}

export function getCommand(id: string) {
  return commands.get(id);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

export function isEnabled(cmd: Command) {
  return cmd.enabled ? cmd.enabled() : true;
}

export function executeCommand(id: string) {
  const cmd = commands.get(id);
  if (!cmd || !isEnabled(cmd)) return false;
  void Promise.resolve(cmd.run()).catch((e) => console.error(`command ${id} failed`, e));
  return true;
}

/** The built-in key of a command (before user overrides). */
export function defaultKeybindingFor(cmd: Command, os: OsKind): string | undefined {
  const own = os === "mac" ? (cmd.mac ?? cmd.keybinding) : (cmd.win ?? cmd.keybinding);
  return own ?? editorDefaults.get(cmd.id);
}

const hasOverride = (id: string) => Object.prototype.hasOwnProperty.call(userOverrides, id);

/** The key shown for a command: the user's override ("" = removed), else the default. */
export function keybindingFor(cmd: Command, os: OsKind): string | undefined {
  if (hasOverride(cmd.id)) return userOverrides[cmd.id] || undefined;
  return defaultKeybindingFor(cmd, os);
}

/** The key the workbench resolver dispatches (Monaco handles its own keys). */
export function dispatchKeybindingFor(cmd: Command, os: OsKind): string | undefined {
  if (cmd.editorOwned) return undefined;
  if (hasOverride(cmd.id)) return userOverrides[cmd.id] || undefined;
  return os === "mac" ? (cmd.mac ?? cmd.keybinding) : (cmd.win ?? cmd.keybinding);
}

/** User keybindings: command id → key ("" = no key). Set from settings (commands/keybindings.ts). */
let userOverrides: Record<string, string> = {};
export function setUserKeybindings(map: Record<string, string>) {
  userOverrides = { ...map };
}
export function userKeybindings(): Readonly<Record<string, string>> {
  return userOverrides;
}

/** Monaco's own keys for its actions (⌘D, ⌥↑…), filled once Monaco is up. Display only. */
const editorDefaults = new Map<string, string>();
export function setEditorDefaultKeybindings(map: Map<string, string>) {
  editorDefaults.clear();
  map.forEach((v, k) => editorDefaults.set(k, v));
}
export function editorDefaultKeybinding(id: string) {
  return editorDefaults.get(id);
}

/** While a key is being recorded (keybindings editor), the resolver lets every key through. */
let suspended = false;
export function suspendKeybindings(on: boolean) {
  suspended = on;
}

const MAC_SYMBOLS: Record<string, string> = { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
/** macOS menus show arrows as symbols (⌥⌘↑), as VS Code does. */
const MAC_ARROWS: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→" };
const KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  tab: "Tab",
  space: "Space",
  up: "UpArrow",
  down: "DownArrow",
  left: "LeftArrow",
  right: "RightArrow",
  "`": "`",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
};

/** Formats "mod+shift+p" as "⇧⌘P" (macOS) or "Ctrl+Shift+P". */
export function formatKeybinding(kb: string | undefined, os: OsKind): string {
  if (!kb) return "";
  return kb
    .split(" ")
    .map((chord) => {
      const parts = chord.split("+");
      const key = parts.pop()!;
      const keyLabel = (os === "mac" ? MAC_ARROWS[key] : undefined) ?? KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
      if (os === "mac") {
        const order = ["ctrl", "alt", "shift", "mod"];
        const mods = order.filter((m) => parts.includes(m)).map((m) => MAC_SYMBOLS[m]);
        return mods.join("") + keyLabel;
      }
      const names: string[] = parts.map((m) => (m === "mod" || m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : "Shift"));
      const ordered = ["Ctrl", "Shift", "Alt"].filter((n) => names.includes(n));
      return [...ordered, keyLabel].join("+");
    })
    .join(" ");
}

function normaliseKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  if (k === " ") return "space";
  if (k === "arrowup") return "up";
  if (k === "arrowdown") return "down";
  if (k === "arrowleft") return "left";
  if (k === "arrowright") return "right";
  // Shift changes e.key ("?" for "/"); use the physical key for letters, digits and punctuation.
  if (e.code.startsWith("Key")) return e.code.slice(3).toLowerCase();
  if (e.code.startsWith("Digit")) return e.code.slice(5);
  const codes: Record<string, string> = {
    Backquote: "`",
    Backslash: "\\",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Equal: "=",
    Minus: "-",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
  };
  return codes[e.code] ?? k;
}

/** Turns a key event into "mod+shift+p" form for this OS. */
export function chordOf(e: KeyboardEvent, os: OsKind): string | null {
  const key = normaliseKey(e);
  if (["meta", "control", "shift", "alt"].includes(key)) return null;
  const parts: string[] = [];
  const mod = os === "mac" ? e.metaKey : e.ctrlKey;
  if (os === "mac" && e.ctrlKey) parts.push("ctrl");
  if (mod) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

export function canonical(chord: string, os: OsKind) {
  // Off macOS, Ctrl *is* the primary modifier, so "ctrl+`" and "mod+`" are the same key.
  const parts = chord.split("+").map((p) => (os !== "mac" && p === "ctrl" ? "mod" : p));
  const key = parts.pop()!;
  const order = ["ctrl", "mod", "alt", "shift"];
  return [...order.filter((m) => parts.includes(m)), key].join("+");
}

/**
 * Resolves key events to commands, including two-step chords such as
 * ⌘K ⌘T. Returns what happened so the caller can preventDefault.
 */
export class KeybindingResolver {
  private pendingChord: string | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private os: OsKind,
    private onChordPending: (label: string | null) => void = () => {},
  ) {}

  handle(e: KeyboardEvent): "executed" | "chord" | "none" {
    if (suspended) return "none";
    const chord = chordOf(e, this.os);
    if (!chord) return "none";
    const c = canonical(chord, this.os);
    const bindings = allCommands()
      .map((cmd) => ({ cmd, kb: dispatchKeybindingFor(cmd, this.os) }))
      .filter((b): b is { cmd: Command; kb: string } => !!b.kb);

    if (this.pendingChord) {
      const full = `${this.pendingChord} ${c}`;
      this.clearPending();
      const hit = bindings.find((b) => b.kb.split(" ").map((k) => canonical(k, this.os)).join(" ") === full);
      if (hit && isEnabled(hit.cmd)) {
        executeCommand(hit.cmd.id);
        return "executed";
      }
      return "chord"; // swallow the unknown second key, as VS Code does
    }

    const direct = bindings.find((b) => !b.kb.includes(" ") && canonical(b.kb, this.os) === c && isEnabled(b.cmd));
    if (direct) {
      executeCommand(direct.cmd.id);
      return "executed";
    }
    if (bindings.some((b) => b.kb.includes(" ") && canonical(b.kb.split(" ")[0], this.os) === c)) {
      this.pendingChord = c;
      this.onChordPending(formatKeybinding(c, this.os));
      this.pendingTimer = setTimeout(() => this.clearPending(), 3000);
      return "chord";
    }
    return "none";
  }

  private clearPending() {
    this.pendingChord = null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.onChordPending(null);
  }
}
