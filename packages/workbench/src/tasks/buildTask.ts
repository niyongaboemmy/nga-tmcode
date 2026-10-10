import { parseJsonc } from "../textmate/jsonc";

/**
 * Run Build Task (⇧⌘B): the default build task of .vscode/tasks.json
 * (`"group": { "kind": "build", "isDefault": true }`), else its only build
 * task. Pure (unit-tested); the caller reads the file and runs the command.
 */

export interface BuildTask {
  label: string;
  /** Shell command line (command and arguments joined). */
  command: string;
  /** Workspace-relative folder ("" = the root). */
  cwd: string;
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);

function argText(a: unknown): string | null {
  if (typeof a === "string") return quote(a);
  if (a && typeof a === "object" && typeof (a as { value?: unknown }).value === "string") return quote((a as { value: string }).value);
  return null;
}

/** `${workspaceFolder}/client` → "client"; other variables are left out. */
function relCwd(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const rel = raw.replace(/^\$\{workspaceFolder\}[\\/]?/, "").replace(/\\/g, "/").replace(/\/+$/, "");
  return rel.includes("${") || rel.startsWith("/") || rel.split("/").includes("..") ? "" : rel;
}

type RawTask = Record<string, unknown>;

const groupOf = (t: RawTask) => {
  const g = t.group;
  if (typeof g === "string") return { kind: g, isDefault: false };
  if (g && typeof g === "object") return { kind: String((g as { kind?: unknown }).kind ?? ""), isDefault: (g as { isDefault?: unknown }).isDefault === true };
  return { kind: "", isDefault: false };
};

export function defaultBuildTask(tasksJson: string, os: "mac" | "windows" | "linux"): BuildTask | null {
  let raw: unknown;
  try {
    raw = parseJsonc(tasksJson);
  } catch {
    return null;
  }
  const tasks = Array.isArray((raw as { tasks?: unknown })?.tasks) ? ((raw as { tasks: unknown[] }).tasks.filter((t) => t && typeof t === "object") as RawTask[]) : [];
  const builds = tasks.filter((t) => groupOf(t).kind === "build");
  const chosen = builds.find((t) => groupOf(t).isDefault) ?? (builds.length === 1 ? builds[0] : null);
  if (!chosen) return null;
  // Per-OS overrides ("osx", "windows", "linux"), as VS Code merges them.
  const osKey = os === "mac" ? "osx" : os;
  const t = { ...chosen, ...((chosen[osKey] as RawTask | undefined) ?? {}) };
  // npm tasks name a script instead of a command.
  if (t.type === "npm" && typeof t.script === "string") return { label: String(t.label ?? `npm: ${t.script}`), command: `npm run ${t.script}`, cwd: relCwd(t.path) };
  if (typeof t.command !== "string" || !t.command.trim()) return null;
  const args = Array.isArray(t.args) ? t.args.map(argText).filter((a): a is string => a !== null) : [];
  const opts = (t.options as { cwd?: unknown } | undefined) ?? {};
  return {
    label: typeof t.label === "string" ? t.label : t.command,
    command: [t.command, ...args].join(" "),
    cwd: relCwd(opts.cwd),
  };
}
