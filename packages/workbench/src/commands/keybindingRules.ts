import { create } from "zustand";
import { evaluateWhen } from "../exthost/when";
import type { OsKind } from "../platform/types";
import { parseJsonc } from "../textmate/jsonc";
import { canonical } from "./registry";

/**
 * keybindings.json, VS Code's format: a list of `{ "key", "command", "when" }`
 * rules. A later rule wins over an earlier one and over the defaults; a
 * command written "-editor.action.x" removes that key from it. `when` uses the
 * same expressions as VS Code (editorTextFocus, terminalFocus, editorLangId…).
 */

export interface KeyRule {
  /** As written: "cmd+k cmd+s", "ctrl+shift+p". */
  key: string;
  command: string;
  when?: string;
  args?: unknown;
}

export interface CompiledRule {
  /** TMCode's chord form for this OS ("mod+k mod+s"), canonical. */
  chord: string;
  command: string;
  remove: boolean;
  when?: string;
  args?: unknown;
}

export interface RulesParse {
  rules: KeyRule[];
  issues: { message: string; index?: number }[];
  syntaxError: boolean;
}

export const KEYBINDINGS_TEMPLATE = `// Place your key bindings in this file to override the defaults.
// Example: { "key": "ctrl+alt+t", "command": "workbench.action.terminal.new" }
// Put "-" before a command to remove its key: { "key": "cmd+k", "command": "-workbench.action.terminal.clear" }
[
]
`;

export function parseKeybindingsJson(text: string): RulesParse {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (e) {
    return { rules: [], issues: [{ message: `keybindings.json isn't valid JSON: ${(e as Error).message}` }], syntaxError: true };
  }
  if (raw === undefined || raw === null) return { rules: [], issues: [], syntaxError: false };
  if (!Array.isArray(raw)) return { rules: [], issues: [{ message: "keybindings.json must be a list: [ { \"key\": …, \"command\": … } ]" }], syntaxError: false };
  const rules: KeyRule[] = [];
  const issues: RulesParse["issues"] = [];
  raw.forEach((r, i) => {
    const o = r as Record<string, unknown>;
    if (!o || typeof o !== "object") return issues.push({ message: `Rule ${i + 1} must be an object.`, index: i });
    if (typeof o.key !== "string" || !o.key.trim()) return issues.push({ message: `Rule ${i + 1} needs a "key".`, index: i });
    if (typeof o.command !== "string" || !o.command.trim()) return issues.push({ message: `Rule ${i + 1} needs a "command".`, index: i });
    rules.push({ key: o.key, command: o.command, ...(typeof o.when === "string" ? { when: o.when } : {}), ...(o.args !== undefined ? { args: o.args } : {}) });
  });
  return { rules, issues, syntaxError: false };
}

const KEY_NAMES: Record<string, string> = {
  esc: "escape",
  return: "enter",
  pgup: "pageup",
  pgdn: "pagedown",
  uparrow: "up",
  downarrow: "down",
  leftarrow: "left",
  rightarrow: "right",
  oem_3: "`",
};

/** "cmd+k cmd+s" (VS Code) → "mod+k mod+s" (TMCode, canonical), or null when it can't be typed here. */
export function toChord(key: string, os: OsKind): string | null {
  const chords = key.trim().toLowerCase().split(/\s+/);
  const out: string[] = [];
  for (const chord of chords) {
    const parts = chord.split("+").filter(Boolean);
    const k = parts.pop();
    if (!k) return null;
    const mods: string[] = [];
    for (const m of parts) {
      if (m === "cmd" || m === "meta" || m === "win") {
        if (os !== "mac") return null; // no ⌘ key off macOS
        mods.push("mod");
      } else if (m === "ctrl") mods.push(os === "mac" ? "ctrl" : "mod");
      else if (m === "alt" || m === "option" || m === "opt") mods.push("alt");
      else if (m === "shift") mods.push("shift");
      else return null;
    }
    out.push(canonical([...mods, KEY_NAMES[k] ?? k].join("+"), os));
  }
  return out.join(" ");
}

export function compileRules(rules: KeyRule[], os: OsKind): CompiledRule[] {
  return rules.flatMap((r) => {
    const chord = toChord(r.key, os);
    if (!chord) return [];
    const remove = r.command.startsWith("-");
    return [{ chord, command: remove ? r.command.slice(1) : r.command, remove, when: r.when, args: r.args }];
  });
}

export type RuleContext = (key: string) => unknown;

/**
 * What a key (one chord, or two) does by the rules: the command to run, or
 * the commands whose default binding of this key is removed.
 */
export function resolveRules(rules: CompiledRule[], chord: string, ctx: RuleContext): { run: CompiledRule | null; removed: Set<string> } {
  const removed = new Set<string>();
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i];
    if (r.chord !== chord || !evaluateWhen(r.when, ctx)) continue;
    if (r.remove) removed.add(r.command);
    else if (!removed.has(r.command)) return { run: r, removed };
  }
  return { run: null, removed };
}

/** Do any rules start with this chord (the first of two)? */
export function rulesStartWith(rules: CompiledRule[], chord: string): boolean {
  return rules.some((r) => !r.remove && r.chord.includes(" ") && r.chord.split(" ")[0] === chord);
}

/** How a rule's command runs and what its `when` sees (commands/keybindings.ts sets them; tests use the defaults). */
export const ruleHost: { run(rule: CompiledRule): boolean; context(target: EventTarget | null): RuleContext } = {
  run: () => false,
  context: () => () => undefined,
};

/** The user's keybindings.json, as text and compiled for this OS. */
export const useKeybindingRules = create<{ text: string; rules: CompiledRule[]; issues: RulesParse["issues"] }>(() => ({ text: KEYBINDINGS_TEMPLATE, rules: [], issues: [] }));

export function setKeybindingsText(text: string, os: OsKind): RulesParse {
  const parsed = parseKeybindingsJson(text);
  if (parsed.syntaxError) useKeybindingRules.setState({ text, issues: parsed.issues });
  else useKeybindingRules.setState({ text, rules: compileRules(parsed.rules, os), issues: parsed.issues });
  return parsed;
}
