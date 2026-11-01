import { filterLearningText, identifiersOf, type Layer } from "@tmcode/protocol";
import { create } from "zustand";
import { getPlatform } from "../state/store";
import { readAiKey } from "./keys";
import type { AgentRequest, ChatContext, StreamHandlers, WireMessage } from "./service";
import { AiRequestError } from "./service";

/**
 * AI that never passes NGA (vibe coding proposal §8.6, A7 and the first step of J1):
 *
 * - **Your own key, signed out:** "byok:<provider>/<model>" calls the provider straight from this
 *   computer with the key from the keychain. Signed in, own keys keep going through Task Mentor so
 *   the layers and the log apply there.
 * - **A local model:** "local:<model>" asks an OpenAI-compatible server on this computer (Ollama at
 *   http://localhost:11434/v1 by default, LM Studio at :1234/v1), signed in or not. Free, offline,
 *   nothing leaves the machine.
 *
 * Requests go through the desktop's HTTP host (Rust: no CORS, 30 s). Answers arrive whole, not
 * streamed. In Learning (a sticky layer while signed out, or a device policy) the answer passes the
 * same code filter as Task Mentor's, here on the client, since no server sees it.
 */

export const LOCAL_URL_KEY = "tmcodeAI.localUrl";
export const DEFAULT_LOCAL_URL = "http://localhost:11434/v1";

interface LocalState {
  url: string;
  models: string[];
  state: "unknown" | "checking" | "ready" | "none";
  error: string | null;
}

export const useLocalAi = create<LocalState>(() => ({ url: DEFAULT_LOCAL_URL, models: [], state: "unknown", error: null }));

export const isLocalMode = (mode: string) => mode.startsWith("local:");
export const localModelOf = (mode: string) => (isLocalMode(mode) ? mode.slice("local:".length) : null);

/** A safe local server URL: http(s) on this computer or the LAN (a school's shared Ollama). */
export function cleanLocalUrl(raw: string): string | null {
  const v = raw.trim().replace(/\/+$/, "");
  try {
    const u = new URL(v);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return v;
  } catch {
    return null;
  }
}

export async function loadLocalSettings() {
  const url = await getPlatform()
    .store.get<string>(LOCAL_URL_KEY)
    .catch(() => undefined);
  if (typeof url === "string" && cleanLocalUrl(url)) useLocalAi.setState({ url: cleanLocalUrl(url)! });
}

export function setLocalUrl(url: string) {
  const clean = cleanLocalUrl(url);
  if (!clean) throw new Error("Use an http:// or https:// address, e.g. http://localhost:11434/v1");
  useLocalAi.setState({ url: clean, models: [], state: "unknown", error: null });
  void getPlatform().store.set(LOCAL_URL_KEY, clean);
}

/** Lists the local server's models (GET /models). */
export async function detectLocalModels(): Promise<string[]> {
  const http = getPlatform().http;
  const { url } = useLocalAi.getState();
  if (!http) {
    useLocalAi.setState({ state: "none", error: "Local models need the TMCode desktop app." });
    return [];
  }
  useLocalAi.setState({ state: "checking" });
  try {
    const res = await http.request({ method: "GET", url: `${url}/models`, headers: [] });
    if (res.status < 200 || res.status >= 300) throw new Error(`it answered ${res.status}`);
    const body = JSON.parse(res.body) as { data?: { id?: string }[]; models?: { name?: string }[] };
    const models = [...new Set([...(body.data ?? []).map((m) => m.id ?? ""), ...(body.models ?? []).map((m) => m.name ?? "")].filter(Boolean))].slice(0, 60);
    useLocalAi.setState({ models, state: models.length ? "ready" : "none", error: models.length ? null : "The local server has no models. Pull one (e.g. ollama pull qwen2.5-coder:1.5b)." });
    return models;
  } catch (e) {
    useLocalAi.setState({ models: [], state: "none", error: `No local AI at ${url} (${String((e as Error)?.message ?? e)}). Start Ollama or LM Studio, or change the address in Settings › TMCode AI.` });
    return [];
  }
}

// ── providers ──

interface Endpoint {
  url: string;
  headers: (key: string) => [string, string][];
  /** "openai": chat/completions; "anthropic": /v1/messages. */
  kind: "openai" | "anthropic";
}

export const DIRECT_PROVIDERS: Record<string, Endpoint> = {
  openai: { url: "https://api.openai.com/v1/chat/completions", headers: (k) => [["Authorization", `Bearer ${k}`]], kind: "openai" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", headers: (k) => [["Authorization", `Bearer ${k}`]], kind: "openai" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", headers: (k) => [["Authorization", `Bearer ${k}`], ["X-Title", "TMCode"]], kind: "openai" },
  deepseek: { url: "https://api.deepseek.com/chat/completions", headers: (k) => [["Authorization", `Bearer ${k}`]], kind: "openai" },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", headers: (k) => [["Authorization", `Bearer ${k}`]], kind: "openai" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", headers: (k) => [["x-api-key", k], ["anthropic-version", "2023-06-01"]], kind: "anthropic" },
};

/** Models offered for each provider while signed out (Task Mentor's list isn't there). */
export const DIRECT_SUGGESTED: Record<string, string[]> = {
  openai: ["gpt-4.1-mini", "gpt-4.1"],
  anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro"],
  openrouter: ["openrouter/auto"],
  groq: ["llama-3.3-70b-versatile"],
  deepseek: ["deepseek-chat"],
};

// ── prompts (Task Mentor's live there; these are the short local versions) ──

const SYSTEM = `You are TMCode AI, the coding assistant inside TMCode, a VS Code-style code editor.
Answer clearly and briefly. Use Markdown; put code in fenced blocks with the language, and when a block replaces code in the user's file, write the file name on the line before it.`;

const AGENT_RULES = `You are working inside the user's project folder in TMCode, with tools.
- Look before you change: read a file before editing it, search to find where things are.
- Prefer edit_file with a small, exact old_text over rewriting whole files. Keep changes minimal and in the project's style.
- After changing code, check get_problems (and run tests when that helps).
- When done, reply with a short summary of what you changed and why (file names), without repeating the code.`;

const AGENT_MODE: Record<AgentRequest["mode"], string> = {
  plan: "PLAN MODE: explore with the read-only tools, then answer with a numbered plan of the changes you would make. Do not change anything.",
  manual: "Every change you make is shown to the user to approve first.",
  edit: "File edits are applied directly (the user can undo them); commands need approval.",
  auto: "Safe actions run directly; risky ones wait for the user's approval.",
};

export const TUTOR_LOCAL = `You are TMCode AI's tutor. The student is in the LEARNING layer: "AI helps you think. You write every line."
Never write code: no code blocks, statements, corrected lines, tests or commands. You may name keywords and functions inline (\`for\`, \`len()\`), give example inputs and outputs, and describe steps in plain words.
First ask what the student thinks should happen next. Reveal one idea at a time; end with one question or one next step. Keep it under 120 words, in the student's language (Kinyarwanda, French or English).`;

function systemPrompt(context: ChatContext | undefined, agent: AgentRequest | undefined, layer: Layer): string {
  const parts: string[] = [];
  if (context?.task) parts.push(`The task:\n${context.task}`);
  if (context?.file) parts.push(`Open file: ${context.file}${context.language ? ` (${context.language})` : ""}`);
  if (context?.selection) parts.push(`Selected code:\n\`\`\`${context.language ?? ""}\n${context.selection}\n\`\`\``);
  else if (context?.fileText) parts.push(`The file:\n\`\`\`${context.language ?? ""}\n${context.fileText}\n\`\`\``);
  if (context?.problems?.length) parts.push(`Problems the editor reports:\n${context.problems.map((p) => `- ${p}`).join("\n")}`);
  if (context?.reply_language) parts.push(`Reply in ${context.reply_language}; keep English programming keywords and explain them briefly.`);
  const base = layer === "learning" ? TUTOR_LOCAL : SYSTEM;
  const agentText = agent ? `\n\n${layer === "learning" ? "You may look at the project with read-only tools. Never change anything." : `${AGENT_RULES}\n${AGENT_MODE[agent.mode]}`}` : "";
  return (parts.length ? `${base}\n\n${parts.join("\n\n")}` : base) + agentText;
}

// ── Anthropic's message format ↔ OpenAI's ──

type AnthropicBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: "tool_result"; tool_use_id: string; content: string };

/** OpenAI-shaped wire messages as Anthropic's (tool results join the next user turn). */
export function toAnthropic(messages: WireMessage[]): { role: "user" | "assistant"; content: AnthropicBlock[] }[] {
  const out: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.role === "assistant" && "tool_calls" in m) {
      const blocks: AnthropicBlock[] = m.content ? [{ type: "text", text: m.content }] : [];
      for (const c of m.tool_calls) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
      }
      push("assistant", blocks);
    } else if (typeof m.content === "string") push(m.role, [{ type: "text", text: m.content || "(empty)" }]);
    else
      push(
        m.role,
        m.content.map((p): AnthropicBlock => {
          if (p.type === "text") return { type: "text", text: p.text };
          const [, media, data] = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url) ?? [];
          return { type: "image", source: { type: "base64", media_type: media ?? "image/png", data: data ?? "" } };
        }),
      );
  }
  return out;
}

interface Answer {
  text: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  model: string;
}

/** Parses either provider's JSON answer. Exported for tests. */
export function parseAnswer(kind: Endpoint["kind"], body: unknown, model: string): Answer {
  const b = (body ?? {}) as Record<string, any>;
  if (kind === "anthropic") {
    const blocks: any[] = Array.isArray(b.content) ? b.content : [];
    const text = blocks.filter((x) => x.type === "text").map((x) => String(x.text ?? "")).join("");
    const calls = blocks.filter((x) => x.type === "tool_use").map((x) => ({ id: String(x.id), type: "function" as const, function: { name: String(x.name), arguments: JSON.stringify(x.input ?? {}) } }));
    return { text, model: String(b.model ?? model), ...(calls.length ? { tool_calls: calls } : {}) };
  }
  const msg = b.choices?.[0]?.message ?? {};
  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map((c: any) => ({ id: String(c.id), type: "function" as const, function: { name: String(c.function?.name ?? ""), arguments: String(c.function?.arguments ?? "{}") } })) : [];
  return { text: typeof msg.content === "string" ? msg.content : "", model: String(b.model ?? model), ...(calls.length ? { tool_calls: calls } : {}) };
}

/** A provider's refusal as words ("Your OpenAI key was refused: …"). */
function refusal(provider: string, status: number, body: string): AiRequestError {
  let message = "";
  try {
    const j = JSON.parse(body);
    message = String(j?.error?.message ?? j?.message ?? j?.error ?? "");
  } catch {
    message = body.slice(0, 200);
  }
  if (status === 401 || status === 403) return new AiRequestError("BYOK_REJECTED", `Your ${provider} key was refused${message ? `: ${message}` : "."} Check it in Settings › TMCode AI › Your API keys.`);
  if (status === 429) return new AiRequestError("RATE_LIMITED", `${provider} says you've hit a limit${message ? `: ${message}` : ""}. Wait a little, or pick another model.`);
  return new AiRequestError(`HTTP_${status}`, `${provider} answered ${status}${message ? `: ${message}` : "."}`);
}

export interface DirectRoute {
  label: string;
  url: string;
  headers: [string, string][];
  kind: Endpoint["kind"];
  model: string;
}

/** Where `mode` goes when it doesn't pass NGA (null: it does). */
export async function directRoute(mode: string): Promise<DirectRoute | null> {
  const local = localModelOf(mode);
  if (local) return { label: "Local AI", url: `${useLocalAi.getState().url}/chat/completions`, headers: [], kind: "openai", model: local };
  const m = /^byok:([^/]+)\/(.+)$/.exec(mode);
  if (!m) return null;
  const ep = DIRECT_PROVIDERS[m[1]];
  if (!ep) throw new AiRequestError("FAILED", `TMCode can't call ${m[1]} directly.`);
  const key = await readAiKey(m[1]);
  if (!key) throw new AiRequestError("BYOK_MISSING", `Add your ${m[1]} API key (Settings › TMCode AI › Your API keys), or pick another model.`);
  return { label: m[1], url: ep.url, headers: ep.headers(key), kind: ep.kind, model: m[2] };
}

/** One question to a direct route; the answer arrives whole (meta, one delta, done). */
export async function directChat(route: DirectRoute, messages: WireMessage[], context: ChatContext | undefined, on: StreamHandlers, agent: AgentRequest | undefined, layer: Layer): Promise<() => void> {
  const http = getPlatform().http;
  if (!http) throw new AiRequestError("OLD_APP", "Your own keys and local models answer in the TMCode desktop app.");
  const system = systemPrompt(context, agent, layer);
  const tools = agent?.tools ?? [];
  const body =
    route.kind === "anthropic"
      ? { model: route.model, max_tokens: agent ? 4000 : 1500, system, messages: toAnthropic(messages), ...(tools.length ? { tools: tools.map((t) => ({ name: t.function.name, description: t.function.description ?? "", input_schema: t.function.parameters ?? { type: "object", properties: {} } })) } : {}) }
      : { model: route.model, messages: [{ role: "system", content: system }, ...messages], temperature: agent ? 0.2 : 0.3, ...(tools.length ? { tools, tool_choice: "auto" } : {}) };
  let cancelled = false;
  void (async () => {
    try {
      on.meta({ provider: route.label, model: route.model });
      const res = await http.request({ method: "POST", url: route.url, headers: [["Content-Type", "application/json"], ...route.headers], body: JSON.stringify(body) });
      if (cancelled) return;
      if (res.status < 200 || res.status >= 300) return on.error(refusal(route.label, res.status, res.body));
      const a = parseAnswer(route.kind, JSON.parse(res.body), route.model);
      let text = a.text;
      let removed = 0;
      if (layer === "learning") {
        const f = filterLearningText(text, { identifiers: identifiersOf(`${context?.fileText ?? ""}\n${context?.selection ?? ""}`) });
        text = f.text;
        removed = f.removed;
      }
      if (text) on.delta(text);
      // The tutor never gets tools that change anything, whatever the model asked for.
      const calls = layer === "learning" ? a.tool_calls?.filter((c) => ["list_files", "read_file", "search", "get_problems"].includes(c.function.name)) : a.tool_calls;
      on.done({ provider: route.label, model: a.model, ...(calls?.length ? { tool_calls: calls } : {}), ...(layer === "learning" ? { layer: "learning", filtered: { removed } } : {}) } as Parameters<StreamHandlers["done"]>[0]);
    } catch (e) {
      if (!cancelled) on.error(e instanceof AiRequestError ? e : new AiRequestError("OFFLINE", `${route.label} couldn't be reached: ${String((e as Error)?.message ?? e)}`));
    }
  })();
  return () => {
    cancelled = true;
  };
}

/**
 * One JSON answer from a direct route (the request interpreter on a local model or your own key,
 * prompt interpreter report Q13): a system prompt and the request, JSON asked for where the
 * endpoint supports it. Returns the raw text (the caller validates it).
 */
export async function directJson(route: DirectRoute, system: string, user: string, timeoutMs = 20_000): Promise<string> {
  const http = getPlatform().http;
  if (!http) throw new AiRequestError("OLD_APP", "Local models and your own keys answer in the TMCode desktop app.");
  const body =
    route.kind === "anthropic"
      ? { model: route.model, max_tokens: 1100, system, messages: [{ role: "user", content: user }] }
      : { model: route.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], temperature: 0.1, response_format: { type: "json_object" } };
  const res = await Promise.race([
    http.request({ method: "POST", url: route.url, headers: [["Content-Type", "application/json"], ...route.headers], body: JSON.stringify(body) }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new AiRequestError("TIMEOUT", `${route.label} took too long.`)), timeoutMs)),
  ]);
  if (res.status < 200 || res.status >= 300) throw refusal(route.label, res.status, res.body);
  return parseAnswer(route.kind, JSON.parse(res.body), route.model).text;
}
