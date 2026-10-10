import { api } from "../projects/service";
import type { Manifest } from "../projects/plan";
import type { RosterRow } from "./service";

/**
 * Diffs for grading: the submitted version against the starter files or
 * against another version the student saved. Versions are fetched with the
 * projects API the review folder already uses (revision manifest + blobs);
 * the right side of every diff is the review folder's file (the submitted
 * version), the left side comes from here.
 */

export interface Version {
  project_id: number;
  id: number;
  number: number | null;
  at: string | null;
}

export type ChangeStatus = "added" | "modified" | "deleted";
export interface Change {
  path: string;
  status: ChangeStatus;
}

const manifests = new Map<string, Promise<Manifest>>();
const texts = new Map<string, Promise<string>>();
const lists = new Map<number, Promise<{ id: number; number: number; created_at: string }[] | null>>();

function cached<K, T>(map: Map<K, Promise<T>>, key: K, load: () => Promise<T>): Promise<T> {
  let p = map.get(key);
  if (!p) {
    p = load();
    map.set(key, p);
    p.catch(() => map.delete(key));
  }
  return p;
}

/** A version's file list (cached: versions never change). */
export function revisionFiles(projectId: number, revisionId: number): Promise<Manifest> {
  return cached(manifests, `${projectId}@${revisionId}`, async () => (await api<{ files: Manifest }>("GET", `/projects/${projectId}/revisions/${revisionId}/manifest`)).files.filter((f) => !f.path.startsWith(".tmcode/")));
}

const decode = (base64: string) => new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));

function blobText(projectId: number, sha: string): Promise<string> {
  return cached(texts, sha, async () => decode((await api<{ base64: string }>("GET", `/projects/${projectId}/blobs/${sha}`, undefined, { response: "base64" })).base64));
}

/** The project's saved versions as Task Mentor lists them, or null when this teacher can't list them. */
function listRevisions(projectId: number) {
  return cached(lists, projectId, async () => {
    try {
      return (await api<{ revisions: { id: number; number: number; created_at: string }[] }>("GET", `/projects/${projectId}/revisions?limit=200`)).revisions ?? [];
    } catch {
      return null;
    }
  });
}

/** A revision given by number (as the roster says "version 3") or by id: its id. */
async function resolve(projectId: number, ref: number, id?: number, at?: string | null): Promise<Version> {
  if (id) return { project_id: projectId, id, number: ref, at: at ?? null };
  const list = await listRevisions(projectId);
  const byNumber = list?.find((r) => r.number === ref);
  if (byNumber) return { project_id: projectId, id: byNumber.id, number: byNumber.number, at: at ?? byNumber.created_at };
  const byId = list?.find((r) => r.id === ref);
  if (byId) return { project_id: projectId, id: byId.id, number: byId.number, at: at ?? byId.created_at };
  // Not listed (or no list for teachers): take it as an id.
  return { project_id: projectId, id: ref, number: null, at: at ?? null };
}

/** The versions the student saved, oldest first. */
export async function versionsOf(row: RosterRow): Promise<Version[]> {
  const pid = row.project?.id;
  if (!pid) return [];
  let out: Version[];
  if (row.revisions?.length) out = await Promise.all(row.revisions.map((r) => resolve(pid, r.revision, r.id, r.at)));
  else out = ((await listRevisions(pid)) ?? []).map((r) => ({ project_id: pid, id: r.id, number: r.number, at: r.created_at }));
  return out.sort((a, b) => (a.number ?? a.id) - (b.number ?? b.id));
}

/**
 * The starter files: `starter_revision` (a version of the student's project,
 * or the teacher's starter project), else the student's first version when
 * it is not the submitted one (starting a practical saves the starter as v1).
 */
export async function starterOf(row: RosterRow): Promise<Version | null> {
  const pid = row.project?.id;
  if (!pid || row.project?.kind !== "tm") return null;
  const s = row.starter_revision;
  if (s && typeof s === "object") return { project_id: s.project_id, id: s.revision_id, number: null, at: null };
  if (typeof s === "number") {
    // A version number of the student's project (its id comes with the roster's versions).
    const hit = row.revisions?.find((r) => r.revision === s && r.id);
    return hit ? { project_id: pid, id: hit.id!, number: s, at: hit.at } : resolve(pid, s);
  }
  if (s === null) return null;
  const first = (await versionsOf(row))[0];
  return first && first.id !== row.link?.revision_id ? first : null;
}

/** What changed from `left` to `right`, by path (sorted). */
export function compareManifests(left: Manifest, right: Manifest): Change[] {
  const l = new Map(left.map((f) => [f.path, f.sha256]));
  const r = new Map(right.map((f) => [f.path, f.sha256]));
  const out: Change[] = [];
  for (const [path, sha] of r) {
    if (!l.has(path)) out.push({ path, status: "added" });
    else if (l.get(path) !== sha) out.push({ path, status: "modified" });
  }
  for (const path of l.keys()) if (!r.has(path)) out.push({ path, status: "deleted" });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The submitted version's changes against `base`. */
export async function changesAgainst(row: RosterRow, base: Version): Promise<Change[]> {
  if (!row.project || !row.link?.revision_id) return [];
  const [left, right] = await Promise.all([revisionFiles(base.project_id, base.id), revisionFiles(row.project.id, row.link.revision_id)]);
  return compareManifests(left, right);
}

/** Diff editors name their left side "<project>@<revision>". */
export const entryOf = (v: Version) => `${v.project_id}@${v.id}`;

/** A file's text in that version ("" when the version doesn't have it). */
export async function leftText(entry: string, path: string): Promise<string> {
  const [pid, rev] = entry.split("@").map(Number);
  const files = await revisionFiles(pid, rev);
  const f = files.find((x) => x.path === path);
  return f ? blobText(pid, f.sha256) : "";
}

export const versionLabel = (v: Version, starter = false) => (starter ? "Starter" : v.number != null ? `Version ${v.number}` : `Version #${v.id}`);
