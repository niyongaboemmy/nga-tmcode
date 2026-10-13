/**
 * Task Mentor's web addresses (pure: no state). The new code area and grading routes
 * (CODE_RUNNER_PLAN §5.2); Task Mentor still redirects the old ones.
 */

export type TaskMentorTarget =
  /** A project's page (`/code/projects/:id`). */
  | { kind: "project"; id: number }
  /** A project in the browser editor (`/code/projects/:id/edit`). */
  | { kind: "projectEdit"; id: number }
  /** An assignment's page (`/assignments/:id`). */
  | { kind: "assignment"; id: number }
  /** A code assignment's work in the browser (`/assignments/:id/work`). */
  | { kind: "assignmentWork"; id: number }
  | { kind: "quiz"; id: number }
  /** The "To grade" inbox (`/grading`). */
  | { kind: "toGrade" }
  /** Grading one activity (`/grading/:type/:id?question=&student=`). */
  | { kind: "grading"; type: string; id: number; question?: number | null; student?: number | null }
  | { kind: "playground" }
  | { kind: "starters" }
  | { kind: "page"; path: string };

/** Task Mentor's web address for its API address. */
export function taskMentorWeb(api: string) {
  if (/^https:\/\/taskmentor-api\./.test(api)) return api.replace("://taskmentor-api.", "://taskmentor.");
  return "http://localhost:5173/taskmentor";
}

/** The path of a Task Mentor page (after the web address). */
export function taskMentorPath(target: TaskMentorTarget): string {
  switch (target.kind) {
    case "project":
      return `/code/projects/${target.id}`;
    case "projectEdit":
      return `/code/projects/${target.id}/edit`;
    case "assignment":
      return `/assignments/${target.id}`;
    case "assignmentWork":
      return `/assignments/${target.id}/work`;
    case "quiz":
      return `/quizzes/${target.id}/take`;
    case "toGrade":
      return "/grading";
    case "grading": {
      const q = new URLSearchParams();
      if (target.question) q.set("question", String(target.question));
      if (target.student != null) q.set("student", String(target.student));
      return `/grading/${target.type}/${target.id}${q.toString() ? `?${q}` : ""}`;
    }
    case "playground":
      return "/code/playground";
    case "starters":
      return "/code/starters";
    case "page":
      return target.path;
  }
}
