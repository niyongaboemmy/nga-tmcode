import { terminalAllowed } from "@tmcode/protocol";
import { signal } from "../accessibility/signals";
import { ensureDocument } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import type { NewTerminalRequest, OwnedTerminal } from "../parts/panel/TerminalView";
import { toWorkspacePath } from "../run/diagnostics";
import { activeFilePath, getPlatform, log, notify, onWorkspaceOpened, showPanel, useWorkbench } from "../state/store";
import { ensureTrusted } from "../trust/trust";
import { showInputBox, showQuickPick } from "../widgets/QuickPick";
import { backgroundState, matchProblems, resolveMatchers, type ProblemMatcher } from "./problemMatchers";
import { defaultTaskOf, dependencyError, inputsUsed, parseTasksJson, relativeCwd, resolveVariables, type TaskInput, type TasksFile, type UserTask } from "./tasksJson";

/**
 * Runs tasks.json tasks as VS Code does: each in its own terminal, after its
 * dependencies (together, or one after another), with `${input:…}` asked
 * first; when it ends its output goes through its problem matchers into
 * Problems. A background task (a watcher) counts as started once its matcher
 * sees a run end (or right away without one), and keeps updating Problems.
 */

export async function readTasksFile(): Promise<TasksFile> {
  const text = await getPlatform()
    .fs.readFile(".vscode/tasks.json")
    .catch(() => null);
  return text ? parseTasksJson(text, getPlatform().os) : { tasks: [], inputs: [] };
}

/** The line typed into the shell: the command, then the shell exits with its code (the terminal stays, like VS Code's). */
export function commandLine(command: string, shell: string): string {
  const s = shell.toLowerCase();
  if (s.includes("powershell") || s === "pwsh") return `${command}; exit $LASTEXITCODE`;
  if (s.includes("command prompt") || s === "cmd") return `${command} & exit /b %errorlevel%`;
  return `${command}; exit $?`;
}

const ownerOf = (label: string) => `task:${label}`;

/** A task's problems as markers (replacing its previous ones). */
async function publish(task: UserTask, cwd: string, output: string, matchers: ProblemMatcher[]) {
  const ws = useWorkbench.getState().workspace;
  if (!ws || !matchers.length) return 0;
  const owner = ownerOf(task.label);
  for (const m of monaco.editor.getModels()) monaco.editor.setModelMarkers(m, owner, []);
  const byFile = new Map<string, monaco.editor.IMarkerData[]>();
  for (const matcher of matchers) {
    for (const p of matchProblems(output, matcher)) {
      const path = toWorkspacePath(p.file, ws.root, p.fileLocation === "absolute" ? "" : cwd);
      if (path === null) continue;
      const list = byFile.get(path) ?? [];
      list.push({
        severity: p.severity === "error" ? monaco.MarkerSeverity.Error : p.severity === "warning" ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: p.message,
        source: p.source,
        code: p.code,
        startLineNumber: p.line,
        startColumn: p.column,
        endLineNumber: p.endLine ?? p.line,
        endColumn: p.endColumn ?? (p.column > 1 ? p.column + 1 : 1000),
      });
      byFile.set(path, list);
    }
  }
  let count = 0;
  for (const [path, markers] of byFile) {
    // A path that isn't a file in the folder (a library's, a tool's) isn't shown.
    // A full document (as the Run hub's), so Problems lists it.
    const model = await ensureDocument(path).catch(() => null);
    if (!model) continue;
    monaco.editor.setModelMarkers(model, owner, markers);
    count += markers.length;
  }
  return count;
}

/** Asks for the `${input:…}` a task line uses (once per run). Null: cancelled. */
async function askInputs(ids: string[], inputs: TaskInput[], answers: Record<string, string>): Promise<boolean> {
  for (const id of ids) {
    if (id in answers) continue;
    const input = inputs.find((i) => i.id === id);
    if (!input) {
      notify("error", `The task uses \${input:${id}}, but tasks.json has no input "${id}".`);
      return false;
    }
    const value =
      input.type === "pickString"
        ? (await showQuickPick({ placeholder: input.description, items: (input.options ?? []).map((o) => ({ id: o, label: o, description: o === input.default ? "default" : undefined })) }))?.id
        : await showInputBox({ prompt: input.description, value: input.default ?? "", password: input.password });
    if (value === undefined || value === null) return false;
    answers[id] = value;
  }
  return true;
}

export interface TaskResult {
  label: string;
  exitCode: number | null;
  problems: number;
}

/** Runs one task's command in a terminal; resolves when it ends (a background task: when it is ready). */
function runOne(task: UserTask, command: string, cwd: string): Promise<TaskResult> {
  const matchers = resolveMatchers(task.problemMatcher);
  const bg = task.isBackground ? matchers.find((m) => m.background) : undefined;
  return new Promise((resolve) => {
    let output = "";
    // Output before the typed line's Enter (the prompt, the echoed command) isn't the task's.
    let typed = false;
    let started = false;
    let settled = false;
    const settle = (exitCode: number | null, problems: number) => {
      if (settled) return;
      settled = true;
      resolve({ label: task.label, exitCode, problems });
    };
    let tail = "";
    const detail: NewTerminalRequest = {
      cwd,
      name: task.label,
      owner: {
        onReady: (h: OwnedTerminal) => {
          if (task.reveal === "always") h.reveal();
          // As the Run hub does: give the shell a moment to print its prompt.
          setTimeout(() => {
            typed = true;
            h.write(`${task.isBackground ? command : commandLine(command, h.shell)}\r`);
          }, 350);
          // A background task without a matcher that says when it is ready: ready now.
          if (task.isBackground && !bg) settle(0, 0);
        },
        onData: (chunk) => {
          let d = chunk;
          if (!started) {
            const nl = typed ? d.indexOf("\n") : -1;
            if (nl < 0) return;
            started = true;
            d = d.slice(nl + 1);
          }
          output += d;
          if (output.length > 2_000_000) output = output.slice(-1_000_000);
          if (!bg) return;
          // A watcher's run ended: its problems, and (the first time) the task is ready.
          tail = (tail + d).slice(-4000);
          if (backgroundState(tail, bg) === "end") {
            tail = "";
            void publish(task, cwd, output, matchers).then((n) => settle(0, n));
            output = "";
          }
        },
        onExit: (code) => {
          void publish(task, cwd, output, matchers).then((n) => settle(code ?? null, n));
        },
        onError: (message) => {
          notify("error", `The task '${task.label}' could not start: ${message}`);
          settle(null, 0);
        },
      },
    };
    if (task.reveal !== "never") showPanel("terminal");
    window.dispatchEvent(new CustomEvent("tmcode:new-terminal", { detail }));
  });
}

/** Runs a tasks.json task and its dependencies. Resolves with every result (empty: it didn't run). */
export async function runUserTask(label: string, file?: TasksFile): Promise<TaskResult[]> {
  const ws = useWorkbench.getState().workspace;
  if (!ws) return [];
  if (!getPlatform().terminal || !terminalAllowed(useWorkbench.getState().policy)) {
    notify("info", "Tasks run in the integrated terminal, which is not available here.");
    return [];
  }
  const tf = file ?? (await readTasksFile());
  const error = dependencyError(tf.tasks, label);
  if (error) {
    notify("error", error);
    return [];
  }
  if (!(await ensureTrusted("Tasks"))) return [];
  const byLabel = new Map(tf.tasks.map((t) => [t.label, t]));
  const answers: Record<string, string> = {};
  const ctx = () => ({ workspaceFolder: ws.root, file: activeFilePath() ?? "", env: () => undefined, inputs: answers });
  const results: TaskResult[] = [];
  const running = new Map<string, Promise<boolean>>();

  const run = (name: string): Promise<boolean> => {
    const existing = running.get(name);
    if (existing) return existing;
    const p = (async () => {
      const t = byLabel.get(name)!;
      if (t.dependsOrder === "sequence") {
        for (const d of t.dependsOn) if (!(await run(d))) return false;
      } else if (!(await Promise.all(t.dependsOn.map(run))).every(Boolean)) return false;
      if (!t.command) return true;
      if (!(await askInputs(inputsUsed(t.command, t.cwd), tf.inputs, answers))) return false;
      const command = resolveVariables(t.command, ctx());
      const cwd = relativeCwd(resolveVariables(t.cwd, ctx()), ws.root);
      if (cwd === null) {
        notify("error", `The task '${t.label}' runs in a folder outside this project.`);
        return false;
      }
      log("Tasks", `Running '${t.label}': ${command}${cwd ? ` (in ${cwd})` : ""}`);
      const r = await runOne(t, command, cwd);
      results.push(r);
      const failed = r.exitCode !== null && r.exitCode !== 0;
      signal(failed ? "taskFailed" : "taskCompleted");
      if (failed) {
        notify("error", `The task '${t.label}' failed (exit code ${r.exitCode}).`, r.problems ? [{ label: "Show Problems", run: () => showPanel("problems") }] : undefined);
      } else if (r.problems) notify("warning", `The task '${t.label}' found ${r.problems} problem${r.problems === 1 ? "" : "s"}.`, [{ label: "Show Problems", run: () => showPanel("problems") }]);
      return !failed;
    })();
    running.set(name, p);
    return p;
  };
  await run(label);
  return results;
}

/** Run Build Task / Run Test Task: tasks.json's default of the group. False when there is none. */
export async function runDefaultTask(kind: "build" | "test"): Promise<boolean> {
  const tf = await readTasksFile();
  const task = defaultTaskOf(tf.tasks, kind);
  if (task) {
    await runUserTask(task.label, tf);
    return true;
  }
  // Several in the group and none is the default: pick one, as VS Code does.
  const group = tf.tasks.filter((t) => t.group.kind === kind);
  if (!group.length) return false;
  const pick = await showQuickPick({ placeholder: `Select the ${kind} task to run`, items: group.map((t) => ({ id: t.label, label: t.label, description: t.detail ?? t.command })) });
  if (pick) await runUserTask(pick.id, tf);
  return true;
}

// ── tasks that run when the folder opens ──

const allowKey = (root: string) => `tasks.automatic:${root}`;

/** "runOn": "folderOpen" tasks, once the student allowed automatic tasks for this folder. */
async function runFolderOpenTasks(root: string) {
  if (!getPlatform().terminal || !terminalAllowed(useWorkbench.getState().policy)) return;
  const tf = await readTasksFile();
  const auto = tf.tasks.filter((t) => t.runOn === "folderOpen");
  if (!auto.length || useWorkbench.getState().workspace?.root !== root) return;
  const store = getPlatform().store;
  const decided = await store.get<"allow" | "deny">(allowKey(root)).catch(() => undefined);
  const start = () => auto.forEach((t) => void runUserTask(t.label, tf));
  if (decided === "allow") return start();
  if (decided === "deny") return;
  const names = auto.map((t) => `'${t.label}'`).join(", ");
  notify("info", `This folder has tasks that run when it opens: ${names}. Allow them to run automatically in this folder?`, [
    { label: "Allow and Run", run: () => void store.set(allowKey(root), "allow").then(start) },
    { label: "Don't Allow", run: () => void store.set(allowKey(root), "deny") },
  ]);
}

let wired = false;
export function wireTaskRunner() {
  if (wired) return;
  wired = true;
  onWorkspaceOpened((root) => void runFolderOpenTasks(root).catch(() => undefined));
  const open = useWorkbench.getState().workspace?.root;
  if (open) void runFolderOpenTasks(open).catch(() => undefined);
}
