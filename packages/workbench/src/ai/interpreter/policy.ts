import { hasKinyarwanda, intentSignals, isMixed, type IntentLang } from "@tmcode/protocol";
import type { InterpreterStatus } from "../service";

/**
 * When the request interpreter runs, in which form, and where (prompt interpreter report,
 * "When it runs and when it skips"). Skipping is the default and the interpreter never blocks:
 *
 *   0. hard skip   Exam; the student's A/B holdout; the teacher's "off"; slash recipes with their
 *                  arguments; follow-ups inside a task; a pasted error with "fix"; the user's
 *                  "never" (Open); dismissed twice in a row this session
 *   1. offer       first message of a task in Guided or Learning; Kinyarwanda or mixed requests;
 *                  entering Plan mode; no file, symbol or example named
 *   2. score       vague, very short or long, several goals, no input/output, "it" with nothing open
 *   3. interpret   the card (Industrial), the coach (Learning), or a one-line strip (faded)
 *
 * Industrial · Open (staff, signed-out, own tools) is on demand: ✨ / ⌘⇧Enter, auto-suggested only
 * for Kinyarwanda or mixed requests or a very high score. Pure: the inputs come from env.ts.
 */

export type Trigger = "send" | "manual";
export type CardStage = "full" | "hint" | "strip";
export type Route = "school" | "local" | "direct";

export interface PolicyInput {
  text: string;
  trigger: Trigger;
  /** No earlier message in this chat (a new task). */
  firstOfTask: boolean;
  /** A slash recipe with its arguments (/add-form contact). */
  recipeWithArgs: boolean;
  /** Plan mode chosen for this request. */
  planEntry: boolean;
  mentions: number;
  openFile: boolean;
}

export interface PolicyEnv {
  /** The AI layer and profile (gate.ts). */
  layer: "exam" | "learning" | "industrial";
  profile: "guided" | "open";
  /** A student (not staff, signed in, in an assignment). */
  student: boolean;
  examActive: boolean;
  chatAllowed: boolean;
  /** Task Mentor's interpreter block (null: an older server). */
  status: InterpreterStatus | null;
  setting: "auto" | "onDemand" | "never";
  localSetting: boolean;
  doubleCheck: boolean;
  /** "free", "auto", "premium:…", "byok:…", "local:…", "cli:…". */
  mode: string;
  signedIn: boolean;
  /** A local model was found (Ollama, LM Studio). */
  localAvailable: boolean;
  /** The user sent their words as-is this many times in a row this session. */
  dismissStreak: number;
  /** Guided's fading stage (fading.ts). */
  fadingStage: CardStage;
}

export type Decision =
  | { run: false; reason: string; notice?: string }
  | { run: true; kind: "card" | "coach"; stage: CardStage; route: Route; language: IntentLang; samples: 1 | 2; reasons: string[]; mustFill: boolean };

const PASTED_FIX = /^\s*(please\s+)?(fix|kosora|corrige)\b[\s\S]{0,40}$/i;

/** Should the interpreter run for this request, and how? */
export function decide(input: PolicyInput, env: PolicyEnv): Decision {
  const manual = input.trigger === "manual";
  if (env.examActive || env.layer === "exam" || !env.chatAllowed) return { run: false, reason: "exam" };
  const st = env.status;
  if (env.student && st?.arm === "holdout") return { run: false, reason: "holdout" };
  if (env.student && st?.stage === "off") return { run: false, reason: "teacher-off" };
  const sig = intentSignals(input.text, { openFile: input.openFile, mentions: input.mentions });
  const language = sig.language;
  const rw = hasKinyarwanda(language) || isMixed(language);
  const learning = env.layer === "learning";
  const guidedStudent = env.student && !learning && env.profile === "guided";
  const open = !learning && !guidedStudent;

  // Where it would run (QD10: AI CLI accounts never use the school's quota; Q5: no Kinyarwanda to a small model).
  const cli = env.mode.startsWith("cli:");
  const localMode = env.mode.startsWith("local:");
  const ownKeyOut = !env.signedIn && env.mode.startsWith("byok:");
  let route: Route = "school";
  if (cli || localMode || (env.localSetting && !rw)) route = env.localAvailable ? "local" : "school";
  if (ownKeyOut) route = "direct";
  if (route === "local" && rw) route = "school";
  if (cli && route === "school") {
    return manual ? { run: false, reason: "cli-needs-local", notice: "With your AI account (Claude Code, Codex, Gemini CLI), TMCode checks requests with a local model so it never spends the school's AI. Start Ollama or LM Studio, or switch to the school's AI." } : { run: false, reason: "cli" };
  }
  if (route === "school" && !env.signedIn) {
    if (rw && (localMode || ownKeyOut)) return { run: false, reason: "rw-local", notice: "Small local models don't understand Kinyarwanda well. Sign in to use the school's AI for this request, or write it in English or French." };
    return manual ? { run: false, reason: "signed-out", notice: "Checking requests needs the school's AI (sign in), your own key or a local model." } : { run: false, reason: "signed-out" };
  }
  if (route === "school" && st && !st.available) return { run: false, reason: "unavailable" };

  if (!manual) {
    if (open && env.setting === "never") return { run: false, reason: "never" };
    if (input.recipeWithArgs) return { run: false, reason: "recipe" };
    if (!input.firstOfTask && !rw) return { run: false, reason: "follow-up" };
    if (PASTED_FIX.test(input.text.replace(/```[\s\S]*?```/g, "").trim()) && /```/.test(input.text)) return { run: false, reason: "pasted-error" };
    if (env.dismissStreak >= 2 && !rw) return { run: false, reason: "dismissed" };
    if (open) {
      // On demand, except Kinyarwanda / mixed requests and very unclear ones (or the user's "auto").
      const auto = env.setting === "auto" ? sig.score >= 3 || input.firstOfTask : false;
      if (!(rw || sig.score >= 4 || auto)) return { run: false, reason: "on-demand" };
    } else {
      const offer = input.firstOfTask || input.planEntry || rw || (input.mentions === 0 && sig.reasons.includes("no input/output") && sig.score >= 2);
      if (!offer && sig.score < 3) return { run: false, reason: "clear" };
    }
  }
  const pinned = env.student && st && st.stage !== "auto" && st.stage !== "off" ? (st.stage as CardStage) : null;
  const stage: CardStage = learning ? "full" : guidedStudent ? (pinned ?? env.fadingStage) : "full";
  const samples: 1 | 2 = route === "school" && (env.doubleCheck || /^(premium|byok):/.test(env.mode)) ? 2 : 1;
  return { run: true, kind: learning ? "coach" : "card", stage, route, language, samples, reasons: [...sig.reasons, ...(rw ? ["language"] : []), ...(manual ? ["asked"] : [])], mustFill: guidedStudent && stage === "full" };
}
