import DOMPurify from "dompurify";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { recordActivity } from "../activity/log";
import { rememberAiCopy } from "../activity/sources";
import { monaco } from "../monaco/setup";
import { listFiles } from "../parts/search/search";
import { signIn, useProjects } from "../projects/service";
import { activeFilePath, getPlatform, notify, openFile, openSpecialEditor, useWorkbench } from "../state/store";
import { debugWithAi, reviewFile, startTour } from "./actions";
import { expandRecipe, recipeSuggestions } from "./recipes";
import { showInputBox, showQuickPick, type PickItem } from "../widgets/QuickPick";
import { loadAiKeys, providerLabel, setCustomModels, useAiKeys } from "./keys";
import { Codicon } from "../widgets/icons";
import { renderMarkdown } from "../widgets/markdown";
import { AiExtensions } from "./AiExtensions";
import { CLI_IDS, CLIS, cliBlocked, cliOf, detectAllClis, detectCli, installCli, signInCli, useAiClis, validCliModel, type CliId } from "./aiClis";
import { gateLabel, useAiGate } from "./gate";
import { allowAiCopy } from "./copyGuard";
import { aiMaySee } from "./agent/guard";
import { detectLocalModels, DIRECT_SUGGESTED, isLocalMode, loadLocalSettings, useLocalAi } from "./direct";
import { insertAtCursor, proposeEdit } from "./apply";
import { answerQuestion, approveStep, ask, MODES, modeLabelNow, newChat, referTo, resend, startBuilding, stopAnswer, undoRequest, useChat, type ChatMode, type Message, type Step } from "./chat";
import { aiReadsImages, effectiveMode, loadAiSettings, modeLabel, refreshAiStatus, setAgentMode, setAiMode, setAiSuggestions, useAi } from "./service";
import { scaleImage } from "./imageScale";
import { addAttachments, ATTACH_LIMITS, formatSize, fromAttachedFile, fromBrowserFile, pastedAttachment, textAttachment, type Attachment } from "./attachments";
import { CoachChecklist, IntentNote, IntentPanel, RequestMeter } from "./interpreter/IntentPanel";
import { PromptProblemPanel } from "./interpreter/PromptProblem";
import { interceptRequest, isStudent, registerComposer, useIntent } from "./interpreter/state";

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
  // Learning: a block that got through (the teacher's tiny syntax example) can be read, not taken.
  const takeable = useAiGate().copyCode;
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
        {!takeable && (
          <span className="tm-chat-code-lock" title="Learning: you write every line" data-testid="ai-code-locked">
            <Codicon name="lock" /> read only
          </span>
        )}
        {takeable && (
          <>
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
          </>
        )}
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

/** ask_user (C12): the agent's question, its choices and a box for your own words. */
function QuestionCard({ step }: { step: Step }) {
  const [text, setText] = useState("");
  const q = step.question!;
  return (
    <div className="tm-chat-question" data-testid="ai-question">
      <div className="tm-chat-question-choices">
        {q.choices.map((c) => (
          <button key={c} type="button" className="tm-chat-btn" onClick={() => answerQuestion(step.id, c)} data-testid="ai-question-choice">
            {c}
          </button>
        ))}
      </div>
      <form
        className="tm-chat-question-own"
        onSubmit={(e) => {
          e.preventDefault();
          answerQuestion(step.id, text);
        }}
      >
        <input className="tm-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Or answer in your own words…" aria-label="Your answer" data-testid="ai-question-input" />
        <button type="submit" className="tm-chat-btn is-primary" disabled={!text.trim()}>
          Answer
        </button>
        <button type="button" className="tm-chat-btn" onClick={() => answerQuestion(step.id, null)}>
          Skip
        </button>
      </form>
    </div>
  );
}

const STEP_ICON: Record<string, string> = { ask_user: "question", explore: "telescope", repo_map: "type-hierarchy", find_symbol: "symbol-method", list_files: "list-tree", read_file: "file", search: "search", get_problems: "warning", edit_file: "edit", write_file: "new-file", rename_file: "replace", delete_file: "trash", run_command: "terminal" };

function StepCard({ messageId, step }: { messageId: number; step: Step }) {
  const [open, setOpen] = useState(step.status === "waiting");
  useEffect(() => setOpen(step.status === "waiting" || (open && step.status !== "done")), [step.status]); // eslint-disable-line react-hooks/exhaustive-deps
  const detail = !!(step.diff || step.command || step.output);
  return (
    <div className={`tm-chat-step is-${step.status}`} data-testid="ai-step" data-status={step.status}>
      <button type="button" className="tm-chat-step-head" onClick={() => detail && setOpen(!open)} aria-expanded={open}>
        <Codicon name={step.status === "running" ? "loading" : step.status === "failed" ? "error" : step.status === "rejected" || step.status === "refused" ? "circle-slash" : STEP_ICON[step.tool] ?? "tools"} className={step.status === "running" ? "codicon-modifier-spin" : ""} />
        <span className="tm-chat-step-title">{step.title}</span>
        {step.status === "waiting" && <span className="tm-chat-step-badge">{step.question ? "Needs your answer" : "Needs your OK"}</span>}
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
      {step.status === "waiting" && step.question && <QuestionCard step={step} />}
      {step.status === "waiting" && !step.question && (
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
          if (m.role === "assistant" && !allowAiCopy(m.content)) return;
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

/**
 * Explain before accept (E1, Industrial · Guided): one question about the change before you keep
 * it. It never blocks; the answer goes to the Activity log, where the teacher sees it (I1).
 */
function ExplainChange({ m }: { m: Message }) {
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);
  if (done) return <p className="tm-chat-note" data-testid="ai-explained">Thanks: your explanation is in your Activity log.</p>;
  return (
    <form
      className="tm-chat-explain"
      data-testid="ai-explain-change"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        recordActivity({ kind: "ai", action: "explained", text: `Explained TMCode AI's change to ${m.checkpoint!.files.join(", ")}: "${text.trim().slice(0, 300)}"`, data: { files: m.checkpoint!.files.join(", "), explanation: text.trim().slice(0, 1000) }, actor: { type: "you" }, ai: { by: "TMCode AI", how: "change explained by the student" } });
        setDone(true);
      }}
    >
      <label>
        <Codicon name="mortar-board" /> Before you keep it: in one sentence, what does this change do, and why?
      </label>
      <div className="tm-chat-question-own">
        <input className="tm-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="It… because…" aria-label="Explain the change" />
        <button type="submit" className="tm-chat-btn is-primary" disabled={!text.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

const PLAN_FILE = ".tmcode/plan/plan.md";

/** B1: the plan becomes a file you can edit; "Start building" then carries it out. */
async function savePlan(content: string) {
  const fs = getPlatform().fs;
  await fs.createDir(".tmcode").catch(() => undefined);
  await fs.createDir(".tmcode/plan").catch(() => undefined);
  const tasks = content
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s+/, "- [ ] "))
    .join("\n");
  await fs.writeFile(PLAN_FILE, `# Plan\n\n${tasks.trim()}\n\n## How we'll check it\n\n- [ ] The tests pass\n- [ ] It works in the preview\n`);
  recordActivity({ kind: "ai", action: "plan", path: PLAN_FILE, text: `Saved TMCode AI's plan as ${PLAN_FILE}`, actor: { type: "you" }, ai: { by: "TMCode AI", how: "plan saved as a file" } });
  openFile(PLAN_FILE, { pinned: true });
}

function Answer({ m }: { m: Message }) {
  const parts = useMemo(() => splitAnswer(m.content), [m.content]);
  const g = useAiGate();
  const canEdit = g.edit;
  const scaffolds = g.layer === "industrial" && g.profile === "guided" && useAi.getState().status?.staff !== true;
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
      {m.checkpoint && !m.checkpoint.undone && !m.streaming && scaffolds && <ExplainChange m={m} />}
      {m.mode === "plan" && canEdit && !m.streaming && !m.error && m.content.trim() && (
        <div className="tm-chat-approve">
          <button type="button" className="tm-chat-btn" onClick={() => void savePlan(m.content)} disabled={busy} data-testid="ai-save-plan" title={`Save as ${PLAN_FILE}: edit it, then build from it`}>
            <Codicon name="save" /> Save as Plan
          </button>
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
          {["PREMIUM_REQUIRED", "PREMIUM_QUOTA", "BYOK_REJECTED", "BYOK_MISSING", "BYOK_DISABLED", "BYOK_KEY_REQUIRED"].includes(m.error.code) && (
            <button type="button" className="tm-link-button" onClick={() => setAiMode("free")}>
              Switch to Free
            </button>
          )}
          {(m.error.code === "BYOK_REJECTED" || m.error.code === "BYOK_MISSING" || m.error.code === "BYOK_KEY_REQUIRED") && (
            <button type="button" className="tm-link-button" onClick={openAiKeysSettings}>
              Your API Keys
            </button>
          )}
          <CliFixes code={m.error.code} cli={m.error.reason} />
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
          {m.privacy && !m.error && (
            <span className="tm-chat-meta tm-chat-privacy" title="What this provider's terms say about your data" data-testid="ai-privacy">
              <Codicon name="shield" /> {m.privacy}
            </span>
          )}
          {!!m.filtered && (
            <span className="tm-chat-meta" title="Learning: the tutor's code was removed before you saw it" data-testid="ai-filtered">
              <Codicon name="filter" /> {m.filtered} line{m.filtered === 1 ? "" : "s"} of code removed
            </span>
          )}
          {m.content && <MessageActions m={m} />}
        </div>
      )}
    </div>
  );
}

/** Gemini CLI turned the account away: answer with Antigravity CLI instead (installing it or signing in first when needed). */
async function useAgyInstead() {
  const info = await detectCli("agy", true);
  if (info.state === "ready") return setAiMode("cli:agy");
  if (info.state === "missing") return installCli("agy");
  if (info.state === "signed-out") return signInCli("agy");
  notify("info", info.detail ?? `${CLIS.agy.label} couldn't be checked here.`);
}

/** What to do when an AI CLI couldn't answer (the chat's and the terminal's error boxes); `cli` is the error's reason. */
export function CliFixes({ code, cli, retry }: { code: string; cli?: string; retry?: () => void }) {
  if (!code.startsWith("CLI_")) return null;
  const id = (cli && cli in CLIS ? cli : cliOf(useAi.getState().mode)) as CliId | null;
  const spec = id ? CLIS[id] : null;
  return (
    <>
      {code === "CLI_MISSING" && id && (
        <button type="button" className="tm-link-button" onClick={() => installCli(id)} data-testid="cli-install">
          Install {spec!.label}
        </button>
      )}
      {code === "CLI_SIGNED_OUT" && id && (
        <button type="button" className="tm-link-button" onClick={() => signInCli(id)} data-testid="cli-signin">
          Sign In with {spec!.account}
        </button>
      )}
      {code === "CLI_MOVED" && (
        <>
          <button type="button" className="tm-link-button" onClick={() => void useAgyInstead()} data-testid="cli-use-agy">
            Use {CLIS.agy.label}
          </button>
          <button type="button" className="tm-link-button" onClick={openAiKeysSettings} data-testid="cli-gemini-key">
            Add a Gemini API Key
          </button>
          {id && (
            <button type="button" className="tm-link-button" onClick={() => signInCli(id)} title="Google Cloud work accounts (Gemini Code Assist Standard or Enterprise) still sign in to Gemini CLI">
              Sign In with a Work Account
            </button>
          )}
        </>
      )}
      {code === "CLI_LIMIT" && id && (
        <button type="button" className="tm-link-button" onClick={() => void getPlatform().openExternal?.(spec!.plans)} data-testid="cli-plans">
          Your {spec!.account} Plan
        </button>
      )}
      {(code === "CLI_LIMIT" || code === "CLI_FAILED") && retry && (
        <button type="button" className="tm-link-button" onClick={retry}>
          Try Again
        </button>
      )}
      <button type="button" className="tm-link-button" onClick={() => (setAiMode("free"), retry?.())} data-testid="cli-use-free">
        {retry ? "Use Free AI and Retry" : "Switch to Free"}
      </button>
    </>
  );
}

/** Waits for `p`, at most `ms` (then goes on without it). */
const within = (p: Promise<unknown>, ms: number) => Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

/** The picker's items: what Task Mentor offers (asked first when not known yet) and the AI CLIs. */
async function modeItems(): Promise<PickItem[]> {
  // The status says which models, premium and own keys there are: without it only Free and Auto showed.
  const signedInNow = !!useProjects.getState().account?.signed_in;
  await Promise.all([useAi.getState().status || !signedInNow ? null : within(refreshAiStatus(), 8000), useAiKeys.getState().loaded ? null : within(loadAiKeys(), 3000), within(detectAllClis(), 400)]);
  const { status, mode, error } = useAi.getState();
  const keys = useAiKeys.getState();
  const icon = (id: string, fallback: string) => (id === mode ? "check" : fallback);
  const free: PickItem[] = [
    ...(status?.modes ?? [
      { id: "free", label: "Free (OpenRouter)", detail: "" },
      { id: "auto", label: "Auto", detail: "" },
    ]).map((m) => ({ id: m.id, label: m.label, detail: m.detail, icon: icon(m.id, m.id === "auto" ? "sparkle" : "gift") })),
    ...(status?.models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.providerLabel, icon: icon(m.id, "circuit-board") })),
  ];
  if (!status) free.push({ id: "__retry", label: "Couldn't load the other models", detail: `${error ?? "Task Mentor didn't answer."} Pick this to try again.`, icon: "refresh", alwaysShow: true });
  // Premium (Task Mentor ≥ 2026-10-25): the school's paid models, for the users it entitled.
  const pu = status?.premium_you;
  const premium: PickItem[] = status?.tiers?.premium
    ? (status.premium_models ?? []).map((m) => ({ id: m.id, label: m.label, description: m.providerLabel, icon: icon(m.id, "star-full") }))
    : [];
  // Your keys: one entry per model of each provider the user saved a key for.
  const byok: PickItem[] = [];
  if (status?.tiers?.byok) {
    for (const p of status.byok_providers ?? []) {
      if (!keys.saved.includes(p.id)) continue;
      const models = [...new Set([...(p.suggested_models ?? []), ...(keys.models[p.id] ?? [])])];
      for (const m of models) byok.push({ id: `byok:${p.id}/${m}`, label: m, description: `${p.label} · your key`, icon: icon(`byok:${p.id}/${m}`, "key") });
      byok.push({ id: `__custom:${p.id}`, label: `Another ${p.label} model…`, description: "type its id", icon: "add" });
    }
  }
  // Also while the status couldn't load (it used to vanish then); an older Task Mentor, or own keys off: none.
  if (status?.tiers?.byok || !status) byok.push({ id: "__keys", label: keys.saved.length ? "Manage Your API Keys…" : "Add Your Own API Key…", description: "Settings › TMCode AI", icon: "gear", alwaysShow: true });
  // Signed out, Task Mentor's list isn't there: your keys go straight to the provider (ai/direct.ts).
  const signedOut = !useProjects.getState().account?.signed_in;
  if (signedOut) {
    byok.length = 0;
    for (const provider of keys.saved) {
      const models = [...new Set([...(DIRECT_SUGGESTED[provider] ?? []), ...(keys.models[provider] ?? [])])];
      for (const m of models) byok.push({ id: `byok:${provider}/${m}`, label: m, description: `${providerLabel(provider)} · your key, direct`, icon: icon(`byok:${provider}/${m}`, "key") });
      byok.push({ id: `__custom:${provider}`, label: `Another ${providerLabel(provider)} model…`, description: "type its id", icon: "add" });
    }
    byok.push({ id: "__keys", label: keys.saved.length ? "Manage Your API Keys…" : "Add Your Own API Key…", description: "Settings › TMCode AI", icon: "gear", alwaysShow: true });
  }
  // Local models (Ollama, LM Studio): free, offline, nothing leaves the computer. Found in the
  // background (the chat looks when it opens), so the picker never waits for them.
  const lo = useLocalAi.getState();
  const local: PickItem[] = getPlatform().http
    ? lo.models.length
      ? lo.models.map((m) => ({ id: `local:${m}`, label: m, description: "on this computer", icon: icon(`local:${m}`, "device-desktop") }))
      : [{ id: "__local:find", label: lo.state === "checking" ? "Looking for local models…" : "Find Local Models (Ollama, LM Studio)", detail: lo.error ?? "Use a model on this computer: free, offline, private.", icon: lo.state === "checking" ? "loading" : "search" }]
    : [];
  const section = (list: PickItem[], label: string) => list.map((x, i) => (i === 0 ? { ...x, separator: label } : x));
  if (signedOut) return [...section(cliItems(icon), "Your AI accounts"), ...section(byok, "Your keys"), ...section(local, "On this computer")];
  return [
    ...section(free, "Free"),
    ...section(premium, `Premium${pu ? ` · ${Math.max(0, pu.limit - pu.used)} of ${pu.limit} left today` : ""}`),
    ...section(cliItems(icon), "Your AI accounts"),
    ...section(byok, "Your keys"),
    ...section(local, "On this computer"),
  ];
}

/**
 * Your AI accounts (ai/aiClis.ts): each CLI's models when it's signed in; else what to do (install,
 * sign in). One line for all of them where the school doesn't allow third-party AI tools.
 */
function cliItems(icon: (id: string, fallback: string) => string): PickItem[] {
  if (!getPlatform().proc) return [];
  const blocked = cliBlocked();
  if (blocked) return [{ id: "__cli:blocked", label: "Claude Code, ChatGPT and Gemini", detail: blocked, icon: "lock" }];
  const all = useAiClis.getState();
  return CLI_IDS.flatMap((id): PickItem[] => {
    const spec = CLIS[id];
    const cc = all[id];
    if (cc.state === "missing") return [{ id: `__cli:install:${id}`, label: `Install ${spec.label}…`, description: `your ${spec.account} account`, detail: spec.note, icon: "cloud-download" }];
    if (cc.state === "signed-out") return [{ id: `__cli:signin:${id}`, label: `Sign In to ${spec.label}…`, description: `with your ${spec.account} account`, detail: spec.note ? `Installed, not signed in yet. ${spec.note}` : "Installed, not signed in yet.", icon: "account" }];
    if (cc.state === "unavailable") return [{ id: `__cli:retry:${id}`, label: spec.label, detail: `${cc.detail ?? "It couldn't be checked."} Pick this to check again.`, icon: "warning" }];
    // Still being checked (the menu doesn't wait for it): pick it to see the result.
    if (cc.state === "checking" || cc.state === "unknown") return [{ id: `__cli:retry:${id}`, label: spec.label, description: "checking…", detail: `Is ${spec.label} installed and signed in with your ${spec.account} account? Pick this to see.`, icon: "loading" }];
    const base = `cli:${id}`;
    const who = cc.account ?? `your ${spec.account} account`;
    return [
      { id: base, label: spec.label, description: `${who} · its default model`, detail: "Your own account answers (no TMCode AI allowance used). Agent modes open it in the terminal.", icon: icon(base, "terminal") },
      ...spec.models.map((m) => ({ id: `${base}/${m.id}`, label: `${spec.label} · ${m.label}`, description: m.detail, icon: icon(`${base}/${m.id}`, "terminal") })),
      { id: `__cli:model:${id}`, label: `Another ${spec.label} model…`, description: "type its name", icon: "add" },
    ];
  });
}

export async function pickMode() {
  const picked = await showQuickPick({ title: "Which AI answers", placeholder: "Free AI, your school's premium models, your Claude, ChatGPT or Gemini account, or your own API keys.", items: modeItems(), matchOnDescription: true });
  if (!picked) return;
  if (picked.id === "__keys") return openAiKeysSettings();
  if (picked.id === "__retry") return void refreshAiStatus().then(pickMode);
  const cli = /^__cli:(install|signin|retry|model):(\w+)$/.exec(picked.id);
  if (cli) {
    const id = cli[2] as CliId;
    if (cli[1] === "install") return installCli(id);
    if (cli[1] === "signin") return signInCli(id);
    if (cli[1] === "retry") return void detectCli(id, true).then(pickMode);
    const model = await showInputBox({ title: `A ${CLIS[id].label} model`, prompt: `The model name, as ${CLIS[id].label} accepts it (--model)`, validate: (v) => (validCliModel(v) ? null : "One model name: letters, digits, dots, dashes.") });
    return model ? setAiMode(`cli:${id}/${model.trim()}`) : undefined;
  }
  if (picked.id === "__cli:blocked") return void notify("info", cliBlocked() ?? "AI CLIs aren't available here.");
  if (picked.id === "__local:find") {
    const found = await detectLocalModels();
    if (found.length) return pickMode();
    return void notify("info", useLocalAi.getState().error ?? "Install Ollama (ollama.com) or LM Studio, pull a model, then pick it here.");
  }
  if (picked.id.startsWith("__custom:")) {
    const provider = picked.id.slice("__custom:".length);
    const model = await showInputBox({ title: `A ${providerLabel(provider)} model`, prompt: "The model id, as the provider names it", placeholder: "e.g. gpt-4.1-mini", validate: (v) => (!v.trim() || /\s/.test(v.trim()) ? "One model id, without spaces." : null) });
    if (!model) return;
    setCustomModels(provider, [...(useAiKeys.getState().models[provider] ?? []), model.trim()]);
    return setAiMode(`byok:${provider}/${model.trim()}`);
  }
  setAiMode(picked.id);
}

/** Settings › TMCode AI › Your API keys. */
export function openAiKeysSettings() {
  openSpecialEditor("settings");
  setTimeout(() => document.getElementById("settings-TMCode AI")?.scrollIntoView({ block: "start" }), 80);
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

/** Why files can't be attached now, or null. */
function attachRefusal(): string | null {
  if (useWorkbench.getState().policy.mode !== "practice") return "You can't attach files during an exam.";
  return null;
}


/** Workspace files dragged from the Explorer onto the chat. */
async function workspaceAttachments(paths: string[]): Promise<(Attachment | string)[]> {
  const fs = getPlatform().fs;
  return Promise.all(
    paths.map(async (p) => {
      const text = await fs.readFile(p).catch(() => null);
      if (text === null) return `${p.slice(p.lastIndexOf("/") + 1)} could not be read (a folder or a binary file).`;
      return textAttachment(p.slice(p.lastIndexOf("/") + 1), text, text.length, p);
    }),
  );
}

/** Files from the desktop (dialog, drop, clipboard): read by ai_attach.rs. */
async function desktopAttachments(paths: string[]): Promise<(Attachment | string)[]> {
  const host = getPlatform().attachments;
  if (!host) return [];
  return Promise.all(paths.map((p) => host.read(p).then(fromAttachedFile, (e) => String((e as Error)?.message ?? e))));
}

/** "@app" → the project's files whose path matches, for @-mentions. */
let fileCache: { at: number; files: string[] } | null = null;
async function projectFiles(): Promise<string[]> {
  if (fileCache && Date.now() - fileCache.at < 15_000) return fileCache.files;
  const files = (await listFiles(getPlatform().fs).catch(() => [] as string[])).filter((f) => aiMaySee(f));
  fileCache = { at: Date.now(), files };
  return files;
}

const STARTERS = [
  { icon: "book", label: "Explain this code", prompt: "Explain what this code does, step by step." },
  { icon: "bug", label: "Find and fix bugs", prompt: "Find the bugs in this code and fix them." },
  { icon: "beaker", label: "Write tests", prompt: "Write unit tests for this code." },
  { icon: "lightbulb", label: "Make it better", prompt: "Make this code clearer and better." },
];

/** Learning's starters: the student commits first (Lead-and-Reveal), the tutor never writes code. */
const TUTOR_STARTERS = [
  { icon: "question", label: "Give me a hint", prompt: "I'm stuck. Give me one hint about the next step, without code." },
  { icon: "bug", label: "Explain my error", prompt: "Help me understand the error I'm getting. Ask me what I think it means first." },
  { icon: "book", label: "Explain a concept", prompt: "Explain the concept this code relies on, in words, with an example input and output." },
  { icon: "lightbulb", label: "What should I check?", prompt: "What should I check or test next in my code? Ask me questions." },
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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const attachedRef = useRef(attachments);
  attachedRef.current = attachments;

  const attach = async (load: () => Promise<(Attachment | string)[]>) => {
    const refusal = attachRefusal();
    if (refusal) return setAttachError(refusal);
    const reads = aiReadsImages();
    const items = await Promise.all(
      (await load()).map(async (a) => {
        if (typeof a === "string" || a.kind !== "image" || !a.image) return a;
        if (!reads) return `${a.name}: the AI answering now can't read images. Pick Auto or a model that reads images, or attach code and text files.`;
        const scaled = await scaleImage(a.image);
        return { ...a, image: scaled.dataUrl, size: scaled.size };
      }),
    );
    const { list, errors } = addAttachments(attachedRef.current, items);
    setAttachments(list);
    setAttachError(errors.length ? errors.join(" ") : null);
    input.current?.focus();
  };

  // Your AI accounts (Claude Code, Codex, Gemini CLI) are checked now, so the model menu opens without waiting.
  useEffect(() => {
    if (getPlatform().proc) void detectAllClis();
  }, []);

  // Files dragged from the Explorer (a pointer drag, not an HTML one) arrive as workspace paths.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onPaths = (e: Event) => void attach(() => workspaceAttachments((e as CustomEvent<string[]>).detail ?? []));
    el.addEventListener("tmcode:drop-paths", onPaths);
    return () => el.removeEventListener("tmcode:drop-paths", onPaths);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root.current]);

  // Desktop: files dropped from Finder / File Explorer arrive as paths (the HTML drop gets none).
  useEffect(() => {
    const platform = getPlatform();
    if (!platform.onFileDrop || !platform.attachments) return;
    const over = (x: number, y: number) => !!root.current && !!document.elementFromPoint(x, y)?.closest(".tm-chat") && root.current.contains(document.elementFromPoint(x, y));
    return platform.onFileDrop((e) => {
      if (e.type === "leave") return setDropping(false);
      const inside = over(e.x, e.y);
      if (e.type === "over") return setDropping(inside);
      setDropping(false);
      if (inside && e.paths.length) void attach(() => desktopAttachments(e.paths));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
  // The request check's "Edit my words" puts the text back here.
  useEffect(() => {
    registerComposer((t) => {
      setText(t);
      setTimeout(() => {
        input.current?.focus();
        input.current?.setSelectionRange(t.length, t.length);
      }, 0);
    });
    return () => registerComposer(null);
  }, []);
  const checking = useIntent((s) => !!s.pending);
  useEffect(() => {
    if (signedIn) void refreshAiStatus();
  }, [signedIn, projectId]);
  useEffect(() => {
    void loadAiKeys();
    // Local models: looked for once, quietly, when the chat opens.
    void loadLocalSettings().then(() => (useLocalAi.getState().state === "unknown" && getPlatform().http ? detectLocalModels() : null));
  }, []);
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
  // Signed out: bring your own AI (proposal §8.6). Your key, a local model or your AI account
  // answer here; the school's free AI needs a sign-in.
  const ownAi = mode.startsWith("byok:") || isLocalMode(mode) || mode.startsWith("cli:");
  if (!signedIn && !ownAi) {
    return (
      <div className="tm-chat tm-chat-welcome" data-testid="tmcode-ai-chat">
        <div className="tm-chat-hero">
          <Codicon name="sparkle" />
          <h2>TMCode AI</h2>
          <p>
            You're not signed in to NGA, so TMCode is in <strong>{gateLabel(gate)}</strong> mode: use your own AI. Pick your API key, a local model (Ollama, LM Studio) or your Claude, ChatGPT or Gemini account. Nothing goes through NGA.
          </p>
          <button type="button" className="tm-button" onClick={() => void pickMode()} data-testid="ai-pick-own">
            Use My Own AI…
          </button>
          <p className="tm-chat-note">NGA students: sign in to get your school's AI and your assignments.</p>
          <button type="button" className="tm-button is-secondary" onClick={() => void signIn()} data-testid="ai-sign-in">
            Sign In to NGA
          </button>
        </div>
        <AiExtensions />
      </div>
    );
  }

  /** "starter": one of the ready-made prompts (already clear, so never checked). */
  const send = (typed = text, trigger: "send" | "manual" | "starter" = "send") => {
    const files = attachments;
    // Attachments alone are a question too.
    const q = typed.trim() || (files.length ? `Look at the attached file${files.length === 1 ? "" : "s"}.` : "");
    if (!q || busy) return;
    const used = mentions.filter((m) => q.includes(`@${m}`));
    setText("");
    setMentions([]);
    setSuggest(null);
    setAttachments([]);
    setAttachError(null);
    historyAt.current = null;
    // Slash recipes (L6): one word for a common job; in Learning they become guides.
    const recipe = expandRecipe(q, gate.tutor, agentMode);
    if (recipe?.kind === "action") {
      if (recipe.action === "review") return void reviewFile();
      if (recipe.action === "debug") return debugWithAi();
      if (recipe.action === "tour") return void startTour();
      if (gate.tutor) return void ask(`Help me write a plan for: ${recipe.arg || "this task"}. Ask me questions about what it should do; I write the plan.`, { file: withFile, problems: withProblems }, "chat");
      setAgentMode("plan");
      return void ask(recipe.arg || "Plan the next step for this project.", { file: withFile, problems: withProblems, mentions: used, attachments: files }, "plan");
    }
    if (recipe?.kind === "ask") return void ask(recipe.prompt, { file: withFile, problems: withProblems, mentions: used, attachments: files }, recipe.mode);
    const opts = { file: withFile, problems: withProblems, mentions: used, attachments: files };
    // The request check (prompt interpreter report): the card or the coach first, when the gate says so.
    if (trigger !== "starter" && interceptRequest(q, opts, agentMode, { firstOfTask: !useChat.getState().messages.length, recipeWithArgs: false, planEntry: agentMode === "plan" && !useChat.getState().messages.length, mentions: used.length, openFile: !!file }, trigger)) return;
    void ask(q, opts);
  };

  /** ✨ / ⌘⇧Enter: check what I mean before the AI acts (on demand, Q8). */
  const checkMeaning = () => send(text, "manual");

  const pickFiles = () => {
    const host = getPlatform().attachments;
    if (host) void attach(async () => desktopAttachments(await host.pick()));
    else fileInput.current?.click();
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    const files = [...data.files];
    const host = getPlatform().attachments;
    const hasFiles = files.length > 0 || data.types.includes("Files") || data.types.includes("text/uri-list");
    if (hasFiles) {
      e.preventDefault();
      // A screenshot or an image copied from a page comes as a File; files copied in Finder as paths.
      if (files.length && (files.every((f) => f.type.startsWith("image/")) || !host)) void attach(() => Promise.all(files.map(fromBrowserFile)));
      else if (host) void attach(async () => desktopAttachments(await host.clipboard()));
      return;
    }
    const pasted = data.getData("text/plain");
    if (pasted.length > ATTACH_LIMITS.pasteChars) {
      e.preventDefault();
      void attach(async () => [pastedAttachment(pasted, attachedRef.current)]);
    }
  };

  const dragHasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("application/x-tmcode-path");
  const onDrop = (e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    setDropping(false);
    let paths: string[] = [];
    try {
      paths = JSON.parse(e.dataTransfer.getData("application/x-tmcode-paths") || "[]");
    } catch {
      paths = [];
    }
    if (!paths.length) paths = [e.dataTransfer.getData("application/x-tmcode-path")].filter(Boolean);
    if (paths.length) return void attach(() => workspaceAttachments(paths));
    const files = [...e.dataTransfer.files];
    if (files.length) void attach(() => Promise.all(files.map(fromBrowserFile)));
  };

  const cycleMode = () => {
    const i = MODES.findIndex((m) => m.id === agentMode);
    setAgentMode(MODES[(i + 1) % MODES.length].id as ChatMode);
  };

  const updateSuggest = async (value: string, caret: number) => {
    // "/" at the start: the slash recipes (L6).
    const slash = /^\/([a-z0-9-]*)$/i.exec(value.slice(0, caret));
    if (slash) {
      const items = recipeSuggestions(slash[1]).map((r) => `/${r.id}`);
      return setSuggest(items.length ? { query: slash[1], items, index: 0 } : null);
    }
    const m = /(^|\s)@([\w./-]*)$/.exec(value.slice(0, caret));
    if (!m) return setSuggest(null);
    const q = m[2].toLowerCase();
    const items = (await projectFiles()).filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
    setSuggest(items.length ? { query: m[2], items, index: 0 } : null);
  };

  const pickMention = (path: string) => {
    const el = input.current;
    if (path.startsWith("/")) {
      setText(`${path} `);
      setSuggest(null);
      setTimeout(() => el?.focus(), 0);
      return;
    }
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
  const tutor = gate.tutor;
  const allowance = status?.learning?.allowance ?? null;
  // Students in Guided or Learning see which of the six things their request says, as they type.
  const showMeter = !checking && isStudent() && (gate.tutor || gate.profile === "guided") && status?.interpreter?.arm !== "holdout";

  return (
    <div
      ref={root}
      className={`tm-chat ${dropping ? "is-dropping" : ""}`}
      data-testid="tmcode-ai-chat"
      data-drop-files=""
      onDragOver={(e) => {
        if (!dragHasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      {dropping && (
        <div className="tm-chat-drop" data-testid="ai-drop-zone">
          <Codicon name="cloud-upload" />
          <span>Drop files to attach them to your question</span>
        </div>
      )}
      <div className="tm-chat-head">
        {tutor ? (
          <span className="tm-chat-agent-mode is-tutor" title={`${gateLabel(gate)}: AI helps you think, you write every line. ${gate.detail ?? ""}`.trim()} data-testid="ai-tutor-mode">
            <Codicon name="lightbulb" />
            <span>{modeLabelNow(agentMode, gate.layer)}{status?.learning?.strength === "hints" ? " · hints" : ""}</span>
          </span>
        ) : (
          <div className="tm-chat-agent-wrap">
            <button type="button" className="tm-chat-agent-mode" onClick={() => setModesOpen(!modesOpen)} title={current.detail} data-testid="ai-agent-mode" aria-haspopup="menu" aria-expanded={modesOpen}>
              <Codicon name={current.icon} />
              <span>{current.label}</span>
              <Codicon name="chevron-down" />
            </button>
            {modesOpen && <ModeMenu onClose={() => setModesOpen(false)} />}
          </div>
        )}
        <button type="button" className="tm-chat-mode" onClick={() => void pickMode()} title="Which AI answers" data-testid="ai-mode">
          <Codicon name={mode === "auto" ? "sparkle" : mode === "free" ? "gift" : mode.startsWith("premium:") ? "star-full" : mode.startsWith("byok:") ? "key" : isLocalMode(mode) ? "device-desktop" : "circuit-board"} />
          <span>{modeLabel(effectiveMode(mode, status), status)}</span>
          <Codicon name="chevron-down" />
        </button>
        {tutor && allowance ? (
          <span
            className={`tm-chat-quota is-hearts ${allowance.left <= 2 ? "is-low" : ""}`}
            title={`Questions: ${allowance.left} of ${allowance.max} left. One comes back every ${allowance.regain_minutes} min${allowance.next_in_s ? ` (next in ${Math.ceil(allowance.next_in_s / 60)} min)` : ""}: a pause to think is part of learning.`}
            data-testid="ai-allowance"
          >
            <Codicon name="heart" /> {allowance.left}/{allowance.max}
          </span>
        ) : (
        <span
          className={`tm-chat-quota ${left !== null && left <= 5 ? "is-low" : ""}`}
          title={[left !== null ? `You: ${left} of ${status!.you.chat.limit} questions left today` : null, status?.you.agent ? `Agent steps: ${status.you.agent.limit - status.you.agent.used} of ${status.you.agent.limit} left today` : null, or ? `School's OpenRouter free requests: ${or.remaining} of ${or.limit} left today` : null].filter(Boolean).join("\n")}
          data-testid="ai-quota"
        >
          {left !== null ? `${left} left today` : error ? "offline" : "…"}
        </span>
        )}
        <span className="tm-chat-spacer" />
        {gate.complete && (
          <button type="button" className={`tm-chat-icon ${suggestions ? "is-on" : ""}`} title={suggestions ? "Suggestions while typing: on" : "Suggestions while typing: off"} aria-pressed={suggestions} onClick={() => setAiSuggestions(!suggestions)} data-testid="ai-suggestions">
            <Codicon name="lightbulb-autofix" />
          </button>
        )}
        <button type="button" className="tm-chat-icon" title="New Chat" onClick={newChat} data-testid="ai-new-chat">
          <Codicon name="add" />
        </button>
      </div>
      <div
        ref={list}
        className="tm-chat-list tm-scroll"
        role="log"
        aria-live="polite"
        onCopy={(e) => {
          // Learning: selected code can't leave the panel either (the copy guard, logged).
          const sel = window.getSelection()?.toString() ?? "";
          if (sel && !allowAiCopy(sel, "the AI panel")) e.preventDefault();
        }}
      >
        <PromptProblemPanel />
        {!messages.length && (
          <div className="tm-chat-empty">
            {tutor ? (
              <div className="tm-chat-hero is-tutor" data-testid="ai-tutor-hero">
                <Codicon name="lightbulb" />
                <h2>Your tutor</h2>
                <p>Learning: AI helps you think. You write every line. Ask about an error, a concept, or what to try next; the tutor answers in words, never with code.</p>
              </div>
            ) : (
              <div className="tm-chat-hero">
                <Codicon name="sparkle" />
                <h2>{agentMode === "chat" ? "Ask TMCode AI" : "What should we build?"}</h2>
                <p>{agentMode === "chat" ? (file ? `About ${file.slice(file.lastIndexOf("/") + 1)}, or anything about code.` : "Ask anything about code.") : `${current.label}: ${current.detail.toLowerCase()}.`}</p>
              </div>
            )}
            <div className="tm-chat-starters">
              {(tutor ? TUTOR_STARTERS : STARTERS).map((s) => (
                <button key={s.label} type="button" className="tm-chat-starter" onClick={() => send(s.prompt, "starter")} disabled={!file && s.icon !== "lightbulb"}>
                  <Codicon name={s.icon} /> {s.label}
                </button>
              ))}
            </div>
            {!tutor && <AiExtensions />}
            <p className="tm-chat-note">Everything AI does is in your Activity log, and your teacher sees it for linked work.</p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="tm-chat-q">
              {!!m.images?.length && (
                <div className="tm-chat-q-images">
                  {m.images.map((src, i) => (
                    <img key={i} src={src} alt={`Attached image ${i + 1}`} className="tm-chat-q-image" data-testid="ai-question-image" />
                  ))}
                </div>
              )}
              <div className="tm-chat-q-text">{m.content}</div>
              {m.intent && (
                <details className="tm-chat-q-intent" data-testid="ai-question-checked">
                  <summary>
                    <Codicon name="pass-filled" /> Checked: {m.intent.restated}
                  </summary>
                  <div className="tm-chat-q-spec">{m.intent.spec}</div>
                </details>
              )}
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
        <IntentPanel />
        <IntentNote />
        {!checking && <CoachChecklist text={text} />}
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
          {attachments.map((a) => (
            <span key={a.id} className={`tm-chat-chip is-on tm-chat-attachment is-${a.kind}`} data-testid="ai-attachment" title={`${a.origin || a.name} · ${formatSize(a.size)}${a.truncated ? " · only the start is sent" : ""}`}>
              {a.kind === "image" && a.image ? <img src={a.image} alt="" className="tm-chat-thumb" /> : <Codicon name={a.kind === "pasted" ? "note" : "file-code"} />}
              <span className="tm-chat-attachment-name">{a.name}</span>
              <span className="tm-chat-attachment-size">{formatSize(a.size)}</span>
              <button type="button" className="tm-chat-attachment-remove" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((l) => l.filter((x) => x.id !== a.id))}>
                <Codicon name="close" />
              </button>
            </span>
          ))}
        </div>
        {attachError && (
          <div className="tm-chat-attach-error" role="alert" data-testid="ai-attach-error">
            <Codicon name="warning" /> {attachError}
          </div>
        )}
        <div className="tm-chat-input">
          {suggest && (
            <div className="tm-chat-suggest" role="listbox" data-testid="ai-mentions">
              {suggest.items.map((f, i) => (
                <button key={f} type="button" role="option" aria-selected={i === suggest.index} className={i === suggest.index ? "is-on" : ""} onMouseDown={(e) => (e.preventDefault(), pickMention(f))} data-testid={f.startsWith("/") ? "ai-recipe" : undefined}>
                  <Codicon name={f.startsWith("/") ? "zap" : "file"} /> {f}
                  {f.startsWith("/") && <span className="tm-chat-suggest-detail">{recipeSuggestions(f.slice(1)).find((r) => r.id === f.slice(1))?.label}</span>}
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            value={text}
            rows={1}
            placeholder={checking ? "Confirm or change what TMCode understood above…" : agentMode === "chat" ? (file ? `Ask about ${file.slice(file.lastIndexOf("/") + 1)}…` : "Ask TMCode AI…") : "Describe a change or a fix… (@ adds a file)"}
            disabled={checking}
            aria-label="Ask TMCode AI"
            onPaste={onPaste}
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
              if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (text.trim()) checkMeaning();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            data-testid="ai-input"
          />
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="ai-attach-input"
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              if (files.length) void attach(() => Promise.all(files.map(fromBrowserFile)));
            }}
          />
          {!busy && !checking && (
            <button type="button" className="tm-chat-attach tm-chat-check" onClick={checkMeaning} disabled={!text.trim()} title={tutor ? "Check my question before asking (⌘⇧Enter)" : "Check what I mean before the AI acts (⌘⇧Enter)"} aria-label="Check what I mean" data-testid="ai-check-meaning">
              <Codicon name="sparkle" />
            </button>
          )}
          <button type="button" className="tm-chat-attach" onClick={pickFiles} title="Attach files (or paste / drop them here)" aria-label="Attach files" data-testid="ai-attach">
            <Codicon name="attach" />
          </button>
          {busy ? (
            <button type="button" className="tm-chat-send is-stop" onClick={stopAnswer} title="Stop" aria-label="Stop" data-testid="ai-stop">
              <Codicon name="debug-stop" />
            </button>
          ) : (
            <button type="button" className="tm-chat-send" onClick={() => send()} disabled={checking || (!text.trim() && !attachments.length)} title="Send (Enter)" aria-label="Send" data-testid="ai-send">
              <Codicon name="send" />
            </button>
          )}
        </div>
        {showMeter && <RequestMeter text={text} mentions={mentions.length} />}
        <div className="tm-chat-hint">
          Enter to send · ⌘⇧Enter check what I mean · Shift+Enter new line · ⇧Tab mode · @ file · ↑ earlier prompts
        </div>
      </div>
    </div>
  );
}
