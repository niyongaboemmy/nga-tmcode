/**
 * One way to Task Mentor's web pages (guided plan H): every "Open in Task Mentor" door builds its
 * address here and opens it in the system browser.
 */
import { getPlatform } from "../state/store";
import { useProjects } from "./service";

export type TaskMentorTarget =
  | { kind: "project"; id: number }
  | { kind: "assignment"; id: number }
  | { kind: "quiz"; id: number }
  | { kind: "grading"; type: string; id: number }
  | { kind: "page"; path: string };

/** Task Mentor's web address for its API address. */
export function taskMentorWeb(api: string) {
  if (/^https:\/\/taskmentor-api\./.test(api)) return api.replace("://taskmentor-api.", "://taskmentor.");
  return "http://localhost:5173/taskmentor";
}

export function taskMentorUrl(target: TaskMentorTarget): string {
  const base = taskMentorWeb(useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com");
  switch (target.kind) {
    case "project":
      return `${base}/projects/${target.id}`;
    case "assignment":
      return `${base}/assignments/${target.id}`;
    case "quiz":
      return `${base}/quizzes/${target.id}/take`;
    case "grading":
      return `${base}/grading/practical/${target.type}/${target.id}`;
    case "page":
      return `${base}${target.path}`;
  }
}

/** Open in Task Mentor: the one function behind every such button and menu item. */
export function openInTaskMentor(target: TaskMentorTarget) {
  const url = taskMentorUrl(target);
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
