import { EventEmitter } from "../api/events";
import { ProcessExecution, ShellExecution, Task, TaskGroup } from "../api/moreTypes";
import type { RpcConnection } from "../rpc";

/**
 * `tasks.registerTaskProvider`, `tasks.fetchTasks` and `tasks.executeTask`:
 * extensions' shell and process tasks show in TMCode's Run Task list and run
 * in its terminal (with their problem matchers), as in VS Code. Custom
 * (pseudoterminal) executions are not supported and are left out.
 */

/** A task as the workbench runs it. */
export interface TaskDTO {
  label: string;
  source: string;
  command: string;
  cwd: string;
  group: "build" | "test" | "";
  isBackground: boolean;
  problemMatchers: string[];
  detail?: string;
}

interface TaskProvider {
  provideTasks(token?: unknown): Task[] | undefined | null | Promise<Task[] | undefined | null>;
  resolveTask?(task: Task, token?: unknown): Task | undefined | null | Promise<Task | undefined | null>;
}

const quote = (a: string) => (/^[\w@%+=:,./${}-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`);
const argText = (a: unknown) => (typeof a === "string" ? quote(a) : a && typeof a === "object" && typeof (a as { value?: unknown }).value === "string" ? quote((a as { value: string }).value) : "");

/** A vscode.Task → what the workbench runs; null for executions TMCode can't run. */
export function toTaskDTO(task: Task): TaskDTO | null {
  const ex = task.execution;
  let command = "";
  let options: { cwd?: unknown } | undefined;
  if (ex instanceof ShellExecution) {
    const base = typeof ex.commandLine === "string" ? ex.commandLine : argText(ex.commandLine);
    const args = Array.isArray(ex.args) ? ex.args.map(argText).filter(Boolean) : [];
    command = [base, ...args].filter(Boolean).join(" ");
    options = ex.options as { cwd?: unknown } | undefined;
  } else if (ex instanceof ProcessExecution) {
    const args = Array.isArray(ex.args) ? ex.args.map(argText).filter(Boolean) : [];
    command = [quote(ex.process), ...args].join(" ");
    options = ex.options as { cwd?: unknown } | undefined;
  } else return null;
  if (!command.trim()) return null;
  const group = task.group instanceof TaskGroup ? task.group.id : "";
  return {
    label: task.name,
    source: task.source || "extension",
    command,
    cwd: typeof options?.cwd === "string" ? options.cwd : "",
    group: group === "build" || group === "test" ? group : "",
    isBackground: !!task.isBackground,
    problemMatchers: task.problemMatchers ?? [],
    detail: (() => {
      const d = (task as unknown as { detail?: unknown }).detail;
      return typeof d === "string" ? d : undefined;
    })(),
  };
}

export class TaskService {
  readonly #providers = new Map<number, { type: string; provider: TaskProvider }>();
  #seq = 0;
  readonly #executions = new Map<number, { task: Task; execution: { task: Task; terminate(): void } }>();
  readonly onDidStartTask = new EventEmitter<{ execution: { task: Task } }>();
  readonly onDidEndTask = new EventEmitter<{ execution: { task: Task } }>();
  readonly onDidStartTaskProcess = new EventEmitter<{ execution: { task: Task }; processId: number }>();
  readonly onDidEndTaskProcess = new EventEmitter<{ execution: { task: Task }; exitCode: number | undefined }>();

  constructor(private readonly rpc: RpcConnection) {
    rpc.register("$provideTasks", () => this.provideDTOs());
    rpc.register("$taskEnded", ([id, exitCode]) => {
      const e = this.#executions.get(Number(id));
      if (!e) return null;
      this.#executions.delete(Number(id));
      this.onDidEndTaskProcess.fire({ execution: e.execution, exitCode: typeof exitCode === "number" ? exitCode : undefined });
      this.onDidEndTask.fire({ execution: e.execution });
      return null;
    });
  }

  get taskExecutions() {
    return [...this.#executions.values()].map((e) => e.execution);
  }

  register(type: string, provider: TaskProvider) {
    const id = ++this.#seq;
    this.#providers.set(id, { type, provider });
    return { dispose: () => void this.#providers.delete(id) };
  }

  /** Every provider's tasks (a failing provider gives none). */
  async fetch(filter?: { type?: string }): Promise<Task[]> {
    const out: Task[] = [];
    for (const { type, provider } of this.#providers.values()) {
      if (filter?.type && filter.type !== type) continue;
      try {
        out.push(...((await provider.provideTasks()) ?? []));
      } catch {
        /* a provider that throws gives no tasks */
      }
    }
    return out;
  }

  async provideDTOs(): Promise<TaskDTO[]> {
    return (await this.fetch()).map(toTaskDTO).filter((t): t is TaskDTO => !!t);
  }

  async execute(task: Task) {
    const dto = toTaskDTO(task);
    if (!dto) throw new Error(`TMCode can't run the task '${task.name}': only shell and process tasks are supported.`);
    const id = Number(await this.rpc.request("$main.executeTask", [dto]));
    const execution = { task, terminate: () => void this.rpc.request("$main.terminateTask", [id]).catch(() => undefined) };
    this.#executions.set(id, { task, execution });
    this.onDidStartTask.fire({ execution });
    return execution;
  }
}
