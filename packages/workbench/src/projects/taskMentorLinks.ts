/**
 * One way to Task Mentor's web pages (guided plan H): every "Open in Task Mentor" door builds its
 * address here and opens it in the system browser.
 */
import { getPlatform } from "../state/store";
import { useProjects } from "./service";
import { taskMentorPath, taskMentorWeb, type TaskMentorTarget } from "./taskMentorWeb";

export { taskMentorWeb, type TaskMentorTarget } from "./taskMentorWeb";

export function taskMentorUrl(target: TaskMentorTarget): string {
  return `${taskMentorWeb(useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com")}${taskMentorPath(target)}`;
}

/** Open in Task Mentor: the one function behind every such button and menu item. */
export function openInTaskMentor(target: TaskMentorTarget) {
  const url = taskMentorUrl(target);
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
