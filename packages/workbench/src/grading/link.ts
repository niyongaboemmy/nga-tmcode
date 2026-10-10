import { inExam } from "../exam/state";
import { notify, revealView } from "../state/store";
import { signedIn, signIn, useProjects } from "../projects/service";
import { keyOf, loadRoster, openGrading, openSubmission, refreshGrading, selectStudent, useGrading, type ActivityType } from "./service";

/**
 * Deep links into grading (G9), from Task Mentor's web grading page:
 * tmcode://grading?type=<assignment|quiz>&id=<id>&question=<qid>&student=<sid>&api=<origin>
 * opens that practical's grading tab on that student (and their submission).
 */

export interface GradingLink {
  type: ActivityType;
  id: number;
  question: number | null;
  student: number | null;
  api: string;
}

export function parseGradingLink(link: string): GradingLink | null {
  try {
    const u = new URL(link);
    if (u.protocol !== "tmcode:" || (u.hostname !== "grading" && u.pathname.replace(/^\/+/, "") !== "grading")) return null;
    const type = u.searchParams.get("type");
    const id = Number(u.searchParams.get("id"));
    if ((type !== "assignment" && type !== "quiz") || !Number.isInteger(id) || id <= 0) return null;
    const num = (k: string) => {
      const n = Number(u.searchParams.get(k));
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    return { type, id, question: type === "quiz" ? num("question") : null, student: num("student"), api: (u.searchParams.get("api") ?? "").replace(/\/+$/, "") };
  } catch {
    return null;
  }
}

async function openNow(link: GradingLink) {
  if (!useGrading.getState().activities) await refreshGrading({ rosters: false });
  if (!useGrading.getState().grader) {
    notify("info", "Grading is for the teachers of this practical.");
    return;
  }
  revealView("grading");
  // A quiz without a question in the link: its first practical question.
  let question = link.question;
  if (link.type === "quiz" && !question) question = useGrading.getState().activities?.find((a) => a.type === "quiz" && a.id === link.id)?.question_id ?? null;
  const key = keyOf(link.type, link.id, question);
  openGrading(key);
  const roster = useGrading.getState().rosters[key] ?? (await loadRoster(key));
  if (!roster || !link.student) return;
  const row = roster.rows.find((r) => r.student?.id === link.student);
  if (!row?.student) {
    notify("info", "That student isn't in this practical's list.");
    return;
  }
  selectStudent(key, row.student.id);
  if (row.project?.kind === "tm" && row.link?.revision_id) await openSubmission(key, row);
}

export async function openGradingLink(link: GradingLink) {
  const { isAllowedApi } = await import("../exam/api");
  const { getPlatform } = await import("../state/store");
  // No api: the Task Mentor TMCode is signed in to.
  if (link.api && !isAllowedApi(link.api, !!getPlatform().exam?.dev)) return notify("error", "This link points to an unknown Task Mentor server and was ignored.");
  if (inExam()) return notify("info", "Grading is not available during an exam.");
  const account = useProjects.getState().account;
  if (account?.signed_in && link.api && account.tm_api.replace(/\/+$/, "") !== link.api) {
    return notify("error", `This practical belongs to ${link.api}, but TMCode is signed in to ${account.tm_api}.`);
  }
  if (!signedIn()) {
    const off = useProjects.subscribe((s) => {
      if (!s.account?.signed_in) return;
      off();
      void openNow(link);
    });
    setTimeout(off, 10 * 60_000);
    notify("info", "Sign in with NGA to grade this practical.");
    void signIn();
    return;
  }
  await openNow(link);
}
