import { create } from "zustand";
import { registerCommand } from "../commands/registry";
import { saveKeybindingsText } from "../commands/keybindings";
import { KEYBINDINGS_TEMPLATE, useKeybindingRules } from "../commands/keybindingRules";
import { inExam } from "../exam/state";
import { showInputBox, showQuickPick } from "../widgets/QuickPick";
import { userDiff, type LanguageOverrides } from "./settingsJson";
import type { Settings } from "./settings";
import { activeFilePath, applyUserSettingsJson, getPlatform, notify, openFile, refreshExplorer, useWorkbench } from "./store";

/**
 * Profiles (VS Code's): named sets of settings and keyboard shortcuts — one
 * for exams practice, one for web projects, one for Python… Switching keeps
 * the current set in its profile and loads the other. "Default" is the set
 * you had before profiles. Not during exams.
 */

export interface ProfileData {
  settings: Partial<Settings>;
  languages: LanguageOverrides;
  other: Record<string, unknown>;
  keybindings: string;
}

export interface ProfilesState {
  active: string;
  profiles: Record<string, ProfileData>;
}

export const DEFAULT_PROFILE = "Default";
const KEY = "profiles";

export const useProfiles = create<ProfilesState>(() => ({ active: DEFAULT_PROFILE, profiles: {} }));

/** The settings and shortcuts in force now. */
export function captureProfile(): ProfileData {
  const s = useWorkbench.getState();
  return { settings: userDiff(s.userSettings), languages: s.languageSettings, other: s.otherSettings, keybindings: useKeybindingRules.getState().text };
}

/** Puts a profile's settings and shortcuts in force. */
export function applyProfile(p: ProfileData) {
  applyUserSettingsJson({ values: p.settings ?? {}, languages: p.languages ?? {}, other: p.other ?? {} });
  saveKeybindingsText(p.keybindings || KEYBINDINGS_TEMPLATE);
}

/** A valid profile from JSON (an exported file); null when it isn't one. Pure. */
export function readProfileJson(text: string): { name: string; data: ProfileData } | null {
  try {
    const raw = JSON.parse(text) as { name?: unknown; settings?: unknown; languages?: unknown; other?: unknown; keybindings?: unknown };
    if (!raw || typeof raw !== "object" || typeof raw.settings !== "object" || raw.settings === null) return null;
    return {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "Imported",
      data: {
        settings: raw.settings as Partial<Settings>,
        languages: (raw.languages && typeof raw.languages === "object" ? raw.languages : {}) as LanguageOverrides,
        other: (raw.other && typeof raw.other === "object" ? raw.other : {}) as Record<string, unknown>,
        keybindings: typeof raw.keybindings === "string" ? raw.keybindings : KEYBINDINGS_TEMPLATE,
      },
    };
  } catch {
    return null;
  }
}

function persist() {
  void getPlatform()
    .store.set(KEY, useProfiles.getState())
    .catch(() => undefined);
}

const blocked = () => {
  if (inExam() || useWorkbench.getState().policy.mode !== "practice") {
    notify("warning", "Profiles can't be changed during an exam.");
    return true;
  }
  return false;
};

/** Switches to `name`: the current set goes into the active profile first. */
export function switchProfile(name: string) {
  const st = useProfiles.getState();
  if (name === st.active) return;
  const target = name === DEFAULT_PROFILE ? st.profiles[DEFAULT_PROFILE] : st.profiles[name];
  if (!target) return;
  useProfiles.setState({ active: name, profiles: { ...st.profiles, [st.active]: captureProfile() } });
  applyProfile(target);
  persist();
  notify("info", `Profile: ${name}.`);
}

export function createProfile(name: string, from: "current" | "empty") {
  const st = useProfiles.getState();
  const data: ProfileData = from === "current" ? captureProfile() : { settings: {}, languages: {}, other: {}, keybindings: KEYBINDINGS_TEMPLATE };
  useProfiles.setState({ profiles: { ...st.profiles, [st.active]: captureProfile(), [name]: data } });
  switchProfile(name);
  persist();
}

export function deleteProfile(name: string) {
  const st = useProfiles.getState();
  if (name === st.active || name === DEFAULT_PROFILE) return;
  const profiles = { ...st.profiles };
  delete profiles[name];
  useProfiles.setState({ profiles });
  persist();
}

const names = () => {
  const st = useProfiles.getState();
  return [DEFAULT_PROFILE, ...Object.keys(st.profiles).filter((n) => n !== DEFAULT_PROFILE).sort()];
};

let wired = false;
export function wireProfiles() {
  if (wired) return;
  wired = true;
  void getPlatform()
    .store.get<ProfilesState>(KEY)
    .then((saved) => saved?.active && useProfiles.setState({ active: saved.active, profiles: saved.profiles ?? {} }))
    .catch(() => undefined);

  registerCommand({
    id: "workbench.profiles.actions.createProfile",
    title: "Create Profile...",
    category: "Profiles",
    run: async () => {
      if (blocked()) return;
      const name = (await showInputBox({ prompt: "Profile name", placeholder: "Web projects, Python course…", validate: (v) => (!v.trim() ? "Type a name." : names().includes(v.trim()) ? "A profile with this name exists." : null) }))?.trim();
      if (!name) return;
      const from = await showQuickPick({
        placeholder: "Start the profile from…",
        items: [
          { id: "current", label: "Your current settings and shortcuts" },
          { id: "empty", label: "TMCode's defaults" },
        ],
      });
      if (from) createProfile(name, from.id as "current" | "empty");
    },
  });
  registerCommand({
    id: "workbench.profiles.actions.switchProfile",
    title: "Switch Profile...",
    category: "Profiles",
    run: async () => {
      if (blocked()) return;
      const st = useProfiles.getState();
      const pick = await showQuickPick({ placeholder: "Select a profile", items: names().map((n) => ({ id: n, label: n, description: n === st.active ? "current" : undefined, icon: n === st.active ? "check" : "account" })) });
      if (pick && pick.id !== st.active) {
        // The Default profile is the set from before profiles: kept the first time we leave it.
        if (!st.profiles[DEFAULT_PROFILE]) useProfiles.setState({ profiles: { ...st.profiles, [DEFAULT_PROFILE]: captureProfile() } });
        switchProfile(pick.id);
      }
    },
  });
  registerCommand({
    id: "workbench.profiles.actions.deleteProfile",
    title: "Delete Profile...",
    category: "Profiles",
    enabled: () => Object.keys(useProfiles.getState().profiles).some((n) => n !== DEFAULT_PROFILE && n !== useProfiles.getState().active),
    run: async () => {
      if (blocked()) return;
      const st = useProfiles.getState();
      const pick = await showQuickPick({ placeholder: "Select the profile to delete", items: names().filter((n) => n !== DEFAULT_PROFILE && n !== st.active).map((n) => ({ id: n, label: n })) });
      if (pick) deleteProfile(pick.id);
    },
  });
  registerCommand({
    id: "workbench.profiles.actions.exportProfile",
    title: "Export Profile...",
    category: "Profiles",
    enabled: () => !!useWorkbench.getState().workspace,
    run: async () => {
      const name = useProfiles.getState().active;
      const file = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "profile"}.tmcode-profile.json`;
      await getPlatform().fs.writeFile(file, `${JSON.stringify({ name, ...captureProfile() }, null, 2)}\n`);
      await refreshExplorer();
      openFile(file, { pinned: true });
      notify("info", `Exported the ${name} profile to ${file}. Share it, or import it on another computer.`);
    },
  });
  registerCommand({
    id: "workbench.profiles.actions.importProfile",
    title: "Import Profile from the Open File",
    category: "Profiles",
    enabled: () => !!activeFilePath(),
    run: async () => {
      if (blocked()) return;
      const path = activeFilePath();
      const text = path ? await getPlatform().fs.readFile(path).catch(() => "") : "";
      const p = readProfileJson(text);
      if (!p) return notify("error", "The open file isn't a TMCode profile (export one with Profiles: Export Profile…).");
      let name = p.name;
      while (names().includes(name)) name = `${p.name} (${names().filter((n) => n.startsWith(p.name)).length + 1})`;
      const st = useProfiles.getState();
      useProfiles.setState({ profiles: { ...st.profiles, [st.active]: captureProfile(), [name]: p.data } });
      persist();
      switchProfile(name);
    },
  });
}
