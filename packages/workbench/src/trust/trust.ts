import { registerCommand } from "../commands/registry";
import { isExamRoot } from "../exam/roots";
import { getPlatform, notify, showDialog, useWorkbench } from "../state/store";
import { basename } from "../util/paths";

/**
 * A light version of VS Code's Workspace Trust. Before the first task,
 * launch.json debug configuration or project script runs in a folder that
 * came from elsewhere (cloned, or with a git remote), the student is asked
 * once whether they trust its authors. Task Mentor assignment and project
 * folders, exam folders and the built-in demo are trusted.
 *
 * "Open in New Window" (V19) is not offered: the desktop host keeps one open
 * folder per app (workspace.rs `Workspace`, and the watcher, terminals, git
 * and exam state built on it), so a second window would need all of that per
 * window. Not cheap; left for a later release.
 */

export type TrustDecision = "trusted" | "untrusted";

export interface TrustContext {
  root: string;
  /** Bound to a Task Mentor project or assignment (.tmcode binding). */
  taskMentor: boolean;
  exam: boolean;
  /** Cloned by TMCode in this or an earlier session. */
  cloned: boolean;
  /** The folder's git repository has a remote: its code came from somewhere else. */
  hasRemote: boolean;
}

/** Whether running this folder's tasks or debug configurations needs the trust question. */
export function needsTrust(c: TrustContext): boolean {
  if (c.exam || c.taskMentor || isExamRoot(c.root)) return false;
  // The browser build's demo folder is TMCode's own; clones there behave like real ones.
  if (c.root.startsWith("memory://") && !c.root.startsWith("memory://clones/")) return false;
  return c.cloned || c.hasRemote;
}

export const normRoot = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const decisionKey = (root: string) => `trust:${normRoot(root)}`;
const CLONED_KEY = "trust:cloned";

/** Remembers a folder TMCode cloned (asked before its scripts first run). */
export async function markCloned(path: string) {
  const store = getPlatform().store;
  const list = (await store.get<string[]>(CLONED_KEY).catch(() => undefined)) ?? [];
  if (!list.includes(normRoot(path))) await store.set(CLONED_KEY, [normRoot(path), ...list].slice(0, 200));
}

async function context(): Promise<TrustContext | null> {
  const ws = useWorkbench.getState().workspace;
  if (!ws) return null;
  const store = getPlatform().store;
  const cloned = ((await store.get<string[]>(CLONED_KEY).catch(() => undefined)) ?? []).includes(normRoot(ws.root));
  // Lazy: these modules import a lot, and trust is only checked before running something.
  const [{ useGit }, { useProjects }] = await Promise.all([import("../scm/gitService"), import("../projects/service")]);
  return {
    root: ws.root,
    taskMentor: !!useProjects.getState().binding,
    exam: useWorkbench.getState().policy.mode !== "practice",
    cloned,
    hasRemote: !!useGit.getState().status?.remotes.length,
  };
}

export async function trustDecision(root: string): Promise<TrustDecision | null> {
  return (await getPlatform().store.get<TrustDecision>(decisionKey(root)).catch(() => undefined)) ?? null;
}

export async function setTrust(root: string, decision: TrustDecision) {
  await getPlatform().store.set(decisionKey(root), decision);
}

/**
 * Before running a folder's code (tasks, launch.json, npm scripts): true when
 * it may run. Asks once per folder; "Don't Trust" is remembered too.
 */
export async function ensureTrusted(what = "Tasks and debug configurations"): Promise<boolean> {
  const c = await context();
  if (!c || !needsTrust(c)) return true;
  const decided = await trustDecision(c.root);
  if (decided === "trusted") return true;
  if (decided === "untrusted") {
    notify("warning", `${what} don't run in folders you don't trust.`, [{ label: "Trust This Folder", run: () => void askTrust(c.root) }]);
    return false;
  }
  return askTrust(c.root);
}

async function askTrust(root: string): Promise<boolean> {
  const choice = await showDialog({
    message: "Do you trust the authors of this folder?",
    detail: `${basename(root) || root}\n\nTasks and debug configurations can run code. Only trust folders from people you know.`,
    severity: "warning",
    buttons: [
      { id: "trust", label: "Trust", primary: true },
      { id: "no", label: "Don't Trust" },
    ],
    cancelId: "no",
  });
  const trusted = choice === "trust";
  await setTrust(root, trusted ? "trusted" : "untrusted");
  return trusted;
}

let registered = false;
export function registerTrustCommands() {
  if (registered) return;
  registered = true;
  registerCommand({
    id: "workbench.trust.manage",
    title: "Manage Workspace Trust",
    category: "Workspaces",
    enabled: () => !!useWorkbench.getState().workspace && useWorkbench.getState().policy.mode === "practice",
    run: async () => {
      const root = useWorkbench.getState().workspace?.root;
      if (!root) return;
      const now = await trustDecision(root);
      const choice = await showDialog({
        message: now === "trusted" ? "You trust this folder." : now === "untrusted" ? "You don't trust this folder." : "You haven't decided about this folder yet.",
        detail: `${root}\n\nIn a trusted folder, tasks, launch.json debug configurations and project scripts can run.`,
        buttons: [
          { id: "trust", label: "Trust", primary: now !== "trusted" },
          { id: "no", label: "Don't Trust" },
          { id: "cancel", label: "Cancel" },
        ],
        cancelId: "cancel",
      });
      if (choice === "trust" || choice === "no") await setTrust(root, choice === "trust" ? "trusted" : "untrusted");
    },
  });
}
