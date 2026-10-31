import { create } from "zustand";
import { getPlatform } from "../state/store";

/**
 * Own AI provider keys ("bring your own key", BYOK): the key lives in the OS keychain (desktop,
 * ai_keys.rs; the dev browser build keeps it in memory), is read just before each TMCode AI request
 * and goes to Task Mentor in that request's body only (`byok: { provider, key }`), which uses it
 * once and never stores it. TMCode keeps here only WHICH providers have a key and the model ids the
 * user added, never a key: not in localStorage, not in settings, not in the activity log.
 */

export type ByokProvider = "openai" | "anthropic" | "gemini" | "openrouter" | "groq" | "deepseek";
export const BYOK_PROVIDERS: ByokProvider[] = ["openai", "anthropic", "gemini", "openrouter", "groq", "deepseek"];

const SAVED_KEY = "tmcodeAI.byokProviders";
const MODELS_KEY = "tmcodeAI.byokModels";

interface AiKeysState {
  /** Providers with a key in the keychain. */
  saved: string[];
  /** Model ids the user added, per provider (besides Task Mentor's suggestions). */
  models: Record<string, string[]>;
  loaded: boolean;
}

export const useAiKeys = create<AiKeysState>(() => ({ saved: [], models: {}, loaded: false }));

const host = () => {
  try {
    return getPlatform().aiKeys ?? null;
  } catch {
    return null;
  }
};

/** Can this TMCode keep own keys at all (desktop keychain, dev memory)? */
export const aiKeysSupported = () => !!host();

export async function loadAiKeys() {
  const store = getPlatform().store;
  const saved = await store.get<string[]>(SAVED_KEY).catch(() => undefined);
  const models = await store.get<Record<string, string[]>>(MODELS_KEY).catch(() => undefined);
  useAiKeys.setState({ saved: Array.isArray(saved) ? saved.filter((p) => typeof p === "string") : [], models: models && typeof models === "object" ? models : {}, loaded: true });
}

function rememberSaved(saved: string[]) {
  useAiKeys.setState({ saved });
  void getPlatform().store.set(SAVED_KEY, saved);
}

export async function saveAiKey(provider: string, key: string) {
  const h = host();
  if (!h) throw new Error("Own API keys need the TMCode desktop app (they are kept in your computer's keychain).");
  const k = key.trim();
  if (!k || /\s/.test(k)) throw new Error("That doesn't look like an API key.");
  await h.set(provider, k);
  const saved = useAiKeys.getState().saved;
  if (!saved.includes(provider)) rememberSaved([...saved, provider]);
}

export async function removeAiKey(provider: string) {
  await host()?.delete(provider);
  rememberSaved(useAiKeys.getState().saved.filter((p) => p !== provider));
  // A model on that key can't answer any more: back to Free rather than failing the next question.
  onKeyRemoved?.(provider);
}

let onKeyRemoved: ((provider: string) => void) | null = null;
/** ai/service.ts: what to do when a provider's key goes (it owns the picked mode). */
export function whenKeyRemoved(fn: (provider: string) => void) {
  onKeyRemoved = fn;
}

export function setCustomModels(provider: string, list: string[]) {
  const clean = [...new Set(list.map((m) => m.trim()).filter((m) => m && !/\s/.test(m)))].slice(0, 20);
  const models = { ...useAiKeys.getState().models, [provider]: clean };
  useAiKeys.setState({ models });
  void getPlatform().store.set(MODELS_KEY, models);
}

/** The key, read from the keychain now (null: none saved). */
export async function readAiKey(provider: string): Promise<string | null> {
  const h = host();
  if (!h) return null;
  try {
    return (await h.get(provider)) || null;
  } catch {
    return null;
  }
}

/** "free" | "auto" | "<provider>/<model>" (free) | "premium:<provider>/<model>" | "byok:<provider>/<model>". */
export function parseMode(mode: string): { tier: "free" | "premium" | "byok"; provider: string | null; model: string | null } {
  const m = /^(premium|byok):([^/]+)\/(.+)$/.exec(mode);
  if (m) return { tier: m[1] as "premium" | "byok", provider: m[2], model: m[3] };
  if (mode === "free" || mode === "auto") return { tier: "free", provider: null, model: null };
  const i = mode.indexOf("/");
  return { tier: "free", provider: i > 0 ? mode.slice(0, i) : null, model: i > 0 ? mode.slice(i + 1) : null };
}

export class MissingKeyError extends Error {
  constructor(readonly provider: string) {
    super(`Add your ${providerLabel(provider)} API key (Settings › TMCode AI › Your API keys), or pick another model.`);
  }
}

/**
 * The `mode` (and `byok`) fields of a TMCode AI request body. Own-key modes read the key now and
 * carry it; every other mode sends only `mode`.
 */
export async function modeFields(mode: string, read: (provider: string) => Promise<string | null> = readAiKey): Promise<{ mode: string; byok?: { provider: string; key: string } }> {
  const p = parseMode(mode);
  if (p.tier !== "byok" || !p.provider) return { mode };
  const key = await read(p.provider);
  if (!key) throw new MissingKeyError(p.provider);
  return { mode, byok: { provider: p.provider, key } };
}

const LABELS: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", gemini: "Google Gemini", openrouter: "OpenRouter", groq: "Groq", deepseek: "DeepSeek" };
export const providerLabel = (p: string) => LABELS[p] ?? p;

/** How each provider's keys start (the keys pages say so); a key of another provider is a common slip. */
const KEY_SHAPES: { provider: ByokProvider; re: RegExp }[] = [
  { provider: "anthropic", re: /^sk-ant-/ },
  { provider: "openrouter", re: /^sk-or-/ },
  { provider: "groq", re: /^gsk_/ },
  { provider: "gemini", re: /^AIza/ },
];

/**
 * A warning when `key` looks like another provider's ("This looks like an Anthropic key."), else
 * null. Only a hint: providers change formats, so the key is saved either way.
 */
export function keyShapeWarning(provider: string, key: string): string | null {
  const k = key.trim();
  if (!k) return null;
  const looks = KEY_SHAPES.find((s) => s.re.test(k))?.provider;
  if (looks && looks !== provider) return `This looks like ${looks === "anthropic" ? "an" : "a"} ${providerLabel(looks)} key, not ${/^[aeiou]/i.test(providerLabel(provider)) ? "an" : "a"} ${providerLabel(provider)} key.`;
  const own = KEY_SHAPES.find((s) => s.provider === provider);
  if (own && !own.re.test(k)) return `${providerLabel(provider)} keys usually start with "${own.re.source.replace(/^\^/, "")}". Check you copied the whole key.`;
  return null;
}

export type KeyCheck = { ok: true; model: string } | { ok: false; code: string; message: string };

/**
 * "Test key": asks Task Mentor to try the saved key once (POST /api/tmcode/ai/byok/verify, Task
 * Mentor ≥ 2026-11) with `model`, else the provider's cheap check model. The key goes in that
 * request's body only, as with every question.
 */
export async function verifyAiKey(provider: string, model?: string): Promise<KeyCheck> {
  const key = await readAiKey(provider);
  if (!key) return { ok: false, code: "BYOK_MISSING", message: `No ${providerLabel(provider)} key is saved on this computer.` };
  const account = getPlatform().account;
  if (!account) return { ok: false, code: "NO_ACCOUNT", message: "Sign in to NGA to test your key." };
  let res;
  try {
    res = await account.request<Record<string, unknown>>({ method: "POST", path: "/api/tmcode/ai/byok/verify", json: { provider, key, ...(model ? { model } : {}) } });
  } catch (e) {
    return { ok: false, code: "OFFLINE", message: /sign in/i.test(String((e as Error)?.message ?? e)) ? "Sign in to NGA to test your key." : "Can't reach Task Mentor. Check your connection." };
  }
  const body = (res.body ?? {}) as Record<string, unknown>;
  if (res.status >= 200 && res.status < 300 && body.ok) return { ok: true, model: String(body.model ?? model ?? "") };
  if (res.status === 404) return { ok: false, code: "OLD_SERVER", message: "Your Task Mentor can't test keys yet. The key is checked on your first question." };
  const nested = (body.error && typeof body.error === "object" ? body.error : {}) as Record<string, unknown>;
  const code = String(body.code ?? body.error_code ?? nested.code ?? `HTTP_${res.status}`);
  const message = String(body.message ?? nested.message ?? (typeof body.error === "string" ? body.error : "") ?? "") || `Task Mentor answered ${res.status}.`;
  return { ok: false, code, message };
}

/** Where each provider's keys are made (Settings links). */
export const KEY_PAGES: Record<string, string> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  gemini: "https://aistudio.google.com/apikey",
  openrouter: "https://openrouter.ai/settings/keys",
  groq: "https://console.groq.com/keys",
  deepseek: "https://platform.deepseek.com/api_keys",
};
