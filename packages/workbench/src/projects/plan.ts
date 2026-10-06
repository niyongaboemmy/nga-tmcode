/**
 * The sync planner (pure, unit-tested): three manifests in, a plan out.
 *
 * - `base`: what this folder last saved to / pulled from Task Mentor
 *   (kept in `.tmcode/project.json`).
 * - `local`: the folder now (`proj_scan`).
 * - `remote`: Task Mentor's head revision.
 *
 * A file changed on one side only follows that side; changed on both sides to
 * different content is a conflict. Like git, a missing base means "first
 * sync": identical files agree, differing ones are conflicts.
 */

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
}

export type Manifest = ManifestEntry[];

export interface SyncPlan {
  /** Local edits not in Task Mentor yet (save uploads these). */
  localChanges: { added: string[]; modified: string[]; deleted: string[] };
  /** Task Mentor changes not in this folder yet (pull applies these). */
  remoteChanges: { added: string[]; modified: string[]; deleted: string[] };
  /** Changed on both sides to different content. */
  conflicts: string[];
  /** The manifest a save would commit: local, with nothing silently lost. */
  next: Manifest;
}

const byPath = (m: Manifest | null | undefined) => new Map((m ?? []).map((e) => [e.path, e]));

export function planSync(base: Manifest | null, local: Manifest, remote: Manifest | null): SyncPlan {
  const B = byPath(base);
  const L = byPath(local);
  const R = byPath(remote ?? base);
  const paths = [...new Set([...B.keys(), ...L.keys(), ...R.keys()])].sort();
  const plan: SyncPlan = {
    localChanges: { added: [], modified: [], deleted: [] },
    remoteChanges: { added: [], modified: [], deleted: [] },
    conflicts: [],
    next: [...L.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  const firstSync = base === null;
  for (const p of paths) {
    const b = B.get(p)?.sha256;
    const l = L.get(p)?.sha256;
    const r = R.get(p)?.sha256;
    const localChanged = firstSync ? l !== undefined && l !== r : l !== b;
    const remoteChanged = firstSync ? r !== undefined && r !== l : r !== b;
    if (localChanged && remoteChanged) {
      if (l !== r) plan.conflicts.push(p);
      continue;
    }
    if (localChanged) {
      (b === undefined && !firstSync ? plan.localChanges.added : l === undefined ? plan.localChanges.deleted : firstSync && r === undefined ? plan.localChanges.added : plan.localChanges.modified).push(p);
    } else if (remoteChanged) {
      (b === undefined && !firstSync ? plan.remoteChanges.added : r === undefined ? plan.remoteChanges.deleted : firstSync && l === undefined ? plan.remoteChanges.added : plan.remoteChanges.modified).push(p);
    }
  }
  return plan;
}

export function changeCount(c: SyncPlan["localChanges"]) {
  return c.added.length + c.modified.length + c.deleted.length;
}

/** Same files, same content. */
export function sameManifest(a: Manifest | null, b: Manifest | null) {
  if (!a || !b || a.length !== b.length) return false;
  const B = byPath(b);
  return a.every((e) => B.get(e.path)?.sha256 === e.sha256);
}
