import type { FileSystem } from "../platform/types";
import { aiOf, currentActor, isRecordingSuppressed, recordActivity, type Actor } from "./log";

/**
 * Records every change made through the workbench's file system: one place,
 * so the Explorer, editors, extensions and TMCode AI are all covered. The
 * actor is read when a call starts (see `runAs`); a call that fails records
 * nothing.
 */

/** TMCode's own folders and the repository's internals are bookkeeping, not the student's work. */
export function isBookkeepingPath(path: string) {
  return /^(\.git|\.tmcode)(\/|$)/.test(path) || /(^|\/)\.git\//.test(path);
}

const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
let lastWrite = new Map<string, number>();

/** Paths TMCode itself just changed: the file watcher's echo of them isn't an outside change. */
/** Changes made on disk for TMCode (an extension's write): the watcher's echo isn't an outside change. */
export function markWritten(paths: string[]) {
  const now = Date.now();
  for (const p of paths) lastWrite.set(p, now);
}

export function recentlyWritten(path: string, within = 3000) {
  const t = lastWrite.get(path);
  return t !== undefined && Date.now() - t < within;
}

const RECORDING = Symbol("tmcode.recordingFs");
export const isRecordingFs = (fs: FileSystem) => !!(fs as unknown as Record<symbol, unknown>)[RECORDING];

export function wrapFileSystem(fs: FileSystem, exists: (path: string) => boolean | undefined): FileSystem {
  const done = (paths: string[]) => {
    const now = Date.now();
    for (const p of paths) lastWrite.set(p, now);
    if (lastWrite.size > 2000) lastWrite = new Map([...lastWrite].slice(-1000));
  };
  // Starts the bookkeeping for one call: who acts, and whether it counts at all.
  const begin = (paths: string[]) => {
    const actor: Actor = currentActor();
    const skip = isRecordingSuppressed() || paths.every(isBookkeepingPath);
    return { actor, skip };
  };
  const overrides: Partial<FileSystem> = {
    async writeFile(path: string, content: string) {
      const { actor, skip } = begin([path]);
      const isNew = exists(path) === false;
      await fs.writeFile(path, content);
      done([path]);
      if (skip) return;
      const lines = content ? content.split("\n").length : 0;
      recordActivity({
        kind: "file",
        action: isNew ? "create" : "save",
        path,
        text: isNew ? `Created ${name(path)}` : `Saved ${name(path)}`,
        data: { lines, chars: content.length },
        actor,
        ai: aiOf(actor, isNew ? "created the file" : "changed the file"),
      });
    },
    async createFile(path: string) {
      const { actor, skip } = begin([path]);
      await fs.createFile(path);
      done([path]);
      if (!skip) recordActivity({ kind: "file", action: "create", path, text: `Created file ${name(path)}`, actor, ai: aiOf(actor, "created the file") });
    },
    async createDir(path: string) {
      const { actor, skip } = begin([path]);
      await fs.createDir(path);
      done([path]);
      if (!skip) recordActivity({ kind: "file", action: "create-folder", path, text: `Created folder ${name(path)}`, actor, ai: aiOf(actor, "created the folder") });
    },
    async rename(from: string, to: string) {
      const { actor, skip } = begin([from, to]);
      await fs.rename(from, to);
      done([from, to]);
      if (skip) return;
      const moved = dir(from) !== dir(to);
      recordActivity({
        kind: "file",
        action: moved ? "move" : "rename",
        path: from,
        to,
        text: moved ? `Moved ${name(from)} to ${dir(to) || "the project folder"}` : `Renamed ${name(from)} to ${name(to)}`,
        actor,
        ai: aiOf(actor, moved ? "moved the file" : "renamed the file"),
      });
    },
    async remove(path: string) {
      const { actor, skip } = begin([path]);
      await fs.remove(path);
      done([path]);
      if (!skip) recordActivity({ kind: "file", action: "delete", path, text: `Deleted ${name(path)}`, actor, ai: aiOf(actor, "deleted the file") });
    },
  };
  // Everything else (reads, encodings…) goes straight to the real file system, bound to it.
  const wrapped = new Proxy(fs, {
    get(target, key, receiver) {
      if (key === RECORDING) return true;
      if (typeof key === "string" && key in overrides) return overrides[key as keyof FileSystem];
      const v = Reflect.get(target, key, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  if (fs.copy) {
    const copy = fs.copy.bind(fs);
    overrides.copy = async (from: string, to: string) => {
      const { actor, skip } = begin([from, to]);
      await copy(from, to);
      done([to]);
      if (!skip) recordActivity({ kind: "file", action: "copy", path: from, to, text: `Copied ${name(from)} to ${to}`, actor, ai: aiOf(actor, "copied the file") });
    };
  }
  if (fs.trash) {
    const trash = fs.trash.bind(fs);
    overrides.trash = async (path: string) => {
      const { actor, skip } = begin([path]);
      await trash(path);
      done([path]);
      if (!skip) recordActivity({ kind: "file", action: "delete", path, text: `Moved ${name(path)} to the Trash`, data: { trash: true }, actor, ai: aiOf(actor, "deleted the file") });
    };
  }
  if (fs.importPaths) {
    const importPaths = fs.importPaths.bind(fs);
    overrides.importPaths = async (sources: string[], dest: string, overwrite: boolean) => {
      const { actor, skip } = begin([dest]);
      const r = await importPaths(sources, dest, overwrite);
      done(r.imported);
      if (!skip && r.imported.length)
        recordActivity({
          kind: "file",
          action: "import",
          path: dest,
          text: `Imported ${r.imported.length === 1 ? name(r.imported[0]) : `${r.imported.length} files`} from outside the project`,
          data: { files: r.imported.slice(0, 20).join(", "), count: r.imported.length },
          actor,
        });
      return r;
    };
  }
  return wrapped;
}
