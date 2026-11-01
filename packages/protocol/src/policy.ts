import { z } from "zod";

/** How locked-down a session is (plan §11.1). */
export const ModeSchema = z.enum(["practice", "monitored", "secure"]);
export type Mode = z.infer<typeof ModeSchema>;

/** How much help the editor gives (plan §6.2): language intelligence, not AI (that is `ai`). */
export const IntelligenceSchema = z.enum(["none", "basic", "diagnostics", "full"]);
export type Intelligence = z.infer<typeof IntelligenceSchema>;

/**
 * TMCode AI in a session (AI usage control plan §6.3): Task Mentor fills it from the quiz's
 * `ai_mode`, or "off" when the school's AI policy denies. The values are the three AI layers
 * (layers.ts): "off" = Exam (no AI), "hints" = Learning (a tutor that writes no code), "full" =
 * Industrial. A session whose `ai` isn't "off" is a timed task, not an exam (proposal D9).
 * Outside sessions Task Mentor's AI status decides.
 */
export const AiModeSchema = z.enum(["off", "hints", "full"]);
export type AiMode = z.infer<typeof AiModeSchema>;

/** Any value as an AiMode: unknown or missing (older Task Mentor) is "off". */
export function normalizeAiMode(m: unknown): AiMode {
  return m === "hints" || m === "full" ? m : "off";
}

export const PastePolicySchema = z.enum(["allow", "internal_only", "block"]);
export type PastePolicy = z.infer<typeof PastePolicySchema>;

export const TerminalPolicySchema = z.enum(["off", "restricted", "full"]);
export type TerminalPolicy = z.infer<typeof TerminalPolicySchema>;

export const PolicySchema = z.object({
  mode: ModeSchema,
  intelligence: IntelligenceSchema,
  paste: PastePolicySchema,
  terminal: TerminalPolicySchema,
  internet_in_preview: z.boolean(),
  require_seb: z.boolean(),
  allow_offline_grace_minutes: z.number().int().min(0).max(30),
  /** Settings the student may not change during the session. */
  locked_settings: z.array(z.string()).default([]),
  /** Run and Debug (breakpoints, stepping) in an exam. Off unless the teacher turns it on. */
  debugger: z.boolean().optional(),
  /** TMCode AI during the session. Older Task Mentor servers don't send it: off. */
  ai: z.preprocess(normalizeAiMode, AiModeSchema).default("off"),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Practice mode: everything a student may use on their own. */
export const PRACTICE_POLICY: Policy = {
  mode: "practice",
  intelligence: "full",
  paste: "allow",
  terminal: "full",
  internet_in_preview: true,
  require_seb: false,
  allow_offline_grace_minutes: 0,
  locked_settings: [],
  // Not forced on: outside exams Task Mentor's AI status (role, teacher, school) decides.
  ai: "off",
};

/** Defaults a teacher starts from when creating an exam (plan §10.1). */
export const EXAM_POLICY_DEFAULTS: Policy = {
  mode: "monitored",
  intelligence: "basic",
  paste: "internal_only",
  terminal: "off",
  internet_in_preview: false,
  require_seb: false,
  allow_offline_grace_minutes: 10,
  locked_settings: [],
  ai: "off",
};

/**
 * Whether the session may open a shell (terminal, REPL, run in terminal).
 * "restricted" has no restricted console yet, so it counts as off: a full
 * shell would let a student read or run anything on the computer.
 */
export function terminalAllowed(p: Pick<Policy, "terminal">): boolean {
  return p.terminal === "full";
}

/** Whether TMCode AI may run in a session with this policy (exams: only when the teacher chose "full"). */
export function examAiAllowed(p: Pick<Policy, "ai">): boolean {
  return normalizeAiMode(p.ai) === "full";
}
