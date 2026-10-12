/**
 * The words TMCode says (workflow plan §3.4, N5/N6/L9): every message the
 * workflow plan touched, with an id, in the glossary's terms, naming things
 * as the user sees them. Technical parts (status codes, request ids) go in a
 * notification's `details`, never in the text. This is also what Kinyarwanda
 * and French translations will start from.
 *
 * Glossary (messages/glossary.test.ts enforces it):
 *   Start, Continue · Save to Task Mentor · Submit · Withdraw to Edit ·
 *   In progress · Returned, Graded, Closed · All My Projects (students) · Sign in
 */

type Params = Record<string, string | number | boolean | null | undefined>;
type Text = string | ((p: Params) => string);

const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const CATALOG = {
  // ── Task Mentor answers ──
  "api.server": "Task Mentor had a problem. Try again in a minute.",
  "api.offline": "Task Mentor can't be reached. Check your internet connection.",
  "api.unsupported": "Task Mentor projects are available in the TMCode desktop app.",
  "api.details": (p) => `${p.method} ${p.path} → ${p.status}${p.code ? ` ${p.code}` : ""}${p.requestId ? ` · request ${p.requestId}` : ""}`,

  // ── Sign in ──
  "signin.button": "Sign in",
  "signin.account": "Accounts: Sign in",
  "signin.waiting": "Continue in your browser…",
  "signin.browser": "Continue in your browser to sign in with your NGA account.",
  "signin.prompt": "Sign in to continue",
  "signin.promptDetail": "Task Mentor projects need your NGA account. One sign-in does Central MIS and Task Mentor.",
  "signin.toOpenAssignment": "Sign in to open this assignment.",
  "signin.toGrade": "Sign in to grade this practical.",
  "signin.resume": (p) => `Signed in. Opening ${p.what}…`,

  // ── Start / Continue ──
  "start.examFirst": "Finish your exam first.",
  "start.completed": "This assignment is completed, so it can't be started.",
  "start.ready": (p) => `Your workspace for "${p.title}" is ready${p.files ? ` with ${s(Number(p.files), "starter file")}` : ""}. Save to Task Mentor as you go, then Submit.`,
  "start.firstThis": "Start this assignment first.",

  // ── Save to Task Mentor ──
  "save.notConnected": "This folder isn't connected to Task Mentor yet.",
  "save.connect": "Connect to Task Mentor",
  "save.github": "This is a GitHub project: commit and push in Source Control. Task Mentor follows your pushes.",
  "save.autoFailed": (p) => `Automatic saving to Task Mentor isn't working: ${p.why}`,
  "save.conflicts": (p) => `${s(Number(p.n), "file")} changed both here and in Task Mentor. Compare, then keep yours or take Task Mentor's.`,
  "save.conflictsBlock": (p) => `${s(Number(p.n), "file")} changed both here and in Task Mentor. Resolve ${Number(p.n) === 1 ? "it" : "them"} under Conflicts, then ${p.doing} again.`,
  "save.showConflicts": "Show Conflicts",

  // ── Locks ──
  "lock.submitted": (p) => `${p.name} is submitted: Withdraw to Edit to keep working on it.`,
  "lock.removed": (p) => `${p.name} was removed: restore it to edit it again.`,
  "lock.graded": (p) => `${p.name} is graded, so it can't be changed.`,

  // ── Submit / Withdraw ──
  "submit.done": (p) => `Submitted ${p.what}${p.late ? " (late)" : ""}. Your teacher sees exactly this version.`,
  "submit.openFirst": "Continue this assignment first, so the newest work is what you submit.",
  "submit.openPracticalFirst": "Continue this practical first, so the newest work is what you submit.",
  "submit.already": "This is already submitted. Withdraw to Edit to change it.",
  "submit.alreadyGraded": "This is already graded.",
  "submit.completed": "This assignment is completed: it can no longer be submitted.",
  "submit.closed": "This assignment is closed: your teacher no longer takes submissions.",
  "submit.quizClosed": "The quiz isn't open in Task Mentor. Open the quiz, then submit again.",
  "withdraw.done": "Submission withdrawn: you can edit again. Submit when you are ready.",
  "withdraw.first": "Withdraw to Edit first; then you can change what this project is for.",
  "match.unmatchFirst": (p) => `"${p.title}" is already matched with another of your projects. Change it there first.`,

  // ── Projects ──
  "projects.removed": (p) => `"${p.name}" was removed.`,
  "projects.restore": "Restore",
  "projects.allMine": "All My Projects",
  "projects.teacher": "Task Mentor Projects",

  // ── Grading ──
  "grade.saved": (p) => `Grade saved: ${p.score}/${p.max}. ${p.quiz ? "The student sees it when the quiz results are released." : "The student sees it in Task Mentor."}`,
  "grade.draftSaved": (p) => `Draft saved: ${p.score}/${p.max}. The student doesn't see it until you release it.`,
  "grade.noDrafts": (p) => `Grade saved: ${p.score}/${p.max}. This Task Mentor has no draft grades yet, so the student can already see it.`,
  "grade.locks": "The student's project is now read-only.",
  "release.none": "There are no draft grades to release.",
  "release.done": (p) => `Released ${s(Number(p.n), "grade")}.${p.quiz ? " Students see them when the quiz results are released." : " Students see them in Task Mentor now."}`,
  "release.partial": (p) => `Released ${p.done} of ${p.total} grades. Not released: ${p.list}.`,
  "release.failed": "The drafts couldn't be released.",
  "release.skip.GRADE_CHANGED": "changed by another teacher",
  "release.skip.DRAFT_NEEDS_SUBMISSION": "not handed in yet",
  "release.skip.NOT_SUBMITTED": "not handed in any more",
  "release.skip.ACTIVITY_CLOSED": "the activity is closed",
  "release.skip.PROJECT_GRADED": "already graded",
  "release.skip.other": "Task Mentor refused it",
  "return.done": (p) => `Returned to ${p.name} for changes. They can edit and submit again.`,
  "return.resubmit": (p) => `${p.name} can change their work and submit again. Their grade was taken back.`,
} satisfies Record<string, Text>;

export type MessageId = keyof typeof CATALOG;

/** A message in the user's words: `msg("submit.done", { what: '"To-do list"', late: true })`. */
export function msg(id: MessageId, params: Params = {}): string {
  const t: Text = CATALOG[id];
  return typeof t === "function" ? t(params) : t;
}

/** Why Task Mentor skipped a draft, in words (never a server code). */
export function releaseSkipReason(code: string): string {
  const id = `release.skip.${code}` as MessageId;
  return id in CATALOG ? msg(id) : msg("release.skip.other");
}
