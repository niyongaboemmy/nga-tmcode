import { z } from "zod";

/** How locked-down a session is (plan §11.1). */
export const ModeSchema = z.enum(["practice", "monitored", "secure"]);
export type Mode = z.infer<typeof ModeSchema>;

/** How much help the editor gives (plan §6.2). AI completion is never an option. */
export const IntelligenceSchema = z.enum(["none", "basic", "diagnostics", "full"]);
export type Intelligence = z.infer<typeof IntelligenceSchema>;

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
};
