import { parseJsonc } from "../textmate/jsonc";

/**
 * .vscode/tasks.json (version 2.0.0), the parts students and teachers use:
 * shell/process tasks and npm scripts, per-OS overrides, `dependsOn` (in
 * parallel or in sequence), groups (build/test, isDefault), background tasks,
 * problem matchers, `inputs` (promptString / pickString) and the usual
 * variables. Pure (unit-tested); tasks/runner.ts runs them.
 */

export interface UserTask {
  label: string;
  /** Command line (command and arguments joined); "" for a task that only runs its dependencies. */
  command: string;
  /** Raw, before variables are resolved: `${workspaceFolder}/client` and the like. */
  cwd: string;
  group: { kind: "build" | "test" | ""; isDefault: boolean };
  dependsOn: string[];
  dependsOrder: "parallel" | "sequence";
  isBackground: boolean;
  /** The task's `problemMatcher` as written (resolved by problemMatchers.ts). */
  problemMatcher: unknown;
  detail?: string;
  /** "folderOpen": run when the folder opens (after the user allows automatic tasks). */
  runOn: "default" | "folderOpen";
  /** Presentation: reveal the terminal ("always", "silent", "never"). */
  reveal: "always" | "silent" | "never";
}

export interface TaskInput {
  id: string;
  type: "promptString" | "pickString";
  description: string;
  default?: string;
  options?: string[];
  password?: boolean;
}

export interface TasksFile {
  tasks: UserTask[];
  inputs: TaskInput[];
}

type Raw = Record<string, unknown>;

const quote = (a: string) => (/^[\w@%+=:,./${}-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);

function argText(a: unknown): string | null {
  if (typeof a === "string") return quote(a);
  if (a && typeof a === "object" && typeof (a as { value?: unknown }).value === "string") return quote((a as { value: string }).value);
  return null;
}

function groupOf(g: unknown): UserTask["group"] {
  const kind = typeof g === "string" ? g : g && typeof g === "object" ? String((g as Raw).kind ?? "") : "";
  return { kind: kind === "build" || kind === "test" ? kind : "", isDefault: !!g && typeof g === "object" && (g as Raw).isDefault === true };
}

export function parseTasksJson(text: string, os: "mac" | "windows" | "linux"): TasksFile {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch {
    return { tasks: [], inputs: [] };
  }
  const root = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const osKey = os === "mac" ? "osx" : os;
  // Options at the top level apply to every task (a task's own win).
  const topOptions = ((root[osKey] as Raw | undefined)?.options ?? root.options ?? {}) as Raw;
  const list = Array.isArray(root.tasks) ? (root.tasks.filter((t) => t && typeof t === "object") as Raw[]) : [];
  const tasks: UserTask[] = [];
  for (const base of list) {
    const t = { ...base, ...((base[osKey] as Raw | undefined) ?? {}) };
    const label = typeof t.label === "string" ? t.label : typeof t.taskName === "string" ? t.taskName : typeof t.script === "string" ? `npm: ${t.script}` : typeof t.command === "string" ? t.command : "";
    if (!label) continue;
    let command = "";
    if (t.type === "npm" && typeof t.script === "string") command = `npm run ${t.script}`;
    else if (typeof t.command === "string" && t.command.trim()) {
      const args = Array.isArray(t.args) ? t.args.map(argText).filter((a): a is string => a !== null) : [];
      command = [t.type === "process" ? quote(t.command) : t.command, ...args].join(" ");
    }
    const opts = { ...topOptions, ...((t.options as Raw | undefined) ?? {}) };
    const dependsOn = typeof t.dependsOn === "string" ? [t.dependsOn] : Array.isArray(t.dependsOn) ? t.dependsOn.map((d) => (typeof d === "string" ? d : typeof (d as Raw)?.label === "string" ? String((d as Raw).label) : "")).filter(Boolean) : [];
    if (!command && !dependsOn.length) continue;
    const presentation = (t.presentation as Raw | undefined) ?? {};
    tasks.push({
      label,
      command,
      cwd: typeof opts.cwd === "string" ? opts.cwd : t.type === "npm" && typeof t.path === "string" ? `\${workspaceFolder}/${t.path}` : "",
      group: groupOf(t.group),
      dependsOn,
      dependsOrder: t.dependsOrder === "sequence" ? "sequence" : "parallel",
      isBackground: t.isBackground === true,
      problemMatcher: t.problemMatcher,
      detail: typeof t.detail === "string" ? t.detail : undefined,
      runOn: (t.runOptions as Raw | undefined)?.runOn === "folderOpen" ? "folderOpen" : "default",
      reveal: presentation.reveal === "never" || presentation.reveal === "silent" ? presentation.reveal : "always",
    });
  }
  const inputs: TaskInput[] = (Array.isArray(root.inputs) ? (root.inputs as Raw[]) : [])
    .filter((i) => i && typeof i.id === "string" && (i.type === "promptString" || i.type === "pickString"))
    .map((i) => ({
      id: String(i.id),
      type: i.type as TaskInput["type"],
      description: typeof i.description === "string" ? i.description : String(i.id),
      default: typeof i.default === "string" ? i.default : undefined,
      options: Array.isArray(i.options) ? i.options.map((o) => (typeof o === "string" ? o : String((o as Raw)?.value ?? ""))).filter(Boolean) : undefined,
      password: i.password === true,
    }));
  return { tasks, inputs };
}

/** The task Run Build Task / Run Test Task runs: the default of its group, else its only one. */
export function defaultTaskOf(tasks: UserTask[], kind: "build" | "test"): UserTask | null {
  const inGroup = tasks.filter((t) => t.group.kind === kind);
  return inGroup.find((t) => t.group.isDefault) ?? (inGroup.length === 1 ? inGroup[0] : null);
}

/** Why a task can't run: a dependency that isn't defined, or tasks that depend on each other in a loop. */
export function dependencyError(tasks: UserTask[], label: string): string | null {
  const byLabel = new Map(tasks.map((t) => [t.label, t]));
  const ok = new Set<string>();
  const visit = (name: string, path: string[]): string | null => {
    if (path.includes(name)) return `The tasks depend on each other in a loop: ${[...path, name].join(" → ")}.`;
    const t = byLabel.get(name);
    if (!t) return `The task '${name}' is not defined in tasks.json.`;
    if (ok.has(name)) return null;
    for (const d of t.dependsOn) {
      const e = visit(d, [...path, name]);
      if (e) return e;
    }
    ok.add(name);
    return null;
  };
  return visit(label, []);
}

export interface VariableContext {
  /** The folder's absolute path. */
  workspaceFolder: string;
  /** The active file, workspace-relative ("" when none). */
  file: string;
  env: (name: string) => string | undefined;
  /** Answers for `${input:id}` (asked before the task runs). */
  inputs: Record<string, string>;
}

/** `${workspaceFolder}`, `${file}`… resolved; unknown variables are left as they are. */
export function resolveVariables(text: string, ctx: VariableContext): string {
  const root = ctx.workspaceFolder.replace(/[\\/]+$/, "");
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  const abs = ctx.file ? `${root}${sep}${ctx.file.replace(/\//g, sep)}` : "";
  const base = ctx.file.split("/").pop() ?? "";
  const dir = ctx.file.includes("/") ? ctx.file.slice(0, ctx.file.lastIndexOf("/")) : "";
  const values: Record<string, string> = {
    workspaceFolder: root,
    workspaceRoot: root,
    workspaceFolderBasename: root.split(/[\\/]/).pop() ?? "",
    file: abs,
    relativeFile: ctx.file,
    relativeFileDirname: dir,
    fileBasename: base,
    fileBasenameNoExtension: base.replace(/\.[^.]*$/, ""),
    fileExtname: base.includes(".") ? base.slice(base.lastIndexOf(".")) : "",
    fileDirname: dir ? `${root}${sep}${dir.replace(/\//g, sep)}` : root,
    pathSeparator: sep,
    "/": sep,
  };
  return text.replace(/\$\{([^}]+)\}/g, (m, name: string) => {
    if (name in values) return values[name];
    if (name.startsWith("env:")) return ctx.env(name.slice(4)) ?? "";
    if (name.startsWith("input:")) return ctx.inputs[name.slice(6)] ?? m;
    return m;
  });
}

/** The `${input:…}` ids a task line uses, in order. */
export function inputsUsed(...texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) for (const m of t.matchAll(/\$\{input:([^}]+)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** A task's folder as a workspace-relative path ("" = the root), or null when it is outside. */
export function relativeCwd(resolved: string, workspaceFolder: string): string | null {
  if (!resolved) return "";
  const root = workspaceFolder.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === root) return "";
  if (p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return p.slice(root.length + 1);
  if (/^(\/|[A-Za-z]:\/)/.test(p) || p.split("/").includes("..")) return null;
  return p.replace(/^\.\//, "");
}
