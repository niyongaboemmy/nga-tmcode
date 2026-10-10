import { describe, expect, it } from "vitest";
import { fallbackShellName, pickProfile, terminalLabel } from "./profiles";
import { needsTrust } from "../trust/trust";
import type { TerminalProfile } from "../platform/types";

const P: TerminalProfile[] = [
  { id: "powershell", name: "PowerShell", path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", is_default: true },
  { id: "cmd", name: "Command Prompt", path: "C:/Windows/System32/cmd.exe", is_default: false },
  { id: "gitbash", name: "Git Bash", path: "C:/Program Files/Git/bin/bash.exe", is_default: false },
];

describe("terminal profiles", () => {
  it("uses the requested shell, else the setting, else the system's", () => {
    expect(pickProfile(P, "cmd", "gitbash")?.id).toBe("cmd");
    expect(pickProfile(P, undefined, "gitbash")?.id).toBe("gitbash");
    expect(pickProfile(P, undefined, "")?.id).toBe("powershell");
    // A setting naming a shell that isn't installed (a profile synced from another computer) falls back.
    expect(pickProfile(P, undefined, "wsl")?.id).toBe("powershell");
    expect(pickProfile([], "zsh", "zsh")).toBeNull();
  });

  it("labels tabs with the real shell, numbering repeats", () => {
    expect(terminalLabel("bash", [])).toBe("bash");
    expect(terminalLabel("bash", ["bash", "zsh"])).toBe("bash (2)");
    expect(fallbackShellName("windows")).toBe("powershell");
    expect(fallbackShellName("linux")).toBe("bash");
  });
});

describe("workspace trust", () => {
  const base = { root: "/Users/ada/code/repo", taskMentor: false, exam: false, cloned: false, hasRemote: false };
  it("asks for cloned folders and folders with a git remote", () => {
    expect(needsTrust({ ...base, cloned: true })).toBe(true);
    expect(needsTrust({ ...base, hasRemote: true })).toBe(true);
    expect(needsTrust(base)).toBe(false);
  });
  it("never for Task Mentor folders, exams or the built-in demo", () => {
    expect(needsTrust({ ...base, cloned: true, taskMentor: true })).toBe(false);
    expect(needsTrust({ ...base, cloned: true, exam: true })).toBe(false);
    expect(needsTrust({ ...base, root: "memory://practice-project", hasRemote: true })).toBe(false);
    expect(needsTrust({ ...base, root: "memory://clones/Hello-World", cloned: true })).toBe(true);
  });
});
