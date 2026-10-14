import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { recordActivity } from "../activity/log";
import { rememberAiCopy } from "../activity/sources";
import { useExam } from "../exam/state";
import { monaco } from "../monaco/setup";
import { codeEditorFor } from "../monaco/editors";
import { getDocument, languageForPath } from "../monaco/documents";
import { signIn, useProjects } from "../projects/service";
import { activeFilePath, getPlatform, notify, useWorkbench } from "../state/store";
import { showQuickPick } from "../widgets/QuickPick";
import { Codicon } from "../widgets/icons";
import { renderMarkdown } from "../widgets/markdown";
import { insertAtCursor, proposeEdit } from "./apply";
import { asAiError, chat, loadAiSettings, modeLabel, refreshAiStatus, setAiMode, setAiSuggestions, useAi, type AiRequestError, type ChatContext, type ChatTurn } from "./service";

/**
 * TMCode AI's chat (secondary side bar), as VS Code's Chat view: ask about the open file or the
 * selection, get a streamed answer, and Copy, Insert or Apply its code (Apply shows a diff to
 * accept). Free AI only; the mode picker chooses Free (OpenRouter), Auto or one model.
 */

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Context the question carried ("app.js", "lines 3–8", "2 problems"). */
  chips?: string[];
  model?: string;
  provider?: string;
  streaming?: boolean;
  error?: { code: string; message: string };
}

interface ChatState {
  messages: Message[];
  busy: boolean;
}

export const useChat = create<ChatState>(() => ({ messages: [], busy: false }));
let seq = 0;
let cancelCurrent: (() => void) | null = null;

/** Context for the next question: the open file, the selection, the editor's problems. */
function gatherContext(opts: { file: boolean; problems: boolean }): { context: ChatContext; chips: string[] } {
  const file = activeFilePath();
  const chips: string[] = [];
  const context: ChatContext = {};
  if (!file) return { context, chips };
  const model = getDocument(file);
  const ed = codeEditorFor(useWorkbench.getState().activeGroup);
  context.file = file;
  context.language = model?.getLanguageId() ?? languageForPath(file);
  const sel = ed?.getModel() === model ? ed?.getSelection() : null;
  if (model && sel && !sel.isEmpty()) {
    context.selection = model.getValueInRange(sel).slice(0, 20_000);
    chips.push(`${file.slice(file.lastIndexOf("/") + 1)}: lines ${sel.startLineNumber}–${sel.endLineNumber}`);
  } else if (opts.file && model) {
    context.fileText = model.getValue().slice(0, 60_000);
    chips.push(file.slice(file.lastIndexOf("/") + 1));
  }
  if (opts.problems && model) {
    const markers = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity >= monaco.MarkerSeverity.Warning);
    if (markers.length) {
      context.problems = markers.slice(0, 30).map((m) => `line ${m.startLineNumber}: ${m.message}`);
      chips.push(`${markers.length} problem${markers.length === 1 ? "" : "s"}`);
    }
  }
  return { context, chips };
}

export async function ask(text: string, opts: { file: boolean; problems: boolean } = { file: true, problems: true }) {
  const question = text.trim();
  if (!question || useChat.getState().busy) return;
  const { context, chips } = gatherContext(opts);
  const history: ChatTurn[] = useChat
    .getState()
    .messages.filter((m) => !m.error && !m.streaming)
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));
  const user: Message = { id: ++seq, role: "user", content: question, chips };
  const answer: Message = { id: ++seq, role: "assistant", content: "", streaming: true };
  useChat.setState((s) => ({ messages: [...s.messages, user, answer], busy: true }));
  recordActivity({
    kind: "ai",
    action: "chat",
    path: context.file,
    text: `Asked TMCode AI: "${question.length > 90 ? `${question.slice(0, 87)}…` : question}"`,
    data: { question: question.slice(0, 600), context: chips.join(", ") || "none", mode: useAi.getState().mode },
    actor: { type: "you" },
    ai: { by: "TMCode AI", how: "question asked in the chat" },
  });
  const patch = (p: Partial<Message>) => useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === answer.id ? { ...m, ...p } : m)) }));
  let content = "";
  try {
    cancelCurrent = await chat([...history, { role: "user", content: question }], context, {
      meta: (m) => patch({ model: m.model, provider: m.provider }),
      delta: (t) => {
        content += t;
        patch({ content });
      },
      done: (d) => {
        patch({ streaming: false, model: d.model, provider: d.provider });
        useChat.setState({ busy: false });
        cancelCurrent = null;
        if (d.you && useAi.getState().status) useAi.setState((s) => ({ status: s.status && { ...s.status, you: { ...s.status.you, chat: d.you! } } }));
        recordActivity({
          kind: "ai",
          action: "answer",
          path: context.file,
          text: `TMCode AI answered (${content.length} characters${/```/.test(content) ? ", with code" : ""})`,
          data: { chars: content.length, code_blocks: (content.match(/```/g)?.length ?? 0) / 2, model: d.model, provider: d.provider },
          actor: { type: "tmcode-ai" },
          ai: { by: "TMCode AI", how: "answered in the chat", model: `${d.provider} · ${d.model}` },
        });
      },
      error: (e) => fail(e),
    });
  } catch (e) {
    fail(asAiError(e));
  }
  function fail(err: AiRequestError) {
    const e = asAiError(err);
    patch({ streaming: false, error: { code: e.code, message: e.message } });
    useChat.setState({ busy: false });
    cancelCurrent = null;
  }
}

export function stopAnswer() {
  cancelCurrent?.();
  cancelCurrent = null;
  useChat.setState((s) => ({ busy: false, messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content + (m.content ? "\n\n_(stopped)_" : "_(stopped)_") } : m)) }));
}

export function newChat() {
  stopAnswer();
  useChat.setState({ messages: [] });
}

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

function Answer({ m }: { m: Message }) {
  const parts = useMemo(() => splitAnswer(m.content), [m.content]);
  const model = m.provider ? `${m.provider} · ${m.model}` : (m.model ?? "");
  return (
    <div className="tm-chat-answer">
      {parts.map((p, i) =>
        p.kind === "md" ? (
          <div key={i} className="tm-chat-md" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMarkdown(p.text)) }} />
        ) : (
          <CodeBlock key={i} part={p} model={model} />
        ),
      )}
      {m.streaming && !m.content && (
        <div className="tm-chat-thinking" aria-label="Thinking">
          <span />
          <span />
          <span />
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
      {!m.streaming && m.model && !m.error && (
        <div className="tm-chat-meta">
          <Codicon name="sparkle" /> {m.model.replace(/:free$/, "")} · {m.provider}
        </div>
      )}
    </div>
  );
}

const STARTERS = [
  { icon: "book", label: "Explain this code", prompt: "Explain what this code does, step by step." },
  { icon: "bug", label: "Find the bug", prompt: "Find bugs in this code and show how to fix them." },
  { icon: "beaker", label: "Write tests", prompt: "Write unit tests for this code." },
  { icon: "lightbulb", label: "Make it better", prompt: "How can I make this code clearer and better? Show the improved code." },
];

export async function pickMode() {
  const { status, mode } = useAi.getState();
  const items = [
    ...(status?.modes ?? [
      { id: "free", label: "Free (OpenRouter)", detail: "" },
      { id: "auto", label: "Auto", detail: "" },
    ]).map((m) => ({ id: m.id, label: m.label, detail: m.detail, icon: m.id === mode ? "check" : m.id === "auto" ? "sparkle" : "gift" })),
    ...(status?.models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.providerLabel, icon: m.id === mode ? "check" : "circuit-board" })),
  ];
  const picked = await showQuickPick({ title: "How TMCode AI answers", placeholder: "Free AI only. Auto picks one that still has requests left today.", items, matchOnDescription: true });
  if (picked) setAiMode(picked.id);
}

export function ChatView() {
  const messages = useChat((s) => s.messages);
  const busy = useChat((s) => s.busy);
  const { status, mode, suggestions, error } = useAi();
  const signedIn = useProjects((s) => !!s.account?.signed_in);
  const inExam = useExam((s) => !!s.quiz);
  const [text, setText] = useState("");
  const [withFile, setWithFile] = useState(true);
  const [withProblems, setWithProblems] = useState(true);
  const file = useWorkbench((s) => {
    const g = s.groups.find((x) => x.id === s.activeGroup);
    const e = g?.editors.find((x) => x.id === g.activeId);
    return e?.kind === "file" ? e.path : null;
  });
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void loadAiSettings();
  }, []);
  useEffect(() => {
    if (signedIn && !inExam) void refreshAiStatus();
  }, [signedIn, inExam]);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
  }, [messages]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);

  if (inExam) {
    return (
      <div className="tm-chat tm-chat-off" data-testid="tmcode-ai-chat">
        <Codicon name="lock" /> TMCode AI is off during exams.
      </div>
    );
  }
  if (!signedIn) {
    return (
      <div className="tm-chat tm-chat-welcome" data-testid="tmcode-ai-chat">
        <div className="tm-chat-hero">
          <Codicon name="sparkle" />
          <h2>TMCode AI</h2>
          <p>Ask about your code, find bugs, write tests. Free AI, through your NGA account.</p>
          <button type="button" className="tm-button" onClick={() => void signIn()}>
            Sign in to use TMCode AI
          </button>
        </div>
      </div>
    );
  }

  const send = (q = text) => {
    if (!q.trim() || busy) return;
    setText("");
    void ask(q, { file: withFile, problems: withProblems });
  };
  const left = status ? Math.max(0, status.you.chat.limit - status.you.chat.used) : null;
  const or = status?.openrouter;

  return (
    <div className="tm-chat" data-testid="tmcode-ai-chat">
      <div className="tm-chat-head">
        <button type="button" className="tm-chat-mode" onClick={() => void pickMode()} title="Choose how TMCode AI answers" data-testid="ai-mode">
          <Codicon name={mode === "auto" ? "sparkle" : mode === "free" ? "gift" : "circuit-board"} />
          <span>{modeLabel(mode, status)}</span>
          <Codicon name="chevron-down" />
        </button>
        <span
          className={`tm-chat-quota ${left !== null && left <= 5 ? "is-low" : ""}`}
          title={[
            left !== null ? `You: ${left} of ${status!.you.chat.limit} questions left today` : null,
            or ? `School's OpenRouter free requests: ${or.remaining} of ${or.limit} left today (shared by all NGA apps)` : null,
          ]
            .filter(Boolean)
            .join("\n")}
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
              <h2>Ask TMCode AI</h2>
              <p>{file ? `About ${file.slice(file.lastIndexOf("/") + 1)}, or anything about code.` : "Open a file to ask about it, or ask anything about code."}</p>
            </div>
            <div className="tm-chat-starters">
              {STARTERS.map((s) => (
                <button key={s.label} type="button" className="tm-chat-starter" onClick={() => send(s.prompt)} disabled={!file && s.icon !== "lightbulb"}>
                  <Codicon name={s.icon} /> {s.label}
                </button>
              ))}
            </div>
            <p className="tm-chat-note">Everything you do with AI is shown in your Activity log, and your teacher sees it for linked work.</p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="tm-chat-q">
              <div className="tm-chat-q-text">{m.content}</div>
              {!!m.chips?.length && (
                <div className="tm-chat-q-chips">
                  {m.chips.map((c) => (
                    <span key={c} className="tm-chat-chip">
                      <Codicon name="file-code" /> {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <Answer key={m.id} m={m} />
          ),
        )}
      </div>
      <div className="tm-chat-compose">
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
        </div>
        <div className="tm-chat-input">
          <textarea
            ref={input}
            value={text}
            rows={1}
            placeholder={file ? `Ask about ${file.slice(file.lastIndexOf("/") + 1)}…` : "Ask TMCode AI…"}
            aria-label="Ask TMCode AI"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
        <div className="tm-chat-hint">Enter to send · Shift+Enter for a new line · Free AI can make mistakes: check its code.</div>
      </div>
    </div>
  );
}
