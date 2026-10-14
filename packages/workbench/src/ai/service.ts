import { create } from "zustand";
import { getPlatform } from "../state/store";
import { useExam } from "../exam/state";

/**
 * TMCode AI: chat and inline suggestions from Task Mentor (/api/tmcode/ai, free AI only; the keys
 * stay on the server). The student picks how it answers:
 * - "free" (default): OpenRouter's free models;
 * - "auto": TMCode picks a free AI that still has requests left today;
 * - "<provider>/<model>": one free model.
 * Off during exams (Task Mentor refuses too) and without an NGA sign-in.
 */

export interface AiModel {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
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
}

const MODE_KEY = "tmcodeAI.mode";
const SUGGEST_KEY = "tmcodeAI.suggestions";

export const useAi = create<AiState>(() => ({ status: null, error: null, loading: false, mode: "free", suggestions: false, agentMode: "manual" }));
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

export function setAiSuggestions(on: boolean) {
  useAi.setState({ suggestions: on });
  void getPlatform().store.set(SUGGEST_KEY, on);
}

/** The label of the current mode ("Free · OpenRouter", "Auto", "gpt-oss-20b"). */
export function modeLabel(mode: string, status: AiStatus | null = useAi.getState().status): string {
  if (mode === "free") return "Free";
  if (mode === "auto") return "Auto";
  return status?.models.find((m) => m.id === mode)?.label ?? mode.split("/").slice(1).join("/");
}

export class AiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
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
  const b = (res.body ?? {}) as Record<string, unknown>;
  if (res.status === 401) throw new AiRequestError("SIGNED_OUT", "Sign in to NGA to use TMCode AI.");
  throw new AiRequestError(String(b.error_code ?? `HTTP_${res.status}`), typeof b.message === "string" ? b.message : `Task Mentor answered ${res.status}.`);
}

export async function refreshAiStatus() {
  if (useExam.getState().quiz) return;
  useAi.setState({ loading: true });
  try {
    const status = await call<AiStatus>("GET", "/status");
    useAi.setState({ status, error: null, loading: false });
  } catch (e) {
    useAi.setState({ error: (e as Error).message, loading: false });
  }
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
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
}

export interface StreamHandlers {
  meta(m: { provider: string; model: string }): void;
  delta(text: string): void;
  done(d: { provider: string; model: string; you?: { used: number; limit: number }; steps?: { used: number; limit: number }; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }): void;
  error(e: AiRequestError): void;
}

/** Asks, then streams the answer. Returns a cancel function. */
export async function chat(messages: WireMessage[], context: ChatContext | undefined, on: StreamHandlers, agent?: AgentRequest): Promise<() => void> {
  if (useExam.getState().quiz) throw new AiRequestError("EXAM_ACTIVE", "TMCode AI is off while you're taking an exam.");
  const { id } = await call<{ id: string }>("POST", "/chat", { mode: useAi.getState().mode, messages, context, ...(agent ? { agent } : {}) });
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
    if (name === "meta") on.meta(data as { provider: string; model: string });
    else if (name === "delta") on.delta(String((data as { text?: string }).text ?? ""));
    else if (name === "done") finish(() => on.done(data as { provider: string; model: string }));
    else if (name === "error") finish(() => on.error(new AiRequestError(String((data as { code?: string }).code ?? "FAILED"), String((data as { message?: string }).message ?? "The AI didn't answer."))));
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
  if (useExam.getState().quiz) return null;
  const r = await call<{ text: string | null; provider?: string; model?: string }>("POST", "/complete", { mode: useAi.getState().mode, ...input });
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
