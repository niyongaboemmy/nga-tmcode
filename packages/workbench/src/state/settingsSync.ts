import { create } from "zustand";
import { registerCommand } from "../commands/registry";
import { useKeybindingRules } from "../commands/keybindingRules";
import { inExam } from "../exam/state";
import { useProjects } from "../projects/service";
import { applyProfile, captureProfile, useProfiles, type ProfileData, type ProfilesState } from "./profiles";
import { getPlatform, notify, showDialog, useWorkbench } from "./store";

/**
 * Settings Sync through the student's NGA account (Task Mentor's
 * /api/tmcode/settings-sync): settings, shortcuts and profiles follow you to
 * another computer. Each write names the version it starts from; when another
 * computer wrote since, its settings are taken (they are the newer ones).
 */

export interface SyncDocument {
  version: 1;
  current: ProfileData;
  profiles: ProfilesState;
}

interface SyncState {
  enabled: boolean;
  /** The server's version this computer has (updated_at). */
  base: string | null;
  status: "off" | "idle" | "syncing" | "error";
  lastSynced: number | null;
}

const KEY = "settingsSync";
export const useSettingsSync = create<SyncState>(() => ({ enabled: false, base: null, status: "off", lastSynced: null }));

function account() {
  return getPlatform().account;
}

const allowed = () => !!account() && !!useProjects.getState().account?.signed_in && !inExam() && useWorkbench.getState().policy.mode === "practice";

function persist() {
  const { enabled, base } = useSettingsSync.getState();
  void getPlatform()
    .store.set(KEY, { enabled, base })
    .catch(() => undefined);
}

export function localDocument(): SyncDocument {
  return { version: 1, current: captureProfile(), profiles: useProfiles.getState() };
}

/** Puts a synced document in force (its settings, shortcuts and profiles). */
export function applyDocument(doc: SyncDocument) {
  if (doc?.version !== 1 || !doc.current) return;
  applying = true;
  try {
    if (doc.profiles?.active) useProfiles.setState({ active: doc.profiles.active, profiles: doc.profiles.profiles ?? {} });
    applyProfile(doc.current);
  } finally {
    applying = false;
  }
}

let applying = false;

async function get(): Promise<{ data: SyncDocument | null; updated_at: string | null }> {
  const r = await account()!.request<{ data: SyncDocument | null; updated_at: string | null }>({ method: "GET", path: "/api/tmcode/settings-sync" });
  if (r.status !== 200) throw new Error(`Settings Sync failed (${r.status}).`);
  return r.body;
}

async function put(): Promise<"ok" | "conflict"> {
  const r = await account()!.request<{ updated_at?: string; error_code?: string }>({ method: "PUT", path: "/api/tmcode/settings-sync", json: { data: localDocument(), base: useSettingsSync.getState().base } });
  if (r.status === 409) return "conflict";
  if (r.status !== 200 || !r.body.updated_at) throw new Error(`Settings Sync failed (${r.status}).`);
  useSettingsSync.setState({ base: r.body.updated_at, lastSynced: Date.now() });
  persist();
  return "ok";
}

/** Pulls newer settings from the account, then pushes this computer's. */
export async function syncNow(): Promise<void> {
  if (!allowed() || !useSettingsSync.getState().enabled) return;
  useSettingsSync.setState({ status: "syncing" });
  try {
    const remote = await get();
    if (remote.data && remote.updated_at && remote.updated_at !== useSettingsSync.getState().base) {
      // Another computer synced since: its settings are the newer ones.
      applyDocument(remote.data);
      useSettingsSync.setState({ base: remote.updated_at, lastSynced: Date.now() });
      persist();
      notify("info", "Settings Sync: your settings came from your other computer.");
    } else if (JSON.stringify(remote.data) !== JSON.stringify(localDocument())) {
      if ((await put()) === "conflict") return syncNow();
    }
    useSettingsSync.setState({ status: "idle", lastSynced: Date.now() });
  } catch (e) {
    useSettingsSync.setState({ status: "error" });
    notify("warning", `Settings Sync: ${String((e as Error)?.message ?? e)}`);
  }
}

/** Turns sync on: when the account already has settings, the student chooses which to keep. */
export async function turnOnSync() {
  if (!allowed()) return notify("info", "Settings Sync needs the NGA account signed in (and not during an exam).");
  const remote = await get().catch((e) => {
    notify("error", String((e as Error)?.message ?? e));
    return null;
  });
  if (!remote) return;
  if (remote.data && JSON.stringify(remote.data) !== JSON.stringify(localDocument())) {
    const choice = await showDialog({
      message: "Your account already has synced settings.",
      detail: "Use them on this computer, or replace them with this computer's settings?",
      buttons: [
        { id: "remote", label: "Use Synced Settings", primary: true },
        { id: "local", label: "Replace with This Computer's" },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice === "cancel") return;
    if (choice === "remote") {
      applyDocument(remote.data);
      useSettingsSync.setState({ enabled: true, base: remote.updated_at, status: "idle", lastSynced: Date.now() });
      persist();
      return notify("info", "Settings Sync is on. Your synced settings are in use.");
    }
  }
  useSettingsSync.setState({ enabled: true, base: remote.updated_at, status: "idle" });
  persist();
  await put().catch((e) => notify("error", String((e as Error)?.message ?? e)));
  notify("info", "Settings Sync is on. Your settings, shortcuts and profiles follow your NGA account.");
}

export function turnOffSync() {
  useSettingsSync.setState({ enabled: false, status: "off" });
  persist();
  notify("info", "Settings Sync is off. Your settings stay as they are on this computer.");
}

let wired = false;
export function wireSettingsSync() {
  if (wired) return;
  wired = true;
  void getPlatform()
    .store.get<{ enabled: boolean; base: string | null }>(KEY)
    .then((saved) => {
      if (saved?.enabled) {
        useSettingsSync.setState({ enabled: true, base: saved.base ?? null, status: "idle" });
        setTimeout(() => void syncNow(), 1500);
      }
    })
    .catch(() => undefined);
  // A change on this computer goes up a few seconds later.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = () => {
    if (applying || !useSettingsSync.getState().enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void syncNow(), 3000);
  };
  useWorkbench.subscribe((s, prev) => {
    if (s.userSettings !== prev.userSettings || s.languageSettings !== prev.languageSettings) changed();
  });
  useKeybindingRules.subscribe((s, prev) => s.text !== prev.text && changed());
  useProfiles.subscribe(changed);
  registerCommand({ id: "workbench.userDataSync.actions.turnOn", title: "Turn On Settings Sync...", category: "Settings Sync", enabled: () => allowed() && !useSettingsSync.getState().enabled, run: () => void turnOnSync() });
  registerCommand({ id: "workbench.userDataSync.actions.turnOff", title: "Turn Off", category: "Settings Sync", enabled: () => useSettingsSync.getState().enabled, run: turnOffSync });
  registerCommand({ id: "workbench.userDataSync.actions.syncNow", title: "Sync Now", category: "Settings Sync", enabled: () => allowed() && useSettingsSync.getState().enabled, run: () => void syncNow() });
}
