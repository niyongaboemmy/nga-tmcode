import { z } from "zod";
import { normalizeAiMode, type AiMode } from "./policy";

/**
 * The three AI layers (vibe coding proposal §8): what AI may do, set as a ceiling.
 *
 * - **exam** ("off"): no AI at all; an exam session, or anything the school, teacher or role sets off;
 * - **learning** ("hints"): AI helps you think, you write every line (no code out, read-only tools);
 * - **industrial** ("full"): full AI. Students get the *Guided* profile (school-routed TMCode AI
 *   only, scaffolds on); staff, signed-out users and teacher-allowed students get *Open* (any tool).
 *
 * The wire value stays `off | hints | full` (AiModeSchema); these are the names people see.
 * The effective layer is the lowest of every ceiling that applies (§8.5): nobody can raise it
 * above a ceiling, anyone may lower their own.
 */

export const LayerSchema = z.enum(["exam", "learning", "industrial"]);
export type Layer = z.infer<typeof LayerSchema>;
export type AiProfile = "guided" | "open";

const RANK: Record<Layer, number> = { exam: 0, learning: 1, industrial: 2 };

export function layerOf(mode: unknown): Layer {
  const m = normalizeAiMode(mode);
  return m === "full" ? "industrial" : m === "hints" ? "learning" : "exam";
}

export function aiModeOf(layer: Layer): AiMode {
  return layer === "industrial" ? "full" : layer === "learning" ? "hints" : "off";
}

/** Any value as a Layer (unknown: null). */
export function parseLayer(v: unknown): Layer | null {
  return v === "exam" || v === "learning" || v === "industrial" ? v : null;
}

export const layerRank = (l: Layer) => RANK[l];
export const lowerOf = (a: Layer, b: Layer): Layer => (RANK[a] <= RANK[b] ? a : b);
export const atMost = (l: Layer, ceiling: Layer) => RANK[l] <= RANK[ceiling];

/** Where a ceiling comes from, in the order of §8.5 (earlier wins a tie). */
export type LayerCause = "exam-session" | "device" | "school" | "class" | "assignment" | "sticky" | "default" | "signed-out" | "choice";
export const LAYER_CAUSES: readonly LayerCause[] = ["exam-session", "device", "school", "class", "assignment", "sticky", "default", "signed-out", "choice"];

export interface LayerCeiling {
  layer: Layer;
  cause: LayerCause;
  /** Words for the badge's hover ("set by your teacher for Web Project 2"). */
  detail?: string;
}

export interface ResolvedLayer extends LayerCeiling {
  /** Every ceiling that applied, lowest first (for "why" in the badge). */
  ceilings: LayerCeiling[];
}

/** The lowest of the ceilings; with none at all, Industrial (an editor with nothing set is a plain editor with AI). */
export function resolveLayer(ceilings: readonly (LayerCeiling | null | undefined | false)[]): ResolvedLayer {
  const list = ceilings.filter((c): c is LayerCeiling => !!c && !!parseLayer(c.layer));
  const sorted = [...list].sort((a, b) => RANK[a.layer] - RANK[b.layer] || LAYER_CAUSES.indexOf(a.cause) - LAYER_CAUSES.indexOf(b.cause));
  const lowest = sorted[0] ?? { layer: "industrial" as const, cause: "default" as const };
  return { ...lowest, ceilings: sorted };
}

export interface ProfileInput {
  layer: Layer;
  /** A grader (teacher, admin): staff use AI like professionals. */
  staff: boolean;
  signedIn: boolean;
  /** The project belongs to an assignment or quiz. */
  assessment: boolean;
  /** The assignment's teacher allowed "students' own AI tools". */
  ownTools: boolean;
  /** The school's switch for students' third-party AI tools (personal projects). */
  schoolThirdParty: boolean;
  /** The device policy forces Guided (lab PCs). */
  forceGuided?: boolean;
  /** The user chose Guided while Open (it counts as lower). */
  choseGuided?: boolean;
}

/**
 * Guided or Open, decided by who the user is, after the layer (§8.0, §8.5). Only Industrial has a
 * profile; the others report "guided" (nothing third-party runs there either).
 */
export function decideProfile(i: ProfileInput): AiProfile {
  if (i.layer !== "industrial" || i.forceGuided || i.choseGuided) return "guided";
  if (!i.signedIn) return "open";
  if (i.staff) return "open";
  if (i.assessment) return i.ownTools ? "open" : "guided";
  return i.schoolThirdParty ? "open" : "guided";
}

export interface LayerInfo {
  /** "Exam", "Learning", "Industrial". */
  name: string;
  /** One line shown to users (§8.1). */
  line: string;
  /** Codicon. */
  icon: string;
  /** CSS colour token. */
  color: string;
}

export const LAYER_INFO: Record<Layer, LayerInfo> = {
  exam: { name: "No AI", line: "No AI. You're coding on your own.", icon: "lock", color: "var(--tm-layer-exam, #e5534b)" },
  learning: { name: "Learning", line: "AI helps you think. You write every line.", icon: "lightbulb", color: "var(--tm-layer-learning, #3b8eea)" },
  industrial: { name: "Industrial", line: "Full AI writes code with you.", icon: "sparkle", color: "var(--tm-layer-industrial, #a371f7)" },
};

export const PROFILE_LINE: Record<AiProfile, string> = {
  guided: "Full AI through your school's AI. Explain what you keep.",
  open: "Full AI: any tool, your way.",
};

/** The badge's name: "Exam" in an exam session, else "No AI"; "Industrial · Guided". */
export function layerName(layer: Layer, profile: AiProfile | null, examSession = false): string {
  if (layer === "exam") return examSession ? "Exam" : "No AI";
  if (layer === "industrial" && profile) return `Industrial · ${profile === "open" ? "Open" : "Guided"}`;
  return LAYER_INFO[layer].name;
}

// ── Learning's teacher knobs (§8.3) ──

export const HelpStrengthSchema = z.enum(["hints", "tutor"]);
export type HelpStrength = z.infer<typeof HelpStrengthSchema>;

export const LearningHelpSchema = z.object({
  /** Hints: questions and nudges. Tutor: adds explanations, error explanations, review comments. */
  strength: HelpStrengthSchema.default("tutor"),
  /** Pseudo-code in words ("loop over the list; keep the largest so far"). */
  pseudo: z.boolean().default(true),
  /** A tiny generic syntax example (≤ 2 lines, no project identifiers). Off by default (D5). */
  syntax: z.boolean().default(false),
  /** Question allowance (CS50 hearts, D6): at most `max`, one comes back every `regain_minutes`. */
  allowance: z.object({ max: z.number().int().min(1).max(100).default(10), regain_minutes: z.number().min(0.5).max(120).default(3) }).default({ max: 10, regain_minutes: 3 }),
});
export type LearningHelp = z.infer<typeof LearningHelpSchema>;
export const LEARNING_HELP_DEFAULT: LearningHelp = LearningHelpSchema.parse({});

// ── the managed device policy (A8) ──

/**
 * `/Library/Application Support/TMCode/policy.json`, `/etc/tmcode/policy.json` or
 * `C:\ProgramData\TMCode\policy.json`, written by school IT and read by the desktop app (Rust);
 * the user can't change it. Like Claude Code's managed settings, it can't be overridden.
 */
export const DevicePolicySchema = z.object({
  /** The layer when nobody is signed in (default Industrial). */
  signedOutLayer: LayerSchema.optional(),
  /** The highest layer on this machine, signed in or not. */
  maxLayer: LayerSchema.optional(),
  /** Industrial is always Guided here (lab PCs). */
  forceGuided: z.boolean().optional(),
  /** AI needs an NGA sign-in on this machine (signed out: No AI). */
  requireSignIn: z.boolean().optional(),
  /** Agent permission rules from IT (ai/agent/rules.ts syntax), applied before the school's. */
  rules: z.array(z.object({ rule: z.string().max(300), verdict: z.enum(["allow", "ask", "deny"]) })).max(200).optional(),
});
export type DevicePolicy = z.infer<typeof DevicePolicySchema>;

/** Any value as a device policy; unreadable parts are dropped (an empty policy changes nothing). */
export function parseDevicePolicy(raw: unknown): DevicePolicy | null {
  if (raw == null) return null;
  const r = DevicePolicySchema.safeParse(raw);
  if (r.success) return r.data;
  // Keep what is readable rather than dropping IT's whole file for one bad field.
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: DevicePolicy = {};
  const s = parseLayer(o.signedOutLayer);
  const m = parseLayer(o.maxLayer);
  if (s) out.signedOutLayer = s;
  if (m) out.maxLayer = m;
  if (typeof o.forceGuided === "boolean") out.forceGuided = o.forceGuided;
  if (typeof o.requireSignIn === "boolean") out.requireSignIn = o.requireSignIn;
  return out;
}

// ── the sticky signed assignment layer (A9) ──

/**
 * What Task Mentor signs for an assignment project (Ed25519): the layer travels with the work, so
 * signing out never raises it (§8.7). Kept in the project's `.tmcode/layer.json`.
 */
export const StickyLayerClaimsSchema = z.object({
  v: z.literal(1),
  project_id: z.number().int().positive(),
  ai_mode: z.enum(["off", "hints", "full"]),
  own_tools: z.boolean().default(false),
  /** ISO time it was issued and when it stops applying (due date + grace). */
  iat: z.string(),
  exp: z.string(),
  /** Which signing key (Task Mentor may rotate). */
  kid: z.string().max(40),
});
export type StickyLayerClaims = z.infer<typeof StickyLayerClaimsSchema>;

export const StickyLayerTokenSchema = z.object({
  /** base64url of the JSON claims (exactly the bytes signed). */
  claims: z.string().max(4000),
  /** base64url Ed25519 signature of `claims` (its ASCII bytes). */
  sig: z.string().max(200),
});
export type StickyLayerToken = z.infer<typeof StickyLayerTokenSchema>;
