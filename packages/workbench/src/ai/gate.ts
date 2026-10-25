import { normalizeAiMode, type AiMode } from "@tmcode/protocol";
import { useExam } from "../exam/state";
import { useWorkbench } from "../state/store";
import { useAi, type AiStatus } from "./service";

/**
 * Whether TMCode AI (chat, suggestions) and third-party AI tools (extensions such as Claude Code,
 * and AI CLIs in the terminal) may run right now: the one place every AI entry point asks
 * (AI usage control plan §6).
 *
 * - In an exam (or any locked-down policy) the exam package's `policy.ai` decides: only "full"
 *   turns TMCode AI on; third-party AI tools never run in exams.
 * - Outside exams Task Mentor's AI status for the open project decides (school switch, the
 *   teacher's setting for an assignment, the role). An older Task Mentor that sends no `allowed`
 *   is decided as before: on outside exams.
 * - A refusal Task Mentor just gave (403 AI_DISABLED, or the legacy EXAM_ACTIVE) locks too, until
 *   the next status.
 * - Status not known yet: TMCode AI shows (Task Mentor refuses if it must), but third-party AI tools
 *   stay off in a project linked to an assignment or quiz (they bypass Task Mentor).
 */

export type AiGateReason = "GLOBAL_OFF" | "APP_OFF" | "FEATURE_OFF" | "ASSESSMENT_LOCKED" | "TEACHER_OFF" | "HINTS_ONLY" | "EXAM_ACTIVE" | "ROLE_OFF" | (string & {});

export interface AiGate {
  /** TMCode AI chat and agent. */
  chat: boolean;
  /** Ghost-text suggestions. */
  complete: boolean;
  /** Third-party AI tools: extensions (Claude Code, Copilot…) and AI CLIs in the terminal. */
  thirdParty: boolean;
  /** Why something is off (null: nothing is). */
  reason: AiGateReason | null;
  /** Words for the lock screen (null: nothing is off). */
  message: string | null;
  /** Task Mentor's status (or the exam policy) decided; false while it is unknown. */
  known: boolean;
}

export interface AiGateInput {
  status: AiStatus | null;
  /** The last refusal from Task Mentor (cleared by the next status). */
  denied?: { reason: string; message?: string | null } | null;
  /** An exam session is running, or the policy is locked down. */
  exam: boolean;
  /** The exam policy's `ai` (exams only). */
  examAi?: AiMode | null;
  /** The open project is linked to an assignment or quiz. */
  assessmentProject?: boolean;
}

/** What each reason says when Task Mentor sends no words. */
export const AI_REASON_TEXT: Record<string, string> = {
  GLOBAL_OFF: "Your school has turned AI off.",
  APP_OFF: "Your school has turned AI off in TMCode.",
  FEATURE_OFF: "Your school has turned this AI feature off.",
  ASSESSMENT_LOCKED: "Your school has turned AI off for all quizzes and assignments.",
  TEACHER_OFF: "Your teacher turned AI off for this assignment.",
  HINTS_ONLY: "Hints only for this assignment: TMCode AI chat, suggestions and other AI tools are off.",
  EXAM_ACTIVE: "TMCode AI is off during exams.",
  ROLE_OFF: "AI isn't turned on for your account. Ask your school if you need it.",
};

export function aiReasonText(reason: string | null | undefined, message?: string | null): string {
  if (typeof message === "string" && message.trim()) return message.trim();
  return (reason && AI_REASON_TEXT[reason]) || "TMCode AI is off.";
}

const deny = (reason: string, message?: string | null, known = true): AiGate => ({ chat: false, complete: false, thirdParty: false, reason, message: aiReasonText(reason, message), known });

export function decideAiGate(i: AiGateInput): AiGate {
  const s = i.status;
  if (i.exam) {
    const mode = normalizeAiMode(i.examAi);
    if (mode === "hints") return deny("HINTS_ONLY", "Hints only in this exam: TMCode AI chat and suggestions are off.");
    if (mode !== "full") return deny("EXAM_ACTIVE");
    if (i.denied) return deny(i.denied.reason, i.denied.message);
    if (s && s.allowed === false) return deny(s.reason ?? "EXAM_ACTIVE", s.message);
    // The teacher chose full: TMCode AI only. Extensions and AI CLIs never run in exams.
    return { chat: s?.features?.assist ?? true, complete: s?.features?.complete ?? true, thirdParty: false, reason: null, message: null, known: true };
  }
  if (i.denied) return deny(i.denied.reason, i.denied.message);
  if (!s) {
    return i.assessmentProject
      ? { chat: true, complete: true, thirdParty: false, reason: null, message: null, known: false }
      : { chat: true, complete: true, thirdParty: true, reason: null, message: null, known: false };
  }
  if (typeof s.allowed !== "boolean") {
    // An older Task Mentor: exam-only gating, as before (it refuses itself during an exam session).
    if (s.exam) return deny("EXAM_ACTIVE");
    return { chat: true, complete: true, thirdParty: true, reason: null, message: null, known: true };
  }
  if (!s.allowed) return { ...deny(s.reason ?? "GLOBAL_OFF", s.message), thirdParty: false };
  const chat = s.features?.assist ?? true;
  const complete = s.features?.complete ?? true;
  const thirdParty = s.thirdPartyExtensions === true;
  if (chat && complete) return { chat, complete, thirdParty, reason: null, message: null, known: true };
  const reason = s.mode === "hints" ? "HINTS_ONLY" : s.reason && !/^ALLOWED/.test(s.reason) ? s.reason : "FEATURE_OFF";
  return { chat, complete, thirdParty, reason, message: aiReasonText(reason, s.reason === reason ? s.message : null), known: true };
}

/** In an exam session, or under a locked-down policy. */
export function aiExamActive(): boolean {
  return !!useExam.getState().quiz || useWorkbench.getState().policy.mode !== "practice";
}

/** The gate now, from the stores. */
export function aiGate(): AiGate {
  const a = useAi.getState();
  return decideAiGate({ status: a.status, denied: a.denied, exam: aiExamActive(), examAi: useWorkbench.getState().policy.ai, assessmentProject: a.project.assessment });
}

/** The gate as a React hook (re-renders when the status, exam or policy changes). */
export function useAiGate(): AiGate {
  const status = useAi((s) => s.status);
  const denied = useAi((s) => s.denied);
  const assessment = useAi((s) => s.project.assessment);
  const quiz = useExam((s) => !!s.quiz);
  const policy = useWorkbench((s) => s.policy);
  return decideAiGate({ status, denied, exam: quiz || policy.mode !== "practice", examAi: policy.ai, assessmentProject: assessment });
}

/** Why third-party AI tools (extensions, AI CLIs) are off, or null when they may run. */
export function thirdPartyMessage(gate: AiGate, exam = aiExamActive()): string | null {
  if (gate.thirdParty) return null;
  if (exam) return "AI tools and extensions are off during exams.";
  if (gate.message) return gate.message;
  if (!gate.known) return "Third-party AI tools stay off in assignment projects until Task Mentor confirms they're allowed.";
  return "Your school hasn't allowed third-party AI tools (Claude Code, Copilot, AI command-line tools).";
}
