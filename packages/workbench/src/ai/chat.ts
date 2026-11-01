import { create } from "zustand";
import { recordActivity } from "../activity/log";
import { getDocument, languageForPath } from "../monaco/documents";
import { codeEditorFor } from "../monaco/editors";
import { monaco } from "../monaco/setup";
import { listFiles } from "../parts/search/search";
import { activeFilePath, getPlatform, useWorkbench } from "../state/store";
import { Checkpoint, EXPLORE_TOOLS, gradingTools, parseArgs, permission, preview, runTool, toolDefs, type AgentMode, type ToolCall } from "./agent/tools";
import { CLIS, cliOf, isCliMode, isCliProvider, openCliAgent } from "./aiClis";
import { aiMaySee, combine, forAi, guardCall, loadAgentGuard } from "./agent/guard";
import { projectRules } from "./agent/projectRules";
import { replyLanguage } from "./actions";
import { aiGate } from "./gate";
import { asAiError, chat, effectiveMode, setAgentMode, useAi, type AiRequestError, type ChatContext, type WireMessage } from "./service";
import { attachmentChips, attachmentText, type Attachment } from "./attachments";
import { handoffText, similarity, type IntentCard } from "@tmcode/protocol";

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
  /** ask_user (C12): the agent's question and its choices, waiting for the answer. */
  question?: { text: string; choices: string[] };
}

export interface Message {
  /** Learning: lines of code the filter cut from this answer. */
  filtered?: number;
  /** The answering provider's terms in a few words ("Free tier · terms 18+ · no training"). */
  privacy?: string;
  id: number;
  role: "user" | "assistant";
  content: string;
  chips?: string[];
  model?: string;
  provider?: string;
  streaming?: boolean;
  /** `reason`: why (AI_DISABLED), or which AI CLI failed (CLI_*). */
  error?: { code: string; message: string; reason?: string };
  /** The agent's steps, in order (agent modes). */
  steps?: Step[];
  /** Files this request changed: "Undo all" puts them back. */
  checkpoint?: { files: string[]; undone?: boolean };
  /** The mode it was asked in. */
  mode?: ChatMode;
  /** Images attached to a question (data: URLs), shown as thumbnails. */
  images?: string[];
  /** The request check the user confirmed (prompt interpreter report, Q4): what was understood. */
  intent?: { restated: string; spec: string; language: string };
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
/** ask_user steps waiting for the answer (null: skipped). */
const answers = new Map<string, (answer: string | null) => void>();
const EXPLORE_STEPS = 8;
const checkpoints = new Map<number, Checkpoint>();
/** "Allow all edits / commands for this request" after the first OK. */
let allowAllFor: number | null = null;

const MAX_STEPS = 25;
/** The last question asked, and the last self-check failure with the question it followed (Q9). */
let lastQuestion = "";
let prevFailure: { question: string; sig: string } | null = null;

// ── context ──

export interface ContextOptions {
  file: boolean;
  problems: boolean;
  /** Files @-mentioned in the prompt: their text goes along. */
  mentions?: string[];
  /** Files attached with the paperclip, dropped or pasted (ai/attachments.ts). */
  attachments?: Attachment[];
}

export async function gatherContext(opts: ContextOptions): Promise<{ context: ChatContext; chips: string[] }> {
  await loadAgentGuard();
  // A file kept away from AI (secrets, .tmcodeignore, teacher-hidden) never goes along.
  const active = activeFilePath();
  const file = aiMaySee(active) ? active : null;
  const chips: string[] = [];
  const context: ChatContext = {};
  if (file) {
    const model = getDocument(file);
    const ed = codeEditorFor(useWorkbench.getState().activeGroup);
    context.file = file;
    context.language = model?.getLanguageId() ?? languageForPath(file);
    const sel = ed?.getModel() === model ? ed?.getSelection() : null;
    if (model && sel && !sel.isEmpty()) {
      context.selection = forAi(model.getValueInRange(sel).slice(0, 20_000));
      chips.push(`${file.slice(file.lastIndexOf("/") + 1)}: lines ${sel.startLineNumber}–${sel.endLineNumber}`);
    } else if (opts.file && model) {
      context.fileText = forAi(model.getValue().slice(0, 60_000));
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
    if (m === file || !aiMaySee(m)) continue;
    const open = getDocument(m)?.getValue();
    const text = open ?? (await getPlatform().fs.readFile(m).catch(() => null));
    if (text === null) continue;
    extra.push(`File ${m}:\n\`\`\`\n${forAi(text.slice(0, 30_000))}\n\`\`\``);
    chips.push(m.slice(m.lastIndexOf("/") + 1));
  }
  const attached = attachmentText(opts.attachments ?? []);
  if (attached) extra.push(attached);
  chips.push(...attachmentChips(opts.attachments ?? []));
  if (extra.length) context.task = [context.task, ...extra].filter(Boolean).join("\n\n");
  // A teacher reviewing a submission: Task Mentor answers as a grading assistant (staff only).
  const lang = replyLanguage();
  if (lang) context.reply_language = lang;
  // AGENTS.md (B2): the project's own rules, nearest folder last.
  const rules = await projectRules(getPlatform().fs, active).catch(() => null);
  if (rules?.text) {
    context.task = [context.task, `Project rules (${rules.files.join(", ")}): follow them.\n${forAi(rules.text)}`].filter(Boolean).join("\n\n");
    chips.push(`Rules: ${rules.files.length} file${rules.files.length === 1 ? "" : "s"}`);
  }
  // Industrial · Guided (A6, E7): scaffolds on for students.
  const g = aiGate();
  if (g.layer === "industrial" && g.profile === "guided" && useAi.getState().status?.staff !== true) context.scaffolds = true;
  const grading = gradingTools.chatContext?.() ?? null;
  if (grading) {
    context.purpose = grading.purpose;
    context.grading = grading.grading;
    chips.push(`grading ${grading.grading.student_name}`);
  }
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

/** What a mode is called now: in Learning every question goes to the tutor. */
export function modeLabelNow(mode: ChatMode, layer = aiGate().layer): string {
  return layer === "learning" ? "Tutor" : MODES.find((m) => m.id === mode)!.label;
}

export async function ask(text: string, opts: ContextOptions = { file: true, problems: true }, mode: ChatMode = useAi.getState().agentMode, extra: { intent?: IntentCard } = {}) {
  // A confirmed request check (Q4): the agent gets the user's words (authoritative) plus the card.
  let question = extra.intent ? handoffText(extra.intent) : text.trim();
  if (!question || useChat.getState().busy) return;
  // Learning: the tutor, which may read the project (read-only tools) and never changes it.
  const layer = aiGate().layer;
  if (layer === "learning") mode = getPlatform().fs ? "plan" : "chat";
  const ref = useChat.getState().reference;
  if (ref) question = `About your earlier answer:\n> ${ref.excerpt.replace(/\n/g, "\n> ")}\n\n${question}`;
  // An AI CLI in an agent mode: it works on the project itself, in a terminal (ai/aiClis.ts).
  if (mode !== "chat" && isCliMode(effectiveMode())) return askCliAgent(text.trim(), question, mode);
  const { context, chips } = await gatherContext(opts);
  const prior = priorTurns();
  const images = (opts.attachments ?? []).flatMap((a) => (a.kind === "image" && a.image ? [a.image] : []));
  const intent = extra.intent ? { restated: extra.intent.restated, spec: extra.intent.spec_en, language: extra.intent.language } : undefined;
  const user: Message = { id: ++seq, role: "user", content: text.trim(), chips: ref ? ["earlier answer", ...chips] : chips, mode, ...(images.length ? { images } : {}), ...(intent ? { intent } : {}) };
  lastQuestion = text.trim();
  const answer: Message = { id: ++seq, role: "assistant", content: "", streaming: true, mode, ...(mode !== "chat" ? { steps: [] } : {}) };
  useChat.setState((s) => ({ messages: [...s.messages, user, answer], busy: true, history: [...s.history.filter((h) => h !== text.trim()), text.trim()].slice(-50), reference: null }));
  stopFlag.cancelled = false;
  recordActivity({
    kind: "ai",
    action: "chat",
    path: context.file,
    text: `Asked TMCode AI${layer === "learning" ? " (Tutor, Learning)" : mode === "chat" ? "" : ` (${modeLabelNow(mode, layer)})`}: "${question.length > 90 ? `${question.slice(0, 87)}…` : text.trim().slice(0, 90)}"`,
    data: {
      question: text.trim().slice(0, 600),
      context: chips.join(", ") || "none",
      mode: useAi.getState().mode,
      agent_mode: mode,
      layer,
      ...(opts.attachments?.length ? { attachments: opts.attachments.map((a) => a.name).join(", ") } : {}),
      // The request check's A/B arm (Q14): holdout students' questions count for the comparison too.
      ...(useAi.getState().status?.interpreter ? { arm: useAi.getState().status!.interpreter!.arm } : {}),
      ...(extra.intent ? { checked: true } : {}),
    },
    actor: { type: "you" },
    ai: { by: "TMCode AI", how: layer === "learning" ? "question asked to the tutor (Learning)" : mode === "chat" ? "question asked in the chat" : `asked to work on the project (${mode})` },
  });
  // Images go with this question only (earlier turns are sent as text).
  const turn: WireMessage = { role: "user", content: images.length ? [{ type: "text", text: question }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] : question };
  if (mode === "chat") return answerOnce(answer.id, [...prior, turn], context);
  return runAgent(answer.id, mode, [...prior, turn], context);
}

async function askCliAgent(shown: string, task: string, mode: AgentMode) {
  const label = MODES.find((m) => m.id === mode)!.label;
  const cli = CLIS[cliOf(effectiveMode()) ?? "claude"];
  const user: Message = { id: ++seq, role: "user", content: shown, mode };
  const answer: Message = { id: ++seq, role: "assistant", content: "", streaming: true, mode, provider: cli.label };
  useChat.setState((s) => ({ messages: [...s.messages, user, answer], busy: true, history: [...s.history.filter((h) => h !== shown), shown].slice(-50), reference: null }));
  const file = activeFilePath();
  const r = await openCliAgent(file ? `${task}\n\n(The file open in the editor: ${file})` : task, mode, effectiveMode());
  if (!r.ok) return fail(answer.id, r.error);
  patch(answer.id, {
    streaming: false,
    model: "terminal",
    content: `${cli.label} is working on this in the terminal (**${label}**: \`${r.command}\`). It asks there before anything the mode doesn't allow, and its changes show in your editor as it makes them.`,
  });
  useChat.setState({ busy: false });
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
        meta: (m) => patch(id, { model: m.model, provider: m.provider, ...(m.privacy ? { privacy: m.privacy } : {}) }),
        delta: (t) => {
          text += t;
          patch(id, { content: prefix + text });
        },
        done: (d) => {
          cancel = null;
          if (useAi.getState().status) {
            useAi.setState((s) => ({
              status: s.status && {
                ...s.status,
                you: { ...s.status.you, ...(d.you ? { chat: d.you } : {}), ...(d.steps ? { agent: d.steps } : {}) },
                ...(d.allowance && s.status.learning ? { learning: { ...s.status.learning, allowance: d.allowance } } : {}),
              },
            }));
          }
          if (d.filtered?.removed) noteFiltered(id, d.filtered.removed, d.provider, d.model);
          resolve({ text, toolCalls: (d.tool_calls ?? []) as ToolCall[], provider: d.provider, model: d.model });
        },
        error: (e) => {
          cancel = null;
          reject(e);
        },
      },
      agent && agent.mode !== "chat" ? { mode: agent.mode, step: agent.step, tools: toolDefs(agent.mode, canRun, !!gradingTools.chatContext?.(), aiGate().layer) } : undefined,
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

/** Learning: the filter cut code from an answer. The teacher sees it in the log (I1: filter hits). */
function noteFiltered(id: number, removed: number, provider: string, model: string) {
  patch(id, (m) => ({ filtered: (m.filtered ?? 0) + removed }));
  recordActivity({
    kind: "ai",
    action: "filtered",
    text: `Learning: TMCode removed ${removed} line${removed === 1 ? "" : "s"} of code from the tutor's answer`,
    data: { removed },
    actor: { type: "tmcode-ai" },
    ai: { by: "TMCode AI", how: "Learning filter removed code", model: `${provider} · ${model}` },
  });
}

function finish(id: number, content: string, provider: string, model: string) {
  patch(id, { streaming: false, model, provider });
  useChat.setState({ busy: false });
  recordActivity({
    kind: "ai",
    action: "answer",
    text: `${isCliProvider(provider) ? provider : "TMCode AI"} answered (${content.length} characters${/```/.test(content) ? ", with code" : ""})`,
    data: { chars: content.length, model, provider },
    actor: { type: "tmcode-ai" },
    ai: { by: isCliProvider(provider) ? provider : "TMCode AI", how: "answered in the chat", model: `${provider} · ${model}` },
  });
}

function fail(id: number, err: unknown) {
  const e = asAiError(err as AiRequestError);
  patch(id, { streaming: false, error: { code: e.code, message: e.message, ...(e.reason ? { reason: e.reason } : {}) } });
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
  await loadAgentGuard();
  const cp = new Checkpoint();
  checkpoints.set(id, cp);
  allowAllFor = null;
  let content = "";
  let provider = "";
  let model = "";
  let heal: HealState = { attempts: 0, last: null };
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      if (stopFlag.cancelled) break;
      const prefix = content ? `${content}\n\n` : "";
      // Later steps carry only the grading purpose (Task Mentor keeps the grading prompt for every step).
      const r = await streamOnce(id, wire, step === 0 ? context : context.purpose ? { purpose: context.purpose, grading: context.grading } : undefined, { mode, step }, prefix);
      provider = r.provider;
      model = r.model;
      if (r.text.trim()) content = prefix + r.text;
      if (!r.toolCalls.length) {
        // L3: check the work (the project's tests), and let the agent fix what fails, with a breaker.
        const again = await selfCheck(id, mode, cp, heal);
        if (!again) break;
        heal = again.state;
        wire = [...wire, { role: "assistant", content: r.text || "Done." }, { role: "user", content: again.prompt }];
        continue;
      }
      wire = [...wire, { role: "assistant", content: r.text || null, tool_calls: r.toolCalls }];
      for (const call of r.toolCalls) {
        if (stopFlag.cancelled) break;
        const args = parseArgs(call);
        // The agent asks instead of guessing (C12): the step waits for the user's answer.
        if (call.function.name === "ask_user") {
          const text = String(args.question ?? "").slice(0, 400) || "Which way should I go?";
          const choices = (Array.isArray(args.choices) ? args.choices : []).map((c) => String(c).slice(0, 120)).filter(Boolean).slice(0, 4);
          setStep(id, { id: call.id, tool: "ask_user", title: text, status: "waiting", question: { text, choices } });
          const answer = await new Promise<string | null>((resolve) => answers.set(call.id, resolve));
          answers.delete(call.id);
          setStep(id, { id: call.id, tool: "ask_user", title: text, status: answer ? "done" : "rejected", output: answer ?? undefined });
          wire = [...wire, { role: "tool", tool_call_id: call.id, content: answer ? `The user answered: ${answer}` : "The user skipped the question. Make a sensible choice and say which." }];
          continue;
        }
        // A read-only helper researches and answers with a summary (C11 Explore).
        if (call.function.name === "explore") {
          const q = String(args.question ?? "").slice(0, 600);
          setStep(id, { id: call.id, tool: "explore", title: `Exploring: ${q.slice(0, 80)}`, status: "running" });
          const summary = await explore(q, context).catch((e) => `The explorer couldn't finish: ${asAiError(e).message}`);
          setStep(id, { id: call.id, tool: "explore", title: `Explored: ${q.slice(0, 80)}`, status: "done", output: summary });
          wire = [...wire, { role: "tool", tool_call_id: call.id, content: summary }];
          continue;
        }
        const layer = aiGate().layer;
        const modeVerdict = permission(mode, call.function.name, args, layer);
        // The safety rails (rules, ignore list, package check) tighten what the mode allows.
        const rails = modeVerdict === "refuse" ? { verdict: null } : await guardCall(mode, call.function.name, args);
        const verdict = combine(modeVerdict, rails);
        const p = await preview(call);
        let output: string;
        if (verdict === "refuse") {
          setStep(id, { id: call.id, tool: call.function.name, title: rails.reason ? `${p.title}: ${rails.reason}` : p.title, status: "refused" });
          output = rails.reason ? `Refused: ${rails.reason} Don't retry it; continue without it or ask the user.` : layer === "learning" ? "Not allowed in Learning: the student writes every line. Explain in words what they could try instead." : "Not allowed in Plan mode: present your plan instead of changing files.";
        } else {
          let ok = true;
          // "Allow all" never skips a rails question (a rule's ask, a new package).
          if (verdict === "ask" && (allowAllFor !== id || rails.verdict === "ask")) {
            setStep(id, { id: call.id, tool: call.function.name, title: rails.warning ? `${p.title} — ${rails.warning}` : p.title, status: "waiting", diff: p.diff, command: p.command });
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
    for (const [, resolve] of answers) resolve(null);
    answers.clear();
  }
}

// ── L3: the self-healing loop, with a circuit breaker ──

export interface HealState {
  attempts: number;
  /** The last failure, to stop when the same one comes back. */
  last: string | null;
}

export const HEAL_MAX = 5;

/** The project's own test command, if it has one (never anything destructive). */
export async function detectTestCommand(): Promise<string | null> {
  const fs = getPlatform().fs;
  const pkg = await fs.readFile("package.json").catch(() => null);
  if (pkg) {
    try {
      const t = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts?.test;
      if (t && !/no test specified/.test(t)) return "npm test --silent";
    } catch {
      /* not JSON */
    }
  }
  const files = await listFiles(fs).catch(() => [] as string[]);
  if (files.some((f) => /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(f))) return "python3 -m pytest -q";
  if (files.some((f) => /_test\.go$/.test(f))) return "go test ./...";
  if (files.includes("Cargo.toml")) return "cargo test --quiet";
  return null;
}

/** A failure's fingerprint: the output's tail without numbers that change between runs (times, ids). */
export function failureSignature(output: string): string {
  return output.slice(-600).replace(/\d+(\.\d+)?\s*m?s\b/g, "#").replace(/0x[0-9a-f]+/gi, "#").replace(/\s+/g, " ").trim();
}

/**
 * After the agent says it's done (Industrial, Edit automatically / Auto, files changed): run the
 * tests. Pass: stop. Fail: hand the output back, at most HEAL_MAX times, and stop at once when the
 * same failure repeats (the breaker), never running anything but the project's own test command.
 */
async function selfCheck(id: number, mode: AgentMode, cp: Checkpoint, state: HealState): Promise<{ prompt: string; state: HealState } | null> {
  const g = aiGate();
  if (stopFlag.cancelled || g.layer !== "industrial" || (mode !== "edit" && mode !== "auto") || !cp.files.length || !getPlatform().proc) return null;
  const command = await detectTestCommand();
  if (!command) return null;
  const stepId = `selfcheck-${state.attempts + 1}`;
  setStep(id, { id: stepId, tool: "run_command", title: `Self-check ${state.attempts + 1}: ${command}`, status: "running", command });
  const res = await runTool({ id: stepId, type: "function", function: { name: "run_command", arguments: JSON.stringify({ command }) } }, cp, stopFlag);
  if (res.ok) {
    setStep(id, { id: stepId, tool: "run_command", title: `Self-check passed: ${command}`, status: "done", command, output: res.output });
    return null;
  }
  const sig = failureSignature(res.output);
  // Q9 (the "same wrong program despite edits" trap): an edited request that fails the same way.
  if (state.attempts === 0 && prevFailure && prevFailure.sig === sig && prevFailure.question !== lastQuestion && similarity(prevFailure.question, lastQuestion) >= 0.3) {
    setStep(id, { id: `${stepId}-same`, tool: "ask_user", title: "Same failure as before you changed your request: the change didn't change the result. Try adding an example of what should happen.", status: "done" });
    recordActivity({ kind: "ai", action: "understood-diff", text: "TMCode noticed an edited request that failed the same way as before", data: { kind: "same-failure" }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "same failure after an edited request" } });
  }
  if (state.attempts === 0) prevFailure = { question: lastQuestion, sig };
  const attempts = state.attempts + 1;
  if (sig === state.last || attempts > HEAL_MAX) {
    setStep(id, { id: stepId, tool: "run_command", title: sig === state.last ? "Self-check stopped: the same failure came back (circuit breaker)" : `Self-check stopped after ${HEAL_MAX} attempts`, status: "failed", command, output: res.output });
    recordActivity({ kind: "ai", action: "self-heal-stopped", text: `TMCode AI's self-check stopped (${sig === state.last ? "same failure twice" : `${HEAL_MAX} attempts`})`, data: { attempts }, actor: { type: "tmcode-ai" }, ai: { by: "TMCode AI", how: "self-healing loop stopped by the breaker" } });
    return null;
  }
  setStep(id, { id: stepId, tool: "run_command", title: `Self-check ${attempts}/${HEAL_MAX} failed: fixing`, status: "failed", command, output: res.output });
  return {
    state: { attempts, last: sig },
    prompt: `The self-check (\`${command}\`) failed, attempt ${attempts} of ${HEAL_MAX}:\n\n${res.output.slice(-4000)}\n\nFix the cause with the smallest change. Don't change or delete tests to make them pass, and don't run destructive commands.`,
  };
}

/** The user's answer to an ask_user step (null: skip). */
export function answerQuestion(stepId: string, answer: string | null) {
  answers.get(stepId)?.(answer && answer.trim() ? answer.trim().slice(0, 600) : null);
}

/**
 * Explore (C11): a separate, read-only run with its own small conversation, so the main agent's
 * context stays small. It may list, read, search and use the code map; it answers with a summary.
 */
async function explore(question: string, context: ChatContext): Promise<string> {
  const canRun = !!getPlatform().proc;
  const tools = toolDefs("plan", canRun, false, aiGate().layer).filter((t) => EXPLORE_TOOLS.has(t.function.name));
  let wire: WireMessage[] = [{ role: "user", content: `Research this question in the project with the read-only tools, then answer with a concise summary (the files, functions and how they connect; at most 200 words). Don't propose changes.\n\nQuestion: ${question}` }];
  const cp = new Checkpoint();
  for (let step = 0; step < EXPLORE_STEPS; step++) {
    if (stopFlag.cancelled) return "(stopped)";
    const r = await new Promise<{ text: string; calls: ToolCall[] }>((resolve, reject) => {
      let text = "";
      chat(wire, step === 0 ? { file: context.file, language: context.language } : undefined, { meta() {}, delta: (t) => (text += t), done: (d) => resolve({ text, calls: (d.tool_calls ?? []) as ToolCall[] }), error: reject }, { mode: "plan", step: step + 1, tools }).catch(reject);
    });
    const calls = r.calls.filter((c) => EXPLORE_TOOLS.has(c.function.name));
    if (!calls.length) return r.text.trim() || "(the explorer found nothing to report)";
    wire = [...wire, { role: "assistant", content: r.text || null, tool_calls: calls }];
    for (const c of calls) wire = [...wire, { role: "tool", tool_call_id: c.id, content: (await runTool(c, cp, stopFlag)).output }];
  }
  return "(the explorer ran out of steps; ask a narrower question)";
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
