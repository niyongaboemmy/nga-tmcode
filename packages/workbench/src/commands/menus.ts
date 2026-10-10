import spec from "./menus.json";
import type { NativeMenuItemState, OsKind } from "../platform/types";
import { executeCommand, formatKeybinding, getCommand, isEnabled, keybindingFor, registerCommand } from "./registry";
import { toAccelerator } from "./keybindingLogic";
import { getPlatform, openQuickInput, useWorkbench, type ContextMenuItem } from "../state/store";
import { hasWorkspaceSymbolProvider } from "./symbols";
import { codeEditorFor } from "../monaco/editors";
import { workbench } from "../state/store";

/**
 * One menu spec (menus.json) for the in-app title-bar menus and the macOS
 * menu bar (V7): Rust builds the native menu from the same file, and this
 * module keeps its labels, accelerators and enabled states in step.
 */

export type MenuItemSpec =
  | "-"
  | string
  | { command: string; label: string; keyFrom?: string; accel?: string; native?: "only" | "never" }
  | { role: string };
export interface MenuSpec {
  label: string;
  native?: "only" | "never";
  items: MenuItemSpec[];
}

export const MENU_SPEC: MenuSpec[] = (spec as { menus: MenuSpec[] }).menus;

type CommandEntry = Extract<MenuItemSpec, { command: string }>;
function entryOf(it: MenuItemSpec): CommandEntry | null {
  if (typeof it === "string") return it === "-" ? null : { command: it, label: getCommand(it)?.title ?? it };
  return "command" in it ? it : null;
}

/** Menus of the in-app title bar (Windows, Linux, the browser build). */
export function inAppMenus(): MenuSpec[] {
  return MENU_SPEC.filter((m) => m.native !== "only");
}

/** The key a menu item shows: its own command's, or `keyFrom`'s (Start Debugging shows F5). */
export function menuKeybinding(e: CommandEntry, os: OsKind): string | undefined {
  const cmd = getCommand(e.keyFrom ?? e.command) ?? getCommand(e.command);
  return cmd ? keybindingFor(cmd, os) : undefined;
}

/** In-app menu items: hidden when the command doesn't exist here, greyed out when it's disabled. */
export function menuItems(menu: MenuSpec, os: OsKind, beforeRun?: () => void): ContextMenuItem[] {
  const out: ContextMenuItem[] = [];
  for (const it of menu.items) {
    if (it === "-") {
      if (out.length && out[out.length - 1].kind !== "separator") out.push({ kind: "separator" });
      continue;
    }
    const e = entryOf(it);
    if (!e || e.native === "only") continue;
    const cmd = getCommand(e.command);
    if (!cmd) continue;
    out.push({
      kind: "item",
      label: e.label,
      keybinding: formatKeybinding(menuKeybinding(e, os), os),
      disabled: !isEnabled(cmd),
      run: () => {
        beforeRun?.();
        executeCommand(e.command);
      },
    });
  }
  if (out[out.length - 1]?.kind === "separator") out.pop();
  return out;
}

/** Every native command item with its current label, state and accelerator (deduplicated by id). */
export function nativeMenuState(os: OsKind): NativeMenuItemState[] {
  const seen = new Map<string, NativeMenuItemState>();
  for (const menu of MENU_SPEC) {
    if (menu.native === "never") continue;
    for (const it of menu.items) {
      const e = entryOf(it);
      if (!e || e.native === "never" || seen.has(e.command)) continue;
      const cmd = getCommand(e.command);
      const accel = e.accel !== undefined ? e.accel || null : toAccelerator(menuKeybinding(e, os));
      seen.set(e.command, { id: e.command, text: e.label, enabled: !!cmd && isEnabled(cmd), accel });
    }
  }
  return [...seen.values()];
}

let nativeWired = false;
/** Pushes enabled states and accelerators to the macOS menu whenever they may have changed. */
export function wireNativeMenus() {
  const platform = getPlatform();
  if (nativeWired || !platform.setMenuState) return;
  nativeWired = true;
  let last = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    timer = null;
    const state = nativeMenuState(platform.os);
    const changed = state.filter((s) => last.get(s.id) !== JSON.stringify(s));
    if (!changed.length) return;
    last = new Map(state.map((s) => [s.id, JSON.stringify(s)]));
    platform.setMenuState!(changed);
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(push, 120);
  };
  push();
  useWorkbench.subscribe(schedule);
  // Focus decides Undo/Find targets; runs and debug sessions change Stop/Restart.
  window.addEventListener("focusin", schedule);
  window.addEventListener("focus", schedule);
  setInterval(schedule, 1500);
}

let registered = false;
/** Commands the menus need that had no single command before. */
export function registerMenuCommands() {
  if (registered) return;
  registered = true;
  const enabledId = (...ids: string[]) => ids.find((id) => {
    const c = getCommand(id);
    return !!c && isEnabled(c);
  });
  registerCommand({
    id: "workbench.action.gotoSymbol",
    title: "Go to Symbol in Editor...",
    category: "Go",
    keybinding: "mod+shift+o",
    enabled: () => !!codeEditorFor(workbench.get().activeGroup)?.getModel(),
    run: () => openQuickInput("files", "@"),
  });
  registerCommand({
    id: "workbench.action.showAllSymbols",
    title: "Go to Symbol in Workspace...",
    category: "Go",
    keybinding: "mod+t",
    enabled: () => hasWorkspaceSymbolProvider() && !!useWorkbench.getState().workspace,
    run: () => openQuickInput("files", "#"),
  });
  registerCommand({
    id: "workbench.action.quickOpenHelp",
    title: "Quick Open Help",
    category: "Help",
    run: () => openQuickInput("files", "?"),
  });
  // Run › Stop / Restart: the debugger, else the running file, else the project.
  const stopIds = ["workbench.action.debug.stop", "tmcode.stop", "tmcode.stopProject"];
  const restartIds = ["workbench.action.debug.restart", "tmcode.restartProject"];
  registerCommand({ id: "tmcode.stopAny", title: "Stop", category: "Run", hidden: true, enabled: () => !!enabledId(...stopIds), run: () => executeCommand(enabledId(...stopIds) ?? "") });
  registerCommand({
    id: "tmcode.restartAny",
    title: "Restart",
    category: "Run",
    hidden: true,
    enabled: () => !!enabledId(...restartIds),
    run: () => executeCommand(enabledId(...restartIds) ?? ""),
  });
}
