import { create } from "zustand";
import { recordActivity } from "../activity/log";
import { CLIS, cliOf, isCliProvider } from "../ai/aiClis";
import { aiGate, aiUiHidden } from "../ai/gate";
import { AiRequestError, asAiError, chat, modeLabel, effectiveMode, useAi, type WireMessage } from "../ai/service";
import type { OsKind } from "../platform/types";
import { getPlatform, useWorkbench } from "../state/store";
import { assessRisk, buildTerminalPrompt, maxRisk, parseTerminalAnswer, type RecentCommand, type Risk, type TerminalAiAnswer, type TerminalAiKind } from "./ai";

/**
 * One TMCode AI conversation in the terminal panel (terminal/ai.ts has the format and the rules):
 * the widget asks, follow-ups refine the same answer ("only in src", "for Windows"), and the
 * cards' Run / Insert go to the terminal it was opened on.
 */

/** What the widget needs from a terminal (TerminalView registers the active one). */
export interface TerminalAiHost {
  id: number;
  shell: string;
  os: OsKind;
  cwd(): string | undefined;
  /** The last finished commands, oldest first (the last one with its output when `withOutput`). */
  recent(withOutput: boolean): RecentCommand[];
  /** A command is still running (typing would go to it, not to the shell). */
  busy(): boolean;
  /** Clears what is typed at the prompt, then types `text` (with "\r": runs it). */
  type(text: string): void;
  /** Runs `command` in a new terminal (when this one is busy). */
  runElsewhere(command: string): void;
  focus(): void;
}

export interface CommandCard {
  command: string;
  explanation: string;
  /** The higher of the AI's risk and TMCode's own check (assessRisk). */
  risk: Risk;
  /** Why TMCode thinks it's risky ("deletes files without asking"). */
  why: string | null;
}

export interface TerminalAiState {
  open: boolean;
  terminalId: number | null;
  kind: TerminalAiKind;
  phase: "idle" | "asking" | "done" | "error";
  /** The last request typed (or the failed command's line for fix / explain). */
  request: string;
  answer: (Omit<TerminalAiAnswer, "commands"> & { commands: CommandCard[] }) | null;
  error: AiRequestError | null;
  /** "Groq · gpt-oss-120b" once the server says who answers. */
  by: string | null;
  /** The conversation so far (for follow-ups). */
  turns: WireMessage[];
  /** Requests asked this session (↑ in the empty box). */
  history: string[];
  /** Bumps when the widget should take focus (opened again while open). */
  focusSeq: number;
}

const INITIAL: Omit<TerminalAiState, "history" | "focusSeq"> = { open: false, terminalId: null, kind: "ask", phase: "idle", request: "", answer: null, error: null, by: null, turns: [] };

export const useTerminalAi = create<TerminalAiState>(() => ({ ...INITIAL, history: [], focusSeq: 0 }));

let hostOf: () => TerminalAiHost | null = () => null;
/** TerminalView: how to reach the active terminal. */
export function registerTerminalAiHost(get: () => TerminalAiHost | null) {
  hostOf = get;
}

export function terminalAiHost(): TerminalAiHost | null {
  return hostOf();
}

let cancelStream: (() => void) | null = null;
function stop() {
  cancelStream?.();
  cancelStream = null;
}

/** Is TMCode AI in the terminal on (the setting), whatever the school allows? */
export function terminalAiEnabled(): boolean {
  // Exam: the terminal has no AI at all (A5).
  return useWorkbench.getState().settings["terminal.integrated.ai.enabled"] !== false && !aiUiHidden();
}

/** Opens the widget on the active terminal; with `request`, asks at once. */
export function openTerminalAi(opts: { kind?: TerminalAiKind; request?: string } = {}) {
  const host = hostOf();
  if (!host) return;
  const s = useTerminalAi.getState();
  const kind = opts.kind ?? "ask";
  if (s.open && s.terminalId === host.id && !opts.request && kind === "ask") {
    useTerminalAi.setState({ focusSeq: s.focusSeq + 1 });
    return;
  }
  stop();
  useTerminalAi.setState({ ...INITIAL, open: true, terminalId: host.id, kind, history: s.history, focusSeq: s.focusSeq + 1 });
  if (opts.request !== undefined || kind !== "ask") void askTerminalAi(kind, opts.request ?? "");
}

export function closeTerminalAi(focusTerminal = true) {
  stop();
  const s = useTerminalAi.getState();
  useTerminalAi.setState({ ...INITIAL, history: s.history, focusSeq: s.focusSeq });
  if (focusTerminal) hostOf()?.focus();
}

/** Starts over in the open widget (New question). */
export function resetTerminalAi() {
  stop();
  const s = useTerminalAi.getState();
  useTerminalAi.setState({ ...INITIAL, open: true, terminalId: s.terminalId, history: s.history, focusSeq: s.focusSeq + 1 });
}

let filesCache: { root: string; at: number; names: string[] } | null = null;
/** The folder's top level ("src/", "package.json"), cached for half a minute. */
async function topLevelNames(): Promise<string[]> {
  const root = useWorkbench.getState().workspace?.root;
  if (!root) return [];
  if (filesCache && filesCache.root === root && Date.now() - filesCache.at < 30_000) return filesCache.names;
  try {
    const entries = await getPlatform().fs.readDir("");
    const names = entries
      .filter((e) => !/^(\.git|node_modules|\.DS_Store)$/.test(e.name))
      .map((e) => (e.kind === "dir" ? `${e.name}/` : e.name))
      .slice(0, 60);
    filesCache = { root, at: Date.now(), names };
    return names;
  } catch {
    return [];
  }
}

/** The answer's commands as cards, with TMCode's own risk check over the AI's. */
export function toCards(answer: TerminalAiAnswer): CommandCard[] {
  return answer.commands.map((c) => {
    const local = assessRisk(c.command);
    return { command: c.command, explanation: c.explanation, risk: maxRisk(local.risk, answer.risk === "danger" && local.risk === "safe" ? "caution" : answer.risk), why: local.why };
  });
}

/**
 * Asks TMCode AI (in the widget's conversation). `kind` fix / explain is about the terminal's
 * last command; a follow-up (`request` while an answer shows) refines the answer.
 */
export async function askTerminalAi(kind: TerminalAiKind, request: string) {
  const host = hostOf();
  const s = useTerminalAi.getState();
  if (!host) return;
  const gate = aiGate();
  if (!gate.chat) {
    useTerminalAi.setState({ phase: "error", error: new AiRequestError(gate.reason ?? "AI_DISABLED", gate.message ?? "TMCode AI is off.", gate.reason ?? undefined) });
    return;
  }
  // Learning: TMCode AI explains what you typed, in words; it never writes the command for you.
  if (!gate.nlCommand && kind !== "explain") {
    useTerminalAi.setState({ phase: "error", error: new AiRequestError("LAYER_LEARNING", "Learning: TMCode AI won't write commands for you. Use Explain on a failed command, or ask your tutor in the chat.") });
    return;
  }
  const followUp = s.phase === "done" && s.turns.length > 0 && kind === "ask";
  const recent = host.recent(kind !== "ask");
  if (kind !== "ask" && !recent.length) {
    useTerminalAi.setState({ phase: "error", error: new AiRequestError("NO_COMMAND", "No command has finished in this terminal yet. Run one, or ask in your own words.") });
    return;
  }
  const text = followUp
    ? `${request.trim()}\n\n(Same shell and folder. Answer in the same JSON format.)`
    : buildTerminalPrompt(kind, request, { os: host.os, shell: host.shell, cwd: host.cwd(), files: await topLevelNames(), recent });
  const turns: WireMessage[] = [...(followUp ? s.turns : []), { role: "user", content: text }];
  const shown = kind === "ask" ? request.trim() : recent[recent.length - 1].command;
  const history = kind === "ask" && request.trim() ? [...s.history.filter((h) => h !== request.trim()), request.trim()].slice(-30) : s.history;
  stop();
  useTerminalAi.setState({ kind: followUp ? s.kind : kind, phase: "asking", request: shown, error: null, by: null, turns, history, ...(followUp ? {} : { answer: null }) });

  let raw = "";
  const fail = (e: AiRequestError) => {
    cancelStream = null;
    useTerminalAi.setState({ phase: "error", error: e });
  };
  try {
    cancelStream = await chat(turns, { purpose: "terminal" }, {
      meta: (m) => useTerminalAi.setState({ by: `${m.model}` }),
      delta: (t) => {
        raw += t;
      },
      done: (d) => {
        cancelStream = null;
        const answer = parseTerminalAnswer(raw);
        // Learning: words only, whatever came back (the server's filter cuts commands too).
        const parsed = aiGate().nlCommand ? answer : { ...answer, commands: [] };
        if (!parsed.commands.length && !parsed.explanation && !parsed.question) return fail(new AiRequestError("EMPTY", `${isCliProvider(d.provider) ? d.provider : "TMCode AI"} sent an empty answer. Try again, or pick another model.`));
        useTerminalAi.setState({
          phase: "done",
          answer: { ...parsed, commands: toCards(parsed) },
          by: d.model || useTerminalAi.getState().by,
          turns: [...turns, { role: "assistant", content: raw }],
        });
        recordActivity({
          kind: "ai",
          action: "terminal-ask",
          text: `Asked ${isCliProvider(d.provider) ? d.provider : "TMCode AI"} in the terminal: ${shown.length > 100 ? `${shown.slice(0, 97)}…` : shown}`,
          data: { kind, commands: parsed.commands.length },
          actor: { type: "you" },
          ai: { by: isCliProvider(d.provider) ? d.provider : "TMCode AI", how: kind === "fix" ? "fix for a failed command" : kind === "explain" ? "explained a command" : "terminal commands from plain words", model: d.model },
        });
      },
      error: fail,
    });
  } catch (e) {
    fail(asAiError(e));
  }
}

/** Cancels an answer still coming. */
export function cancelTerminalAi() {
  stop();
  const s = useTerminalAi.getState();
  if (s.phase === "asking") useTerminalAi.setState({ phase: s.answer ? "done" : "idle" });
}

/** A card's Run / Insert: types it at the prompt (Run also presses Enter), then hands the keyboard back. */
export function applyCard(card: CommandCard, how: "run" | "insert", insertText: string) {
  const host = hostOf();
  if (!host) return;
  if (how === "run" && host.busy()) host.runElsewhere(insertText);
  else host.type(how === "run" ? `${insertText}\r` : insertText);
  if (how === "run") {
    const model = useTerminalAi.getState().by ?? undefined;
    const cli = cliOf(effectiveMode());
    const cliLabel = cli ? CLIS[cli].label : null;
    recordActivity({
      kind: "ai",
      action: "terminal-run",
      text: `Ran a command ${cliLabel ?? "TMCode AI"} suggested: ${card.command.length > 120 ? `${card.command.slice(0, 117)}…` : card.command}`,
      data: { command: card.command.slice(0, 500), risk: card.risk },
      actor: { type: "you" },
      ai: { by: cliLabel ?? "TMCode AI", how: "terminal command suggested, run by the student", model },
    });
  }
  closeTerminalAi(true);
}

/** The model chip's words ("Free", "Auto", "claude-sonnet-5-5 · your Anthropic key"). */
export function currentModelLabel(): string {
  const { mode, status } = useAi.getState();
  return modeLabel(effectiveMode(mode, status), status);
}
