import { useEffect, useRef, useState } from "react";
import { CommandChip } from "../../activity/ActivityView";
import { pickMode, openAiKeysSettings } from "../../ai/ChatView";
import { useAiGate } from "../../ai/gate";
import { refreshAiStatus, setAiMode, useAi } from "../../ai/service";
import { getPlatform, notify } from "../../state/store";
import { Codicon } from "../../widgets/icons";
import { insertableText } from "../../terminal/ai";
import { applyCard, askTerminalAi, cancelTerminalAi, closeTerminalAi, currentModelLabel, resetTerminalAi, terminalAiHost, useTerminalAi, type CommandCard } from "../../terminal/aiSession";

/**
 * TMCode AI in the terminal (⌘I / Ctrl+I, the ✨ in the panel header, "# words" at the prompt):
 * a box over the bottom of the terminal. Say what you want in your own words; the answer comes
 * back as commands to Run, Insert at the prompt, or Copy. Follow-ups refine it. Nothing runs
 * until you click, and dangerous commands ask twice.
 */

const EXAMPLES = ["Find files bigger than 100 MB here", "Undo my last commit but keep the changes", "Stop whatever is using port 3000", "Show which folders take the most space"];

const RISK_WORDS: Record<CommandCard["risk"], string> = { safe: "", caution: "Careful", danger: "Dangerous" };

const mac = () => getPlatform().os === "mac";
const keyLabel = (k: string) => (mac() ? k.replace("mod+", "⌘").replace("alt+", "⌥").replace("enter", "↵") : k.replace("mod+", "Ctrl+").replace("alt+", "Alt+").replace("enter", "Enter"));

export function TerminalAi() {
  const s = useTerminalAi();
  const gate = useAiGate();
  const mode = useAi((x) => x.mode);
  const status = useAi((x) => x.status);
  const [text, setText] = useState("");
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [confirming, setConfirming] = useState<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const shell = terminalAiHost()?.shell ?? "";

  useEffect(() => {
    if (!s.open) return;
    if (!useAi.getState().status) void refreshAiStatus();
    requestAnimationFrame(() => input.current?.focus());
  }, [s.open, s.focusSeq]);
  useEffect(() => {
    setConfirming(null);
    if (s.phase === "done") requestAnimationFrame(() => input.current?.focus());
  }, [s.phase, s.answer]);

  if (!s.open) return null;

  const submit = () => {
    const v = text.trim();
    if (!v || s.phase === "asking" || !gate.chat) return;
    setText("");
    setHistoryAt(null);
    void askTerminalAi("ask", v);
  };

  const use = (i: number, how: "run" | "insert") => {
    const card = s.answer?.commands[i];
    if (!card) return;
    if (how === "run" && card.risk === "danger" && confirming !== i) {
      setConfirming(i);
      return;
    }
    applyCard(card, how, insertableText(card.command, shell));
  };

  const copy = async (command: string) => {
    try {
      const clip = getPlatform().clipboard;
      await (clip ? clip.writeText(command) : navigator.clipboard.writeText(command));
      notify("info", "Command copied.", undefined, { kind: "hint" });
    } catch {
      notify("warning", "Could not copy the command to the clipboard.");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = mac() ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      if (s.phase === "asking") cancelTerminalAi();
      else closeTerminalAi(true);
      return;
    }
    if (e.key === "Enter" && mod && s.answer?.commands.length) {
      e.preventDefault();
      return use(confirming ?? 0, "run");
    }
    if (e.key === "Enter" && e.altKey && s.answer?.commands.length) {
      e.preventDefault();
      return use(0, "insert");
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      return submit();
    }
    // ↑/↓ in an empty (or recalled) box: earlier requests.
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && (!text || historyAt !== null) && s.history.length) {
      e.preventDefault();
      const last = s.history.length - 1;
      const next = e.key === "ArrowUp" ? (historyAt === null ? last : Math.max(0, historyAt - 1)) : historyAt === null ? null : historyAt + 1 > last ? null : historyAt + 1;
      setHistoryAt(next);
      setText(next === null ? "" : s.history[next]);
    }
  };

  const code = s.error?.code ?? "";
  const paidError = ["PREMIUM_REQUIRED", "PREMIUM_QUOTA", "BYOK_REJECTED", "BYOK_MISSING", "BYOK_DISABLED", "BYOK_KEY_REQUIRED", "MODEL_UNKNOWN"].includes(code);
  const title = s.kind === "fix" ? "Fix with TMCode AI" : s.kind === "explain" ? "Explain with TMCode AI" : "Ask TMCode AI";
  const placeholder = !gate.chat ? "TMCode AI is off" : s.answer ? "Ask a follow-up to refine… (e.g. only in the src folder)" : "Say what you want to do, in your own words…";

  return (
    <div
      ref={box}
      className="tm-term-ai"
      role="dialog"
      aria-label={title}
      data-testid="terminal-ai"
      data-phase={s.phase}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="tm-term-ai-head">
        <span className="tm-term-ai-title">
          <Codicon name="sparkle" /> {title}
        </span>
        <button type="button" className="tm-chat-mode tm-term-ai-model" onClick={() => void pickMode()} title="Which AI answers (Free, Auto, Premium or your own key)" data-testid="terminal-ai-model">
          <Codicon name={mode === "auto" ? "sparkle" : mode === "free" ? "gift" : mode.startsWith("premium:") ? "star-full" : mode.startsWith("byok:") ? "key" : "circuit-board"} />
          <span>{currentModelLabel()}</span>
          <Codicon name="chevron-down" />
        </button>
        {status?.you.chat && <span className="tm-term-ai-quota">{Math.max(0, status.you.chat.limit - status.you.chat.used)} left today</span>}
        <span className="tm-chat-spacer" />
        {(s.answer || s.error) && (
          <button type="button" className="tm-chat-icon" title="New question" onClick={() => (setText(""), resetTerminalAi())} data-testid="terminal-ai-new">
            <Codicon name="add" />
          </button>
        )}
        <button type="button" className="tm-chat-icon" title="Close (Esc)" onClick={() => closeTerminalAi(true)} data-testid="terminal-ai-close">
          <Codicon name="close" />
        </button>
      </div>

      <div className="tm-term-ai-body tm-scroll" aria-live="polite">
        {!gate.chat && (
          <p className="tm-term-ai-lock" data-testid="terminal-ai-locked">
            <Codicon name="lock" /> {gate.message}
          </p>
        )}

        {gate.chat && s.phase === "idle" && (
          <div className="tm-term-ai-idle">
            <div className="tm-term-ai-examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" className="tm-term-ai-example" onClick={() => void askTerminalAi("ask", ex)}>
                  {ex}
                </button>
              ))}
            </div>
            <p className="tm-term-ai-tip">
              <Codicon name="lightbulb" /> Tip: type <kbd>#</kbd> and your words at the prompt (<code># list the files changed today</code>), then press Enter.
            </p>
          </div>
        )}

        {s.request && s.phase !== "idle" && (
          <div className="tm-term-ai-request">
            {s.kind === "ask" ? <span>{s.request}</span> : <CommandChip command={s.request} wrap />}
          </div>
        )}

        {s.phase === "asking" && (
          <div className="tm-term-ai-thinking" data-testid="terminal-ai-thinking">
            <span className="tm-term-ai-shimmer" />
            <span className="tm-term-ai-shimmer is-short" />
            <span className="tm-term-ai-status">
              <Codicon name="loading" className="codicon-modifier-spin" /> {s.by ? `${s.by} is writing…` : "Thinking…"}
              <button type="button" className="tm-link-button" onClick={cancelTerminalAi}>
                Stop
              </button>
            </span>
          </div>
        )}

        {s.answer && s.phase !== "asking" && (
          <div className="tm-term-ai-answer" data-testid="terminal-ai-answer">
            {s.answer.explanation && <p className="tm-term-ai-explanation">{s.answer.explanation}</p>}
            {s.answer.question && (
              <p className="tm-term-ai-question">
                <Codicon name="question" /> {s.answer.question}
              </p>
            )}
            {s.answer.commands.map((c, i) => (
              <div key={`${i}:${c.command}`} className={`tm-term-ai-card is-${c.risk}`} data-testid="terminal-ai-card" data-risk={c.risk}>
                <CommandChip command={c.command} wrap />
                {c.explanation && <p className="tm-term-ai-card-why">{c.explanation}</p>}
                {c.risk !== "safe" && (
                  <p className={`tm-term-ai-risk is-${c.risk}`} data-testid="terminal-ai-risk">
                    <Codicon name={c.risk === "danger" ? "warning" : "info"} /> {RISK_WORDS[c.risk]}
                    {c.why ? `: this ${c.why}.` : ". Check it before you run it."}
                  </p>
                )}
                {confirming === i ? (
                  <div className="tm-term-ai-actions is-confirm">
                    <span>Run it anyway?</span>
                    <button type="button" className="tm-button tm-button--small tm-button--danger" onClick={() => use(i, "run")} data-testid="terminal-ai-confirm">
                      Run Anyway
                    </button>
                    <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => setConfirming(null)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="tm-term-ai-actions">
                    <button type="button" className="tm-button tm-button--small" onClick={() => use(i, "run")} title={i === 0 ? `Run (${keyLabel("mod+enter")})` : "Run"} data-testid="terminal-ai-run">
                      <Codicon name="play" /> {c.risk === "danger" ? "Run…" : "Run"}
                      {i === 0 && <kbd>{keyLabel("mod+enter")}</kbd>}
                    </button>
                    <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => use(i, "insert")} title={i === 0 ? `Put it at the prompt without running (${keyLabel("alt+enter")})` : "Put it at the prompt without running"} data-testid="terminal-ai-insert">
                      <Codicon name="insert" /> Insert
                    </button>
                    <button type="button" className="tm-chat-icon" onClick={() => void copy(c.command)} title="Copy" data-testid="terminal-ai-copy">
                      <Codicon name="copy" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {s.phase === "error" && s.error && (
          <div className="tm-term-ai-error" role="alert" data-testid="terminal-ai-error">
            <p>
              <Codicon name="error" /> {s.error.message}
            </p>
            <div className="tm-term-ai-actions">
              {paidError && (
                <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => (setAiMode("free"), void askTerminalAi(s.kind, s.kind === "ask" ? s.request : ""))}>
                  Switch to Free and Retry
                </button>
              )}
              {code.startsWith("BYOK") && (
                <button type="button" className="tm-link-button" onClick={openAiKeysSettings}>
                  Your API keys
                </button>
              )}
              {["OFFLINE", "INTERRUPTED", "EMPTY", "FAILED", "PROVIDER_FAILED", "PROVIDER_QUOTA", "USER_QUOTA"].includes(code) && (
                <button type="button" className="tm-button tm-button--small tm-button--secondary" onClick={() => void askTerminalAi(s.kind, s.kind === "ask" ? s.request : "")}>
                  Try Again
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="tm-term-ai-input">
        <textarea
          ref={input}
          rows={1}
          className="tm-term-ai-textarea"
          value={text}
          disabled={!gate.chat}
          placeholder={placeholder}
          aria-label="Ask TMCode AI about the terminal"
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            setHistoryAt(null);
          }}
          onKeyDown={onKeyDown}
          data-testid="terminal-ai-input"
        />
        <button type="button" className="tm-term-ai-send" disabled={!text.trim() || s.phase === "asking" || !gate.chat} onClick={submit} title="Ask (Enter)" data-testid="terminal-ai-send">
          <Codicon name="send" />
        </button>
      </div>
      <div className="tm-term-ai-foot">
        AI can be wrong: read a command before you run it.
        {s.answer?.commands.length ? (
          <span>
            <kbd>{keyLabel("mod+enter")}</kbd> run · <kbd>{keyLabel("alt+enter")}</kbd> insert · <kbd>Esc</kbd> close
          </span>
        ) : (
          <span>
            <kbd>Enter</kbd> ask · <kbd>↑</kbd> earlier · <kbd>Esc</kbd> close
          </span>
        )}
      </div>
    </div>
  );
}

/** "This command failed. ✨ Fix with AI": beside the terminal after a failed command. */
export function FixHint({ command, onFix, onExplain, onDismiss }: { command: string; onFix(): void; onExplain(): void; onDismiss(): void }) {
  return (
    <div className="tm-term-ai-hint" role="status" data-testid="terminal-ai-hint">
      <Codicon name="error" />
      <span className="tm-term-ai-hint-text" title={command}>
        <strong>{command.length > 40 ? `${command.slice(0, 37)}…` : command}</strong> failed
      </span>
      <button type="button" className="tm-term-ai-hint-fix" onClick={onFix} data-testid="terminal-ai-fix">
        <Codicon name="sparkle" /> Fix with AI
      </button>
      <button type="button" className="tm-link-button" onClick={onExplain}>
        Explain
      </button>
      <button type="button" className="tm-chat-icon" title="Dismiss" aria-label="Dismiss" onClick={onDismiss}>
        <Codicon name="close" />
      </button>
    </div>
  );
}
