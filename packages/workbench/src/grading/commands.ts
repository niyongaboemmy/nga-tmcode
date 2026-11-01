import { registerCommand } from "../commands/registry";
import { notify, openEditorInput, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { addCommentAtCursor, canAddCommentHere, reviewTarget, typingComment } from "./comments";
import { changesAgainst, entryOf, starterOf, versionLabel, versionsOf, type Version } from "./diff";
import { aiGate } from "../ai/gate";
import { copyGradingPrompt, gradeWithCli, GRADING_CLIS } from "./aiCli";
import { discardAiDraft, extensionGetContext, useAiGrading } from "./aiGrading";
import { draftFrom, draftKey, inputFromDraft } from "./drafts";
import { isDraftGrade, releaseDrafts, startGrading, useGrading } from "./service";

/**
 * Grading commands (G10): Save & Next, next / previous student and focus the
 * panel, with global keys while a grading tab shows; line comments and the
 * diffs of the review folder; releasing draft grades.
 */

/** What an open grading tab can do (it registers itself while mounted). */
export interface GradingController {
  key: string;
  next(): void;
  previous(): void;
  saveAndNext(): void;
  focusPanel(): void;
  /** Opens the panel's "Return for Changes" form (false: not possible for this student). */
  returnForChanges(): boolean;
  /** Opens the panel's "Draft with AI" box (false: no student to grade on screen). */
  aiDraft?(): boolean;
}
const controllers = new Map<string, GradingController>();

export function registerGradingController(c: GradingController) {
  controllers.set(c.key, c);
  return () => {
    if (controllers.get(c.key) === c) controllers.delete(c.key);
  };
}

/** The grading tab the keys act on: the focused group's, or (while reviewing) any one showing. */
function gradingKeyInView(): string | null {
  const s = useWorkbench.getState();
  const activeOf = (g: (typeof s.groups)[number]) => g.editors.find((e) => e.id === g.activeId);
  const focused = s.groups.find((g) => g.id === s.activeGroup);
  const e = focused && activeOf(focused);
  if (e?.kind === "grading") return e.gradingKey;
  if (!useGrading.getState().review) return null;
  for (const g of s.groups) {
    const x = activeOf(g);
    if (x?.kind === "grading") return x.gradingKey;
  }
  return null;
}
const controller = () => {
  const k = gradingKeyInView();
  return k ? (controllers.get(k) ?? null) : null;
};

// ── Diffs (G2) ────────────────────────────────────────────────────────────

const codeGroup = () => {
  const groups = useWorkbench.getState().groups;
  return groups.find((g) => !g.editors.some((e) => e.kind === "grading"))?.id ?? groups[0].id;
};

/** The review folder's file in view: the focused group's, else any group's. */
function fileInView(): string | null {
  const s = useWorkbench.getState();
  const of = (g: (typeof s.groups)[number]) => {
    const e = g.editors.find((x) => x.id === g.activeId);
    return e?.kind === "file" || (e?.kind === "historyDiff" && e.source === "grading") ? e.path : null;
  };
  const focused = s.groups.find((g) => g.id === s.activeGroup);
  return (focused && of(focused)) ?? s.groups.map(of).find(Boolean) ?? null;
}

export function openGradingDiff(path: string, base: Version, label: string) {
  openEditorInput({ kind: "historyDiff", id: `grading-diff:${entryOf(base)}:${path}`, path, entry: entryOf(base), time: Date.now(), preview: false, source: "grading", label }, { group: codeGroup() });
}

/** Changes vs Starter: the file in view (or the first changed one) against the starter files. */
export async function diffWithStarter(path?: string) {
  const row = reviewTarget()?.row;
  if (!row) return;
  try {
    const base = await starterOf(row);
    if (!base) {
      notify("info", "This activity has no starter files to compare with.");
      return;
    }
    const target = path ?? fileInView() ?? (await changesAgainst(row, base))[0]?.path;
    if (!target) {
      notify("info", "Nothing changed since the starter files.");
      return;
    }
    openGradingDiff(target, base, "Starter");
  } catch (e) {
    notify("error", `Could not load the starter files: ${(e as Error).message}`);
  }
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** Compare with Version N…: pick one of the student's other versions. */
export async function compareWithVersion(path?: string) {
  const row = reviewTarget()?.row;
  if (!row) return;
  const loading = Promise.all([versionsOf(row), starterOf(row).catch(() => null)]);
  const items = loading.then(([versions, starter]) =>
    versions
      .filter((v) => v.id !== row.link?.revision_id)
      .reverse()
      .map((v) => ({ id: String(v.id), label: versionLabel(v), description: when(v.at), detail: starter?.id === v.id ? "The starter files" : undefined, icon: "git-commit" })),
  );
  const list = await items.catch(() => []);
  if (!list.length) {
    notify("info", `${row.student?.name ?? "The student"} saved no other versions to compare with.`);
    return;
  }
  const pick = await showQuickPick({ title: `Compare ${row.student?.name ?? "the"}'s submitted version with…`, placeholder: "Pick a version", items: list, matchOnDescription: true });
  if (!pick) return;
  const [versions] = await loading;
  const v = versions.find((x) => String(x.id) === pick.id);
  if (!v) return;
  const target = path ?? fileInView() ?? (await changesAgainst(row, v))[0]?.path;
  if (!target) {
    notify("info", `Nothing changed since ${versionLabel(v).toLowerCase()}.`);
    return;
  }
  openGradingDiff(target, v, versionLabel(v));
}

// ── Release ───────────────────────────────────────────────────────────────

export function draftGradeCount(key: string) {
  const r = useGrading.getState().rosters[key];
  return r?.counts.drafts ?? r?.rows.filter(isDraftGrade).length ?? 0;
}

export function releaseDraftGrades(key: string) {
  return releaseDrafts(key, (roster, row) => inputFromDraft(roster, draftFrom(roster, row)));
}

// ── Registration ──────────────────────────────────────────────────────────

let registered = false;
export function registerGradingCommands() {
  if (registered) return;
  registered = true;
  const can = () => !!controller() && !typingComment();
  registerCommand({ id: "grading.saveAndNext", title: "Save Grade and Go to Next", category: "Grading", keybinding: "mod+enter", enabled: can, run: () => controller()?.saveAndNext() });
  registerCommand({ id: "grading.next", title: "Next Student", category: "Grading", keybinding: "alt+down", enabled: can, run: () => controller()?.next() });
  registerCommand({ id: "grading.previous", title: "Previous Student", category: "Grading", keybinding: "alt+up", enabled: can, run: () => controller()?.previous() });
  registerCommand({ id: "grading.focusPanel", title: "Focus Grade Panel", category: "Grading", keybinding: "mod+alt+g", enabled: () => !!controller(), run: () => controller()?.focusPanel() });
  // Palette doors to the one home of each grading action (guided plan H).
  registerCommand({ id: "grading.start", title: "Start Grading", category: "Grading", aliases: ["grade next", "oldest submission"], enabled: () => !!useGrading.getState().grader, run: () => startGrading() });
  registerCommand({
    id: "grading.returnForChanges",
    title: "Return for Changes…",
    category: "Grading",
    enabled: () => !!controller(),
    run: () => {
      if (!controller()?.returnForChanges()) notify("info", "Only submitted work can be returned for changes. Choose a student who handed in.");
    },
  });
  registerCommand({ id: "grading.addComment", title: "Add Line Comment", category: "Grading", enabled: canAddCommentHere, run: addCommentAtCursor });
  registerCommand({ id: "grading.diffStarter", title: "Changes vs Starter", category: "Grading", enabled: () => !!reviewTarget()?.row.project, run: () => diffWithStarter() });
  registerCommand({
    id: "grading.runUnitTests",
    title: "Run the Student's Unit Tests",
    category: "Grading",
    enabled: () => reviewTarget()?.row.project?.kind === "tm",
    run: async () => {
      const t = reviewTarget();
      if (t) await (await import("./unitTests")).runStudentUnitTests(t.gkey, t.row);
    },
  });
  // AI-assisted grading: an AI drafts, the teacher reviews and saves (grading/aiGrading.ts).
  const reviewOpen = () => !!useGrading.getState().review;
  registerCommand({
    id: "grading.aiDraft",
    title: "Draft Grade with AI",
    category: "Grading",
    aliases: ["ai grade", "grade with ai", "ai draft"],
    enabled: () => !!controller() && aiGate().chat,
    run: () => {
      if (!controller()?.aiDraft?.()) notify("info", "Pick a student who handed in, then Draft with AI.");
    },
  });
  for (const tool of ["claude", "agy", "gemini", "codex"] as const) {
    registerCommand({
      id: `grading.gradeWith.${tool}`,
      title: `Grade with ${GRADING_CLIS[tool].label}`,
      category: "Grading",
      aliases: ["ai grade", GRADING_CLIS[tool].bin],
      enabled: () => reviewOpen() && aiGate().thirdParty,
      run: () => gradeWithCli(tool),
    });
  }
  registerCommand({ id: "grading.copyPrompt", title: "Copy Grading Prompt (for an AI extension)", category: "Grading", enabled: () => reviewOpen() && aiGate().thirdParty, run: () => copyGradingPrompt() });
  registerCommand({
    id: "grading.discardAiDraft",
    title: "Discard AI Draft",
    category: "Grading",
    enabled: () => {
      const r = useGrading.getState().review;
      return !!r && !!useAiGrading.getState().meta[draftKey(r.key, r.student_id)];
    },
    run: () => {
      const r = useGrading.getState().review;
      if (r) discardAiDraft(draftKey(r.key, r.student_id));
    },
  });
  // For extensions (exthost/mainThread.ts runBuiltin passes their arguments and returns the result).
  registerCommand({ id: "tmcode.grading.getContext", title: "Grading Context (for extensions)", category: "Grading", hidden: true, run: () => extensionGetContext() });
  registerCommand({ id: "tmcode.grading.proposeDraft", title: "Propose a Grading Draft (for extensions)", category: "Grading", hidden: true, run: () => undefined });
  registerCommand({ id: "grading.compareVersion", title: "Compare with Version…", category: "Grading", enabled: () => !!reviewTarget()?.row.project, run: () => compareWithVersion() });
  registerCommand({
    id: "grading.releaseDrafts",
    title: "Release Draft Grades",
    category: "Grading",
    enabled: () => {
      const k = gradingKeyInView();
      return !!k && draftGradeCount(k) > 0;
    },
    run: () => {
      const k = gradingKeyInView();
      if (k) void releaseDraftGrades(k);
    },
  });
}

/** The shortcuts the grade panel lists. */
export const GRADING_SHORTCUTS: { id: string; label: string; keys: string }[] = [
  { id: "grading.saveAndNext", label: "Save & Next", keys: "mod+enter" },
  { id: "grading.next", label: "Next student", keys: "alt+down" },
  { id: "grading.previous", label: "Previous student", keys: "alt+up" },
  { id: "grading.focusPanel", label: "Focus the grade panel", keys: "mod+alt+g" },
];
