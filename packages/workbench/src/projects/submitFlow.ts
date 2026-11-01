import type { ProjectScan, SkippedFile } from "../platform/types";
import { msg } from "../messages/catalog";
import { getPlatform, log, notify, showDialog, showPanel } from "../state/store";
import { runSafetyScan } from "../ai/scan";
import { aiUseStatement, summariseAiUse } from "../activity/aiStatement";
import { useActivityLog } from "../activity/log";
import { showQuickPick } from "../widgets/QuickPick";
import { openInTaskMentor } from "./taskMentorLinks";
import { notifyError, TmError } from "./service";
import { markJourney } from "../util/journey";

/**
 * The words both submit flows share (the brief's Submit and All My Projects'
 * Submit), so they never contradict each other. They follow Task
 * Mentor: a submitted project is locked until the teacher grades it or the
 * student withdraws it, and Withdraw works while the assessment is open.
 */

export function submitConfirmDetail(opts: { late?: boolean; quizPractical?: boolean }) {
  const what = opts.quizPractical ? "quiz" : "assignment";
  return (
    `TMCode saves your work to Task Mentor, then submits that exact version.${opts.late ? " The due date has passed, so it will be marked late." : ""}` +
    `\n\nSubmitted work is locked until your teacher grades it or you withdraw it. You can withdraw and submit again until the ${what} closes.` +
    (opts.quizPractical ? "\n\nThis is a coding question: keep the quiz open in Task Mentor while you submit, so your project is recorded as your answer." : "")
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
  // The verification gate (proposal F1): the safety scan runs first and says what it found.
  // It informs; it never stops a student handing work in (only sharing is blocked, M1).
  const scan = opts.quizPractical ? null : await runSafetyScan({ quiet: true }).catch(() => null);
  // The AI-use statement (I4): facts from the Activity log, as the teacher will see them.
  const aiUse = aiUseStatement(summariseAiUse(useActivityLog.getState().events));
  for (;;) {
    const scanLine = scan && scan.findings.length ? `\n\nSafety scan: ${scan.critical ? `${scan.critical} critical finding${scan.critical === 1 ? "" : "s"} (a security mistake to fix), ` : ""}${scan.findings.length} in all. You can still submit.` : scan ? "\n\nSafety scan: nothing found." : "";
    const extra = (manifest ? `\n\n${manifestLine(manifest)}.${notIncludedLine(manifest) ? ` ${notIncludedLine(manifest)}: Show to see what and why.` : ""}` : "") + scanLine + `\n\n${aiUse}`;
    const choice = await showDialog({
      severity: "info",
      message: opts.message,
      detail: submitConfirmDetail(opts) + extra,
      buttons: [
        { id: "submit", label: "Save and Submit", primary: true },
        ...(manifest && manifest.skippedCount ? [{ id: "show", label: "Show Not Included" }] : []),
        ...(scan?.findings.length ? [{ id: "findings", label: "Show Findings" }] : []),
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice === "findings") {
      showPanel("problems");
      return false;
    }
    if (choice !== "show" || !manifest) return choice === "submit";
    await showNotIncluded(manifest);
  }
}

/** Only once Task Mentor accepted the submission. `what`: `"Name"` or `"Name" for "Assessment"`. */
export function notifySubmitted(what: string, submission: unknown, owner?: string) {
  const late = (submission as { is_late?: boolean } | null)?.is_late;
  markJourney("submitted");
  notify("info", msg("submit.done", { what, late: !!late }), undefined, { kind: "result", important: true, owner });
}

/** A refused submit, explained: a closed quiz attempt gets a way to open it. */
export async function explainSubmitError(e: unknown, target?: { activity_type: string; activity_id: number }) {
  if (e instanceof TmError && e.code === "QUIZ_NOT_OPEN") {
    const choice = await showDialog({
      severity: "warning",
      message: msg("submit.quizClosed"),
      detail: "Nothing was submitted. Your work is saved in Task Mentor.",
      buttons: [
        { id: "open", label: "Open the Quiz in Task Mentor", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice === "open" && target?.activity_type === "quiz") openInTaskMentor({ kind: "quiz", id: target.activity_id });
    return;
  }
  notifyError(e);
}
