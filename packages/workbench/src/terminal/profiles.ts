import { create } from "zustand";
import type { TerminalProfile } from "../platform/types";
import { getPlatform, useWorkbench } from "../state/store";

/**
 * Shell profiles found on this computer (desktop: pty.rs detects zsh, bash,
 * fish; PowerShell, pwsh, Command Prompt, Git Bash, WSL), like VS Code's
 * terminal profiles. Loaded once, on first use.
 */
export const useTerminalProfiles = create<{ profiles: TerminalProfile[]; loaded: boolean }>(() => ({ profiles: [], loaded: false }));

let loading: Promise<TerminalProfile[]> | null = null;
export function loadTerminalProfiles(): Promise<TerminalProfile[]> {
  if (!loading) {
    const term = (() => {
      try {
        return getPlatform().terminal;
      } catch {
        return undefined;
      }
    })();
    loading = (term?.profiles?.() ?? Promise.resolve([] as TerminalProfile[]))
      .catch(() => [] as TerminalProfile[])
      .then((profiles) => {
        useTerminalProfiles.setState({ profiles, loaded: true });
        return profiles;
      });
  }
  return loading;
}

export function resetTerminalProfilesForTests() {
  loading = null;
  useTerminalProfiles.setState({ profiles: [], loaded: false });
}

/**
 * The profile a new terminal uses: the one asked for, else the
 * "terminal.integrated.defaultProfile" setting, else the system's default.
 * A setting naming a shell that isn't installed falls back too.
 */
export function pickProfile(profiles: TerminalProfile[], requested?: string | null, setting?: string | null): TerminalProfile | null {
  const byId = (id?: string | null) => (id ? profiles.find((p) => p.id === id) : undefined);
  return byId(requested) ?? byId(setting) ?? profiles.find((p) => p.is_default) ?? profiles[0] ?? null;
}

/** The name a terminal tab shows when the platform has no profiles (the browser build). */
export function fallbackShellName(os: string) {
  return os === "windows" ? "powershell" : os === "mac" ? "zsh" : "bash";
}

/** "zsh", "bash (2)": numbered when the same shell runs more than once. */
export function terminalLabel(name: string, others: string[]): string {
  const n = others.filter((o) => o === name).length;
  return n ? `${name} (${n + 1})` : name;
}

export function defaultProfileSetting() {
  return useWorkbench.getState().settings["terminal.integrated.defaultProfile"];
}
