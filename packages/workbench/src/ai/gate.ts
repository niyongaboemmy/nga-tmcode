import { atMost, decideProfile, layerName, normalizeAiMode, parseLayer, resolveLayer, type AiMode, type DevicePolicy, type Layer, type LayerCause, type LayerCeiling, type AiProfile } from "@tmcode/protocol";
import { useExam } from "../exam/state";
import { useWorkbench } from "../state/store";
import { useLayerInputs, type StickyLayer } from "./layerState";
import { useAi, type AiStatus } from "./service";

/**
 * Whether TMCode AI (chat, suggestions) and third-party AI tools (extensions such as Claude Code,
 * and AI CLIs in the terminal) may run right now: the one place every AI entry point asks
 * (AI usage control plan §6).
 *
 * - In an exam (or any locked-down policy) a status Task Mentor gave during the exam decides (it
 *   follows the quiz's AI setting and the school's policy as they are now, ai/live.ts); until there
 *   is one, the exam package's `policy.ai` does: only "full" turns TMCode AI on. Third-party AI
 *   tools never run in exams.
 * - Outside exams Task Mentor's AI status for the open project decides (school switch, the
 *   teacher's setting for an assignment, the role). An older Task Mentor that sends no `allowed`
 *   is decided as before: on outside exams.
 * - A refusal Task Mentor just gave (403 AI_DISABLED, or the legacy EXAM_ACTIVE) locks too, until
 *   the next status.
 * - Status not known yet: TMCode AI shows (Task Mentor refuses if it must), but third-party AI tools
 *   stay off in a project linked to an assignment or quiz (they bypass Task Mentor).
 *
 * On top of that sits the AI layer (vibe coding proposal §8, @tmcode/protocol layers.ts): Exam (no
 * AI), Learning (a tutor that writes no code: chat only, no suggestions, no edits, no NL→command,
 * no third-party AI) or Industrial (Guided for students: school AI only; Open for staff, signed-out
 * users and teacher-allowed students). The layer is the lowest of every ceiling (§8.5): the exam
 * session, the device policy, Task Mentor's status (school, class, teacher), the project's signed
 * sticky layer when no status speaks, and the user's own choice. A Task Mentor that knows layers
 * sends `layer`; an older one is read as before (hints = off).
 */

export type AiGateReason = "GLOBAL_OFF" | "APP_OFF" | "FEATURE_OFF" | "ASSESSMENT_LOCKED" | "TEACHER_OFF" | "HINTS_ONLY" | "EXAM_ACTIVE" | "ROLE_OFF" | (string & {});

export interface AiGate {
  /** TMCode AI chat and agent (in Learning: the tutor, read-only). */
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
  /** The AI layer now, and where it comes from. */
  layer: Layer;
  /** Industrial's profile (Exam and Learning report "guided": nothing third-party runs there). */
  profile: AiProfile;
  cause: LayerCause;
  /** Why, in words, for the badge ("Set by your teacher for this assignment."). */
  detail: string | null;
  /** The agent may change files (edit, write, rename, delete, run). False in Learning. */
  edit: boolean;
  /** Plain words → shell commands, and "Fix with AI" (Learning: "Explain this error" instead). */
  nlCommand: boolean;
  /** Code may be copied from the AI panel into the editor (Learning: blocked and logged). */
  copyCode: boolean;
  /** Answers come from the Learning tutor (no code). */
  tutor: boolean;
  /** A timed session whose AI isn't off: a timed task, not an exam (D9). */
  timedTask: boolean;
}

export interface AiGateInput {
  status: AiStatus | null;
  /** The last refusal from Task Mentor (cleared by the next status). */
  denied?: { reason: string; message?: string | null } | null;
  /** An exam session is running, or the policy is locked down. */
  exam: boolean;
  /** `status` was asked for during this exam (a status from before it can't speak for it). */
  statusInExam?: boolean;
  /** The exam policy's `ai` (exams only). */
  examAi?: AiMode | null;
  /** The open project is linked to an assignment or quiz. */
  assessmentProject?: boolean;
  /** Signed in to NGA (undefined/null: assume so, as before layers). */
  signedIn?: boolean | null;
  /** The managed device policy (A8). */
  device?: DevicePolicy | null;
  /** The project's verified sticky layer (A9): applies while no status speaks for the project. */
  sticky?: StickyLayer | null;
  /** The user's own lower layer for this project (P5), and "Guided" chosen while Open. */
  choice?: Layer | null;
  choseGuided?: boolean;
}

/** What each reason says when Task Mentor sends no words. */
export const AI_REASON_TEXT: Record<string, string> = {
  GLOBAL_OFF: "Your school has turned AI off.",
  APP_OFF: "Your school has turned AI off in TMCode.",
  FEATURE_OFF: "Your school has turned this AI feature off.",
  ASSESSMENT_LOCKED: "Your school has turned AI off for all quizzes and assignments.",
  TEACHER_OFF: "Your teacher turned AI off for this assignment.",
  HINTS_ONLY: "Hints only for this assignment: TMCode AI chat, suggestions and other AI tools are off.",
  DEVICE_POLICY: "AI is off on this computer (your school's device settings).",
  SIGN_IN_REQUIRED: "Sign in to NGA to use AI on this computer.",
  YOUR_CHOICE: "You turned AI off for this project.",
  EXAM_ACTIVE: "TMCode AI is off during exams.",
  ROLE_OFF: "AI isn't turned on for your account. Ask your school if you need it.",
};

export function aiReasonText(reason: string | null | undefined, message?: string | null): string {
  if (typeof message === "string" && message.trim()) return message.trim();
  return (reason && AI_REASON_TEXT[reason]) || "TMCode AI is off.";
}

/** Today's flags before the layer (the AI usage control rules, unchanged). */
type BaseGate = Pick<AiGate, "chat" | "complete" | "thirdParty" | "reason" | "message" | "known"> & { learning?: boolean };

const deny = (reason: string, message?: string | null, known = true): BaseGate => ({ chat: false, complete: false, thirdParty: false, reason, message: aiReasonText(reason, message), known });

/** A Task Mentor that knows layers says Learning (the tutor: chat on, suggestions off). */
const learningStatus = (s: AiStatus | null | undefined) => !!s && s.allowed === true && s.layer === "learning";

function decideBase(i: AiGateInput): BaseGate {
  const s = i.status;
  if (i.exam) {
    if (i.denied) return deny(i.denied.reason, i.denied.message);
    if (s && i.statusInExam && typeof s.allowed === "boolean") {
      if (!s.allowed) return deny(s.reason ?? "EXAM_ACTIVE", s.message);
      if (learningStatus(s)) return { chat: true, complete: false, thirdParty: false, reason: null, message: null, known: true, learning: true };
      const chat = s.features?.assist ?? true;
      const complete = s.features?.complete ?? true;
      if (!chat && !complete) return deny("HINTS_ONLY", s.mode === "hints" ? "Hints only in this exam: TMCode AI chat and suggestions are off." : s.message);
      return { chat, complete, thirdParty: false, reason: null, message: null, known: true };
    }
    const mode = normalizeAiMode(i.examAi);
    // A timed task (Learning): the tutor, until a status says otherwise (an older Task Mentor refuses).
    if (mode === "hints") return s && s.allowed === false ? deny(s.reason ?? "HINTS_ONLY", s.message) : { chat: true, complete: false, thirdParty: false, reason: null, message: null, known: true, learning: true };
    if (mode !== "full") return deny("EXAM_ACTIVE");
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
  if (learningStatus(s)) return { chat: true, complete: false, thirdParty: false, reason: null, message: null, known: true, learning: true };
  const chat = s.features?.assist ?? true;
  const complete = s.features?.complete ?? true;
  const thirdParty = s.thirdPartyExtensions === true;
  if (chat && complete) return { chat, complete, thirdParty, reason: null, message: null, known: true };
  const reason = s.mode === "hints" ? "HINTS_ONLY" : s.reason && !/^ALLOWED/.test(s.reason) ? s.reason : "FEATURE_OFF";
  return { chat, complete, thirdParty, reason, message: aiReasonText(reason, s.reason === reason ? s.message : null), known: true };
}

const LAYER_DETAIL: Record<LayerCause, string> = {
  "exam-session": "Set by the exam you're taking.",
  device: "Set by your school's settings on this computer.",
  school: "Set by your school.",
  class: "The highest your class may use.",
  assignment: "Set by your teacher for this assignment.",
  sticky: "Set by your teacher for this assignment (kept while you're signed out).",
  default: "The default for your account.",
  "signed-out": "You're not signed in to NGA: bring your own AI (your key, account or a local model).",
  choice: "You chose this for this project.",
};

const now = () => Date.now();

/** Which ceiling Task Mentor's answer is (for the badge's "why"). */
function causeOf(reason: string | null, s: AiStatus | null | undefined): LayerCause {
  if (reason === "TEACHER_OFF" || reason === "HINTS_ONLY" || s?.mode != null) return "assignment";
  if (reason === "GLOBAL_OFF" || reason === "APP_OFF" || reason === "FEATURE_OFF" || reason === "ASSESSMENT_LOCKED") return "school";
  return "default";
}

/** The AI gate: today's rules, then the layer as the lowest ceiling (§8.5), then what the layer allows. */
export function decideAiGate(i: AiGateInput): AiGate {
  const base = decideBase(i);
  const s = i.status;
  const signedIn = i.signedIn !== false;
  const device = i.device ?? null;
  const ceilings: (LayerCeiling | null)[] = [];

  // What Task Mentor (or the exam package) decided.
  const tmLayer: Layer = !base.chat && !base.complete ? "exam" : base.learning ? "learning" : "industrial";
  const fromStatus = !!s && typeof s.allowed === "boolean";
  const cause: LayerCause = i.exam ? "exam-session" : causeOf(base.reason, s);
  if (signedIn || i.exam) ceilings.push({ layer: tmLayer, cause, detail: base.message ?? undefined });

  // The server's class/role ceiling (MIS max_layer, sent as `max_layer`).
  const classMax = parseLayer(s?.max_layer);
  if (signedIn && classMax) ceilings.push({ layer: classMax, cause: "class" });

  if (device?.maxLayer) ceilings.push({ layer: device.maxLayer, cause: "device" });
  if (!signedIn) {
    if (device?.requireSignIn) ceilings.push({ layer: "exam", cause: "device", detail: AI_REASON_TEXT.SIGN_IN_REQUIRED });
    ceilings.push({ layer: device?.signedOutLayer ?? "industrial", cause: device?.signedOutLayer ? "device" : "signed-out" });
  }
  // The sticky layer speaks only where no status does (signed out, or not known yet).
  const sticky = i.sticky && Date.parse(i.sticky.exp) > now() ? i.sticky : null;
  if (sticky && (!signedIn || !fromStatus)) ceilings.push({ layer: sticky.layer, cause: "sticky" });
  if (i.choice) ceilings.push({ layer: i.choice, cause: "choice" });

  const r = resolveLayer(ceilings);
  const layer = r.layer;
  const timedTask = i.exam && layer !== "exam";
  const staff = s?.staff === true;
  // An older Task Mentor (no `allowed`) decided third-party tools alone, as before layers.
  const legacy = !!s && typeof s.allowed !== "boolean";
  const ownTools = sticky && !fromStatus ? sticky.ownTools : legacy || s?.own_tools === true;
  const profile = decideProfile({
    layer,
    staff,
    signedIn,
    assessment: !!i.assessmentProject || !!sticky,
    ownTools,
    // Before layers the school's switch alone opened third-party tools: it still does on personal projects.
    schoolThirdParty: base.thirdParty,
    forceGuided: device?.forceGuided,
    choseGuided: i.choseGuided,
  });

  const detail = r.detail ?? LAYER_DETAIL[r.cause];
  const common = { known: base.known, layer, profile, cause: r.cause, detail, timedTask } as const;
  if (layer === "exam") {
    const reason = base.reason ?? (r.cause === "device" ? (signedIn ? "DEVICE_POLICY" : device?.requireSignIn ? "SIGN_IN_REQUIRED" : "DEVICE_POLICY") : r.cause === "choice" ? "YOUR_CHOICE" : "GLOBAL_OFF");
    return { chat: false, complete: false, thirdParty: false, reason, message: base.message ?? aiReasonText(reason, r.detail), edit: false, nlCommand: false, copyCode: false, tutor: false, ...common };
  }
  if (layer === "learning") {
    // The tutor: words only. Signed out it needs a model of your own (the server filter can't apply).
    return { chat: true, complete: false, thirdParty: false, reason: null, message: null, edit: false, nlCommand: false, copyCode: false, tutor: true, ...common };
  }
  // Industrial. Signed out, TMCode AI has no school quota: your own keys, local models and AI tools.
  // Task Mentor's thirdPartyExtensions already follows the school's switches and the teacher's
  // "students' own AI tools"; the profile adds the device's and the user's Guided.
  const thirdParty = !i.exam && profile === "open" && (!signedIn || base.thirdParty);
  return { chat: base.chat, complete: base.complete, thirdParty, reason: base.reason, message: base.message, edit: base.chat, nlCommand: base.chat, copyCode: true, tutor: false, ...common };
}

/** "Learning", "Industrial · Guided", "Exam" (in an exam session), "No AI". */
export function gateLabel(g: Pick<AiGate, "layer" | "profile">, examSession = aiExamActive()): string {
  return layerName(g.layer, g.layer === "industrial" ? g.profile : null, examSession);
}

/** May the user choose `layer` here? Only ever lower (or the same). */
export const canChoose = (g: Pick<AiGate, "layer">, layer: Layer) => atMost(layer, g.layer);

/** In an exam session, or under a locked-down policy. */
export function aiExamActive(): boolean {
  return !!useExam.getState().quiz || useWorkbench.getState().policy.mode !== "practice";
}

/** The gate now, from the stores. */
export function aiGate(): AiGate {
  const a = useAi.getState();
  const l = useLayerInputs.getState();
  return decideAiGate({ status: a.status, statusInExam: a.statusInExam, denied: a.denied, exam: aiExamActive(), examAi: useWorkbench.getState().policy.ai, assessmentProject: a.project.assessment, signedIn: l.signedIn, device: l.device, sticky: l.sticky, choice: l.choice, choseGuided: l.choseGuided });
}

/** The gate as a React hook (re-renders when the status, exam or policy changes). */
export function useAiGate(): AiGate {
  const status = useAi((s) => s.status);
  const denied = useAi((s) => s.denied);
  const statusInExam = useAi((s) => s.statusInExam);
  const assessment = useAi((s) => s.project.assessment);
  const quiz = useExam((s) => !!s.quiz);
  const policy = useWorkbench((s) => s.policy);
  const l = useLayerInputs();
  return decideAiGate({ status, statusInExam, denied, exam: quiz || policy.mode !== "practice", examAi: policy.ai, assessmentProject: assessment, signedIn: l.signedIn, device: l.device, sticky: l.sticky, choice: l.choice, choseGuided: l.choseGuided });
}

/**
 * Exam: no AI UI at all (proposal A5, P2). In an exam session whose layer is Exam every AI entry
 * point is removed, not shown disabled: the terminal's ✨, Fix with AI, the editor's AI actions.
 */
export function aiUiHidden(g: Pick<AiGate, "layer"> = aiGate(), exam = aiExamActive()): boolean {
  return exam && g.layer === "exam";
}

export function useAiUiHidden(): boolean {
  const g = useAiGate();
  const quiz = useExam((s) => !!s.quiz);
  const locked = useWorkbench((s) => s.policy.mode !== "practice");
  return aiUiHidden(g, quiz || locked);
}

/** Why third-party AI tools (extensions, AI CLIs) are off, or null when they may run. */
export function thirdPartyMessage(gate: AiGate, exam = aiExamActive()): string | null {
  if (gate.thirdParty) return null;
  if (exam) return "AI tools and extensions are off during exams.";
  if (gate.layer === "learning") return "Learning: AI tools and extensions are off (they could write your code). TMCode AI's tutor helps instead.";
  if (gate.layer === "industrial" && gate.profile === "guided" && gate.known) return "Industrial · Guided: your school's TMCode AI only. Other third-party AI tools (Claude Code, Copilot, AI command-line tools) need your school's or your teacher's OK.";
  if (gate.message) return gate.message;
  if (!gate.known) return "Third-party AI tools stay off in assignment projects until Task Mentor confirms they're allowed.";
  return "Your school hasn't allowed third-party AI tools (Claude Code, Copilot, AI command-line tools).";
}
