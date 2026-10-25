import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { recordActivity } from "../activity/log";
import { rememberAiCopy } from "../activity/sources";
import { monaco } from "../monaco/setup";
import { listFiles } from "../parts/search/search";
import { signIn, useProjects } from "../projects/service";
import { activeFilePath, getPlatform, notify, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { Codicon } from "../widgets/icons";
import { renderMarkdown } from "../widgets/markdown";
import { AiExtensions } from "./AiExtensions";
import { useAiGate } from "./gate";
import { insertAtCursor, proposeEdit } from "./apply";
import { approveStep, ask, MODES, newChat, referTo, resend, startBuilding, stopAnswer, undoRequest, useChat, type ChatMode, type Message, type Step } from "./chat";
import { loadAiSettings, modeLabel, refreshAiStatus, setAgentMode, setAiMode, setAiSuggestions, useAi } from "./service";

/**
 * TMCode AI's panel (secondary side bar), modelled on Claude Code's: pick a mode (Chat, Manual,
 * Edit automatically, Plan, Auto; ⇧Tab cycles), ask, and watch the answer, and in the agent modes
 * every step on the project, approving what the mode asks you to. Copy, edit, retry or refer to
 * any message; @-mention files; ↑/↓ for earlier prompts. Free AI only (Free, Auto or one model).
 */

export { ask } from "./chat";

const copyText = (text: string) => void (getPlatform().clipboard?.writeText(text) ?? navigator.clipboard.writeText(text)).catch(() => undefined);

// ── rendering ──

type Part = { kind: "md"; text: string } | { kind: "code"; lang: string; code: string; file: string | null; open: boolean };

/** Markdown with its fenced code blocks split out (a block still streaming is "open"). */
export function splitAnswer(src: string): Part[] {
  const parts: Part[] = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const before = src.slice(last, m.index);
    // "app.js:" or "`app.js`" on the line before a block names the file it belongs to.
    const fileLine = /(?:^|\n)\s*(?:\*\*)?`?([\w./-]+\.[\w]+)`?(?:\*\*)?:?\s*$/.exec(before);
    if (before) parts.push({ kind: "md", text: before });
    parts.push({ kind: "code", lang: m[1], code: m[2], file: fileLine?.[1] ?? null, open: m[3] !== "```" });
    last = m.index + m[0].length;
    if (m[3] !== "```") break;
  }
  if (last < src.length) parts.push({ kind: "md", text: src.slice(last) });
  return parts;
}

/**
 * The file a code block belongs to: the open file when the answer names it (or names nothing),
 * else a file of the folder with that name ("app.js" → "js/app.js"), else the open file.
 */
function resolveTarget(named: string | null): string | null {
  const active = activeFilePath();
  if (!named) return active;
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  if (active && (active === named || active.endsWith(`/${named}`) || base(active) === base(named))) return active;
  const s = useWorkbench.getState();
  const known = Object.values(s.dirs)
    .flat()
    .filter((e) => e.kind === "file")
    .map((e) => e.path);
  return known.find((p) => p === named) ?? known.find((p) => p.endsWith(`/${named}`)) ?? active;
}

function CodeBlock({ part, model }: { part: Extract<Part, { kind: "code" }>; model: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || part.open) return;
    const lang = part.lang && monaco.languages.getLanguages().some((l) => l.id === part.lang || l.aliases?.includes(part.lang)) ? part.lang : "plaintext";
    void monaco.editor.colorize(part.code, lang, { tabSize: 2 }).then((html) => {
      if (ref.current) ref.current.innerHTML = DOMPurify.sanitize(html);
    });
  }, [part.code, part.lang, part.open]);
  const target = resolveTarget(part.file);
  return (
    <div className="tm-chat-code">
      <div className="tm-chat-code-bar">
        <span className="tm-chat-code-lang">{part.file ?? (part.lang || "code")}</span>
        <button
          type="button"
          className="tm-chat-code-btn"
          title="Copy"
          onClick={() => {
            void (getPlatform().clipboard?.writeText(part.code) ?? navigator.clipboard.writeText(part.code)).catch(() => undefined);
            rememberAiCopy(part.code, "TMCode AI");
            recordActivity({ kind: "ai", action: "copy", text: `Copied code from TMCode AI's answer (${part.code.split("\n").length} lines)`, data: { chars: part.code.length }, actor: { type: "you" }, ai: { by: "TMCode AI", how: "code copied from the answer", model } });
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          disabled={part.open}
        >
          <Codicon name={copied ? "check" : "copy"} />
        </button>
        <button type="button" className="tm-chat-code-btn" title="Insert at Cursor" onClick={() => insertAtCursor(part.code, model)} disabled={part.open} data-testid="ai-insert">
          <Codicon name="insert" />
        </button>
        <button
          type="button"
          className="tm-chat-code-btn is-primary"
          title={target ? `Apply to ${target} (shows the change first)` : "Open a file to apply this code"}
          onClick={() => (target ? void proposeEdit(target, part.code, model) : notify("info", "Open the file this code belongs to, then Apply."))}
          disabled={part.open}
          data-testid="ai-apply"
        >
          <Codicon name="sparkle" /> Apply
        </button>
      </div>
      <pre ref={ref} className="tm-chat-code-body">
        {part.code}
      </pre>
    </div>
  );
}


/** A small line diff (changed lines with − / +), for step cards and approvals. */
export function lineDiff(before: string, after: string, max = 60): { kind: "add" | "del" | "same"; text: string }[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  const out: { kind: "add" | "del" | "same"; text: string }[] = [];
  if (s > 0) out.push({ kind: "same", text: a[s - 1] });
  for (let i = s; i <= ea; i++) out.push({ kind: "del", text: a[i] });
  for (let i = s; i <= eb; i++) out.push({ kind: "add", text: b[i] });
  if (ea + 1 < a.length) out.push({ kind: "same", text: a[ea + 1] });
  return out.slice(0, max);
}

function Diff({ d }: { d: NonNullable<Step["diff"]> }) {
  const rows = useMemo(() => lineDiff(d.before, d.after), [d.before, d.after]);
  return (
    <pre className="tm-chat-diff">
      {rows.map((r, i) => (
        <div key={i} className={`is-${r.kind}`}>
          <span className="tm-chat-diff-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
          {r.text || " "}
        </div>
      ))}
    </pre>
  );
}

const STEP_ICON: Record<string, string> = { list_files: "list-tree", read_file: "file", search: "search", get_problems: "warning", edit_file: "edit", write_file: "new-file", rename_file: "replace", delete_file: "trash", run_command: "terminal" };

function StepCard({ messageId, step }: { messageId: number; step: Step }) {
  const [open, setOpen] = useState(step.status === "waiting");
  useEffect(() => setOpen(step.status === "waiting" || (open && step.status !== "done")), [step.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const detail = !!(step.diff || step.command || step.output);
  return (
    <div className={`tm-chat-step is-${step.status}`} data-testid="ai-step" data-status={step.status}>
      <button type="button" className="tm-chat-step-head" onClick={() => detail && setOpen(!open)} aria-expanded={open}>
        <Codicon name={step.status === "running" ? "loading" : step.status === "failed" ? "error" : step.status === "rejected" || step.status === "refused" ? "circle-slash" : STEP_ICON[step.tool] ?? "tools"} className={step.status === "running" ? "codicon-modifier-spin" : ""} />
        <span className="tm-chat-step-title">{step.title}</span>
        {step.status === "waiting" && <span className="tm-chat-step-badge">Needs your OK</span>}
        {step.status === "rejected" && <span className="tm-chat-step-badge is-muted">Declined</span>}
        {detail && <Codicon name={open ? "chevron-down" : "chevron-right"} className="tm-chat-step-chev" />}
      </button>
      {open && (
        <div className="tm-chat-step-body">
          {step.command && <pre className="tm-chat-cmd">$ {step.command}</pre>}
          {step.diff && <Diff d={step.diff} />}
          {step.output && <pre className="tm-chat-cmd-out">{step.output}</pre>}
        </div>
      )}
      {step.status === "waiting" && (
        <div className="tm-chat-approve">
          <button type="button" className="tm-chat-btn is-primary" onClick={() => approveStep(messageId, step.id, true)} data-testid="ai-approve">
            <Codicon name="check" /> {step.tool === "run_command" ? "Run" : "Approve"}
          </button>
          <button type="button" className="tm-chat-btn" onClick={() => approveStep(messageId, step.id, true, true)} title="Allow the rest of this request without asking" data-testid="ai-approve-all">
            Approve all
          </button>
          <button type="button" className="tm-chat-btn" onClick={() => approveStep(messageId, step.id, false)} data-testid="ai-reject">
            <Codicon name="close" /> Reject
          </button>
        </div>
      )}
    </div>
  );
}

function MessageActions({ m }: { m: Message }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="tm-chat-actions">
      <button
        type="button"
        title="Copy"
        aria-label="Copy"
        onClick={() => {
          copyText(m.content);
          if (m.role === "assistant") rememberAiCopy(m.content, "TMCode AI");
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        data-testid="ai-copy-message"
      >
        <Codicon name={copied ? "check" : "copy"} />
      </button>
      {m.role === "user" ? (
        <>
          <button type="button" title="Edit and send again" aria-label="Edit" onClick={() => editPrompt(m)} data-testid="ai-edit-prompt">
            <Codicon name="edit" />
          </button>
          <button type="button" title="Send again" aria-label="Send again" onClick={() => resend(m.id)} data-testid="ai-retry">
            <Codicon name="refresh" />
          </button>
        </>
      ) : (
        <button type="button" title="Ask about this answer" aria-label="Ask about this answer" onClick={() => referTo(m.id)} data-testid="ai-refer">
          <Codicon name="reply" />
        </button>
      )}
    </div>
  );
}

let editPrompt: (m: Message) => void = () => undefined;

function Answer({ m }: { m: Message }) {
  const parts = useMemo(() => splitAnswer(m.content), [m.content]);
  const model = m.provider ? `${m.provider} · ${m.model}` : (m.model ?? "");
  const busy = useChat((s) => s.busy);
  return (
    <div className="tm-chat-answer">
      {!!m.steps?.length && (
        <div className="tm-chat-steps">
          {m.steps.map((s) => (
            <StepCard key={s.id} messageId={m.id} step={s} />
          ))}
        </div>
      )}
      {parts.map((p, i) =>
        p.kind === "md" ? (
          <div key={i} className="tm-chat-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(p.text)) }} />
        ) : (
          <CodeBlock key={i} part={p} model={model} />
        ),
      )}
      {m.streaming && !m.content && !m.steps?.length && (
        <div className="tm-chat-thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
        </div>
      )}
      {m.checkpoint && (
        <div className="tm-chat-checkpoint" data-testid="ai-checkpoint">
          <Codicon name="history" />
          <span>
            {m.checkpoint.undone ? "Undone: " : "Changed "}
            {m.checkpoint.files.map((f) => f.slice(f.lastIndexOf("/") + 1)).join(", ")}
          </span>
          {!m.checkpoint.undone && !m.streaming && (
            <button type="button" className="tm-link-button" onClick={() => void undoRequest(m.id)} data-testid="ai-undo-all">
              Undo all
            </button>
          )}
        </div>
      )}
      {m.mode === "plan" && !m.streaming && !m.error && m.content.trim() && (
        <div className="tm-chat-approve">
          <button type="button" className="tm-chat-btn is-primary" onClick={() => startBuilding("edit")} disabled={busy} data-testid="ai-start-building">
            <Codicon name="play" /> Start building
          </button>
          <button type="button" className="tm-chat-btn" onClick={() => startBuilding("manual")} disabled={busy}>
            Build, asking before each change
          </button>
        </div>
      )}
      {m.error && (
        <div className="tm-chat-error" role="alert">
          <Codicon name="warning" /> {m.error.message}
          {["PROVIDER_QUOTA", "POOL_EXHAUSTED", "NOT_CONFIGURED", "MODEL_UNKNOWN"].includes(m.error.code) && useAi.getState().mode !== "auto" && (
            <button type="button" className="tm-link-button" onClick={() => setAiMode("auto")}>
              Switch to Auto
            </button>
          )}
          {m.error.code === "SIGNED_OUT" && (
            <button type="button" className="tm-link-button" onClick={() => void signIn()}>
              Sign in
            </button>
          )}
        </div>
      )}
      {!m.streaming && (
        <div className="tm-chat-foot">
          {m.model && !m.error && (
            <span className="tm-chat-meta">
              <Codicon name="sparkle" /> {m.model.replace(/:free$/, "")} · {m.provider}
            </span>
          )}
          {m.content && <MessageActions m={m} />}
        </div>
      )}
    </div>
  );
}

export async function pickMode() {
  const { status, mode } = useAi.getState();
  const items = [
    ...(status?.modes ?? [
      { id: "free", label: "Free (OpenRouter)", detail: "" },
      { id: "auto", label: "Auto", detail: "" },
    ]).map((m) => ({ id: m.id, label: m.label, detail: m.detail, icon: m.id === mode ? "check" : m.id === "auto" ? "sparkle" : "gift" })),
    ...(status?.models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.providerLabel, icon: m.id === mode ? "check" : "circuit-board" })),
  ];
  const picked = await showQuickPick({ title: "Which AI answers", placeholder: "Free AI only. Auto picks one that still has requests left today (best for agent modes).", items, matchOnDescription: true });
  if (picked) setAiMode(picked.id);
}

/** The modes menu, as Claude Code's ("Modes · ⇧Tab to switch"). */
function ModeMenu({ onClose }: { onClose: () => void }) {
  const current = useAi((s) => s.agentMode);
  useEffect(() => {
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest(".tm-chat-modes, .tm-chat-agent-mode") && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  return (
    <div className="tm-chat-modes" role="menu" data-testid="ai-modes">
      <div className="tm-chat-modes-head">
        Modes <span className="tm-chat-kbd">⇧</span> + <span className="tm-chat-kbd">tab</span> to switch
      </div>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          role="menuitemradio"
          aria-checked={current === m.id}
          className={`tm-chat-mode-item ${current === m.id ? "is-on" : ""}`}
          onClick={() => {
            setAgentMode(m.id);
            onClose();
          }}
          data-testid={`ai-mode-${m.id}`}
        >
          <Codicon name={m.icon} />
          <span className="tm-chat-mode-text">
            <strong>{m.label}</strong>
            <span>{m.detail}</span>
          </span>
          {current === m.id && <Codicon name="check" />}
        </button>
      ))}
    </div>
  );
}

/** "@app" → the project's files whose path matches, for @-mentions. */
let fileCache: { at: number; files: string[] } | null = null;
async function projectFiles(): Promise<string[]> {
  if (fileCache && Date.now() - fileCache.at < 15_000) return fileCache.files;
  const files = await listFiles(getPlatform().fs).catch(() => [] as string[]);
  fileCache = { at: Date.now(), files };
  return files;
}

const STARTERS = [
  { icon: "book", label: "Explain this code", prompt: "Explain what this code does, step by step." },
  { icon: "bug", label: "Find and fix bugs", prompt: "Find the bugs in this code and fix them." },
  { icon: "beaker", label: "Write tests", prompt: "Write unit tests for this code." },
  { icon: "lightbulb", label: "Make it better", prompt: "Make this code clearer and better." },
];

export function ChatView() {
  const messages = useChat((s) => s.messages);
  const busy = useChat((s) => s.busy);
  const history = useChat((s) => s.history);
  const reference = useChat((s) => s.reference);
  const { status, mode, suggestions, error, agentMode } = useAi();
  const signedIn = useProjects((s) => !!s.account?.signed_in);
  const gate = useAiGate();
  const projectId = useAi((s) => s.project.id);
  const [text, setText] = useState("");
  const [withFile, setWithFile] = useState(true);
  const [withProblems, setWithProblems] = useState(true);
  const [modesOpen, setModesOpen] = useState(false);
  const [mentions, setMentions] = useState<string[]>([]);
  const [suggest, setSuggest] = useState<{ query: string; items: string[]; index: number } | null>(null);
  const historyAt = useRef<number | null>(null);
  const file = useWorkbench((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroup);
    const e = g?.editors.find((x) => x.id === g.activeId);
    return e?.kind === "file" ? e.path : null;
  });
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  editPrompt = (m) => {
    setText(m.content);
    const i = useChat.getState().messages.findIndex((x) => x.id === m.id);
    if (i >= 0) useChat.setState((s) => ({ messages: s.messages.slice(0, i) }));
    setTimeout(() => input.current?.focus(), 0);
  };

  useEffect(() => {
    void loadAiSettings();
  }, []);
  useEffect(() => {
    if (signedIn) void refreshAiStatus();
  }, [signedIn, projectId]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => {
    if (reference) input.current?.focus();
  }, [reference]);

  if (!gate.chat) {
    return (
      <div className="tm-chat tm-chat-off" data-testid="tmcode-ai-chat" data-reason={gate.reason ?? undefined}>
        <Codicon name="lock" />
        <span data-testid="ai-lock-message">{gate.message ?? "TMCode AI is off."}</span>
      </div>
    );
  }
  if (!signedIn) {
    return (
      <div className="tm-chat tm-chat-welcome" data-testid="tmcode-ai-chat">
        <div className="tm-chat-hero">
          <Codicon name="sparkle" />
          <h2>TMCode AI</h2>
          <p>Ask about your code, or let it work on your project with you. Free AI, through your NGA account.</p>
          <button type="button" className="tm-button" onClick={() => void signIn()}>
            Sign in to use TMCode AI
          </button>
        </div>
        <AiExtensions />
      </div>
    );
  }

  const send = (q = text) => {
    if (!q.trim() || busy) return;
    const used = mentions.filter((m) => q.includes(`@${m}`));
    setText("");
    setMentions([]);
    setSuggest(null);
    historyAt.current = null;
    void ask(q, { file: withFile, problems: withProblems, mentions: used });
  };

  const cycleMode = () => {
    const i = MODES.findIndex((m) => m.id === agentMode);
    setAgentMode(MODES[(i + 1) % MODES.length].id as ChatMode);
  };

  const updateSuggest = async (value: string, caret: number) => {
    const m = /(^|\s)@([\w./-]*)$/.exec(value.slice(0, caret));
    if (!m) return setSuggest(null);
    const q = m[2].toLowerCase();
    const items = (await projectFiles()).filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
    setSuggest(items.length ? { query: m[2], items, index: 0 } : null);
  };

  const pickMention = (path: string) => {
    const el = input.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([\w./-]*)$/, `@${path} `);
    setText(before + text.slice(caret));
    setMentions((m) => [...new Set([...m, path])]);
    setSuggest(null);
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    }, 0);
  };

  const left = status ? Math.max(0, status.you.chat.limit - status.you.chat.used) : null;
  const or = status?.openrouter;
  const current = MODES.find((m) => m.id === agentMode) ?? MODES[1];

  return (
    <div className="tm-chat" data-testid="tmcode-ai-chat">
      <div className="tm-chat-head">
        <div className="tm-chat-agent-wrap">
          <button type="button" className="tm-chat-agent-mode" onClick={() => setModesOpen(!modesOpen)} title={current.detail} data-testid="ai-agent-mode" aria-haspopup="menu" aria-expanded={modesOpen}>
            <Codicon name={current.icon} />
            <span>{current.label}</span>
            <Codicon name="chevron-down" />
          </button>
          {modesOpen && <ModeMenu onClose={() => setModesOpen(false)} />}
        </div>
        <button type="button" className="tm-chat-mode" onClick={() => void pickMode()} title="Which AI answers" data-testid="ai-mode">
          <Codicon name={mode === "auto" ? "sparkle" : mode === "free" ? "gift" : "circuit-board"} />
          <span>{modeLabel(mode, status)}</span>
          <Codicon name="chevron-down" />
        </button>
        <span
          className={`tm-chat-quota ${left !== null && left <= 5 ? "is-low" : ""}`}
          title={[left !== null ? `You: ${left} of ${status!.you.chat.limit} questions left today` : null, status?.you.agent ? `Agent steps: ${status.you.agent.limit - status.you.agent.used} of ${status.you.agent.limit} left today` : null, or ? `School's OpenRouter free requests: ${or.remaining} of ${or.limit} left today` : null].filter(Boolean).join("\n")}
          data-testid="ai-quota"
        >
          {left !== null ? `${left} left today` : error ? "offline" : "…"}
        </span>
        <span className="tm-chat-spacer" />
        <button type="button" className={`tm-chat-icon ${suggestions ? "is-on" : ""}`} title={suggestions ? "Suggestions while typing: on" : "Suggestions while typing: off"} aria-pressed={suggestions} onClick={() => setAiSuggestions(!suggestions)} data-testid="ai-suggestions">
          <Codicon name="lightbulb-autofix" />
        </button>
        <button type="button" className="tm-chat-icon" title="New Chat" onClick={newChat} data-testid="ai-new-chat">
          <Codicon name="add" />
        </button>
      </div>
      <div ref={list} className="tm-chat-list tm-scroll" role="log" aria-live="polite">
        {!messages.length && (
          <div className="tm-chat-empty">
            <div className="tm-chat-hero">
              <Codicon name="sparkle" />
              <h2>{agentMode === "chat" ? "Ask TMCode AI" : "What should we build?"}</h2>
              <p>{agentMode === "chat" ? (file ? `About ${file.slice(file.lastIndexOf("/") + 1)}, or anything about code.` : "Ask anything about code.") : `${current.label}: ${current.detail.toLowerCase()}.`}</p>
            </div>
            <div className="tm-chat-starters">
              {STARTERS.map((s) => (
                <button key={s.label} type="button" className="tm-chat-starter" onClick={() => send(s.prompt)} disabled={!file && s.icon !== "lightbulb"}>
                  <Codicon name={s.icon} /> {s.label}
                </button>
              ))}
            </div>
            <AiExtensions />
            <p className="tm-chat-note">Everything AI does is in your Activity log, and your teacher sees it for linked work.</p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="tm-chat-q">
              <div className="tm-chat-q-text">{m.content}</div>
              <div className="tm-chat-q-foot">
                {m.mode && m.mode !== "chat" && <span className="tm-chat-chip is-mode">{MODES.find((x) => x.id === m.mode)?.label}</span>}
                {m.chips?.map((c) => (
                  <span key={c} className="tm-chat-chip">
                    <Codicon name="file-code" /> {c}
                  </span>
                ))}
                <MessageActions m={m} />
              </div>
            </div>
          ) : (
            <Answer key={m.id} m={m} />
          ),
        )}
      </div>
      <div className="tm-chat-compose">
        {reference && (
          <div className="tm-chat-reference" data-testid="ai-reference">
            <Codicon name="reply" />
            <span>About: {reference.excerpt.slice(0, 120)}</span>
            <button type="button" className="tm-chat-icon" onClick={() => useChat.setState({ reference: null })} aria-label="Remove">
              <Codicon name="close" />
            </button>
          </div>
        )}
        <div className="tm-chat-context">
          {file && (
            <button type="button" className={`tm-chat-chip is-toggle ${withFile ? "is-on" : ""}`} aria-pressed={withFile} onClick={() => setWithFile(!withFile)} title="Send the open file (or the selection) with the question">
              <Codicon name="file-code" /> {file.slice(file.lastIndexOf("/") + 1)}
            </button>
          )}
          {file && (
            <button type="button" className={`tm-chat-chip is-toggle ${withProblems ? "is-on" : ""}`} aria-pressed={withProblems} onClick={() => setWithProblems(!withProblems)} title="Send the file's problems (errors, warnings)">
              <Codicon name="warning" /> Problems
            </button>
          )}
          {mentions.map((m) => (
            <span key={m} className="tm-chat-chip is-on">
              <Codicon name="mention" /> {m.slice(m.lastIndexOf("/") + 1)}
            </span>
          ))}
        </div>
        <div className="tm-chat-input">
          {suggest && (
            <div className="tm-chat-suggest" role="listbox" data-testid="ai-mentions">
              {suggest.items.map((f, i) => (
                <button key={f} type="button" role="option" aria-selected={i === suggest.index} className={i === suggest.index ? "is-on" : ""} onMouseDown={(e) => (e.preventDefault(), pickMention(f))}>
                  <Codicon name="file" /> {f}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            rows={1}
            placeholder={agentMode === "chat" ? (file ? `Ask about ${file.slice(file.lastIndexOf("/") + 1)}…` : "Ask TMCode AI…") : "Describe a change or a fix… (@ adds a file)"}
            aria-label="Ask TMCode AI"
            onChange={(e) => {
              setText(e.target.value);
              historyAt.current = null;
              void updateSuggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (suggest) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const d = e.key === "ArrowDown" ? 1 : -1;
                  setSuggest({ ...suggest, index: (suggest.index + d + suggest.items.length) % suggest.items.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickMention(suggest.items[suggest.index]);
                  return;
                }
                if (e.key === "Escape") return setSuggest(null);
              }
              if (e.key === "Tab" && e.shiftKey) {
                e.preventDefault();
                cycleMode();
                return;
              }
              // ↑/↓: earlier prompts, when the box is empty or the caret is on its first / last line.
              const el = e.currentTarget;
              if (e.key === "ArrowUp" && history.length && !el.value.slice(0, el.selectionStart).includes("\n")) {
                const at = historyAt.current === null ? history.length - 1 : Math.max(0, historyAt.current - 1);
                if (historyAt.current === null && el.value.trim()) return;
                e.preventDefault();
                historyAt.current = at;
                setText(history[at]);
                return;
              }
              if (e.key === "ArrowDown" && historyAt.current !== null) {
                e.preventDefault();
                const at = historyAt.current + 1;
                historyAt.current = at < history.length ? at : null;
                setText(at < history.length ? history[at] : "");
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            data-testid="ai-input"
          />
          {busy ? (
            <button type="button" className="tm-chat-send is-stop" onClick={stopAnswer} title="Stop" aria-label="Stop" data-testid="ai-stop">
              <Codicon name="debug-stop" />
            </button>
          ) : (
            <button type="button" className="tm-chat-send" onClick={() => send()} disabled={!text.trim()} title="Send (Enter)" aria-label="Send" data-testid="ai-send">
              <Codicon name="send" />
            </button>
          )}
        </div>
        <div className="tm-chat-hint">
          Enter to send · Shift+Enter new line · ⇧Tab mode · @ file · ↑ earlier prompts
        </div>
      </div>
    </div>
  );
}
