import { layerName, parseDevicePolicy, parseLayer, type Layer } from "@tmcode/protocol";
import { recordActivity } from "../activity/log";
import { useExam } from "../exam/state";
import { useProjects } from "../projects/service";
import { getPlatform, notify, useWorkbench } from "../state/store";
import { aiExamActive, aiGate, aiUiHidden, type AiGate } from "./gate";
import { useLayerInputs } from "./layerState";
import { useAi } from "./service";
import { LAYER_FILE, stickyFileText, verifySticky } from "./sticky";

/**
 * Feeds the AI layer's inputs (ai/layerState.ts) and acts on its changes (proposal §8.5–§8.8):
 *
 * - the NGA sign-in (signed out: Industrial · Open, bring your own AI);
 * - the managed device policy (A8), read at start and when TMCode comes back to the front;
 * - the open project's signed sticky layer (A9): Task Mentor's `layer_token` is kept in
 *   `.tmcode/layer.json` and checked on open, so signing out never raises an assignment's layer;
 * - the user's own lower layer per project (P5), remembered;
 * - every change of layer is logged with its cause; entering Exam or Learning stops what that
 *   layer doesn't allow (a running agent answer, AI tools; ghost text is never offered).
 */

const CHOICE_KEY = "tmcodeAI.layerChoice";

/** The key a choice is remembered under: the Task Mentor project, else the folder. */
function projectKey(): string {
  const b = useProjects.getState().binding;
  if (b?.project_id) return `tm:${b.project_id}`;
  return `folder:${useWorkbench.getState().workspace?.root ?? ""}`;
}

let choices: Record<string, { layer: Layer | null; guided: boolean }> = {};

function applyChoice() {
  const c = choices[projectKey()];
  useLayerInputs.setState({ choice: c?.layer ?? null, choseGuided: !!c?.guided });
}

/** Lower the layer for this project (null: back to what's set for you). Never raises it. */
export function chooseLayer(layer: Layer | null) {
  const key = projectKey();
  choices = { ...choices, [key]: { layer, guided: choices[key]?.guided ?? false } };
  void getPlatform().store.set(CHOICE_KEY, choices);
  applyChoice();
}

/** Industrial · Open → Guided by choice (scaffolds on, school AI only), or back. */
export function chooseGuided(guided: boolean) {
  const key = projectKey();
  choices = { ...choices, [key]: { layer: choices[key]?.layer ?? null, guided } };
  void getPlatform().store.set(CHOICE_KEY, choices);
  applyChoice();
}

function syncSignIn() {
  const p = useProjects.getState();
  const hasAccount = (() => {
    try {
      return !!getPlatform().account;
    } catch {
      return false;
    }
  })();
  // Not known yet (the account is still loading): null, so nothing flips at start-up.
  const signedIn = !hasAccount ? false : p.account == null ? null : !!p.account.signed_in;
  if (useLayerInputs.getState().signedIn !== signedIn) useLayerInputs.setState({ signedIn });
}

export async function loadDevicePolicy() {
  let raw: unknown = null;
  try {
    raw = (await getPlatform().devicePolicy?.()) ?? null;
  } catch (e) {
    notify("warning", String((e as Error)?.message ?? e));
  }
  const device = parseDevicePolicy(raw);
  const was = JSON.stringify(useLayerInputs.getState().device);
  if (JSON.stringify(device) !== was) useLayerInputs.setState({ device });
}

let stickyFor: string | null = null;

/** Reads and checks the open project's `.tmcode/layer.json`. */
export async function loadSticky() {
  const b = useProjects.getState().binding;
  const key = b?.kind === "tm" ? `${b.project_id}` : null;
  stickyFor = key;
  if (!b || b.kind !== "tm") return useLayerInputs.setState({ sticky: null });
  const text = await getPlatform()
    .fs.readFile(LAYER_FILE)
    .catch(() => null);
  if (stickyFor !== key) return;
  if (text === null) return useLayerInputs.setState({ sticky: null });
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const r = await verifySticky(raw, b.project_id);
  if (stickyFor !== key) return;
  if (r.ok) return useLayerInputs.setState({ sticky: r.sticky });
  useLayerInputs.setState({ sticky: null });
  if (r.why === "signature" || r.why === "malformed" || r.why === "project") {
    // Evidence (§8.7): the teacher sees that the layer record was changed or removed.
    recordActivity({ kind: "project", action: "layer-record-invalid", text: `The AI layer record of this assignment (${LAYER_FILE}) failed its check (${r.why}); it doesn't count`, data: { why: r.why }, actor: { type: "you" } });
  }
}

let lastToken = "";

/** Task Mentor sent a signed layer for the open project: keep it in the project folder. */
async function keepToken() {
  const { status, statusFor } = useAi.getState();
  const b = useProjects.getState().binding;
  const token = status?.layer_token;
  if (!token || !b || b.kind !== "tm" || statusFor !== b.project_id) return;
  const text = stickyFileText(token);
  if (text === lastToken) return;
  lastToken = text;
  const fs = getPlatform().fs;
  const now = await fs.readFile(LAYER_FILE).catch(() => null);
  if (now !== text) {
    await fs.createDir(".tmcode").catch(() => undefined);
    await fs.writeFile(LAYER_FILE, text).catch(() => undefined);
  }
  const r = await verifySticky(token, b.project_id);
  if (r.ok) useLayerInputs.setState({ sticky: r.sticky });
}

const describe = (g: AiGate) => `${layerName(g.layer, g.layer === "industrial" ? g.profile : null, aiExamActive())}`;

let lastGate: AiGate | null = null;

let examAiOff: boolean | null = null;

/** Logs a change of layer and stops what the new layer doesn't allow. */
async function onGateChange() {
  const g = aiGate();
  const prev = lastGate;
  lastGate = g;
  // Exam: no AI request leaves the machine, only "is AI allowed now?" (A5, account.rs).
  const off = aiUiHidden(g);
  if (off !== examAiOff) {
    examAiOff = off;
    getPlatform().setExamAiOff?.(off);
  }
  if (!prev || (prev.layer === g.layer && prev.profile === g.profile)) return;
  recordActivity({
    kind: "ai",
    action: "layer",
    text: `AI layer: ${describe(prev)} → ${describe(g)}${g.detail ? ` (${g.detail.replace(/\.$/, "")})` : ""}`,
    data: { from: prev.layer, to: g.layer, profile: g.profile, cause: g.cause },
    ...(g.cause === "choice" ? { actor: { type: "you" as const } } : {}),
  });
  if (g.layer === "industrial" && prev.layer === "industrial") return;
  const chat = await import("./chat");
  if (g.layer === "exam" && prev.layer !== "exam") {
    // Into Exam: AI views close (they render nothing), a running answer stops; files stay as they are.
    if (chat.useChat.getState().busy) chat.stopAnswer();
    notify("info", aiExamActive() ? "Exam: AI is off. Your files stay as they are." : `No AI: ${g.message ?? g.detail ?? "AI is off here."}`);
  } else if (g.layer === "learning" && prev.layer === "industrial") {
    if (chat.useChat.getState().busy) chat.stopAnswer();
    notify("info", "Learning: TMCode AI is now your tutor. It helps you think; you write every line.");
  }
}

let wired = false;

export function wireLayers() {
  if (wired) return;
  wired = true;
  void getPlatform()
    .store.get<typeof choices>(CHOICE_KEY)
    .then((c) => {
      choices = c && typeof c === "object" ? c : {};
      for (const k of Object.keys(choices)) if (choices[k].layer !== null && !parseLayer(choices[k].layer)) delete choices[k];
      applyChoice();
    })
    .catch(() => undefined);
  syncSignIn();
  void loadDevicePolicy();
  void loadSticky();
  useProjects.subscribe((s, prev) => {
    if (s.account !== prev.account) syncSignIn();
    if (s.binding !== prev.binding) {
      applyChoice();
      void loadSticky();
    }
  });
  useWorkbench.subscribe((s, prev) => {
    if (s.workspace !== prev.workspace) applyChoice();
  });
  useAi.subscribe((s, prev) => {
    if (s.status !== prev.status) void keepToken();
  });
  if (typeof window !== "undefined") window.addEventListener("focus", () => void loadDevicePolicy());
  void onGateChange();
  const check = () => void onGateChange();
  useAi.subscribe(check);
  useLayerInputs.subscribe(check);
  useExam.subscribe(check);
  useWorkbench.subscribe((s, prev) => {
    if (s.policy !== prev.policy) check();
  });
}
