import { create } from "zustand";
import { recordActivity } from "../activity/log";
import { getDocument, languageForPath } from "../monaco/documents";
import { codeEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { activeFilePath, getPlatform, useWorkbench } from "../state/store";
import { Checkpoint, parseArgs, permission, preview, runTool, toolDefs, type AgentMode, type ToolCall } from "./agent/tools";
import { asAiError, chat, setAgentMode, useAi, type AiRequestError, type ChatContext, type WireMessage } from "./service";

/**
 * TMCode AI's conversation, as Claude Code's: one place for the question, the answer and, in the
 * agent modes, every step the AI takes on the project (read, search, edit, run…), with the
 * student's OK where the mode asks for it, and Undo for everything a request changed.
 *
 * Modes (⇧Tab cycles them in the prompt box):
 *   chat   — answers only, nothing in the project changes;
 *   manual — the agent asks before each change;
 *   edit   — edits are applied directly (Undo all), commands ask;
 *   plan   — the agent explores read-only and proposes a plan, then "Start building";
 *   auto   — edits and safe commands run directly, anything risky waits for an OK.
 */

export type ChatMode = "chat" | AgentMode;

export const MODES: { id: ChatMode; label: string; detail: string; icon: string }[] = [
  { id: "chat", label: "Chat", detail: "Answers and explains; nothing in your project changes", icon: "comment-discussion" },
  { id: "manual", label: "Manual", detail: "Works on your project and asks before each change", icon: "shield" },
  { id: "edit", label: "Edit automatically", detail: "Makes file changes directly (Undo all); asks before commands", icon: "code" },
  { id: "plan", label: "Plan", detail: "Explores your code and presents a plan before editing", icon: "list-ordered" },
  { id: "auto", label: "Auto", detail: "Edits and safe commands run; pauses for anything risky", icon: "zap" },
];

export type StepStatus = "running" | "done" | "failed" | "waiting" | "rejected" | "refused";

export interface Step {
  id: string;
  tool: string;
  title: string;
  status: StepStatus;
  diff?: { path: string; before: string; after: string };
  command?: string;
  output?: string;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  chips?: string[];
  model?: string;
  provider?: string;
  streaming?: boolean;
  error?: { code: string; message: string };
  /** The agent's steps, in order (agent modes). */
  steps?: Step[];
  /** Files this request changed: "Undo all" puts them back. */
  checkpoint?: { files: string[]; undone?: boolean };
  /** The mode it was asked in. */
  mode?: ChatMode;
}

interface ChatState {
  messages: Message[];
  busy: boolean;
  /** Prompts sent, newest last (↑/↓ in the prompt box). */
  history: string[];
  /** A message the next prompt refers to ("about this answer"). */
  reference: { id: number; excerpt: string } | null;
}

export const useChat = create<ChatState>(() => ({ messages: [], busy: false, history: [], reference: null }));
let seq = 0;
let cancel: (() => void) | null = null;
const stopFlag = { cancelled: false };
const approvals = new Map<string, (ok: boolean) => void>();
const checkpoints = new Map<number, Checkpoint>();
/** "Allow all edits / commands for this request" after the first OK. */
let allowAllFor: number | null = null;

const MAX_STEPS = 25;

// ── context ──

export interface ContextOptions {
  file: boolean;
  problems: boolean;
  /** Files @-mentioned in the prompt: their text goes along. */
  mentions?: string[];
}

export async function gatherContext(opts: ContextOptions): Promise<{ context: ChatContext; chips: string[] }> {
  const file = activeFilePath();
  const chips: string[] = [];
  const context: ChatContext = {};
  if (file) {
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
  }
  const extra: string[] = [];
  for (const m of opts.mentions ?? []) {
    if (m === file) continue;
    const open = getDocument(m)?.getValue();
    const text = open ?? (await getPlatform().fs.readFile(m).catch(() => null));
    if (text === null) continue;
    extra.push(`File ${m}:\n\`\`\`\n${text.slice(0, 30_000)}\n\`\`\``);
    chips.push(m.slice(m.lastIndexOf("/") + 1));
  }
  if (extra.length) context.task = [context.task, ...extra].filter(Boolean).join("\n\n");
  return { context, chips };
}

// ── asking ──

function patch(id: number, p: Partial<Message> | ((m: Message) => Partial<Message>)) {
  useChat.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...(typeof p === "function" ? p(m) : p) } : m)) }));
}

/** Earlier turns as plain text (the agent's tool traffic stays out: it is long and done). */
function priorTurns(): WireMessage[] {
  return useChat
    .getState()
    .messages.filter((m) => !m.error && !m.streaming && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content }));
}

export async function ask(text: string, opts: ContextOptions = { file: true, problems: true }, mode: ChatMode = useAi.getState().agentMode) {
  let question = text.trim();
  if (!question || useChat.getState().busy) return;
  const ref = useChat.getState().reference;
  if (ref) question = `About your earlier answer:\n> ${ref.excerpt.replace(/\n/g, "\n> ")}\n\n${question}`;
  const { context, chips } = await gatherContext(opts);
  const prior = priorTurns();
  const user: Message = { id: ++seq, role: "user", content: text.trim(), chips: ref ? ["earlier answer", ...chips] : chips, mode };
  const answer: Message = { id: ++seq, role: "assistant", content: "", streaming: true, mode, ...(mode !== "chat" ? { steps: [] } : {}) };
  useChat.setState((s) => ({ messages: [...s.messages, user, answer], busy: true, history: [...s.history.filter((h) => h !== text.trim()), text.trim()].slice(-50), reference: null }));
  stopFlag.cancelled = false;
  recordActivity({
    kind: "ai",
    action: "chat",
    path: context.file,
    text: `Asked TMCode AI${mode === "chat" ? "" : ` (${MODES.find((m) => m.id === mode)!.label})`}: "${question.length > 90 ? `${question.slice(0, 87)}…` : text.trim().slice(0, 90)}"`,
    data: { question: text.trim().slice(0, 600), context: chips.join(", ") || "none", mode: useAi.getState().mode, agent_mode: mode },
    actor: { type: "you" },
    ai: { by: "TMCode AI", how: mode === "chat" ? "question asked in the chat" : `asked to work on the project (${mode})` },
  });
  if (mode === "chat") return answerOnce(answer.id, [...prior, { role: "user", content: question }], context);
  return runAgent(answer.id, mode, [...prior, { role: "user", content: question }], context);
}

/** One streamed request; resolves with its text and tool calls. */
function streamOnce(id: number, wire: WireMessage[], context: ChatContext | undefined, agent?: { mode: ChatMode; step: number }, prefix = "") {
  return new Promise<{ text: string; toolCalls: ToolCall[]; provider: string; model: string }>((resolve, reject) => {
    let text = "";
    const canRun = !!getPlatform().proc;
    chat(
      wire,
      context,
      {
        meta: (m) => patch(id, { model: m.model, provider: m.provider }),
        delta: (t) => {
          text += t;
          patch(id, { content: prefix + text });
        },
        done: (d) => {
          cancel = null;
          if (useAi.getState().status) {
            useAi.setState((s) => ({ status: s.status && { ...s.status, you: { ...s.status.you, ...(d.you ? { chat: d.you } : {}), ...(d.steps ? { agent: d.steps } : {}) } } }));
          }
          resolve({ text, toolCalls: (d.tool_calls ?? []) as ToolCall[], provider: d.provider, model: d.model });
        },
        error: (e) => {
          cancel = null;
          reject(e);
        },
      },
      agent && agent.mode !== "chat" ? { mode: agent.mode, step: agent.step, tools: toolDefs(agent.mode, canRun) } : undefined,
    )
      .then((c) => (cancel = c))
      .catch(reject);
  });
}

async function answerOnce(id: number, wire: WireMessage[], context: ChatContext) {
  try {
    const r = await streamOnce(id, wire, context);
    finish(id, r.text, r.provider, r.model);
  } catch (e) {
    fail(id, e);
  }
}

function finish(id: number, content: string, provider: string, model: string) {
  patch(id, { streaming: false, model, provider });
  useChat.setState({ busy: false });
  recordActivity({
    kind: "ai",
    action: "answer",
    text: `TMCode AI answered (${content.length} characters${/```/.test(content) ? ", with code" : ""})`,
    data: { chars: content.length, model, provider },
    actor: { type: "tmcode-ai" },
    ai: { by: "TMCode AI", how: "answered in the chat", model: `${provider} · ${model}` },
  });
}

function fail(id: number, err: unknown) {
  const e = asAiError(err as AiRequestError);
  patch(id, { streaming: false, error: { code: e.code, message: e.message } });
  useChat.setState({ busy: false });
  cancel = null;
}

function setStep(id: number, step: Step) {
  patch(id, (m) => {
    const steps = [...(m.steps ?? [])];
    const i = steps.findIndex((s) => s.id === step.id);
    if (i >= 0) steps[i] = step;
    else steps.push(step);
    return { steps };
  });
}

/** The agent: ask, run the tools the AI calls (with the student's OK where the mode wants it), repeat. */
async function runAgent(id: number, mode: AgentMode, wire: WireMessage[], context: ChatContext) {
  const cp = new Checkpoint();
  checkpoints.set(id, cp);
  allowAllFor = null;
  let content = "";
  let provider = "";
  let model = "";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopFlag.cancelled) break;
      const prefix = content ? `${content}\n\n` : "";
      const r = await streamOnce(id, wire, step === 0 ? context : undefined, { mode, step }, prefix);
      provider = r.provider;
      model = r.model;
      if (r.text.trim()) content = prefix + r.text;
      if (!r.toolCalls.length) break;
      wire = [...wire, { role: "assistant", content: r.text || null, tool_calls: r.toolCalls }];
      for (const call of r.toolCalls) {
        if (stopFlag.cancelled) break;
        const args = parseArgs(call);
        const verdict = permission(mode, call.function.name, args);
        const p = await preview(call);
        let output: string;
        if (verdict === "refuse") {
          setStep(id, { id: call.id, tool: call.function.name, title: p.title, status: "refused" });
          output = "Not allowed in Plan mode: present your plan instead of changing files.";
        } else {
          let ok = true;
          if (verdict === "ask" && allowAllFor !== id) {
            setStep(id, { id: call.id, tool: call.function.name, title: p.title, status: "waiting", diff: p.diff, command: p.command });
            ok = await new Promise<boolean>((resolve) => approvals.set(call.id, resolve));
            approvals.delete(call.id);
          }
          if (!ok) {
            setStep(id, { id: call.id, tool: call.function.name, title: p.title, status: "rejected", diff: p.diff, command: p.command });
            output = "The student declined this change. Don't retry it; ask what they would like instead, or continue without it.";
          } else {
            setStep(id, { id: call.id, tool: call.function.name, title: p.title, status: "running", diff: p.diff, command: p.command });
            const res = await runTool(call, cp, stopFlag);
            setStep(id, { id: call.id, tool: call.function.name, title: res.summary, status: res.ok ? "done" : "failed", diff: res.diff, command: p.command, output: call.function.name === "run_command" ? res.output : undefined });
            output = res.output;
          }
        }
        wire = [...wire, { role: "tool", tool_call_id: call.id, content: output }];
      }
      if (cp.files.length) patch(id, { checkpoint: { files: cp.files } });
    }
    if (!content.trim()) content = stopFlag.cancelled ? "_(stopped)_" : cp.files.length ? `Done: changed ${cp.files.join(", ")}.` : "Done.";
    patch(id, { content });
    finish(id, content, provider, model);
    if (cp.files.length) {
      recordActivity({
        kind: "ai",
        action: "agent",
        text: `TMCode AI changed ${cp.files.length} file${cp.files.length === 1 ? "" : "s"} (${MODES.find((m) => m.id === mode)!.label})`,
        data: { files: cp.files.join(", "), mode },
        actor: { type: "tmcode-ai" },
        ai: { by: "TMCode AI", how: `worked on the project (${mode})`, model: `${provider} · ${model}` },
      });
    }
  } catch (e) {
    if (cp.files.length) patch(id, { checkpoint: { files: cp.files } });
    fail(id, e);
  } finally {
    for (const [, resolve] of approvals) resolve(false);
    approvals.clear();
  }
}

/** The student's answer to a waiting step. `all`: allow the rest of this request without asking. */
export function approveStep(messageId: number, stepId: string, ok: boolean, all = false) {
  if (all && ok) allowAllFor = messageId;
  approvals.get(stepId)?.(ok);
}

export async function undoRequest(messageId: number) {
  const cp = checkpoints.get(messageId);
  if (!cp) return;
  await cp.restore();
  patch(messageId, (m) => ({ checkpoint: m.checkpoint && { ...m.checkpoint, undone: true } }));
}

/** Plan mode's "Start building": carry out the plan in a mode that changes files. */
export function startBuilding(mode: AgentMode = "edit") {
  setAgentMode(mode);
  void ask("Carry out the plan above, step by step.", { file: true, problems: true }, mode);
}

export function stopAnswer() {
  stopFlag.cancelled = true;
  cancel?.();
  cancel = null;
  for (const [, resolve] of approvals) resolve(false);
  approvals.clear();
  useChat.setState((s) => ({ busy: false, messages: s.messages.map((m) => (m.streaming ? { ...m, streaming: false, content: m.content + (m.content ? "\n\n_(stopped)_" : "_(stopped)_") } : m)) }));
}

export function newChat() {
  stopAnswer();
  useChat.setState({ messages: [], reference: null });
}

/** Ask again (the last question, or an edited one): drops everything after it. */
export function resend(messageId: number, text?: string) {
  const list = useChat.getState().messages;
  const i = list.findIndex((m) => m.id === messageId);
  if (i < 0 || useChat.getState().busy) return;
  const q = list[i];
  useChat.setState({ messages: list.slice(0, i) });
  void ask(text ?? q.content, { file: true, problems: true }, q.mode ?? useAi.getState().agentMode);
}

export function referTo(messageId: number) {
  const m = useChat.getState().messages.find((x) => x.id === messageId);
  if (!m) return;
  const excerpt = m.content.replace(/```[\s\S]*?```/g, "[code]").trim().slice(0, 400);
  useChat.setState({ reference: { id: messageId, excerpt } });
}
