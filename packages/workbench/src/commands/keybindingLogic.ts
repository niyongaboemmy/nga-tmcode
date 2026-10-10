import type { OsKind } from "../platform/types";
import { canonical, type Command } from "./registry";

/**
 * Pure keybinding helpers (no Monaco, no store) so they can be unit tested:
 * Monaco label conversion, conflicts, and the overrides map.
 */

const MODIFIER_ORDER = ["ctrl", "mod", "alt", "shift"];

/**
 * Monaco's "user settings" label ("cmd+k cmd+c", "shift+alt+down", "ctrl+d")
 * → TMCode's form ("mod+k mod+c", "alt+shift+down", "mod+d" off macOS).
 */
export function monacoLabelToChord(label: string, os: OsKind): string | null {
  if (!label) return null;
  const chords = label
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split("+");
      // "cmd++" style: the key itself is "+"? Monaco writes "=" there; keep it simple.
      const key = parts.pop();
      if (!key) return null;
      const mods = new Set<string>();
      for (const p of parts) {
        if (p === "cmd" || p === "meta" || p === "win" || p === "super") {
          if (os !== "mac") return null; // the Windows key: TMCode never binds it
          mods.add("mod");
        } else if (p === "ctrl") mods.add(os === "mac" ? "ctrl" : "mod");
        else if (p === "alt" || p === "option") mods.add("alt");
        else if (p === "shift") mods.add("shift");
        else return null;
      }
      if (/^\[.*\]$/.test(key)) return null; // a scan code ([Slash]): not on every layout
      return [...MODIFIER_ORDER.filter((m) => mods.has(m)), key.toLowerCase()].join("+");
    });
  if (chords.some((c) => !c)) return null;
  return chords.join(" ");
}

/** Normalises a key the way the resolver compares them ("shift+mod+p" = "mod+shift+p"). */
export function normalizeKeybinding(kb: string, os: OsKind): string {
  return kb
    .trim()
    .split(/\s+/)
    .map((c) => canonical(c, os))
    .join(" ");
}

/** Commands (other than `exceptId`) bound to the same key. */
export function findConflicts(kb: string, commands: { id: string; kb?: string }[], os: OsKind, exceptId?: string): string[] {
  if (!kb) return [];
  const target = normalizeKeybinding(kb, os);
  return commands.filter((c) => c.id !== exceptId && c.kb && normalizeKeybinding(c.kb, os) === target).map((c) => c.id);
}

/**
 * Next overrides map after the user sets `kb` for `id`: recording the default
 * key again drops the override (the row is no longer "User").
 */
export function withOverride(overrides: Record<string, string>, id: string, kb: string | null, defaultKb: string | undefined, os: OsKind): Record<string, string> {
  const next = { ...overrides };
  if (kb === null) {
    delete next[id];
    return next;
  }
  const norm = kb ? normalizeKeybinding(kb, os) : "";
  if ((defaultKb ? normalizeKeybinding(defaultKb, os) : "") === norm) delete next[id];
  else next[id] = norm;
  return next;
}

/** Only well-formed entries survive (settings can be hand-edited or old). */
export function sanitizeOverrides(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" && k.length < 200 && /^[\w.\-:]+$/.test(k) && /^[\w+`\\,./=\-;'[\] ]*$/.test(val)) out[k] = val;
  }
  return out;
}

/** "mod+shift+p" → Tauri accelerator "CmdOrCtrl+Shift+P"; null for chords and keys a menu can't own. */
export function toAccelerator(kb: string | undefined): string | null {
  if (!kb || kb.includes(" ")) return null;
  const parts = kb.split("+");
  const key = parts.pop()!;
  // Only ⌘/Ctrl shortcuts become native accelerators: plain keys (F5, ⌥↑) would be taken from text fields and the terminal.
  if (!parts.includes("mod")) return null;
  const names: Record<string, string> = { mod: "CmdOrCtrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  const keyNames: Record<string, string> = {
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
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
  };
  const k = keyNames[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : null);
  if (!k) return null;
  return [...MODIFIER_ORDER.filter((m) => parts.includes(m)).map((m) => names[m]), k].join("+");
}

/** Every command a key reference lists: registry commands plus Monaco-only actions. */
export interface KeybindingRow {
  id: string;
  title: string;
  category?: string;
  kb?: string;
  defaultKb?: string;
  source: "Default" | "User" | "Editor";
}

export function rowFor(cmd: Pick<Command, "id" | "title" | "category">, kb: string | undefined, defaultKb: string | undefined, overridden: boolean, editor = false): KeybindingRow {
  return { id: cmd.id, title: cmd.title, category: cmd.category, kb, defaultKb, source: overridden ? "User" : editor ? "Editor" : "Default" };
}
