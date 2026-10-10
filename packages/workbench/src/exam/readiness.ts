import { create } from "zustand";
import { PROFILES } from "@tmcode/profiles";
import type { Profile } from "@tmcode/protocol";
import type { OsKind, Toolchain } from "../platform/types";
import { getPlatform } from "../state/store";
import { ALLOWED_APIS, TmApi } from "./api";

/**
 * "Is this computer ready for a coding exam?" (review E1, F3): the language
 * tools the tasks need, Task Mentor, the clock and the disk. Runs in the exam
 * lobby (with the exam's languages) and from "Check My Computer" (all of them).
 */

export type CheckStatus = "running" | "ok" | "warn" | "fail" | "skipped";

export interface CheckLink {
  label: string;
  url: string;
}

export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  /** One plain line: what was found, or what is wrong. */
  detail: string;
  /** How to fix it on this computer (only for problems). */
  fix?: string;
  links?: CheckLink[];
}

// ───────────────────────── language tools ─────────────────────────

interface ToolHelp {
  name: string;
  fix: Record<OsKind, string>;
  links: Record<OsKind, CheckLink[]>;
}

const all = (links: CheckLink[]): Record<OsKind, CheckLink[]> => ({ mac: links, windows: links, linux: links });
const same = (text: string): Record<OsKind, string> => ({ mac: text, windows: text, linux: text });

const C_FIX: Record<OsKind, string> = {
  mac: "Open Terminal and run: xcode-select --install (Apple's free command line tools).",
  windows: "Install MSYS2, then in its terminal run: pacman -S mingw-w64-ucrt-x86_64-gcc. Add C:\\msys64\\ucrt64\\bin to PATH.",
  linux: "Run: sudo apt install build-essential (or your distribution's gcc package).",
};
const C_LINKS: Record<OsKind, CheckLink[]> = {
  mac: [{ label: "Apple command line tools", url: "https://developer.apple.com/xcode/resources/" }],
  windows: [{ label: "MSYS2 (gcc for Windows)", url: "https://www.msys2.org/" }],
  linux: [{ label: "GCC", url: "https://gcc.gnu.org/install/binaries.html" }],
};

/** Per tool the runner looks for (runner.rs / toolchains.rs TOOLS). */
export const TOOL_HELP: Record<string, ToolHelp> = {
  python: {
    name: "Python 3",
    fix: {
      mac: "Install Python 3 from python.org.",
      windows: 'Install Python 3 from python.org and tick "Add python.exe to PATH" in the installer.',
      linux: "Run: sudo apt install python3 (or your distribution's python3 package).",
    },
    links: {
      mac: [{ label: "Python for macOS", url: "https://www.python.org/downloads/macos/" }],
      windows: [{ label: "Python for Windows", url: "https://www.python.org/downloads/windows/" }],
      linux: [{ label: "Python downloads", url: "https://www.python.org/downloads/" }],
    },
  },
  node: { name: "Node.js", fix: same("Install the LTS version of Node.js."), links: all([{ label: "Node.js downloads", url: "https://nodejs.org/en/download" }]) },
  cc: { name: "a C compiler (gcc or clang)", fix: C_FIX, links: C_LINKS },
  cxx: { name: "a C++ compiler (g++ or clang++)", fix: C_FIX, links: C_LINKS },
  javac: {
    name: "a Java JDK (17 or newer)",
    fix: same("Install a JDK (Temurin 21 is free), then restart TMCode."),
    links: all([{ label: "Temurin JDK 21", url: "https://adoptium.net/temurin/releases/?version=21" }]),
  },
  java: {
    name: "a Java JDK (17 or newer)",
    fix: same("Install a JDK (Temurin 21 is free), then restart TMCode."),
    links: all([{ label: "Temurin JDK 21", url: "https://adoptium.net/temurin/releases/?version=21" }]),
  },
  go: { name: "Go", fix: same("Install Go from go.dev."), links: all([{ label: "Go downloads", url: "https://go.dev/dl/" }]) },
  rustc: {
    name: "Rust",
    fix: { mac: "Install Rust with rustup.", windows: "Install Rust with rustup-init.exe (it also asks for the Visual Studio C++ build tools).", linux: "Install Rust with rustup." },
    links: all([{ label: "rustup", url: "https://rustup.rs/" }]),
  },
};

/** The tools a profile needs to run on this computer ("exe" is the built program). */
export function toolsFor(profile: Profile): string[] {
  if (!profile.local) return [];
  return [...new Set([...profile.local.build.map((s) => s.tool), profile.local.run.tool].filter((t) => t !== "exe"))];
}

/** One line per language: found (with the version) or missing (with how to install it). */
export function toolchainChecks(profiles: Profile[], found: Toolchain[], os: OsKind, opts: { exam: boolean }): CheckItem[] {
  const have = new Map(found.map((t) => [t.tool, t]));
  return profiles.map((p) => {
    const tools = toolsFor(p);
    if (!tools.length) return { id: `tool:${p.id}`, label: p.label, status: "ok", detail: "Runs inside TMCode. Nothing to install." };
    const missing = tools.filter((t) => !have.has(t));
    if (!missing.length) {
      const t = have.get(tools[tools.length - 1]) ?? have.get(tools[0])!;
      return { id: `tool:${p.id}`, label: p.label, status: "ok", detail: t.version || "Installed" };
    }
    const help = TOOL_HELP[missing[0]];
    const name = help?.name ?? missing[0];
    return {
      id: `tool:${p.id}`,
      label: p.label,
      // In an exam the example tests can still run on Task Mentor, so it's a warning there.
      status: opts.exam ? "warn" : "fail",
      detail: opts.exam
        ? `TMCode can't find ${name}. Your example tests will run on Task Mentor instead, and Run won't work on this computer.`
        : `TMCode can't find ${name} on this computer.`,
      fix: `${help?.fix[os] ?? `Install ${name}.`} Then choose Check Again.`,
      links: help?.links[os] ?? [],
    };
  });
}

/** Every language TMCode runs on this computer, once per toolset (TypeScript shares Node.js). */
export function computerProfiles(): Profile[] {
  const seen = new Set<string>();
  return PROFILES.filter((p) => {
    const key = toolsFor(p).join("+");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ───────────────────────── Task Mentor, clock, disk ─────────────────────────

const CLOCK_FIX: Record<OsKind, string> = {
  mac: 'System Settings › General › Date & Time: turn on "Set time and date automatically".',
  windows: 'Settings › Time & language › Date & time: turn on "Set time automatically", then choose Sync now.',
  linux: "Run: timedatectl set-ntp true",
};

export function reachabilityCheck(result: { ms: number } | null): CheckItem {
  if (!result) {
    return {
      id: "taskmentor",
      label: "Task Mentor",
      status: "fail",
      detail: "TMCode can't reach Task Mentor.",
      fix: "Check the Wi-Fi or network cable. On a school network, ask for taskmentor-api.amashuri.com to be allowed.",
    };
  }
  if (result.ms > 3000) return { id: "taskmentor", label: "Task Mentor", status: "warn", detail: `Reachable, but slow (${(result.ms / 1000).toFixed(1)} s).`, fix: "Move closer to the Wi-Fi, or use a cable." };
  return { id: "taskmentor", label: "Task Mentor", status: "ok", detail: `Connected (${result.ms} ms).` };
}

/** `offsetMs` = server time − this computer's time. */
export function clockCheck(offsetMs: number | null, os: OsKind): CheckItem {
  if (offsetMs === null) return { id: "clock", label: "Clock", status: "skipped", detail: "Not checked: Task Mentor did not answer." };
  const off = Math.abs(offsetMs);
  if (off <= 60_000) return { id: "clock", label: "Clock", status: "ok", detail: "In sync with Task Mentor." };
  const mins = Math.round(off / 60_000);
  const amount = off >= 3_600_000 ? `${Math.round(off / 3_600_000)} h` : `${mins} min`;
  return {
    id: "clock",
    label: "Clock",
    status: "warn",
    detail: `This computer's clock is ${amount} ${offsetMs < 0 ? "fast" : "slow"}. Exams use Task Mentor's time, so your timer is still right.`,
    fix: CLOCK_FIX[os],
  };
}

const DISK_FIX = "Free some space on the disk (at least 200 MB), then choose Check Again.";

/** Writes, reads back and removes a small file: in the exam folder during an exam, else in TMCode's own storage. */
export async function diskCheck(where: "workspace" | "store"): Promise<CheckItem> {
  const p = getPlatform();
  const stamp = `tmcode-check-${Date.now()}`;
  try {
    if (where === "workspace") {
      await p.fs.writeFile(".tmcode-check", stamp);
      const back = await p.fs.readFile(".tmcode-check");
      await p.fs.remove(".tmcode-check").catch(() => {});
      if (back !== stamp) throw new Error("read back a different file");
    } else {
      await p.store.set("readiness.check", stamp);
      if ((await p.store.get<string>("readiness.check")) !== stamp) throw new Error("read back a different value");
    }
    return { id: "disk", label: "Saving files", status: "ok", detail: "TMCode can save your work on this computer." };
  } catch (e) {
    return { id: "disk", label: "Saving files", status: "fail", detail: `TMCode can't save files here (${String((e as Error)?.message ?? e)}).`, fix: DISK_FIX };
  }
}

// ───────────────────────── Check My Computer ─────────────────────────

export interface ReadinessState {
  open: boolean;
  running: boolean;
  items: CheckItem[];
  checkedAt: number | null;
}

export const useReadiness = create<ReadinessState>()(() => ({ open: false, running: false, items: [], checkedAt: null }));

/** The Task Mentor this TMCode talks to (the signed-in account's, else production; dev/e2e may override). */
function taskMentorBase(): string {
  try {
    const dev = import.meta.env?.DEV ? localStorage.getItem("tmcode:mock-tm-api") : null;
    if (dev) return dev;
  } catch {
    /* no storage */
  }
  return ALLOWED_APIS[0];
}

/** Language tools, Task Mentor, clock and disk, outside an exam. */
export async function checkMyComputer(apiBase?: string): Promise<CheckItem[]> {
  const p = getPlatform();
  const profiles = computerProfiles();
  const running = (id: string, label: string): CheckItem => ({ id, label, status: "running", detail: "Checking…" });
  useReadiness.setState({
    open: true,
    running: true,
    items: [...profiles.map((pr) => running(`tool:${pr.id}`, pr.label)), running("taskmentor", "Task Mentor"), running("clock", "Clock"), running("disk", "Saving files")],
  });
  const fetchImpl = p.exam?.fetch ? (u: string, i?: RequestInit) => p.exam!.fetch(u, i) : (u: string, i?: RequestInit) => fetch(u, i);
  const api = new TmApi(apiBase ?? taskMentorBase(), fetchImpl);
  const [found, ping, disk] = await Promise.all([
    p.runner ? p.runner.detect(true).catch(() => [] as Toolchain[]) : Promise.resolve([] as Toolchain[]),
    api.ping().catch(() => null),
    diskCheck("store"),
  ]);
  const items = [
    ...(p.runner
      ? toolchainChecks(profiles, found, p.os, { exam: false })
      : [{ id: "tool:none", label: "Language tools", status: "skipped" as const, detail: "Running code needs the TMCode desktop app." }]),
    reachabilityCheck(ping),
    clockCheck(ping?.serverTime != null ? ping.serverTime - Date.now() : null, p.os),
    disk,
  ];
  useReadiness.setState({ running: false, items, checkedAt: Date.now() });
  return items;
}

export function closeCheckMyComputer() {
  useReadiness.setState({ open: false });
}

export const problemCount = (items: CheckItem[]) => items.filter((i) => i.status === "fail" || i.status === "warn").length;
