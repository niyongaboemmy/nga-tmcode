import { create } from "zustand";
import { additions, completeness, examplesToTests, sameMeaning, similarity, cardAsPlan, type CoachResult, type IntentCard, type IntentLang } from "@tmcode/protocol";
import { recordActivity } from "../../activity/log";
import { getPlatform, notify, openFile, useWorkbench } from "../../state/store";
import { useProjects } from "../../projects/service";
import { aiExamActive, aiGate } from "../gate";
import { useAi } from "../service";
import { useLocalAi } from "../direct";
import { ask, type ChatMode, type ContextOptions } from "../chat";
import { decide, type CardStage, type Decision, type PolicyEnv, type PolicyInput, type Trigger } from "./policy";
import { failureText, fetchInterpretation, type Fetched } from "./client";
import { loadFade, nextFade, saveFade } from "./fading";

/**
 * The request interpreter's flow in the chat (prompt interpreter report, Q1–Q10): the policy
 * decides; the card (or Learning's coach) appears above the prompt box; the user confirms, edits,
 * sends their words as they are, or goes back to editing. Confirming hands the agent the user's
 * words plus the card (Q4). Every outcome is one Activity line (Q10); Guided's fading learns from
 * each confirmed card (Q7); an edit that didn't change what was understood is said plainly (Q9).
 */

export type Outcome = "accepted" | "edited" | "as-is" | "back" | "coached" | "failed";

export interface Pending {
  id: number;
  text: string;
  opts: ContextOptions;
  mode: ChatMode;
  decision: Extract<Decision, { run: true }>;
  status: "loading" | "ready" | "failed" | "notice";
  /** The card as the user is editing it. */
  card: IntentCard | null;
  /** The card as it arrived (what the user changed is measured against it). */
  received: IntentCard | null;
  coach: CoachResult | null;
  meta: { provider: string; model: string; ms: number } | null;
  /** Fields the user changed on the card. */
  edited: string[];
  /** Q9: the edit didn't change what was understood. */
  diffNote: string | null;
  /** Why it failed, or the notice shown instead (a Kinyarwanda request on a small model, Q5). */
  message: string | null;
  draftId: string;
  mentions: number;
  /** Agreement of the two samples when there were two (Q15). */
  agreed: boolean | null;
}

interface IntentState {
  pending: Pending | null;
  /** The last confirmed card (Q9 compares the next one with it). */
  last: IntentCard | null;
  /** Sent as-is this many times in a row (the gate stops offering at 2). */
  dismissStreak: number;
  /** Learning: the coach's checklist stays while the student rewrites. */
  checklist: CoachResult | null;
  /** A short note after a request went through unchecked. */
  note: string | null;
  /** The current draft (QD2: one free coach pass per draft). */
  draftId: string;
}

let seq = 0;
const newDraft = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const useIntent = create<IntentState>(() => ({ pending: null, last: null, dismissStreak: 0, checklist: null, note: null, draftId: newDraft() }));

/** ChatView registers how to put text back in the prompt box ("Edit my words"). */
let composer: ((text: string) => void) | null = null;
export function registerComposer(fn: ((text: string) => void) | null) {
  composer = fn;
}

const accountId = () => useProjects.getState().account?.user?.id ?? null;

/** A student: signed in, not staff, and the gate put them in Learning or Industrial · Guided. */
export function isStudent(): boolean {
  const s = useAi.getState().status;
  const g = aiGate();
  return !!useProjects.getState().account?.signed_in && s?.staff !== true && (g.layer === "learning" || (g.layer === "industrial" && g.profile === "guided"));
}

/** What the policy decides from (the stores, now). */
export function policyEnv(): PolicyEnv {
  const g = aiGate();
  const st = useAi.getState();
  const settings = useWorkbench.getState().settings;
  return {
    layer: g.layer,
    profile: g.profile,
    student: isStudent(),
    examActive: aiExamActive(),
    chatAllowed: g.chat,
    status: st.status?.interpreter ?? null,
    setting: settings["tmcodeAI.interpreter"] ?? "onDemand",
    localSetting: settings["tmcodeAI.interpreter.local"] === true,
    doubleCheck: settings["tmcodeAI.interpreter.doubleCheck"] === true,
    mode: st.mode,
    signedIn: !!useProjects.getState().account?.signed_in,
    localAvailable: useLocalAi.getState().models.length > 0,
    dismissStreak: useIntent.getState().dismissStreak,
    fadingStage: loadFade(accountId()).stage,
  };
}

/**
 * Called by the prompt box before a request goes to the AI. True: the interpreter took the request
 * (the card or a notice is showing; don't send). False: send it as usual.
 */
export function interceptRequest(text: string, opts: ContextOptions, mode: ChatMode, input: Omit<PolicyInput, "text" | "trigger">, trigger: Trigger = "send"): boolean {
  if (useIntent.getState().pending) return true;
  const d = decide({ text, trigger, ...input }, policyEnv());
  if (!d.run) {
    if (d.notice && (trigger === "manual" || d.reason === "rw-local")) {
      useIntent.setState({ pending: notice(text, opts, mode, d.notice, input.mentions) });
      return true;
    }
    if (trigger === "manual" && !d.notice) notify("info", reasonText(d.reason));
    return false;
  }
  void begin(text, opts, mode, d, input.mentions);
  return true;
}

function reasonText(reason: string): string {
  return (
    {
      exam: "No AI in exams, so there is no request check either.",
      holdout: "The request check isn't part of your TMCode AI for now.",
      "teacher-off": "Your teacher turned the request check off for this work.",
      unavailable: "The request check isn't available right now.",
      cli: "With your AI account, requests are checked with a local model.",
    }[reason] ?? "There's nothing to check in this request."
  );
}

function notice(text: string, opts: ContextOptions, mode: ChatMode, message: string, mentions: number): Pending {
  return { id: ++seq, text, opts, mode, decision: { run: true, kind: "card", stage: "full", route: "school", language: "en", samples: 1, reasons: [], mustFill: false }, status: "notice", card: null, received: null, coach: null, meta: null, edited: [], diffNote: null, message, draftId: useIntent.getState().draftId, mentions, agreed: null };
}

async function begin(text: string, opts: ContextOptions, mode: ChatMode, d: Extract<Decision, { run: true }>, mentions: number) {
  const id = ++seq;
  const draftId = useIntent.getState().draftId;
  useIntent.setState({ pending: { id, text, opts, mode, decision: d, status: "loading", card: null, received: null, coach: null, meta: null, edited: [], diffNote: null, message: null, draftId, mentions, agreed: null }, note: null });
  let got: Fetched;
  try {
    got = await fetchInterpretation(text, d, { draftId, guided: d.mustFill || d.stage !== "full" });
  } catch (e) {
    if (useIntent.getState().pending?.id !== id) return;
    // Never blocks: an automatic check that fails sends the words; one the user asked for says why.
    if (d.reasons.includes("asked")) {
      useIntent.setState((s) => ({ pending: s.pending && { ...s.pending, status: "failed", message: failureText(e) } }));
      return;
    }
    record("failed", useIntent.getState().pending!, null, failureText(e));
    useIntent.setState({ pending: null, note: failureText(e) });
    void ask(text, opts, mode);
    return;
  }
  const p = useIntent.getState().pending;
  if (!p || p.id !== id) return;
  if (got.allowance) useAi.setState((s) => ({ status: s.status && s.status.learning ? { ...s.status, learning: { ...s.status.learning, allowance: got.allowance! } } : s.status }));
  let diffNote: string | null = null;
  const last = useIntent.getState().last;
  if (got.card && last && last.original.trim() !== text.trim() && similarity(last.original, text) >= 0.3 && sameMeaning(last, got.card)) {
    diffNote = "Your change didn't change what I understood. Try adding an example of what should happen.";
    recordActivity({ kind: "ai", action: "understood-diff", text: "TMCode noticed an edited request that meant the same as before", data: { language: got.card.language }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "request check: same meaning after an edit" } });
  }
  // Hint mode (Guided): the interpreter's own additions are hidden; the student fills the gaps.
  let card = got.card ?? null;
  if (card && d.stage === "hint") card = { ...card, examples: card.examples.filter((e) => e.by === "you"), edge_cases: card.edge_cases.filter((e) => e.by === "you"), assumptions: [] };
  useIntent.setState({ pending: { ...p, status: "ready", card, received: got.card ?? null, coach: got.coach ?? null, meta: { provider: got.provider, model: got.model, ms: got.ms }, diffNote, agreed: got.agreed ?? null } });
}

/** Changes the card being confirmed; `field` names what the user changed (for the log and fading). */
export function editCard(field: string, fn: (c: IntentCard) => IntentCard) {
  useIntent.setState((s) => {
    const p = s.pending;
    if (!p?.card) return s;
    return { pending: { ...p, card: fn(p.card), edited: p.edited.includes(field) ? p.edited : [...p.edited, field] } };
  });
}

/** Guided's "your turn" (Q7): the student added one example or unusual case themselves. */
export function studentContributed(card: IntentCard | null, received: IntentCard | null): boolean {
  if (!card) return false;
  if (card.examples.some((e) => e.by === "you" && e.output.trim()) || card.edge_cases.some((e) => e.by === "you")) return true;
  // A blank "you decide" output the student filled in.
  return card.examples.some((e, i) => !!e.output.trim() && received?.examples[i] && !received.examples[i].output.trim());
}

/** "Yes, do this": the agent receives the words (authoritative) plus the confirmed card. */
export function confirmCard() {
  const p = useIntent.getState().pending;
  if (!p?.card || p.status !== "ready") return;
  const card = p.card;
  const outcome: Outcome = p.edited.length ? "edited" : "accepted";
  record(outcome, p, card);
  updateFading(p, card);
  useIntent.setState({ pending: null, last: card, dismissStreak: 0, checklist: null, draftId: newDraft() });
  void ask(card.original, p.opts, p.mode, { intent: card });
}

/** "Send my words as they are": no card goes along. */
export function sendAsIs() {
  const p = useIntent.getState().pending;
  if (!p) return;
  record(p.coach ? "coached" : "as-is", p, null);
  useIntent.setState((s) => ({ pending: null, dismissStreak: s.dismissStreak + 1, checklist: null, draftId: newDraft() }));
  void ask(p.text, p.opts, p.mode);
}

/** "Edit my words": back to the prompt box with the text (Learning: the coach's checklist stays). */
export function backToEditing() {
  const p = useIntent.getState().pending;
  if (!p) return;
  if (p.status === "ready") record(p.coach ? "coached" : "back", p, null);
  useIntent.setState({ pending: null, checklist: p.coach ?? null });
  composer?.(p.text);
}

/** Learning: closes the coach's checklist. */
export function dismissChecklist() {
  useIntent.setState({ checklist: null });
}

/** Save as Plan (B1) from the card. */
export async function saveCardAsPlan() {
  const card = useIntent.getState().pending?.card;
  if (!card) return;
  const fs = getPlatform().fs;
  await fs.createDir(".tmcode").catch(() => undefined);
  await fs.createDir(".tmcode/plan").catch(() => undefined);
  const path = ".tmcode/plan/PLAN.md";
  await fs.writeFile(path, cardAsPlan(card));
  recordActivity({ kind: "ai", action: "plan", path, text: `Saved the checked request as ${path}`, actor: { type: "you" }, ai: { by: "TMCode AI", how: "request check saved as a plan" } });
  openFile(path, { pinned: true });
}

/** Q12: the examples the user ticked ✓ become a test file next to the target. */
export async function saveExamplesAsTests(): Promise<string | null> {
  const card = useIntent.getState().pending?.card;
  if (!card) return null;
  const t = examplesToTests(card.examples, card.targets.find((x) => /\.(py|m?[jt]sx?|cjs)$/.test(x)) ?? null);
  if (!t) {
    notify("info", "Tick ✓ an example written as a call with a value (like average([1, 2]) → 1.5) on a Python or JavaScript file to save it as a test.");
    return null;
  }
  const fs = getPlatform().fs;
  const exists = await fs.readFile(t.path).then(() => true).catch(() => false);
  if (exists) {
    notify("warning", `${t.path} already exists; TMCode didn't overwrite it.`);
    return null;
  }
  await fs.writeFile(t.path, t.content);
  editCard("tests", (c) => ({ ...c, acceptance_checks: [...new Set([...c.acceptance_checks, `The tests in ${t.path} pass`])].slice(0, 6) }));
  recordActivity({ kind: "ai", action: "intent-tests", path: t.path, text: `Saved the confirmed examples as tests: ${t.path}`, actor: { type: "you" }, ai: { by: "TMCode AI", how: "confirmed examples saved as tests" } });
  openFile(t.path, { pinned: true });
  return t.path;
}

// ── evidence: the Activity line (Q10) and Guided's fading (Q7) ──

function record(outcome: Outcome, p: Pending, card: IntentCard | null, why?: string) {
  const st = useAi.getState().status?.interpreter;
  const showText = !!st?.show_prompts || !isStudent();
  const c = card ?? p.received;
  const comp = c ? completeness(c, p.mentions) : p.coach ? coachCompleteness(p.coach) : null;
  const words: Record<Outcome, string> = { accepted: "confirmed as understood", edited: `confirmed after editing ${p.edited.join(", ")}`, "as-is": "sent the words as they were", back: "went back to editing", coached: "coached before asking the tutor", failed: why ?? "couldn't be checked" };
  recordActivity({
    kind: "ai",
    action: p.coach ? "intent-coach" : "intent",
    text: `Request check (${p.coach ? "Learning coach" : stageName(p.decision.stage)}): ${words[outcome]}${comp ? ` · ${Math.round(comp.score * 100)}% complete` : ""}`,
    data: {
      outcome,
      ...(comp ? { completeness: comp.score, supplied: comp.have.join(", ") } : {}),
      ...(p.edited.length ? { edited: p.edited.join(", ") } : {}),
      stage: p.coach ? "coach" : p.decision.stage,
      language: (c?.language ?? p.decision.language) as IntentLang,
      ...(p.meta ? { ms: p.meta.ms, model: `${p.meta.provider} · ${p.meta.model}` } : {}),
      ...(st ? { arm: st.arm } : {}),
      route: p.decision.route,
      ...(c ? { questions: c.open_questions.length, examples_confirmed: c.examples.filter((e) => e.verdict === "yes").length, assumptions_removed: c.assumptions.filter((a) => a.keep === false).length } : {}),
      ...(p.coach ? { missing: p.coach.missing.map((m) => m.id).join(", ") } : {}),
      ...(showText ? { request: p.text.slice(0, 500) } : {}),
    },
    actor: { type: "you" },
    ai: { by: "TMCode AI", how: p.coach ? "request check: Learning coach" : `request check: ${outcome}`, ...(p.meta ? { model: `${p.meta.provider} · ${p.meta.model}` } : {}) },
  });
}

export function stageName(s: CardStage): string {
  return s === "full" ? "full card" : s === "hint" ? "hints" : "summary";
}

/** The coach's view of completeness: the six items minus what it found missing. */
export function coachCompleteness(c: CoachResult): { score: number; have: string[]; missing: string[] } {
  const all: string[] = ["goal", "inputs", "outputs", "example", "edge_case", "target"];
  const missing: string[] = c.missing.map((m) => m.id as string).filter((x) => all.includes(x));
  const have = all.filter((x) => !missing.includes(x));
  return { score: Math.round((have.length / all.length) * 100) / 100, have, missing };
}

function updateFading(p: Pending, card: IntentCard) {
  if (!isStudent() || p.decision.kind !== "card" || aiGate().profile !== "guided") return;
  const st = useAi.getState().status?.interpreter;
  if (st && st.stage !== "auto") return;
  const acc = accountId();
  const before = loadFade(acc);
  const after = nextFade(before, { additions: additions(card), completeness: completeness(card, p.mentions).score, at: Date.now() });
  saveFade(acc, after);
  if (after.stage !== before.stage) {
    const up = ["full", "hint", "strip"].indexOf(after.stage) > ["full", "hint", "strip"].indexOf(before.stage);
    notify("info", up ? (after.stage === "hint" ? "Your requests are clear: TMCode now shows only what's missing, and you fill it in." : "Your requests say it all: TMCode now just confirms what it understood.") : "TMCode shows the full check again for a while, to help with the details.");
    recordActivity({ kind: "ai", action: "intent-fade", text: `Request check moved to ${stageName(after.stage)} (${up ? "requests complete" : "more help"})`, data: { from: before.stage, to: after.stage }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "request check fading" } });
  }
}

/** For tests: forget the session state. */
export function resetIntent() {
  useIntent.setState({ pending: null, last: null, dismissStreak: 0, checklist: null, note: null, draftId: newDraft() });
}
