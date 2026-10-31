import type { UserTask } from "./tasksJson";

/**
 * Tasks contributed by extensions (`tasks.registerTaskProvider`), asked from
 * every running extension host when Run Task opens. Each host registers one
 * source (exthost/mainThread.ts).
 */

export interface ExtensionTaskDTO {
  label: string;
  source: string;
  command: string;
  cwd: string;
  group: "build" | "test" | "";
  isBackground: boolean;
  problemMatchers: string[];
  detail?: string;
}

type Source = () => Promise<ExtensionTaskDTO[]>;
const sources = new Set<Source>();

export function registerExtensionTaskSource(source: Source) {
  sources.add(source);
  return () => void sources.delete(source);
}

/** Every host's tasks; a host that doesn't answer within 3 s gives none. */
export async function extensionTasks(): Promise<ExtensionTaskDTO[]> {
  const timeout = new Promise<ExtensionTaskDTO[]>((r) => setTimeout(() => r([]), 3000));
  const lists = await Promise.all([...sources].map((s) => Promise.race([s().catch(() => [] as ExtensionTaskDTO[]), timeout])));
  return lists.flat();
}

/** An extension's task as the runner runs it ("npm: build" style labels keep the source). */
export function toUserTask(t: ExtensionTaskDTO): UserTask {
  return {
    label: `${t.source}: ${t.label}`,
    command: t.command,
    cwd: t.cwd,
    group: { kind: t.group, isDefault: false },
    dependsOn: [],
    dependsOrder: "parallel",
    isBackground: t.isBackground,
    problemMatcher: t.problemMatchers,
    detail: t.detail,
    runOn: "default",
    reveal: "always",
  };
}
