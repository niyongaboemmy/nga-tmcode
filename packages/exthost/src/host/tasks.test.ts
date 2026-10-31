import { describe, expect, it } from "vitest";
import { CustomExecution, ProcessExecution, ShellExecution, Task, TaskGroup } from "../api/moreTypes";
import { TaskService, toTaskDTO } from "./tasks";

describe("extension tasks", () => {
  it("turns shell and process tasks into what the workbench runs; custom executions are left out", () => {
    const shell = new Task({ type: "npm" }, 2, "build", "npm", new ShellExecution("npm run build", undefined, { cwd: "${workspaceFolder}/web" }), "$tsc");
    shell.group = TaskGroup.Build;
    expect(toTaskDTO(shell)).toEqual({ label: "build", source: "npm", command: "npm run build", cwd: "${workspaceFolder}/web", group: "build", isBackground: false, problemMatchers: ["$tsc"], detail: undefined });
    const proc = new Task({ type: "x" }, 2, "lint", "eslint", new ProcessExecution("eslint", ["src", "my file.js"]));
    expect(toTaskDTO(proc)?.command).toBe('eslint src "my file.js"');
    expect(toTaskDTO(new Task({ type: "x" }, 2, "c", "x", new CustomExecution(() => undefined)))).toBeNull();
  });

  it("asks every provider, skips one that throws, and runs a task through the workbench", async () => {
    const calls: [string, unknown[]][] = [];
    const handlers = new Map<string, (args: unknown[]) => unknown>();
    const rpc = {
      register: (name: string, fn: (args: unknown[]) => unknown) => handlers.set(name, fn),
      request: async (name: string, args: unknown[]) => (calls.push([name, args]), 7),
    };
    const svc = new TaskService(rpc as never);
    svc.register("npm", { provideTasks: () => [new Task({ type: "npm" }, 2, "test", "npm", new ShellExecution("npm test"))] });
    svc.register("bad", { provideTasks: () => { throw new Error("boom"); } });
    expect(await handlers.get("$provideTasks")!([])).toMatchObject([{ label: "test", command: "npm test" }]);
    const ended: unknown[] = [];
    svc.onDidEndTask.event((e) => ended.push(e));
    const [task] = await svc.fetch({ type: "npm" });
    const execution = await svc.execute(task);
    expect(calls[0]).toEqual(["$main.executeTask", [expect.objectContaining({ label: "test" })]]);
    expect(svc.taskExecutions).toHaveLength(1);
    handlers.get("$taskEnded")!([7, 0]);
    expect(ended).toEqual([{ execution }]);
    expect(svc.taskExecutions).toHaveLength(0);
  });
});
