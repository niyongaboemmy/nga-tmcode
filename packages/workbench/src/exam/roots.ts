/**
 * Exam task folders: `<app data>/exams/<submission>` on the desktop
 * (exam.rs `exam_workspace`), `memory://exam-<submission>` in the browser.
 * They are never listed in Recent and never reopen in practice mode.
 */
export function isExamRoot(root: string | null | undefined): boolean {
  if (!root) return false;
  return /^memory:\/\/exam-\d+$/.test(root) || /com\.amashuri\.tmcode[\\/]+exams[\\/]+\d+[\\/]*$/i.test(root);
}

/** The submission id of an exam folder, or null. */
export function examRootSubmission(root: string | null | undefined): number | null {
  if (!root || !isExamRoot(root)) return null;
  const m = /(\d+)[\\/]*$/.exec(root);
  return m ? Number(m[1]) : null;
}
