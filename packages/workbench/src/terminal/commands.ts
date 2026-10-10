import { registerCommand } from "../commands/registry";
import { terminalAllowed } from "@tmcode/protocol";
import { getPlatform, openContextMenu, openSpecialEditor, showPanel, updateSetting, useWorkbench, type ContextMenuItem } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { terminalAction, useTerminalPanel } from "../parts/panel/TerminalView";
import { loadTerminalProfiles } from "./profiles";

const allowed = () => !!getPlatform().terminal && terminalAllowed(useWorkbench.getState().policy);

/** A new terminal with a chosen shell (the ⌄ menu, "Create New Terminal (With Profile)"). */
export function newTerminal(profile?: string) {
  showPanel("terminal");
  window.dispatchEvent(new CustomEvent("tmcode:new-terminal", { detail: profile ? { profile } : {} }));
}

/** The "+ ⌄" menu next to the terminal's New button: a shell per profile, then split and settings. */
export async function openProfileMenu(x: number, y: number) {
  const profiles = await loadTerminalProfiles();
  const items: ContextMenuItem[] = [
    ...profiles.map((p) => ({ kind: "item" as const, label: p.name, run: () => newTerminal(p.id) })),
    ...(profiles.length ? [{ kind: "separator" as const }] : []),
    { kind: "item", label: "Split Terminal", disabled: !useTerminalPanel.getState().count, run: () => terminalAction("split") },
    { kind: "item", label: "Select Default Profile", disabled: !profiles.length, run: () => void selectDefaultProfile() },
    { kind: "item", label: "Configure Terminal Settings", run: () => openSpecialEditor("settings") },
  ];
  openContextMenu(x, y, items);
}

export async function selectDefaultProfile() {
  const profiles = await loadTerminalProfiles();
  const current = useWorkbench.getState().settings["terminal.integrated.defaultProfile"];
  const pick = await showQuickPick({
    placeholder: "Select your default terminal profile",
    items: [
      { id: "", label: "Automatic", description: current === "" ? "current" : "the system's shell" },
      ...profiles.map((p) => ({ id: p.id, label: p.name, description: [p.path, p.id === current ? "current" : ""].filter(Boolean).join(" · ") })),
    ],
  });
  if (pick) updateSetting("terminal.integrated.defaultProfile", pick.id);
}

let registered = false;
export function registerTerminalCommands() {
  if (registered) return;
  registered = true;
  registerCommand({ id: "workbench.action.terminal.split", title: "Split Terminal", category: "Terminal", keybinding: "mod+shift+5", enabled: allowed, run: () => (showPanel("terminal"), terminalAction("split")) });
  registerCommand({
    id: "workbench.action.terminal.rename",
    title: "Rename...",
    category: "Terminal",
    enabled: () => allowed() && useTerminalPanel.getState().count > 0,
    run: () => (showPanel("terminal"), terminalAction("rename")),
  });
  registerCommand({ id: "workbench.action.terminal.kill", title: "Kill the Active Terminal Instance", category: "Terminal", enabled: () => allowed() && useTerminalPanel.getState().count > 0, run: () => terminalAction("kill") });
  registerCommand({ id: "workbench.action.terminal.selectDefaultShell", title: "Select Default Profile", category: "Terminal", enabled: allowed, run: () => void selectDefaultProfile() });
  registerCommand({
    id: "workbench.action.terminal.newWithProfile",
    title: "Create New Terminal (With Profile)",
    category: "Terminal",
    enabled: allowed,
    run: async () => {
      const profiles = await loadTerminalProfiles();
      if (!profiles.length) return newTerminal();
      const pick = await showQuickPick({ placeholder: "Select the terminal profile to create", items: profiles.map((p) => ({ id: p.id, label: p.name, description: p.path })) });
      if (pick) newTerminal(pick.id);
    },
  });
}
