import { useEffect, useState } from "react";
import { getPlatform, notify } from "../state/store";
import { Codicon } from "../widgets/icons";
import { aiKeysSupported, BYOK_PROVIDERS, KEY_PAGES, loadAiKeys, providerLabel, removeAiKey, saveAiKey, setCustomModels, useAiKeys } from "./keys";
import { refreshAiStatus, useAi } from "./service";

/**
 * Settings › TMCode AI › Your API keys: add or remove a key per provider (kept in the OS keychain,
 * ai/keys.ts) and extra model ids. Shown only where Task Mentor accepts own keys (`tiers.byok`).
 */

const WORDS = "tmcode ai api keys key byok own provider openai anthropic gemini openrouter groq deepseek premium model";

export function aiKeysMatch(query: string) {
  return !query || query.toLowerCase().split(/\s+/).every((w) => WORDS.includes(w));
}

function ProviderRow({ id, label, suggested }: { id: string; label: string; suggested: string[] }) {
  const saved = useAiKeys((s) => s.saved.includes(id));
  const customList = useAiKeys((s) => s.models[id]);
  const custom = customList ?? [];
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState(custom.join(", "));
  useEffect(() => setModels(custom.join(", ")), [custom.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveAiKey(id, key);
      setKey("");
      setEditing(false);
      notify("info", `Your ${label} key is saved in this computer's keychain. Pick one of its models in TMCode AI's model menu.`, undefined, { kind: "hint" });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tm-ai-key-row" data-testid="ai-key-row" data-provider={id}>
      <div className="tm-ai-key-head">
        <strong>{label}</strong>
        <span className={`tm-ai-key-state ${saved ? "is-saved" : ""}`} data-testid="ai-key-state">
          {saved ? (
            <>
              <Codicon name="pass-filled" /> Key saved
            </>
          ) : (
            "No key"
          )}
        </span>
        <span className="tm-ai-key-actions">
          {!editing && (
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => setEditing(true)} data-testid="ai-key-add">
              {saved ? "Replace Key" : "Add Key"}
            </button>
          )}
          {saved && !editing && (
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => void removeAiKey(id)} data-testid="ai-key-remove">
              Remove
            </button>
          )}
          {KEY_PAGES[id] && (
            <button type="button" className="tm-link-button" onClick={() => void getPlatform().openExternal?.(KEY_PAGES[id])}>
              Get a key
            </button>
          )}
        </span>
      </div>
      {editing && (
        <div className="tm-ai-key-edit">
          <input
            type="password"
            className="tm-input tm-input--wide"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={`Paste your ${label} API key`}
            aria-label={`${label} API key`}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && key.trim()) void save();
              if (e.key === "Escape") setEditing(false);
            }}
            data-testid="ai-key-input"
          />
          <button type="button" className="tm-button tm-button--small" disabled={!key.trim() || busy} onClick={() => void save()} data-testid="ai-key-save">
            Save Key
          </button>
          <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <p className="tm-grade-inline-error" role="alert">
          <Codicon name="error" /> {error}
        </p>
      )}
      {saved && (
        <label className="tm-ai-key-models">
          <span className="tm-muted">Models{suggested.length ? ` (besides ${suggested.slice(0, 3).join(", ")}${suggested.length > 3 ? "…" : ""})` : ""}</span>
          <input className="tm-input tm-input--wide" placeholder="Other model ids, separated by commas" value={models} onChange={(e) => setModels(e.target.value)} onBlur={() => setCustomModels(id, models.split(","))} data-testid="ai-key-models" />
        </label>
      )}
    </div>
  );
}

export function AiKeysSettingsSection({ query }: { query: string }) {
  const status = useAi((s) => s.status);
  const loaded = useAiKeys((s) => s.loaded);
  useEffect(() => {
    if (!loaded) void loadAiKeys().catch(() => {});
    if (!useAi.getState().status) void refreshAiStatus();
  }, [loaded]);
  if (!aiKeysMatch(query)) return null;
  const tiers = status?.tiers;
  const providers = status?.byok_providers?.length ? status.byok_providers : BYOK_PROVIDERS.map((id) => ({ id, label: providerLabel(id), suggested_models: [] as string[] }));
  const premium = tiers?.premium ? status?.premium_you : null;
  let body;
  if (!aiKeysSupported()) body = <p className="tm-muted">Your own API keys need the TMCode desktop app (they are kept in your computer's keychain).</p>;
  else if (!tiers) body = <p className="tm-muted" data-testid="ai-keys-unavailable">{status ? "Your Task Mentor doesn't accept own API keys yet. Ask your school to update it." : "Checking with Task Mentor…"}</p>;
  else if (!tiers.byok) body = <p className="tm-muted" data-testid="ai-keys-unavailable">Your school has turned own API keys off.</p>;
  else body = providers.map((p) => <ProviderRow key={p.id} id={p.id} label={p.label} suggested={p.suggested_models ?? []} />);
  return (
    <section id="settings-TMCode AI" className="tm-settings-section" data-testid="ai-keys-settings">
      <h3>TMCode AI</h3>
      {tiers?.premium && (
        <div className="tm-setting" data-testid="ai-premium-note">
          <div className="tm-setting-title">
            <strong>Premium AI</strong>
          </div>
          <div className="tm-setting-description">
            Your school gives you its premium models{premium ? `: ${Math.max(0, premium.limit - premium.used)} of ${premium.limit} requests left today` : ""}. Pick one in TMCode AI's model menu.
          </div>
        </div>
      )}
      <div className="tm-setting">
        <div className="tm-setting-title">
          <strong>Your API keys</strong>
        </div>
        <div className="tm-setting-description">
          Use your own key from an AI provider for TMCode AI (chat, agent, Draft with AI). The key stays in this computer's keychain; TMCode sends it to Task Mentor with each request, which uses it for that request only and never stores it. The provider bills your account. Your school's AI rules still apply.
        </div>
        <div className="tm-setting-control tm-ai-keys">{body}</div>
      </div>
    </section>
  );
}
