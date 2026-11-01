import { useEffect, useState } from "react";
import { getPlatform, notify } from "../state/store";
import { Codicon } from "../widgets/icons";
import { aiKeysSupported, BYOK_PROVIDERS, KEY_PAGES, keyShapeWarning, loadAiKeys, providerLabel, removeAiKey, saveAiKey, setCustomModels, useAiKeys, verifyAiKey, type KeyCheck } from "./keys";
import { CLI_IDS, CLIS, cliBlocked, cliOf, detectAllClis, detectCli, installCli, installCommand, openCliPlans, signInCli, signOutCli, useAiClis, type CliId } from "./aiClis";
import { useAiGate } from "./gate";
import { refreshAiStatus, setAiMode, useAi } from "./service";

/**
 * Settings › TMCode AI › Your API keys: add or remove a key per provider (kept in the OS keychain,
 * ai/keys.ts) and extra model ids. Shown only where Task Mentor accepts own keys (`tiers.byok`).
 */

const WORDS = "tmcode ai api keys key byok own provider openai anthropic gemini openrouter groq deepseek premium model accounts account claude code chatgpt codex google sign in login plan cli";

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
  const [check, setCheck] = useState<KeyCheck | "checking" | null>(null);
  const mode = useAi((s) => s.mode);
  const shape = editing ? keyShapeWarning(id, key) : null;
  const allModels = [...new Set([...suggested, ...custom])];
  const test = async (model?: string) => {
    setCheck("checking");
    setCheck(await verifyAiKey(id, model));
  };
  useEffect(() => setModels(custom.join(", ")), [custom.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await saveAiKey(id, key);
      setKey("");
      setEditing(false);
      notify("info", `Your ${label} key is saved in this computer's keychain. Testing it…`, undefined, { kind: "hint" });
      // Tested at once: a wrong key or no credit shows now, not at the first question.
      void test();
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
            <button type="button" className="tm-button tm-button--small tm-button--secondary" disabled={check === "checking"} onClick={() => void test()} data-testid="ai-key-test">
              {check === "checking" ? "Testing…" : "Test Key"}
            </button>
          )}
          {saved && !editing && (
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => (setCheck(null), void removeAiKey(id))} data-testid="ai-key-remove">
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
      {shape && (
        <p className="tm-ai-key-check is-warn" data-testid="ai-key-shape">
          <Codicon name="warning" /> {shape}
        </p>
      )}
      {error && (
        <p className="tm-grade-inline-error" role="alert">
          <Codicon name="error" /> {error}
        </p>
      )}
      {saved && check && check !== "checking" && (
        <p className={`tm-ai-key-check ${check.ok ? "is-ok" : check.code === "OLD_SERVER" ? "is-warn" : "is-bad"}`} role="status" data-testid="ai-key-check">
          <Codicon name={check.ok ? "pass-filled" : check.code === "OLD_SERVER" ? "info" : "error"} />{" "}
          {check.ok ? `Your key works${check.model ? ` (${check.model} answered)` : ""}.` : check.message}
        </p>
      )}
      {saved && (
        <label className="tm-ai-key-models">
          <span className="tm-muted">Models{suggested.length ? ` (besides ${suggested.slice(0, 3).join(", ")}${suggested.length > 3 ? "…" : ""})` : ""}</span>
          <input className="tm-input tm-input--wide" placeholder="Other model ids, separated by commas" value={models} onChange={(e) => setModels(e.target.value)} onBlur={() => setCustomModels(id, models.split(","))} data-testid="ai-key-models" />
        </label>
      )}
      {saved && allModels.length > 0 && (
        <div className="tm-ai-key-use" data-testid="ai-key-use">
          <span className="tm-muted">Use for TMCode AI:</span>
          {allModels.map((m) => {
            const id2 = `byok:${id}/${m}`;
            const on = mode === id2;
            return (
              <button key={m} type="button" className={`tm-ai-key-model ${on ? "is-on" : ""}`} aria-pressed={on} title={on ? "TMCode AI answers with this model" : `Answer with ${m} on your key`} onClick={() => setAiMode(on ? "free" : id2)}>
                {on && <Codicon name="check" />} {m}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const CLI_STATE: Record<string, string> = { unknown: "Not checked", checking: "Checking…", ready: "Signed in", missing: "Not installed", "signed-out": "Not signed in", unavailable: "Can't check" };

/** One AI CLI (ai/aiClis.ts): its state on this computer and what the user can do with their account. */
function CliAccountRow({ id }: { id: CliId }) {
  const spec = CLIS[id];
  const info = useAiClis((s) => s[id]);
  const mode = useAi((s) => s.mode);
  const using = cliOf(mode) === id;
  return (
    <div className="tm-ai-key-row tm-ai-account" data-testid="ai-account-row" data-cli={id} data-state={info.state}>
      <div className="tm-ai-key-head">
        <strong>{spec.label}</strong>
        <span className={`tm-ai-key-state ${info.state === "ready" ? "is-saved" : ""}`} data-testid="ai-account-state">
          {info.state === "ready" && <Codicon name="pass-filled" />} {CLI_STATE[info.state]}
          {info.state === "ready" && info.account ? ` · ${info.account}` : ""}
          {info.version ? ` · v${info.version}` : ""}
        </span>
        <span className="tm-ai-key-actions">
          {info.state === "missing" && (
            <button type="button" className="tm-button tm-button--small" onClick={() => installCli(id)} data-testid="ai-account-install" title={installCommand(id, getPlatform().os === "windows")}>
              <Codicon name="cloud-download" /> Install
            </button>
          )}
          {info.state === "signed-out" && (
            <button type="button" className="tm-button tm-button--small" onClick={() => signInCli(id)} data-testid="ai-account-signin">
              <Codicon name="account" /> Sign In with {spec.account}
            </button>
          )}
          {info.state === "ready" && !using && (
            <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => setAiMode(`cli:${id}`)} data-testid="ai-account-use">
              Use for TMCode AI
            </button>
          )}
          {info.state === "ready" && using && <span className="tm-ai-account-using">In use</span>}
          {info.state === "ready" && spec.signOut && (
            <button type="button" className="tm-link-button" onClick={() => (using && setAiMode("free"), signOutCli(id))} data-testid="ai-account-signout">
              Sign Out
            </button>
          )}
          {info.state === "ready" && !spec.signOut && (
            <button type="button" className="tm-link-button" onClick={() => signInCli(id)} title={`Opens ${spec.label}: use its ${spec.switchAccount ?? "/auth"} command to switch account`}>
              Switch Account
            </button>
          )}
          <button type="button" className="tm-link-button" onClick={() => openCliPlans(id)} title={`Free or paid: see and change your ${spec.account} plan`}>
            Your Plan
          </button>
          <button type="button" className="tm-chat-icon" title="Check again" aria-label={`Check ${spec.label} again`} onClick={() => void detectCli(id, true)}>
            <Codicon name="refresh" />
          </button>
        </span>
      </div>
      {info.state === "unavailable" && info.detail && <p className="tm-muted">{info.detail}</p>}
      {spec.note && (
        <p className="tm-muted" data-testid="ai-account-note">
          {spec.note}
        </p>
      )}
    </div>
  );
}

/**
 * Settings › TMCode AI › Your AI accounts: Claude Code, ChatGPT (Codex), Gemini (Antigravity) and Gemini CLI signed in
 * with the user's own accounts, to answer TMCode AI without copying code into a browser tab.
 */
function AiAccounts() {
  const gate = useAiGate();
  useEffect(() => {
    if (getPlatform().proc) void detectAllClis();
  }, []);
  let body;
  if (!getPlatform().proc) body = <p className="tm-muted">Your AI accounts need the TMCode desktop app (the AI companies' coding tools run on your computer).</p>;
  else if (!gate.thirdParty) body = <p className="tm-muted" data-testid="ai-accounts-blocked">{cliBlocked()}</p>;
  else body = CLI_IDS.map((id) => <CliAccountRow key={id} id={id} />);
  return (
    <div className="tm-setting" data-testid="ai-accounts">
      <div className="tm-setting-title">
        <strong>Your AI accounts</strong>
      </div>
      <div className="tm-setting-description">
        Sign in to Claude Code, ChatGPT (Codex) or Gemini (Antigravity) with your own account, free or paid, and TMCode AI answers with it: in the chat, in the terminal, and in agent modes (which open it in the terminal). Each runs on this computer with your account and plan; nothing is copied into a browser. Your school&apos;s AI rules still apply, and what each one does is in your activity log.
      </div>
      <div className="tm-setting-control tm-ai-keys">{body}</div>
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
      {tiers && !tiers.premium && (
        <div className="tm-setting" data-testid="ai-premium-off">
          <div className="tm-setting-title">
            <strong>Premium AI</strong>
          </div>
          <div className="tm-setting-description">
            Not turned on for your account. Your school can give you its premium models (Task Mentor › Admin › AI), or use your own API key below.
          </div>
        </div>
      )}
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
      <AiAccounts />
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
