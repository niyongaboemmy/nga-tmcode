import { create } from "zustand";
import { saveAll } from "../monaco/documents";
import { inExam } from "../exam/state";
import type { UpdateInfo } from "../platform/types";
import { dismissNotification, getPlatform, log, notify, showDialog, useWorkbench } from "../state/store";

/**
 * When TMCode looks for and installs updates (plan §18). Checks are automatic
 * (start + every 6 h) unless the setting says manual/none; nothing is ever
 * installed during an exam, and the student always chooses when to restart.
 */

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "error";

export interface UpdateState {
  status: UpdateStatus;
  info: UpdateInfo | null;
  progress: number | null;
  error: string | null;
  lastChecked: number | null;
}

export const useUpdate = create<UpdateState>()(() => ({ status: "idle", info: null, progress: null, error: null, lastChecked: null }));
const set = useUpdate.setState;

const FIRST_CHECK_MS = 30_000;
const EVERY_MS = 6 * 60 * 60 * 1000;
let timers: ReturnType<typeof setTimeout>[] = [];
let announced: string | null = null;

export function updatesSupported() {
  return !!getPlatform().updater;
}

export async function checkForUpdates(opts: { manual?: boolean } = {}) {
  const updater = getPlatform().updater;
  if (!updater) {
    if (opts.manual) notify("info", "Updates are installed with the TMCode desktop app.");
    return;
  }
  if (useUpdate.getState().status === "downloading" || useUpdate.getState().status === "installing") return;
  set({ status: "checking", error: null });
  try {
    const info = await updater.check();
    set({ status: info ? "available" : "up-to-date", info, lastChecked: Date.now() });
    if (!info) {
      if (opts.manual) notify("info", `You're on the latest version of TMCode (${getPlatform().version}).`);
      return;
    }
    log("Updates", `TMCode ${info.version} is available (current ${info.current_version})`);
    if (opts.manual || announced !== info.version) {
      announced = info.version;
      notify("info", `TMCode ${info.version} is available. You have ${info.current_version}.`, [
        { label: "Release Notes", run: () => void showReleaseNotes() },
        { label: "Install and Restart", run: () => void installUpdate() },
      ]);
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    set({ status: "error", error: msg, lastChecked: Date.now() });
    log("Updates", msg, "warn");
    if (opts.manual) notify("error", msg);
  }
}

export async function showReleaseNotes() {
  const info = useUpdate.getState().info;
  if (!info) return;
  const choice = await showDialog({
    message: `TMCode ${info.version}`,
    detail: `${info.notes?.trim() || "No release notes."}\n\nYou have version ${info.current_version}.`,
    buttons: [
      { id: "install", label: "Install and Restart", primary: true },
      { id: "later", label: "Later" },
    ],
    cancelId: "later",
  });
  if (choice === "install") await installUpdate();
}

export async function installUpdate() {
  const updater = getPlatform().updater;
  if (!updater || !useUpdate.getState().info) return;
  if (inExam()) {
    notify("warning", "Updates can't be installed during an exam. TMCode will offer it again after you submit.");
    return;
  }
  // Nothing may be lost when the app restarts.
  await saveAll();
  if (Object.keys(useWorkbench.getState().dirty).length) {
    notify("error", "Some files could not be saved, so the update was not installed.");
    return;
  }
  set({ status: "downloading", progress: 0 });
  const progressId = notify("info", "Downloading the update…");
  try {
    await updater.install((p) => {
      if (p.type === "chunk" && p.total) set({ progress: Math.round((p.downloaded / p.total) * 100) });
      if (p.type === "installing") set({ status: "installing", progress: 100 });
    });
  } catch (e) {
    set({ status: "error", error: String((e as Error)?.message ?? e) });
    notify("error", String((e as Error)?.message ?? e));
  } finally {
    dismissNotification(progressId);
  }
}

/** Automatic checks per the "update.mode" setting (desktop only). */
export function startAutoUpdates() {
  stopAutoUpdates();
  if (!updatesSupported()) return;
  const schedule = (ms: number) => {
    timers.push(
      setTimeout(() => {
        const mode = useWorkbench.getState().settings["update.mode"];
        if (mode === "default" && !inExam()) void checkForUpdates();
        schedule(EVERY_MS);
      }, ms),
    );
  };
  schedule(FIRST_CHECK_MS);
}

export function stopAutoUpdates() {
  timers.forEach(clearTimeout);
  timers = [];
}

export async function showAbout() {
  const p = getPlatform();
  const u = useUpdate.getState();
  const choice = await showDialog({
    message: "TMCode",
    detail: [
      `Version ${p.version}`,
      `${p.kind === "desktop" ? "Desktop" : "Web"} · ${p.os === "mac" ? "macOS" : p.os === "windows" ? "Windows" : "Linux"}`,
      u.lastChecked ? `Last checked for updates: ${new Date(u.lastChecked).toLocaleString()}` : "",
      "",
      "The New Generation Academy code editor for practice, Task Mentor coding tests and exams.",
    ]
      .filter((l, i) => l || i > 2)
      .join("\n"),
    buttons: [
      ...(updatesSupported() ? [{ id: "check", label: "Check for Updates" }] : []),
      { id: "ok", label: "OK", primary: true },
    ],
    cancelId: "ok",
  });
  if (choice === "check") await checkForUpdates({ manual: true });
}
