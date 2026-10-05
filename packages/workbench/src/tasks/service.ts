import { getPlatform, notify, showPanel, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/quickPick";
import { MANIFESTS, detectTasks, type Task } from "./detect";

const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", ".next", "out"]);

async function tasksIn(dir: string): Promise<{ tasks: Task[]; subdirs: string[] }> {
  const fs = getPlatform().fs;
  const entries = await fs.readDir(dir).catch(() => []);
  const files = entries.filter((e) => e.kind === "file").map((e) => e.name);
  const read: Record<string, string> = {};
  await Promise.all(
    MANIFESTS.filter((m) => files.includes(m)).map(async (m) => {
      read[m] = await fs.readFile(dir ? `${dir}/${m}` : m).catch(() => "");
    }),
  );
  const subdirs = entries.filter((e) => e.kind === "dir" && !SKIP.has(e.name) && !e.name.startsWith(".")).map((e) => e.path);
  return { tasks: detectTasks(files, read, dir), subdirs };
}

/** Tasks of the workspace root and of project folders up to two levels down (client/, server/, apps/web…). */
export async function workspaceTasks(): Promise<Task[]> {
  if (!useWorkbench.getState().workspace) return [];
  const root = await tasksIn("");
  const out = [...root.tasks];
  const level1 = await Promise.all(root.subdirs.slice(0, 40).map(tasksIn));
  for (const r of level1) out.push(...r.tasks);
  const level2 = await Promise.all(level1.flatMap((r) => r.subdirs).slice(0, 80).map(tasksIn));
  for (const r of level2) out.push(...r.tasks);
  return out;
}

/** Runs a shell command in a new, named terminal (as VS Code's task terminals). */
export function runInTerminal(command: string, opts: { cwd?: string; name?: string } = {}) {
  showPanel("terminal");
  window.dispatchEvent(new CustomEvent("tmcode:new-terminal", { detail: { command, cwd: opts.cwd ?? "", name: opts.name } }));
}

export function runTask(task: Task) {
  runInTerminal(task.command, { cwd: task.cwd, name: task.label });
}

const recent: string[] = [];

/** Terminal → Run Task… */
export async function pickAndRunTask() {
  if (!getPlatform().terminal || useWorkbench.getState().policy.terminal === "off") {
    notify("info", "Tasks run in the integrated terminal, which is not available here.");
    return;
  }
  const tasks = await workspaceTasks();
  if (!tasks.length) {
    notify("info", "No tasks were found. TMCode detects npm/yarn/pnpm scripts, Maven, Gradle, Make, Cargo, Go, Django and .NET projects.");
    return;
  }
  const recentTasks = recent.map((l) => tasks.find((t) => t.label === l)).filter((t): t is Task => !!t);
  const ordered = [...recentTasks, ...tasks.filter((t) => !recentTasks.includes(t))];
  const choice = await showQuickPick(
    "Select the task to run",
    ordered.map((t, i) => ({
      id: t.label,
      label: t.label,
      description: t.detail ?? t.command,
      icon: t.icon,
      group: i < recentTasks.length ? "recently used tasks" : `${t.source} tasks`,
    })),
  );
  const task = tasks.find((t) => t.label === choice?.id);
  if (!task) return;
  recent.splice(0, recent.length, task.label, ...recent.filter((l) => l !== task.label).slice(0, 4));
  runTask(task);
}
