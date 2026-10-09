import { getPlatform, notify, showDialog } from "../state/store";
import { taskMentorWeb } from "./commands";
import { TmError, useProjects } from "./service";

/**
 * The words both submit flows share (Assignments › Submit and Projects ›
 * Submit Project), so they never contradict each other. They follow Task
 * Mentor: a submitted project is locked until the teacher grades it or the
 * student withdraws it, and Withdraw works while the assessment is open.
 */

export function submitConfirmDetail(opts: { late?: boolean; quizPractical?: boolean }) {
  const what = opts.quizPractical ? "quiz" : "assignment";
  return (
    `TMCode saves your work to Task Mentor, then submits that exact version.${opts.late ? " The due date has passed, so it will be marked late." : ""}` +
    `\n\nSubmitted work is locked until your teacher grades it or you withdraw it. You can withdraw and submit again until the ${what} closes.` +
    (opts.quizPractical ? "\n\nThis is a quiz practical: keep the quiz open in Task Mentor while you submit, so your project is recorded as your answer." : "")
  );
}

/** Only once Task Mentor accepted the submission. `what`: `"Name"` or `"Name" for "Assessment"`. */
export function notifySubmitted(what: string, submission: unknown) {
  const late = (submission as { is_late?: boolean } | null)?.is_late;
  notify("info", `Submitted ${what}${late ? " (late)" : ""}. Your teacher sees exactly this version.`);
}

/** The student's quiz page in Task Mentor (where the attempt is opened). */
export function openQuizInTaskMentor(quizId: number) {
  const api = useProjects.getState().account?.tm_api ?? "https://taskmentor-api.amashuri.com";
  const url = `${taskMentorWeb(api)}/quizzes/${quizId}/take`;
  const p = getPlatform();
  if (p.openExternal) void p.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** A refused submit, explained: a closed quiz attempt gets a way to open it. */
export async function explainSubmitError(e: unknown, target?: { activity_type: string; activity_id: number }) {
  if (e instanceof TmError && e.code === "QUIZ_NOT_OPEN") {
    const choice = await showDialog({
      severity: "warning",
      message: "The quiz isn't open in Task Mentor. Open the quiz, then submit again.",
      detail: "Nothing was submitted. Your work is saved in Task Mentor.",
      buttons: [
        { id: "open", label: "Open the Quiz in Task Mentor", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice === "open" && target?.activity_type === "quiz") openQuizInTaskMentor(target.activity_id);
    return;
  }
  notify("error", (e as Error).message);
}
