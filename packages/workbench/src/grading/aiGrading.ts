import { create } from "zustand";
import { summarize } from "@nga/runtimes/testing";
import { onExternalChanges } from "../monaco/external";
import { api, TmError } from "../projects/service";
import { getPlatform, notify, openFile, useWorkbench } from "../state/store";
import { useFrameworkTests } from "../testing/service";
import { useServerUnit } from "../testing/serverUnit";
import { gradingTools } from "../ai/agent/tools";
import { aiErrorFromResponse, requestModeFields, useAi, AiRequestError } from "../ai/service";
import {
  buildGradingContext,
  CLAUDE_FILE,
  CONTEXT_FILE,
  DRAFT_FILE,
  draftSchema,
  gradingReadme,
  GRADING_DIR,
  mergeAiDraft,
  parseDraftText,
  README_FILE,
  SCHEMA_FILE,
  testsSummary,
  validateAiDraft,
  type Confidence,
  type GradingContext,
  type TestsSummary,
} from "./aiDraft";
import { currentDraft, draftFrom, draftKey, dropDraft, getDraft, putDraft, type Draft } from "./drafts";
import { loadRoster, openGrading, parseKey, selectStudent, useGrading, type Review, type Roster, type RosterRow } from "./service";

/**
 * AI-assisted grading in TMCode: every way an AI drafts a grade ends here, and none of them saves.
 * - Built-in: "Draft with AI" in the grade panel (POST …/ai-draft with the picked TMCode AI mode).
 * - Any AI that writes `.tmcode/grading/draft.json` in the review folder (Claude Code, Gemini CLI,
 *   Codex, an extension's agent…): the file is watched, checked and put in the form.
 * - TMCode AI's agent (`propose_grade`) and extensions (`tmcode.grading.proposeDraft`).
 * The form gets the AI's scores, comments and feedback as an unsaved draft marked "AI draft by X"
 * (confidence, notes for the teacher, Discard); the teacher adjusts it and clicks Save.
 */

export interface AiDraftMeta {
  by: string;
  at: number;
  confidence: Confidence | null;
  teacher_notes: string;
  warnings: string[];
  /** What TMCode changed in the AI's draft (clamped scores, left-out criteria). */
  notes: string[];
  /** The AI's values, to mark what is still the AI's (a teacher's edit removes the mark). */
  scores: (number | null)[];
  comments: (string | null)[];
  score: number | null;
  feedback: string | null;
  /** The unsaved form before the AI's draft (null: there was none): Discard puts it back. */
  before: Draft | null;
}

interface AiGradingState {
  /** Draft key → the AI draft waiting for the teacher. */
  meta: Record<string, AiDraftMeta>;
  /** Draft key → an AI tool working on it ("Claude Code is grading Ben… watching for its draft"). */
  watching: Record<string, { tool: string; student: string; since: number }>;
  /** Draft key → the built-in "Draft with AI" request in flight. */
  drafting: Record<string, boolean>;
}

const META_KEY = "tmcode.grading.aiDrafts";

function loadMeta(): Record<string, AiDraftMeta> {
  try {
    const raw = localStorage.getItem(META_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, AiDraftMeta>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistMeta(meta: Record<string, AiDraftMeta>) {
  try {
    if (Object.keys(meta).length) localStorage.setItem(META_KEY, JSON.stringify(meta));
    else localStorage.removeItem(META_KEY);
  } catch {
    /* storage blocked: the mark lives in this window */
  }
}

export const useAiGrading = create<AiGradingState>(() => ({ meta: loadMeta(), watching: {}, drafting: {} }));

function setMeta(dkey: string, m: AiDraftMeta | null) {
  const meta = { ...useAiGrading.getState().meta };
  if (m) meta[dkey] = m;
  else delete meta[dkey];
  useAiGrading.setState({ meta });
  persistMeta(meta);
}

/** The grade was saved or thrown away: the AI marks go. */
export function clearAiMeta(dkey: string) {
  if (useAiGrading.getState().meta[dkey]) setMeta(dkey, null);
  stopWatching(dkey);
}

export function setWatching(dkey: string, w: { tool: string; student: string } | null) {
  const watching = { ...useAiGrading.getState().watching };
  if (w) watching[dkey] = { ...w, since: Date.now() };
  else delete watching[dkey];
  useAiGrading.setState({ watching });
}
export const stopWatching = (dkey: string) => useAiGrading.getState().watching[dkey] && setWatching(dkey, null);

/** "Discard AI Draft": the form goes back to what it was before the AI's draft. */
export function discardAiDraft(dkey: string) {
  const m = useAiGrading.getState().meta[dkey];
  if (!m) return;
  setMeta(dkey, null);
  const [type, id, q, sid] = dkey.split(":");
  const gkey = `${type}:${id}:${q}`;
  const roster = useGrading.getState().rosters[gkey];
  const row = roster?.rows.find((r) => String(r.student?.id) === sid);
  if (m.before && roster && row) putDraft(dkey, m.before, draftFrom(roster, row), row.grade?.version ?? null);
  else dropDraft(dkey);
}

// ── the review open now, as context ──

/** Tests the teacher ran on the open review folder (local suites, else Task Mentor's code runner). */
export function reviewTestsSummary(): TestsSummary | null {
  const unit = useServerUnit.getState().report;
  if (unit && unit.total > 0) {
    const bad = unit.tests.filter((t) => t.status === "failed" || t.status === "error");
    return { passed: unit.passed, failed: unit.failed + unit.errors, total: unit.total, ...(bad.length ? { summary: bad.slice(0, 30).map((t) => `FAILED ${t.name}${t.message ? `: ${String(t.message).split("\n")[0]}` : ""}`).join("\n").slice(0, 4000) } : {}) };
  }
  const results = Object.values(useFrameworkTests.getState().state).flatMap((s) => s.results);
  if (!results.length) return null;
  const s = summarize(results);
  return { ...testsSummary(results)!, passed: s.passed, total: s.total };
}

async function rosterAndRow(review: Review): Promise<{ roster: Roster; row: RosterRow } | null> {
  const roster = useGrading.getState().rosters[review.key] ?? (await loadRoster(review.key, { quiet: true }));
  const row = roster?.rows.find((r) => r.student?.id === review.student_id);
  return roster && row ? { roster, row } : null;
}

/** The grading context of the review folder open now (null: none open). */
export async function currentGradingContext(): Promise<GradingContext | null> {
  const review = useGrading.getState().review;
  if (!review) return null;
  const rr = await rosterAndRow(review);
  return rr ? buildGradingContext(rr.roster, rr.row, reviewTestsSummary()) : null;
}

/** TMCode AI chat's `context.grading` while a teacher reviews a submission (null otherwise). */
export function gradingChatContext(): { purpose: "grading"; grading: { activity_title: string; brief: string; rubric: { index: number; criteria: string; description: string | null; max_score: number }[]; student_name: string; question_text?: string } } | null {
  const g = useGrading.getState();
  if (!g.review || !(useAi.getState().status?.staff ?? g.grader)) return null;
  const roster = g.rosters[g.review.key];
  const row = roster?.rows.find((r) => r.student?.id === g.review!.student_id);
  if (!roster || !row) return null;
  const ctx = buildGradingContext(roster, row, reviewTestsSummary());
  const brief = [ctx.brief.description, ctx.brief.instructions && `Instructions:\n${ctx.brief.instructions}`].filter(Boolean).join("\n\n").slice(0, 12_000);
  return {
    purpose: "grading",
    grading: {
      activity_title: ctx.activity.title,
      brief,
      rubric: ctx.rubric.map(({ index, criteria, description, max_score }) => ({ index, criteria, description, max_score })),
      student_name: ctx.student.name,
      ...(ctx.activity.question ? { question_text: ctx.activity.question.slice(0, 4000) } : {}),
    },
  };
}

/** Writes the grading files into the review folder (TMCode's files; the student's stay as submitted). */
export async function writeGradingFiles(): Promise<boolean> {
  const ctx = await currentGradingContext();
  if (!ctx || !useWorkbench.getState().workspace) return false;
  const fs = getPlatform().fs;
  const readme = gradingReadme(ctx);
  const write = async (path: string, content: string) => {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
    await fs.writeFile(path, content).catch(async () => {
      await fs.createFile(path);
      await fs.writeFile(path, content);
    });
  };
  try {
    await write(README_FILE, readme);
    await write(CONTEXT_FILE, `${JSON.stringify(ctx, null, 2)}\n`);
    await write(SCHEMA_FILE, `${JSON.stringify(draftSchema(ctx), null, 2)}\n`);
    await write(CLAUDE_FILE, readme);
    return true;
  } catch {
    return false;
  }
}

// ── an AI's draft into the form ──

export type ApplyResult = { ok: true; notes: string[] } | { ok: false; errors: string[] };

/**
 * Checks an AI's draft and puts it in this student's form (unsaved), marked as the AI's, with a
 * toast: [Review] [Discard]. `quiet`: no toast (the grade panel asked and shows it itself).
 */
export function applyAiDraftTo(gkey: string, roster: Roster, row: RosterRow, raw: unknown, source: { by: string; quiet?: boolean }): ApplyResult {
  if (!row.student) return { ok: false, errors: ["This row has no student."] };
  if (!roster.activity.can_grade) return { ok: false, errors: ["You can follow this activity, but only its teachers can grade it."] };
  const rubric = roster.activity.rubric;
  const check = validateAiDraft(raw, rubric, roster.activity.max_points);
  if (!check.ok) return check;
  const ai = check.draft;
  const dkey = draftKey(gkey, row.student.id);
  const pristine = draftFrom(roster, row);
  const stored = getDraft(dkey);
  const prev = useAiGrading.getState().meta[dkey];
  // A second AI draft replaces the first; Discard still goes back to the teacher's own form.
  const before = prev ? prev.before : (stored ?? null);
  const base = currentDraft(roster, gkey, row.student.id) ?? pristine;
  const next = mergeAiDraft(base, ai, rubric.length);
  putDraft(dkey, next, pristine, row.grade?.version ?? null);
  const by = ai.by ?? source.by;
  setMeta(dkey, { by, at: Date.now(), confidence: ai.confidence, teacher_notes: ai.teacher_notes, warnings: ai.warnings, notes: ai.notes, scores: ai.scores, comments: ai.comments, score: ai.score, feedback: ai.feedback, before });
  stopWatching(dkey);
  if (!source.quiet) {
    const name = row.student.name;
    notify("info", `${by} drafted grades for ${name}: review, adjust, then Save.`, [
      { label: "Review", run: () => revealGrade(gkey, row.student!.id) },
      { label: "Discard", run: () => discardAiDraft(dkey) },
    ], { kind: "result", replaceKey: `ai-draft:${dkey}` });
  }
  return { ok: true, notes: ai.notes };
}

/** Shows the grading tab on that student (the toast's Review). */
export function revealGrade(gkey: string, studentId: number) {
  selectStudent(gkey, studentId);
  openGrading(gkey, { toSide: true });
  setTimeout(() => document.querySelector<HTMLElement>('[data-testid="grade-ai-banner"]')?.focus(), 50);
}

/** A draft for the review folder open now (draft.json, the agent, an extension). */
export async function applyToReview(raw: unknown, source: { by: string; quiet?: boolean }): Promise<ApplyResult> {
  const review = useGrading.getState().review;
  if (!review) return { ok: false, errors: ["No submission is open for grading. Open the student's work from the grading tab first."] };
  const rr = await rosterAndRow(review);
  if (!rr) return { ok: false, errors: [`${review.student}'s row could not be loaded from Task Mentor.`] };
  return applyAiDraftTo(review.key, rr.roster, rr.row, raw, source);
}

// ── draft.json, written by any AI ──

let lastApplied = "";
let wired = false;

/** Watches `.tmcode/grading/draft.json` in the review folder. */
export function wireAiGrading() {
  if (wired) return;
  wired = true;
  // TMCode AI's agent: get_grading_context / propose_grade, and the chat's grading context.
  gradingTools.context = currentGradingContext;
  gradingTools.propose = (args) => applyToReview(args, { by: "TMCode AI" });
  gradingTools.chatContext = gradingChatContext;
  onExternalChanges((paths) => {
    if (paths.includes(DRAFT_FILE)) void onDraftFile();
  });
  // A new review folder: a draft.json left there from earlier is not news.
  let root = useWorkbench.getState().workspace?.root;
  useWorkbench.subscribe((s) => {
    if (s.workspace?.root === root) return;
    root = s.workspace?.root;
    lastApplied = "";
  });
}

async function readDraftFile(): Promise<string | null> {
  return getPlatform().fs.readFile(DRAFT_FILE).catch(() => null);
}

async function onDraftFile() {
  const review = useGrading.getState().review;
  if (!review) return;
  let raw = await readDraftFile();
  if (raw === null || !raw.trim() || raw === lastApplied) return;
  let parsed = parseDraftText(raw);
  // Written in pieces: the next read is complete.
  if (!parsed.ok) {
    await new Promise((r) => setTimeout(r, 700));
    raw = (await readDraftFile()) ?? raw;
    if (raw === lastApplied) return;
    parsed = parseDraftText(raw);
  }
  lastApplied = raw;
  const dkey = draftKey(review.key, review.student_id);
  const tool = useAiGrading.getState().watching[dkey]?.tool ?? "An AI tool";
  const by = parsed.ok && parsed.value && typeof parsed.value === "object" && typeof (parsed.value as { by?: unknown }).by === "string" ? String((parsed.value as { by: string }).by).slice(0, 80) : tool;
  const res = parsed.ok ? await applyToReview(parsed.value, { by }) : parsed;
  if (!res.ok) {
    notify("warning", `${by}'s grading draft for ${review.student} couldn't be used: ${res.errors.join(" ")} Nothing in the form changed.`, [{ label: "Open draft.json", run: () => openFile(DRAFT_FILE, { pinned: true }) }], {
      kind: "result",
      important: true,
      replaceKey: `ai-draft:${dkey}`,
    });
  }
}

/** e2e / tests: forget the last applied file. */
export function resetDraftWatch() {
  lastApplied = "";
}

// ── built-in "Draft with AI" (Task Mentor's ai-draft endpoint) ──

export type DraftRequestResult = { ok: true; by: string; notes: string[] } | { ok: false; code: string; error: string };

/** The body of POST …/ai-draft (mode and own key from TMCode AI's picker). */
export async function aiDraftBody(questionId: number | null, instructions: string, tests: TestsSummary | null) {
  return {
    ...(questionId ? { question_id: questionId } : {}),
    ...(await requestModeFields()),
    ...(instructions.trim() ? { instructions: instructions.trim().slice(0, 4000) } : {}),
    ...(tests ? { tests: { ...tests, ...(tests.summary ? { summary: tests.summary.slice(0, 4000) } : {}) } } : {}),
  };
}

/** Words for a refused or failed ai-draft request. */
export function draftErrorText(e: unknown): { code: string; error: string } {
  if (e instanceof AiRequestError) return { code: e.code, error: e.message };
  if (e instanceof TmError) {
    if (e.status === 404 && /^(NOT_FOUND|HTTP_404)$/.test(e.code)) return { code: "OLD_SERVER", error: "This Task Mentor can't draft grades with AI yet. Update Task Mentor, or use Claude Code or another AI tool from More Actions." };
    if (["AI_DISABLED", "EXAM_ACTIVE", "PREMIUM_REQUIRED", "BYOK_REJECTED"].includes(e.code)) {
      const a = aiErrorFromResponse(e.status, e.body);
      return { code: a.code, error: a.message };
    }
    if (e.status === 429) return { code: e.code, error: e.message || "No AI requests left today. Try another model, or tomorrow." };
    return { code: e.code, error: e.message };
  }
  return { code: "FAILED", error: String((e as Error)?.message ?? e) || "The AI draft failed. Try again." };
}

/** "Draft with AI": asks Task Mentor's AI for a draft and puts it in the form (nothing is saved). */
export async function requestAiDraft(gkey: string, row: RosterRow, instructions = ""): Promise<DraftRequestResult> {
  if (!row.student) return { ok: false, code: "NO_STUDENT", error: "Pick a student first." };
  const { type, id, question_id } = parseKey(gkey);
  const dkey = draftKey(gkey, row.student.id);
  const review = useGrading.getState().review;
  const reviewing = !!review && review.key === gkey && review.student_id === row.student.id;
  useAiGrading.setState((s) => ({ drafting: { ...s.drafting, [dkey]: true } }));
  try {
    const body = await aiDraftBody(question_id, instructions, reviewing ? reviewTestsSummary() : null);
    const res = await api<{ draft: Record<string, unknown> & { by?: string; model?: string } }>("POST", `/grading/${type}/${id}/students/${row.student.id}/ai-draft`, body);
    const roster = useGrading.getState().rosters[gkey] ?? (await loadRoster(gkey, { quiet: true }));
    const fresh = roster?.rows.find((r) => r.student?.id === row.student!.id) ?? row;
    if (!roster) return { ok: false, code: "NO_ROSTER", error: "The class list could not be loaded." };
    const by = typeof res.draft?.by === "string" && res.draft.by ? res.draft.by : `TMCode AI${res.draft?.model ? ` · ${res.draft.model}` : ""}`;
    const applied = applyAiDraftTo(gkey, roster, fresh, res.draft, { by, quiet: true });
    if (!applied.ok) return { ok: false, code: "INVALID_DRAFT", error: `The AI's draft couldn't be used: ${applied.errors.join(" ")}` };
    return { ok: true, by, notes: applied.notes };
  } catch (e) {
    return { ok: false, ...draftErrorText(e) };
  } finally {
    useAiGrading.setState((s) => {
      const drafting = { ...s.drafting };
      delete drafting[dkey];
      return { drafting };
    });
  }
}

// ── extensions (tmcode.grading.getContext / tmcode.grading.proposeDraft) ──

export async function extensionGetContext(): Promise<GradingContext | null> {
  return currentGradingContext();
}

export async function extensionProposeDraft(draft: unknown, by = "An extension"): Promise<{ ok: boolean; errors: string[] }> {
  let value = draft;
  if (typeof draft === "string") {
    const p = parseDraftText(draft);
    if (!p.ok) return { ok: false, errors: p.errors };
    value = p.value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["proposeDraft takes the draft object (rubric_scores, score, feedback, teacher_notes, confidence, by)."] };
  const res = await applyToReview(value, { by });
  return res.ok ? { ok: true, errors: [] } : { ok: false, errors: res.errors };
}

export { GRADING_DIR };
