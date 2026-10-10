import type { ProjectScan, SkippedFile } from "../platform/types";
import { getPlatform, log, notify, showDialog } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
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

// ── What is handed in (S1) ────────────────────────────────────────────────

export const formatBytes = (n: number) => (n < 1024 ? `${n} byte${n === 1 ? "" : "s"}` : n < 1_048_576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Math.round((n / 1_048_576) * 10) / 10} MB`);

/** Why something is left out, in a few words. */
export const SKIP_REASON: Record<SkippedFile["reason"], string> = {
  folder: "build output or dependencies: never handed in",
  ignored: "ignored by .gitignore or .tmignore",
  "too-large": "larger than 10 MB",
  "file-limit": "over the 5,000-file limit",
  "size-limit": "over the 100 MB limit",
  "long-path": "path too long",
  link: "a link, not a file",
  unreadable: "couldn't be read",
};

export interface Manifest {
  files: number;
  bytes: number;
  skipped: SkippedFile[];
  /** All left-out entries (the list may stop at 1,000). */
  skippedCount: number;
}

export function manifestOf(scan: Pick<ProjectScan, "files" | "total_bytes" | "skipped" | "skipped_count">): Manifest {
  const skipped = scan.skipped ?? [];
  return { files: scan.files.length, bytes: scan.total_bytes ?? scan.files.reduce((n, f) => n + f.size, 0), skipped, skippedCount: Math.max(scan.skipped_count ?? 0, skipped.length) };
}

/** "23 files, 1.2 MB will be handed in" */
export function manifestLine(m: Manifest) {
  return `${m.files.toLocaleString()} file${m.files === 1 ? "" : "s"}, ${formatBytes(m.bytes)} will be handed in`;
}

/** "2 not included" (folders count once), or null when nothing is left out. */
export function notIncludedLine(m: Manifest) {
  return m.skippedCount ? `${m.skippedCount.toLocaleString()} not included` : null;
}

/** The open folder as Task Mentor would get it now (null: no desktop scan available). */
export async function currentManifest(): Promise<Manifest | null> {
  const host = getPlatform().account;
  if (!host) return null;
  try {
    return manifestOf(await host.scan());
  } catch {
    return null;
  }
}

/** Show: what is left out and why (a list to read, and the Output channel "Task Mentor: Not included"). */
export async function showNotIncluded(m: Manifest) {
  const channel = "Task Mentor: Not included";
  log(channel, `${notIncludedLine(m) ?? "Nothing left out"} (${manifestLine(m)}):`);
  for (const s of m.skipped) log(channel, `  ${s.path}${s.dir ? "/" : ""} — ${SKIP_REASON[s.reason] ?? s.reason}${s.size ? ` (${formatBytes(s.size)})` : ""}`);
  if (m.skippedCount > m.skipped.length) log(channel, `  …and ${m.skippedCount - m.skipped.length} more`);
  await showQuickPick({
    title: `${notIncludedLine(m)}: these stay on this computer`,
    placeholder: "Not handed in (to include a file, make it smaller or remove it from .gitignore)",
    matchOnDescription: true,
    items: m.skipped.map((s) => ({
      id: s.path,
      label: s.dir ? `${s.path}/` : s.path,
      description: `${SKIP_REASON[s.reason] ?? s.reason}${s.size ? ` · ${formatBytes(s.size)}` : ""}`,
      icon: s.dir ? "folder" : "file",
      resourcePath: s.dir ? undefined : s.path,
    })),
  });
}

/**
 * The submit confirmation, with what will be handed in: "23 files, 1.2 MB
 * will be handed in · 2 not included" and a Show button for that list
 * (from the same scan the save uses). true: submit.
 */
export async function confirmSubmit(opts: { message: string; late?: boolean; quizPractical?: boolean }): Promise<boolean> {
  const manifest = await currentManifest();
  for (;;) {
    const extra = manifest ? `\n\n${manifestLine(manifest)}.${notIncludedLine(manifest) ? ` ${notIncludedLine(manifest)}: Show to see what and why.` : ""}` : "";
    const choice = await showDialog({
      severity: "info",
      message: opts.message,
      detail: submitConfirmDetail(opts) + extra,
      buttons: [
        { id: "submit", label: "Save and Submit", primary: true },
        ...(manifest && manifest.skippedCount ? [{ id: "show", label: "Show Not Included" }] : []),
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice !== "show" || !manifest) return choice === "submit";
    await showNotIncluded(manifest);
  }
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
