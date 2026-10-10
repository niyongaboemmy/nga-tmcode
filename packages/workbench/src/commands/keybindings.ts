import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IKeybindingService } from "monaco-editor/platform/keybinding/common/keybinding.js";
import { EditorExtensionsRegistry } from "monaco-editor/editor/browser/editorExtensions.js";
import { monaco, setupMonaco } from "../monaco/setup";
import { inExam } from "../exam/state";
import { getPlatform, notify, updateSetting, useWorkbench } from "../state/store";
import type { OsKind } from "../platform/types";
import {
  allCommands,
  defaultKeybindingFor,
  executeCommand,
  getCommand,
  keybindingFor,
  setEditorDefaultKeybindings,
  setUserKeybindings,
  userKeybindings,
} from "./registry";
import { monacoLabelToChord, sanitizeOverrides, withOverride } from "./keybindingLogic";

/**
 * User keybindings (V9): overrides live in the "keybindings.user" setting,
 * apply to workbench commands through the resolver and to Monaco's own actions
 * through Monaco keybinding rules. They can't be changed during an exam.
 */

type LookupService = {
  getKeybindings(): { command: string | null; when?: { serialize(): string } | null; resolvedKeybinding?: { getUserSettingsLabel(): string | null } }[];
};

const os = (): OsKind => {
  try {
    return getPlatform().os;
  } catch {
    return "linux";
  }
};

/** Monaco actions TMCode lists but never shows (its own palette; F1 is the workbench's). */
const HIDDEN_ACTIONS = new Set(["editor.action.quickCommand"]);

let catalog: { id: string; label: string }[] | null = null;

/** Every Monaco editor action (id + label), from the registry and live editors. */
export function editorActionCatalog(): { id: string; label: string }[] {
  setupMonaco();
  const seen = new Map<string, string>();
  try {
    for (const a of EditorExtensionsRegistry.getEditorActions()) if (a.label) seen.set(a.id, a.label);
  } catch {
    /* internals moved: live editors below still work */
  }
  for (const ed of monaco.editor.getEditors()) {
    const actions = (ed as unknown as { getActions?: () => { id: string; label: string }[] }).getActions?.() ?? [];
    for (const a of actions) if (a.label && !seen.has(a.id)) seen.set(a.id, a.label);
  }
  catalog = [...seen].filter(([id]) => !HIDDEN_ACTIONS.has(id)).map(([id, label]) => ({ id, label }));
  return catalog;
}

/**
 * Monaco's keys by command, read from its keybinding table. Rules for a web
 * page ("isWeb": ⌘F12 instead of F12) are skipped: TMCode is a desktop app.
 */
function monacoKeyTable(): Map<string, string> {
  const table = new Map<string, string>();
  try {
    const service = StandaloneServices.get(IKeybindingService) as LookupService;
    for (const item of service.getKeybindings()) {
      const id = item.command;
      if (!id || id.startsWith("-") || !item.resolvedKeybinding) continue;
      if (item.when?.serialize().includes("isWeb")) continue;
      const label = item.resolvedKeybinding.getUserSettingsLabel();
      const kb = label && monacoLabelToChord(label, os());
      // The first rule is the primary key (Monaco lists secondary keys after it).
      if (kb && !table.has(id)) table.set(id, kb);
    }
  } catch {
    /* internals moved: no Monaco keys shown */
  }
  return table;
}

/** Monaco's own keys (read before any user rule removes one). */
const lookupDefault = new Map<string, string>();
/** Core editor commands that aren't editor actions but have Monaco keys. */
const CORE_IDS = ["undo", "redo", "editor.action.selectAll", "cursorUndo", "cursorRedo"];

let defaultsLoaded = false;
/** Reads Monaco's own keys once. Registry commands registered later are picked up on the next call. */
export function loadEditorDefaults() {
  setupMonaco();
  const ids = new Set([...(defaultsLoaded ? [] : editorActionCatalog().map((a) => a.id)), ...CORE_IDS, ...allCommands().map((c) => c.id)]);
  defaultsLoaded = true;
  const table = monacoKeyTable();
  for (const id of ids) {
    if (lookupDefault.has(id) || userKeybindings()[id] !== undefined) continue;
    const kb = table.get(id);
    if (kb) lookupDefault.set(id, kb);
  }
  setEditorDefaultKeybindings(lookupDefault);
}

// ── key strings → Monaco keybinding numbers ──
const NAMED: Record<string, string> = {
  up: "UpArrow",
  down: "DownArrow",
  left: "LeftArrow",
  right: "RightArrow",
  enter: "Enter",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  insert: "Insert",
  "`": "Backquote",
  "\\": "Backslash",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  "=": "Equal",
  "-": "Minus",
  "[": "BracketLeft",
  "]": "BracketRight",
  ";": "Semicolon",
  "'": "Quote",
};

function chordToMonaco(chord: string): number | null {
  const parts = chord.split("+");
  const key = parts.pop()!;
  const codes = monaco.KeyCode as unknown as Record<string, number>;
  let code: number | undefined;
  if (/^[a-z]$/.test(key)) code = codes[`Key${key.toUpperCase()}`];
  else if (/^[0-9]$/.test(key)) code = codes[`Digit${key}`];
  else if (/^f\d+$/.test(key)) code = codes[key.toUpperCase()];
  else if (NAMED[key]) code = codes[NAMED[key]];
  if (code === undefined) return null;
  let mods = 0;
  for (const p of parts) {
    if (p === "mod") mods |= monaco.KeyMod.CtrlCmd;
    else if (p === "ctrl") mods |= os() === "mac" ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
    else if (p === "shift") mods |= monaco.KeyMod.Shift;
    else if (p === "alt") mods |= monaco.KeyMod.Alt;
  }
  return mods | code;
}

/** "mod+k mod+c" → a Monaco keybinding number (chords included). */
export function keybindingToMonaco(kb: string): number | null {
  const chords = kb.split(" ").map(chordToMonaco);
  if (chords.some((c) => c === null)) return null;
  if (chords.length === 1) return chords[0];
  if (chords.length === 2) return monaco.KeyMod.chord(chords[0]!, chords[1]!);
  return null;
}

let rules: { dispose(): void } | null = null;
const forwarders = new Set<string>();

/** Re-applies the overrides inside Monaco: removes its default for an overridden action and adds the new key. */
function applyMonacoRules(overrides: Record<string, string>) {
  rules?.dispose();
  rules = null;
  const list: monaco.editor.IKeybindingRule[] = [];
  for (const [id, kb] of Object.entries(overrides)) {
    const cmd = getCommand(id);
    const monacoKnows = lookupDefault.has(id) || (!cmd && !!catalog?.some((a) => a.id === id));
    if (monacoKnows) list.push({ keybinding: 0, command: `-${id}` });
    if (!kb) continue;
    const num = keybindingToMonaco(kb);
    if (num === null) continue;
    if (!cmd || cmd.editorOwned) list.push({ keybinding: num, command: id });
    else if (kb.includes(" ")) {
      // Monaco owns ⌘K while it has focus: a workbench chord must be bound inside it too.
      const fwd = `tmcode.keybinding.${id}`;
      if (!forwarders.has(fwd)) {
        forwarders.add(fwd);
        monaco.editor.registerCommand(fwd, () => executeCommand(id));
      }
      list.push({ keybinding: num, command: fwd });
    }
  }
  if (list.length) {
    try {
      rules = monaco.editor.addKeybindingRules(list);
    } catch {
      rules = null;
    }
  }
}

let wired = false;
/** Loads Monaco's defaults and keeps the overrides in step with the setting. Idempotent. */
export function wireKeybindings() {
  if (wired) return;
  wired = true;
  loadEditorDefaults();
  const apply = (raw: unknown) => {
    const overrides = sanitizeOverrides(raw);
    setUserKeybindings(overrides);
    applyMonacoRules(overrides);
  };
  apply(useWorkbench.getState().settings["keybindings.user"]);
  let last = useWorkbench.getState().settings["keybindings.user"];
  useWorkbench.subscribe((s) => {
    const next = s.settings["keybindings.user"];
    if (next === last) return;
    last = next;
    apply(next);
  });
}

/** Why the keybindings can't be changed right now (null: they can). */
export function keybindingsLockedReason(): string | null {
  if (inExam() || useWorkbench.getState().policy.mode !== "practice") return "Shortcuts can't be changed during an exam.";
  if (useWorkbench.getState().policy.locked_settings.includes("keybindings.user")) return "Your teacher has locked shortcuts for this session.";
  return null;
}

/** Sets (or with null, resets) the key of a command or Monaco action. */
export function setUserKeybinding(id: string, kb: string | null): boolean {
  const why = keybindingsLockedReason();
  if (why) {
    notify("warning", why);
    return false;
  }
  const cmd = getCommand(id);
  const def = cmd ? defaultKeybindingFor(cmd, os()) : lookupDefault.get(id);
  updateSetting("keybindings.user", withOverride(userKeybindings(), id, kb, def, os()));
  return true;
}

/** The key now in force for any id (command or Monaco action). */
export function currentKeybinding(id: string): string | undefined {
  const cmd = getCommand(id);
  if (cmd) return keybindingFor(cmd, os());
  const o = userKeybindings();
  if (Object.prototype.hasOwnProperty.call(o, id)) return o[id] || undefined;
  return lookupDefault.get(id);
}

/** Monaco's default key for an action (not a workbench command). */
export function editorActionDefault(id: string) {
  return lookupDefault.get(id);
}
