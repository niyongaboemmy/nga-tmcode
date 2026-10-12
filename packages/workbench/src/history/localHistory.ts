import { create } from "zustand";
import { inExam } from "../exam/state";
import { getPlatform, log, useWorkbench } from "../state/store";

/**
 * Local History (VS Code's Timeline): every save of a file keeps a copy in
 * `.tmcode/history/<file>/<time>.txt`, at most MAX per file. `.tmcode/` gets
 * its own `.gitignore` and is never synced to Task Mentor, so history stays
 * on this computer. Not kept in exams (the exam journal already records work).
 */

const ROOT = ".tmcode/history";
const MAX = 30;
const MAX_BYTES = 512 * 1024;
const SKIP = /^(\.tmcode|\.git|node_modules)(\/|$)/;

export interface HistoryEntry {
  /** File name inside the history folder: `<ms>.txt`. */
  id: string;
  time: number;
  size: number;
}

/** Bumped when history changes so the Timeline refreshes. */
export const useHistory = create<{ version: number }>(() => ({ version: 0 }));

/** `src/app.ts` → `.tmcode/history/src%2Fapp.ts` (one flat folder per file). */
export function historyDir(path: string) {
  return `${ROOT}/${encodeURIComponent(path)}`;
}

async function ensureDirs(path: string) {
  const fs = getPlatform().fs;
  await fs.createDir(".tmcode").catch(() => {});
  await fs.createDir(ROOT).catch(() => {});
  await fs.createDir(historyDir(path)).catch(() => {});
  // Keep the whole .tmcode folder out of git.
  const exists = await fs.readFile(".tmcode/.gitignore").catch(() => null);
  if (exists === null) await fs.writeFile(".tmcode/.gitignore", "*\n").catch(() => {});
}

export async function listHistory(path: string): Promise<HistoryEntry[]> {
  try {
    const entries = await getPlatform().fs.readDir(historyDir(path));
    return entries
      .filter((e) => e.kind === "file" && /^\d+\.txt$/.test(e.name))
      .map((e) => ({ id: e.name, time: Number(e.name.slice(0, -4)), size: 0 }))
      .sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

export function readHistory(path: string, id: string) {
  return getPlatform().fs.readFile(`${historyDir(path)}/${id}`);
}

/** Called after every successful save. */
export async function recordSave(path: string, content: string) {
  if (inExam() || SKIP.test(path) || content.length > MAX_BYTES || !useWorkbench.getState().workspace) return;
  try {
    const list = await listHistory(path);
    if (list.length && (await readHistory(path, list[0].id).catch(() => null)) === content) return;
    await ensureDirs(path);
    const fs = getPlatform().fs;
    await fs.writeFile(`${historyDir(path)}/${Date.now()}.txt`, content);
    for (const old of list.slice(MAX - 1)) await fs.remove(`${historyDir(path)}/${old.id}`).catch(() => {});
    useHistory.setState((s) => ({ version: s.version + 1 }));
  } catch (e) {
    log("Local History", `Could not keep a copy of ${path}: ${String((e as Error)?.message ?? e)}`, "warn");
  }
}

/**
 * Before an explorer delete: keeps a copy of the file (or of up to 200 files in
 * the folder) in Local History, so it can still be restored from the Timeline
 * when the Trash is emptied or there is none.
 */
export async function snapshotBeforeDelete(path: string) {
  deletedCopies.delete(path);
  if (inExam() || SKIP.test(path) || !useWorkbench.getState().workspace) return;
  const fs = getPlatform().fs;
  let budget = 200;
  let complete = true;
  const copies: DeletedCopy[] = [];
  const visit = async (p: string): Promise<void> => {
    if (SKIP.test(p)) return;
    if (budget <= 0) {
      complete = false;
      return;
    }
    const entries = await fs.readDir(p).catch(() => null);
    if (entries) {
      copies.push({ path: p, content: null });
      for (const e of entries) await visit(e.path);
      return;
    }
    budget--;
    const content = await fs.readFile(p).catch(() => null);
    if (content === null) {
      complete = false;
      return;
    }
    copies.push({ path: p, content });
    await recordSave(p, content);
  };
  await visit(path);
  // Undo puts back exactly what was there; a partial copy would restore half a folder, so none is offered.
  if (complete && copies.length) deletedCopies.set(path, copies);
}

/** What the last delete of a path held (folders: content null), for Undo. */
interface DeletedCopy {
  path: string;
  content: string | null;
}
const deletedCopies = new Map<string, DeletedCopy[]>();

/** An Undo for the delete of this path, while its copy is known (never in exams, never for huge folders). */
export function undoDeleteFor(path: string): (() => Promise<boolean>) | null {
  const copies = deletedCopies.get(path);
  if (!copies) return null;
  return async () => {
    if (deletedCopies.get(path) !== copies) return false;
    deletedCopies.delete(path);
    const fs = getPlatform().fs;
    try {
      for (const c of copies) {
        if (c.content === null) await fs.createDir(c.path).catch(() => {});
        else {
          await fs.createFile(c.path).catch(() => {});
          await fs.writeFile(c.path, c.content);
        }
      }
      return true;
    } catch (e) {
      log("Local History", `Could not restore ${path}: ${String((e as Error)?.message ?? e)}`, "warn");
      return false;
    }
  };
}
