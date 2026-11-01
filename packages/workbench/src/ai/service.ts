import { create } from "zustand";
import { getPlatform } from "../state/store";
import { cliChat, cliModeLabel, isCliMode } from "./aiClis";
import { directChat, directRoute, isLocalMode, localModelOf } from "./direct";
import { aiExamActive, aiGate, aiReasonText } from "./gate";
import { useLayerInputs } from "./layerState";
import { MissingKeyError, modeFields, parseMode, providerLabel, whenKeyRemoved } from "./keys";

/**
 * TMCode AI: chat and inline suggestions from Task Mentor (/api/tmcode/ai, free AI only; the keys
 * stay on the server). The student picks how it answers:
 * - "free" (default): OpenRouter's free models;
 * - "auto": TMCode picks a free AI that still has requests left today;
 * - "<provider>/<model>": one free model;
 * - "premium:<provider>/<model>": the school's paid models, for users it entitled (Task Mentor ≥ 2026-10-25);
 * - "byok:<provider>/<model>": the user's own key (ai/keys.ts), sent with that request only;
 * - "cli:<claude|codex|gemini>[/<model>]": Claude Code, Codex (ChatGPT) or Gemini CLI on this
 *   computer, signed in with the user's own account (ai/aiClis.ts): answers never reach Task Mentor
 *   (suggestions use Free there);
 * - "local:<model>": a model on this computer (Ollama, LM Studio; ai/direct.ts), never NGA.
 * Signed out, own keys call the provider directly (ai/direct.ts) and Free/Auto/premium can't run.
 * Whether it may run is Task Mentor's AI status for the open project (ai/gate.ts), sent with
 * `project_id`; in exams the exam policy's `ai`. Without an NGA sign-in it can't run.
 */

export interface AiModel {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  /** Reads images (Task Mentor 2026-10-31 and later; older servers don't say, and images aren't offered). */
  vision?: boolean;
}

export interface AiStatus {
  enabled: boolean;
  exam: boolean;
  default_mode: string;
  modes: { id: string; label: string; detail: string }[];
  models: AiModel[];
  you: { chat: { used: number; limit: number }; complete: { used: number; limit: number }; agent?: { used: number; limit: number } };
  pools: Record<string, { label: string; used: number; limit: number; remaining: number }>;
  openrouter: { used: number; limit: number; remaining: number } | null;
  /*
   * AI usage control (Task Mentor 2026-10 and later; older servers don't send these, and the gate
   * then decides as before, exam-only).
   */
  /** May this user use TMCode AI here (school switch, teacher's setting, role)? */
  allowed?: boolean;
  /** Why (GLOBAL_OFF, TEACHER_OFF, HINTS_ONLY, ROLE_OFF, ALLOWED_BY_ROLE…). */
  reason?: string;
  /** Words for the student. */
  message?: string;
  /** The assignment's or quiz's AI setting when the project is linked to one (else null). */
  mode?: "off" | "hints" | "full" | null;
  features?: { assist: boolean; complete: boolean };
  /** Third-party AI tools (extensions such as Claude Code, AI CLIs in the terminal); staff follow the school's staff switch. */
  thirdPartyExtensions?: boolean;
  /*
   * Premium AI and own keys (Task Mentor 2026-10-25 and later; older servers send none of these and
   * TMCode then shows the free models only).
   */
  /** A grader (teacher, programme lead…): the staff AI rules apply. */
  staff?: boolean;
  tiers?: { free: true; premium: boolean; byok: boolean };
  /** "premium:<provider>/<model>" ids; empty unless the user is entitled. */
  premium_models?: AiModel[];
  premium_you?: { used: number; limit: number } | null;
  byok_providers?: { id: string; label: string; suggested_models: string[] }[];
  /*
   * AI layers (vibe coding proposal §8; Task Mentor 2026-11 and later, older servers send none):
   */
  /** "exam" | "learning" | "industrial" for this user and project. */
  layer?: string;
  /** The highest layer for this user's class or role (MIS), if one is set. */
  max_layer?: string | null;
  /** The assignment's teacher allowed students' own AI tools (Industrial · Open). */
  own_tools?: boolean;
  /** Learning's teacher knobs (help strength, pseudo-code, allowance) and the allowance left. */
  learning?: { strength: "hints" | "tutor"; pseudo: boolean; syntax: boolean; allowance: { max: number; regain_minutes: number; left: number; next_in_s: number | null } };
  /** The project's signed sticky layer (A9), to keep in its `.tmcode/layer.json`. */
  layer_token?: { claims: string; sig: string } | null;
  /** Hidden from AI in every layer (teacher-hidden tests, reference solution, marking notes): glob patterns. */
  hidden_paths?: string[];
}

/** The open project (Task Mentor id) the AI status is for. */
export interface AiProject {
  id: number | null;
  /** Linked to an assignment or quiz. */
  assessment: boolean;
}

interface AiState {
  status: AiStatus | null;
  error: string | null;
  loading: boolean;
  /** "free" | "auto" | "<provider>/<model>". */
  mode: string;
  /** Ghost-text suggestions while typing. */
  suggestions: boolean;
  /** How TMCode AI works: chat only, or an agent mode (ai/chat.ts MODES). */
  agentMode: "chat" | "manual" | "edit" | "plan" | "auto";
  /** The open project; every AI request carries its id. */
  project: AiProject;
  /** The project the status was asked for. */
  statusFor: number | null;
  /** The status was asked for during an exam (only such a status speaks for the exam). */
  statusInExam: boolean;
  /** Task Mentor's last refusal (403 AI_DISABLED / EXAM_ACTIVE), until the next status. */
  denied: { reason: string; message: string | null } | null;
}

const MODE_KEY = "tmcodeAI.mode";
const SUGGEST_KEY = "tmcodeAI.suggestions";

export const useAi = create<AiState>(() => ({ status: null, error: null, loading: false, mode: "free", suggestions: false, agentMode: "manual", project: { id: null, assessment: false }, statusFor: null, statusInExam: false, denied: null }));
const AGENT_KEY = "tmcodeAI.agentMode";

export function setAgentMode(agentMode: AiState["agentMode"]) {
  useAi.setState({ agentMode });
  void getPlatform().store.set(AGENT_KEY, agentMode);
}

export async function loadAiSettings() {
  const store = getPlatform().store;
  const mode = await store.get<string>(MODE_KEY).catch(() => undefined);
  const suggestions = await store.get<boolean>(SUGGEST_KEY).catch(() => undefined);
  const agent = await store.get<string>(AGENT_KEY).catch(() => undefined);
  useAi.setState({
    mode: typeof mode === "string" && mode ? mode : "free",
    suggestions: suggestions === true,
    agentMode: agent === "chat" || agent === "manual" || agent === "edit" || agent === "plan" || agent === "auto" ? agent : "manual",
  });
}

export function setAiMode(mode: string) {
  useAi.setState({ mode });
  void getPlatform().store.set(MODE_KEY, mode);
}

// A removed key takes its models with it: a mode on that key falls back to Free.
whenKeyRemoved((provider) => {
  const p = parseMode(useAi.getState().mode);
  if (p.tier === "byok" && p.provider === provider) setAiMode("free");
});

export function setAiSuggestions(on: boolean) {
  useAi.setState({ suggestions: on });
  void getPlatform().store.set(SUGGEST_KEY, on);
}

/** The label of the current mode ("Free · OpenRouter", "Auto", "gpt-oss-20b"). */
export function modeLabel(mode: string, status: AiStatus | null = useAi.getState().status): string {
  if (mode === "free") return "Free";
  if (mode === "auto") return "Auto";
  if (isCliMode(mode)) return cliModeLabel(mode);
  if (isLocalMode(mode)) return `${localModelOf(mode)} · local`;
  const p = parseMode(mode);
  if (p.tier === "premium") return `${status?.premium_models?.find((m) => m.id === mode)?.label ?? p.model} · Premium`;
  if (p.tier === "byok") return `${p.model} · your ${providerLabel(p.provider ?? "")} key`;
  return status?.models.find((m) => m.id === mode)?.label ?? mode.split("/").slice(1).join("/");
}

/**
 * The picked mode, unless this Task Mentor can't serve it any more (premium taken away, own keys
 * turned off, or an older server): then Free, so a request never fails for a choice that's gone.
 */
export function effectiveMode(mode: string = useAi.getState().mode, status: AiStatus | null = useAi.getState().status): string {
  // AI CLIs: where third-party AI tools are allowed (not in exams, not where the school says no).
  if (isCliMode(mode)) return aiGate().thirdParty ? mode : "free";
  // A local model: nothing leaves the computer, so every layer with AI may use it.
  if (isLocalMode(mode)) return mode;
  const tier = parseMode(mode).tier;
  if (tier === "free" || !status) return mode;
  if (tier === "premium") return status.tiers?.premium && status.premium_models?.some((m) => m.id === mode) ? mode : "free";
  return status.tiers?.byok ? mode : "free";
}

/**
 * Can the AI that answers in `mode` read images? Free: one of OpenRouter's free models can (the
 * server sends image questions only to those); Auto: any model can; one model, premium: that
 * model; own key: the server decides. False with an older Task Mentor (no `vision` flags).
 */
export function aiReadsImages(mode: string = useAi.getState().mode, status: AiStatus | null = useAi.getState().status): boolean {
  if (!status) return false;
  const m = effectiveMode(mode, status);
  if (isCliMode(m) || isLocalMode(m)) return false;
  const models = status.models ?? [];
  if (m === "free") return models.some((x) => x.provider === "openrouter" && x.vision);
  if (m === "auto") return models.some((x) => x.vision);
  if (m.startsWith("premium:")) return !!status.premium_models?.find((x) => x.id === m)?.vision;
  if (m.startsWith("byok:")) return models.some((x) => x.vision !== undefined);
  return !!models.find((x) => x.id === m)?.vision;
}

/** `mode` (and `byok`) for a request body: own keys are read from the keychain now. */
export async function requestModeFields(): Promise<{ mode: string; byok?: { provider: string; key: string } }> {
  const mode = effectiveMode();
  // An AI CLI or a local model answers on this computer; what still goes to Task Mentor (suggestions) uses Free.
  if (isCliMode(mode) || isLocalMode(mode)) return { mode: "free" };
  try {
    return await modeFields(mode);
  } catch (e) {
    if (e instanceof MissingKeyError) throw new AiRequestError("BYOK_MISSING", e.message);
    throw e;
  }
}

export class AiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** AI_DISABLED / EXAM_ACTIVE: why (GLOBAL_OFF, TEACHER_OFF…). */
    readonly reason?: string,
  ) {
    super(message);
  }
}

/**
 * Task Mentor's refusal as an error. AI_DISABLED carries `code`, `reason` and `message` at the top
 * level or under `error`; older servers say `error_code` (EXAM_ACTIVE during an exam session).
 */
export function aiErrorFromResponse(status: number, body: unknown): AiRequestError {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const nested = (b.error && typeof b.error === "object" ? b.error : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof b[k] === "string" && b[k] ? (b[k] as string) : typeof nested[k] === "string" && nested[k] ? (nested[k] as string) : undefined);
  const code = pick("code") ?? pick("error_code") ?? `HTTP_${status}`;
  const message = pick("message") ?? (typeof b.error === "string" ? b.error : undefined);
  if (code === "AI_DISABLED" || code === "EXAM_ACTIVE") {
    const reason = pick("reason") ?? (code === "EXAM_ACTIVE" ? "EXAM_ACTIVE" : "GLOBAL_OFF");
    return new AiRequestError(code, aiReasonText(reason, message), reason);
  }
  if (code === "PREMIUM_REQUIRED") return new AiRequestError(code, message ?? "Premium AI isn't turned on for your account. Pick a free model, or ask your school.");
  if (code === "BYOK_REJECTED") return new AiRequestError(code, `Your own API key was refused${message ? `: ${message}` : ". Check the key and its credit in Settings › TMCode AI › Your API keys, or pick another model."}`);
  return new AiRequestError(code, message ?? `Task Mentor answered ${status}.`);
}

/** A refusal locks the gate until the next status (which is asked for at once). */
function noteRefusal(e: AiRequestError) {
  if (!e.reason) return;
  useAi.setState({ denied: { reason: e.reason, message: e.message } });
  void refreshAiStatus();
}

/** The open project's Task Mentor id (null: none, or not a Task Mentor project). */
export function currentAiProjectId(): number | null {
  return useAi.getState().project.id;
}

let soon: ReturnType<typeof setTimeout> | null = null;
/**
 * Asks for the status after `delayMs` (calls meanwhile fold into one). Many apps hear the same
 * "changed" at once; a little spread keeps them from asking Task Mentor in the same instant.
 */
export function refreshAiStatusSoon(delayMs = 0) {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    void refreshAiStatus();
  }, Math.max(0, delayMs));
}

/** An exam started or ended: a status from the other side of it says nothing about now. */
export function forgetAiStatus() {
  useAi.setState({ status: null, statusFor: null, statusInExam: false, denied: null });
}

/** The open project changed: the old status says nothing about the new one. */
export function setAiProject(project: AiProject) {
  const was = useAi.getState().project;
  if (was.id === project.id && was.assessment === project.assessment) return;
  if (was.id === project.id) {
    useAi.setState({ project });
    return;
  }
  useAi.setState({ project, status: null, statusFor: null, denied: null });
}

/**
 * Any failure as an AiRequestError with words to show: the desktop app's invoke() rejects with a
 * plain string, other failures may have no message at all (an empty error box helps nobody).
 */
export function asAiError(e: unknown): AiRequestError {
  if (e instanceof AiRequestError && e.message) return e;
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message ?? "") : "";
  const code = e instanceof AiRequestError ? e.code : "FAILED";
  if (/sign in/i.test(raw)) return new AiRequestError("SIGNED_OUT", "Sign in to NGA to use TMCode AI.");
  if (/not allowed|not found|unknown command/i.test(raw)) return new AiRequestError("OLD_APP", "This version of TMCode can't receive AI answers. Update TMCode (Help › Check for Updates).");
  return new AiRequestError(code, raw.trim() ? `TMCode AI couldn't answer: ${raw.trim()}` : "TMCode AI couldn't answer. Try again.");
}

function host() {
  const h = getPlatform().account;
  if (!h) throw new AiRequestError("NO_ACCOUNT", "TMCode AI needs the TMCode app signed in to NGA.");
  return h;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res;
  try {
    res = await host().request<Record<string, unknown>>({ method, path: `/api/tmcode/ai${path}`, ...(body !== undefined ? { json: body } : {}) });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    throw new AiRequestError(/sign in/i.test(message) ? "SIGNED_OUT" : "OFFLINE", /sign in/i.test(message) ? "Sign in to NGA to use TMCode AI." : "TMCode AI can't reach Task Mentor. Check your connection.");
  }
  if (res.status >= 200 && res.status < 300) return res.body as T;
  if (res.status === 401) throw new AiRequestError("SIGNED_OUT", "Sign in to NGA to use TMCode AI.");
  const err = aiErrorFromResponse(res.status, res.body);
  noteRefusal(err);
  throw err;
}

/** `project_id` for a request body ({} without a project). */
function projectField(): { project_id?: number } {
  const id = currentAiProjectId();
  return id != null ? { project_id: id } : {};
}

let statusSeq = 0;
/**
 * Asks Task Mentor whether AI may run (for the open project), in exams too: a teacher may change
 * the quiz's AI setting, or the school its policy, while the exam runs (ai/live.ts says when).
 */
export async function refreshAiStatus() {
  const project = currentAiProjectId();
  const inExam = aiExamActive();
  const seq = ++statusSeq;
  useAi.setState({ loading: true });
  try {
    const status = await call<AiStatus>("GET", project != null ? `/status?project_id=${project}` : "/status");
    // A newer request (another project) wins; an exam that started or ended meanwhile asks again.
    if (seq !== statusSeq || currentAiProjectId() !== project) return;
    if (aiExamActive() !== inExam) {
      useAi.setState({ loading: false });
      void refreshAiStatus();
      return;
    }
    useAi.setState({ status, statusFor: project, statusInExam: inExam, denied: null, error: null, loading: false });
  } catch (e) {
    if (seq !== statusSeq) return;
    useAi.setState({ error: (e as Error).message, loading: false });
  }
}

/** A question with images: its text and the images (data: URLs), as OpenAI's content parts. */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string | ContentPart[];
}

/** A message of an agent's conversation (tool calls and their results included). */
export type WireMessage =
  | ChatTurn
  | { role: "assistant"; content: string | null; tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentRequest {
  mode: "manual" | "edit" | "plan" | "auto";
  step: number;
  tools: { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
}

export interface ChatContext {
  file?: string;
  language?: string;
  selection?: string;
  fileText?: string;
  problems?: string[];
  task?: string;
  /**
   * "grading": a teacher grading a review folder (Task Mentor uses its grading prompt for staff);
   * "terminal": the terminal asking for shell commands (terminal/ai.ts, Task Mentor's terminal prompt).
   */
  purpose?: "grading" | "terminal";
  grading?: { activity_title: string; brief: string; rubric: { index: number; criteria: string; description: string | null; max_score: number }[]; student_name: string; question_text?: string };
}

export interface StreamHandlers {
  /** Who answers; `privacy` is the provider's terms in a few words (Task Mentor ≥ 2026-11, J4). */
  meta(m: { provider: string; model: string; privacy?: string | null }): void;
  delta(text: string): void;
  done(d: {
    provider: string;
    model: string;
    you?: { used: number; limit: number };
    steps?: { used: number; limit: number };
    tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    /** Learning: the answer came from the tutor, `filtered.removed` lines of code were cut, the allowance left. */
    layer?: string;
    filtered?: { removed: number };
    allowance?: { max: number; regain_minutes: number; left: number; next_in_s: number | null };
  }): void;
  error(e: AiRequestError): void;
}

/** Asks, then streams the answer. Returns a cancel function. */
export async function chat(messages: WireMessage[], context: ChatContext | undefined, on: StreamHandlers, agent?: AgentRequest): Promise<() => void> {
  const gate = aiGate();
  if (!gate.chat) throw new AiRequestError(gate.reason === "EXAM_ACTIVE" ? "EXAM_ACTIVE" : "AI_DISABLED", gate.message ?? aiReasonText(gate.reason), gate.reason ?? undefined);
  const mode = effectiveMode();
  if (isCliMode(mode) && !agent) return cliChat(messages, context, on, mode);
  // Your own key while signed out, or a local model: straight to it, never NGA.
  const signedOut = useLayerInputs.getState().signedIn === false || !getPlatform().account;
  if (isLocalMode(mode) || (signedOut && parseMode(mode).tier === "byok")) {
    const route = await directRoute(mode);
    if (route) return directChat(route, messages, context, on, agent, gate.layer);
  }
  if (signedOut) throw new AiRequestError("SIGNED_OUT", "You're not signed in to NGA: pick your own API key, a local model or your AI account (Claude Code, ChatGPT, Gemini) under \"Which AI answers\", or sign in for your school's AI.");
  const { id } = await call<{ id: string }>("POST", "/chat", { ...(await requestModeFields()), messages, context, ...(agent ? { agent } : {}), ...projectField() });
  const h = host();
  let finished = false;
  let handle: { cancel(): void } | null = null;
  let cancelled = false;
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };
  const parse = sseParser((name, data) => {
    if (name === "meta") on.meta(data as { provider: string; model: string; privacy?: string | null });
    else if (name === "delta") on.delta(String((data as { text?: string }).text ?? ""));
    else if (name === "done") finish(() => on.done(data as { provider: string; model: string }));
    else if (name === "error")
      finish(() => {
        const d = (data ?? {}) as { code?: string; message?: string; reason?: string };
        if (d.code === "AI_DISABLED" || d.code === "EXAM_ACTIVE") {
          const err = aiErrorFromResponse(403, d);
          noteRefusal(err);
          on.error(err);
        } else if (d.code === "PREMIUM_REQUIRED" || d.code === "BYOK_REJECTED") on.error(aiErrorFromResponse(403, d));
        else on.error(new AiRequestError(String(d.code ?? "FAILED"), String(d.message ?? "The AI didn't answer.")));
      });
  });
  if (!h.stream) throw new AiRequestError("OLD_APP", "Update TMCode to use TMCode AI.");
  handle = await h
    .stream(`/api/tmcode/ai/chat/${id}/stream`, (e) => {
    if (cancelled) return;
    if (e.type === "data") parse(e.data);
    else if (e.type === "end") finish(() => on.error(new AiRequestError("INTERRUPTED", "The answer stopped. Try again.")));
      else if (e.type === "error") finish(() => on.error(new AiRequestError("OFFLINE", e.message || "TMCode AI lost its connection to Task Mentor. Try again.")));
    })
    .catch((err) => {
      throw asAiError(err);
    });
  return () => {
    cancelled = true;
    finished = true;
    handle?.cancel();
  };
}

/** One ghost-text suggestion at the cursor (null: nothing, or no allowance left). */
export async function completeAt(input: { prefix: string; suffix: string; language: string; path: string }): Promise<{ text: string; provider: string; model: string } | null> {
  if (!aiGate().complete) return null;
  const r = await call<{ text: string | null; provider?: string; model?: string }>("POST", "/complete", { ...(await requestModeFields()), ...input, ...projectField() });
  return r.text ? { text: r.text, provider: r.provider ?? "", model: r.model ?? "" } : null;
}

/** `event: name` + `data: json` blocks; pieces may split anywhere. */
export function sseParser(on: (name: string, data: unknown) => void) {
  let buf = "";
  return (text: string) => {
    buf += text.replace(/\r\n?/g, "\n");
    for (let cut = buf.indexOf("\n\n"); cut >= 0; cut = buf.indexOf("\n\n")) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      let name = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
      if (!data.length) continue;
      try {
        on(name, JSON.parse(data.join("\n")));
      } catch {
        /* a malformed block is skipped */
      }
    }
  };
}
