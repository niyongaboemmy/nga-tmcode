import { isExamRoot } from "../exam/roots";
import { ensureDocument, getDocument, onDocumentChanged } from "../monaco/documents";
import { isUntitled } from "../util/untitled";
import { isVirtualPath } from "../util/virtual";
import { getPlatform, log, notify, onWorkspaceOpened, openFile, useWorkbench } from "./store";

/**
 * Hot exit and crash recovery, as in VS Code: the text of every unsaved file
 * (untitled ones too) is backed up a moment after each edit, per folder. When
 * the folder opens again, after quitting with unsaved files or after a crash,
 * the files come back unsaved, as they were. Not in exams: they have their own
 * journal and send every change to Task Mentor.
 */

export interface BackupEntry {
  path: string;
  text: string;
  /** When it was backed up (ms). */
  at: number;
}

export interface BackupSet {
  entries: BackupEntry[];
}

/** One file's backup is skipped above this; all of a folder's together stay under the total. */
export const BACKUP_LIMITS = { file: 5 * 1024 * 1024, total: 30 * 1024 * 1024 };

const key = (root: string) => `backups:${root}`;
/** Set while TMCode runs; cleared on a normal quit. Still set at start: the last session ended unexpectedly. */
const RUNNING = "session:running";

/** Which unsaved files are backed up: the newest first while they fit. Pure. */
export function selectBackups(files: { path: string; text: string }[], now = Date.now()): BackupEntry[] {
  let total = 0;
  const out: BackupEntry[] = [];
  for (const f of files) {
    if (f.text.length > BACKUP_LIMITS.file || total + f.text.length > BACKUP_LIMITS.total) continue;
    total += f.text.length;
    out.push({ path: f.path, text: f.text, at: now });
  }
  return out;
}

function enabled() {
  const s = useWorkbench.getState();
  return s.settings["files.hotExit"] !== "off" && !!s.workspace && !isExamRoot(s.workspace.root) && s.policy.mode === "practice";
}

function unsavedFiles() {
  const s = useWorkbench.getState();
  return Object.keys(s.dirty)
    // Untitled buffers have their own scheme but are the student's text: backed up too.
    .filter((p) => isUntitled(p) || !isVirtualPath(p))
    .flatMap((p) => {
      const model = getDocument(p);
      return model ? [{ path: p, text: model.getValue() }] : [];
    });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

/** Writes the folder's backups now (the last write wins). */
export function flushBackups(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  const root = useWorkbench.getState().workspace?.root;
  if (!root || !enabled()) return writing;
  const entries = selectBackups(unsavedFiles());
  writing = writing
    .then(() => getPlatform().store.set<BackupSet | null>(key(root), entries.length ? { entries } : null))
    .catch((e) => log("Workbench", `Backing up unsaved files failed: ${String((e as Error)?.message ?? e)}`, "warn"));
  return writing;
}

function scheduleBackup() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void flushBackups(), 750);
}

/** The folder's backups, restored into editors (unsaved). Returns how many came back. */
export async function restoreBackups(root: string): Promise<number> {
  if (!enabled()) return 0;
  const set = await getPlatform()
    .store.get<BackupSet | null>(key(root))
    .catch(() => null);
  const entries = set?.entries ?? [];
  let restored = 0;
  for (const e of entries) {
    if (useWorkbench.getState().workspace?.root !== root) return restored;
    try {
      // Untitled buffers open empty and get their text back; a file deleted since is skipped.
      const model = await ensureDocument(e.path);
      if (model.getValue() === e.text) continue;
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: e.text }], () => null);
      openFile(e.path, { pinned: true });
      restored++;
    } catch {
      log("Workbench", `Could not restore the unsaved copy of ${e.path}`, "warn");
    }
  }
  return restored;
}

let wired = false;
/** Backs up as files change; restores when a folder opens. Idempotent. */
export function wireBackups() {
  if (wired) return;
  wired = true;
  const store = getPlatform().store;
  // The previous session's flag, read before this one sets its own.
  const crashed = store.get<boolean>(RUNNING).catch(() => false);
  void crashed.then(() => store.set(RUNNING, true)).catch(() => undefined);
  onDocumentChanged(() => enabled() && scheduleBackup());
  // A save or a revert clears the dirty flag: the backup follows.
  useWorkbench.subscribe((s, prev) => {
    if (s.dirty !== prev.dirty && enabled()) scheduleBackup();
  });
  const restore = async (root: string) => {
    const n = await restoreBackups(root);
    if (!n) return;
    const wasCrash = await crashed;
    const files = n === 1 ? "1 unsaved file" : `${n} unsaved files`;
    notify("info", wasCrash ? `TMCode closed unexpectedly. Your ${files} came back.` : `Restored ${files} from your last session.`);
    log("Workbench", `Restored ${files} (${wasCrash ? "after a crash" : "hot exit"})`);
  };
  onWorkspaceOpened(restore);
  // The folder TMCode started with opened before the workbench wired this.
  const open = useWorkbench.getState().workspace?.root;
  if (open) void restore(open);
}

/** A normal quit: backups are written, and the next start isn't treated as a crash. */
export async function backupsBeforeQuit() {
  await flushBackups();
  await getPlatform()
    .store.set(RUNNING, false)
    .catch(() => undefined);
}

/** Quitting may skip "Save changes?" when the unsaved files are safely backed up. */
export function hotExitCovers(): boolean {
  return enabled() && useWorkbench.getState().settings["files.hotExit"] === "onExit";
}
