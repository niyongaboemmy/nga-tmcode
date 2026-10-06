/** Task Mentor project shapes (nga-task-mentor server/src/tmcode/PROJECTS_API.md). */

export type ProjectKind = "github" | "tm";

export interface Revision {
  id: number;
  project_id: number;
  number: number;
  parent_id: number | null;
  author_id: number;
  author_name?: string;
  message: string | null;
  file_count: number;
  size_bytes: number;
  source: "save" | "auto" | "submit";
  git_commit: string | null;
  created_at: string;
}

export interface GitReport {
  branch: string | null;
  head_commit: string | null;
  ahead: number;
  behind: number;
  changes: number;
  remote_url: string | null;
  last_push?: { commit: string; message?: string; at?: string } | null;
  reported_at?: string;
}

export interface PresenceSummary {
  online: boolean;
  devices_online: number;
  last_seen_at: string | null;
  file: string | null;
  dirty: number | null;
}

export interface LinkItem {
  id: number;
  activity_type: "quiz" | "assignment" | "manual_assessment";
  activity_id: number;
  status: "linked" | "submitted";
}

export interface Link extends LinkItem {
  project_id: number;
  activity: { title: string; course_id: number | null; open: boolean; due_date: string | null } | null;
  revision_id: number | null;
  revision_number: number | null;
  git_commit: string | null;
  submitted_at: string | null;
  linked_by: number;
  created_at: string;
}

export interface Project {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  language: string | null;
  kind: ProjectKind;
  visibility: "private" | "course";
  repo_url: string | null;
  repo_full_name: string | null;
  default_branch: string | null;
  head_revision_id: number | null;
  size_bytes: number;
  file_count: number;
  git: GitReport | null;
  archived_at: string | null;
  last_activity_at: string | null;
  created_at: string;
  updated_at: string;
  owner: { id: number; name: string; avatar_url: string | null };
  my_role: "owner" | "collaborator" | "viewer" | null;
  head?: Revision | null;
  presence?: PresenceSummary;
  links?: { total: number; submitted: number; items: LinkItem[] } | Link[];
}

export interface LinkableActivity {
  activity_type: Link["activity_type"];
  activity_id: number;
  title: string;
  course_id?: number | null;
  course_name?: string | null;
  due_date?: string | null;
  open?: boolean;
}

/** `.tmcode/project.json`: which Task Mentor project this folder is, and what it last synced. */
export interface Binding {
  project_id: number;
  tm_api: string;
  kind: ProjectKind;
  name: string;
  /** Revision the folder last saved or pulled (tm projects). */
  base_revision_id: number | null;
  base: { path: string; sha256: string; size: number }[] | null;
}

export type SyncState = "unbound" | "checking" | "synced" | "local-changes" | "remote-changes" | "both" | "conflict" | "saving" | "pulling" | "offline" | "error";
