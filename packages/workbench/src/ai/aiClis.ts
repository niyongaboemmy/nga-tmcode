import { create } from "zustand";
import { recordActivity } from "../activity/log";
import { getPlatform } from "../state/store";
import { runInTerminal } from "../tasks/service";
import { aiGate, thirdPartyMessage } from "./gate";
import { AiRequestError, type ChatContext, type StreamHandlers, type WireMessage } from "./service";

/**
 * The AI companies' own coding CLIs as AIs that answer TMCode AI ("Which AI answers" › Your AI
 * accounts): Claude Code (a Claude account), Codex (a ChatGPT account) and Gemini CLI (a Google
 * account), each signed in with the user's own account on its free or paid plan, or an API key.
 * No Task Mentor allowance is spent and nothing has to be copied into a browser tab.
 *
 * - Questions (the terminal's AI, the chat in Chat mode) run the CLI headless and read-only; the
 *   question goes on stdin, never on the command line, and streams back as JSON lines.
 * - Agent modes hand the task to the CLI itself in a terminal, in its matching permission mode, so
 *   it asks before it acts in its own way.
 * - Sign in, sign out, install and the plan page are one click away (pickMode, Settings › TMCode AI).
 * - They are third-party AI tools: only where the school allows those (the AI gate's `thirdParty`;
 *   never in exams). ai_tools.rs blocks the binaries when the school says no, and every question,
 *   agent task and command run is in the activity log with the CLI named, for teachers and admins.
 *
 * Modes: "cli:<claude|codex|gemini>" (the CLI's own default model) or "cli:<id>/<model>".
 */

export type CliId = "claude" | "codex" | "gemini";
type AgentMode = "manual" | "edit" | "plan" | "auto";

/** One line of a CLI's JSON output, as it matters for the answer. */
export type CliEvent = { kind: "model"; model: string } | { kind: "delta"; text: string } | { kind: "result"; text: string; error: boolean } | null;

export interface CliSpec {
  id: CliId;
  /** "Claude Code". */
  label: string;
  /** What the user signs in with ("Claude", "ChatGPT", "Google"). */
  account: string;
  bin: string;
  install: string;
  docs: string;
  /** Where the user sees or changes their plan (free → paid). */
  plans: string;
  /** Model names the CLI accepts, offered in the picker (any other id can be typed). */
  models: { id: string; label: string; detail: string }[];
  /** Signed in? (exit 0 = yes); null: the CLI can't tell, find out at the first question. */
  statusCommand(windows: boolean): string | null;
  /** "you@school.org · Pro" from the status output. */
  accountOf(out: string): string | null;
  signIn: string;
  signOut: string | null;
  headless(model: string | null): string;
  parse(line: string): CliEvent;
  agent(agentMode: AgentMode, model: string | null, task: string | null): string;
  /** Failure words that mean "sign in again" / "plan or rate limit reached". */
  signedOut: RegExp;
  limit: RegExp;
}

const json = (line: string): Record<string, unknown> | null => {
  try {
    const v = JSON.parse(line) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const ROLE = "You are TMCode AI, answering through a coding CLI. Follow the instructions in the message exactly.";
const MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,63}$/;
const plan = (s: string) => s[0].toUpperCase() + s.slice(1);

export const CLIS: Record<CliId, CliSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    account: "Claude",
    bin: "claude",
    install: "npm install -g @anthropic-ai/claude-code",
    docs: "https://docs.anthropic.com/en/docs/claude-code",
    plans: "https://claude.ai/upgrade",
    models: [
      { id: "sonnet", label: "Sonnet", detail: "Strong and quick" },
      { id: "haiku", label: "Haiku", detail: "The fastest" },
      { id: "opus", label: "Opus", detail: "The most capable, slower" },
    ],
    statusCommand: () => "claude auth status",
    accountOf: (out) => {
      const j = json(out) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string } | null;
      if (!j) return null;
      const p = j.subscriptionType ? plan(j.subscriptionType) : /api/i.test(j.authMethod ?? "") ? "API key" : null;
      return [j.email, p].filter(Boolean).join(" · ") || null;
    },
    signIn: "claude auth login",
    signOut: "claude auth logout",
    headless: (model) => ["claude -p --output-format stream-json --verbose --include-partial-messages --tools \"\" --no-session-persistence --strict-mcp-config", `--system-prompt "${ROLE}"`, ...(model ? [`--model ${model}`] : [])].join(" "),
    parse: (line) => {
      const d = json(line);
      if (!d) return null;
      if (d.type === "stream_event") {
        const e = (d.event ?? {}) as { type?: string; message?: { model?: string }; delta?: { type?: string; text?: string } };
        if (e.type === "message_start" && e.message?.model) return { kind: "model", model: e.message.model };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) return { kind: "delta", text: e.delta.text };
        return null;
      }
      if (d.type === "result") return { kind: "result", text: typeof d.result === "string" ? d.result : "", error: d.is_error === true || (typeof d.subtype === "string" && d.subtype !== "success") };
      return null;
    },
    // Manual → manual, Edit → acceptEdits, Plan → plan, Auto → auto.
    agent: (m, model, task) => ["claude", "--permission-mode", { manual: "manual", edit: "acceptEdits", plan: "plan", auto: "auto" }[m], ...(model ? ["--model", model] : []), ...(task ? [task] : [])].join(" "),
    signedOut: /not logged in|please run \/login|invalid api key|oauth token|authentication_error/i,
    limit: /usage limit|rate limit|limit reached|credit balance|overloaded/i,
  },
  codex: {
    id: "codex",
    label: "ChatGPT (Codex)",
    account: "ChatGPT",
    bin: "codex",
    install: "npm install -g @openai/codex",
    docs: "https://developers.openai.com/codex/cli",
    plans: "https://chatgpt.com/pricing",
    models: [],
    statusCommand: () => "codex login status",
    accountOf: (out) => (/ChatGPT/i.test(out) ? "ChatGPT account" : /api key/i.test(out) ? "OpenAI API key" : /Logged in/i.test(out) ? out.trim().replace(/^Logged in using /i, "") : null),
    signIn: "codex login",
    signOut: "codex logout",
    // Read-only sandbox, no session files, any folder; the question comes on stdin ("-").
    headless: (model) => ["codex exec --json --skip-git-repo-check --ephemeral --color never --sandbox read-only", ...(model ? [`--model ${model}`] : []), "-"].join(" "),
    parse: (line) => {
      const d = json(line);
      if (!d) return null;
      const item = (d.item ?? {}) as { type?: string; text?: string };
      if (d.type === "item.completed" && item.type === "agent_message" && item.text) return { kind: "delta", text: item.text };
      if (d.type === "turn.completed") return { kind: "result", text: "", error: false };
      if (d.type === "turn.failed") return { kind: "result", text: String(((d.error ?? {}) as { message?: string }).message ?? ""), error: true };
      // A missing sign-in shows as 401 retries: stop at the first one instead of waiting for five.
      if (d.type === "error" && /401 Unauthorized/.test(String(d.message ?? ""))) return { kind: "result", text: "not logged in", error: true };
      return null;
    },
    // Codex asks before writing outside its sandbox: Manual and Plan stay read-only, Edit and Auto may edit the folder.
    agent: (m, model, task) =>
      ["codex", "--sandbox", m === "manual" || m === "plan" ? "read-only" : "workspace-write", "--ask-for-approval", "on-request", ...(model ? ["--model", model] : []), ...(task ? [task] : [])].join(" "),
    signedOut: /not logged in|401 unauthorized|missing bearer|please log in|login required/i,
    limit: /usage limit|rate limit|quota|too many requests|429/i,
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    account: "Google",
    bin: "gemini",
    install: "npm install -g @google/gemini-cli",
    docs: "https://github.com/google-gemini/gemini-cli",
    plans: "https://gemini.google/subscriptions/",
    models: [
      { id: "auto", label: "Auto", detail: "Picks Pro or Flash for each question" },
      { id: "pro", label: "Pro", detail: "The most capable" },
      { id: "flash", label: "Flash", detail: "Fast" },
      { id: "flash-lite", label: "Flash-Lite", detail: "The fastest" },
    ],
    // Gemini CLI has no status command: a Google sign-in leaves oauth_creds.json, an API key is in the environment.
    statusCommand: (windows) =>
      windows
        ? 'if defined GEMINI_API_KEY (exit 0) else if exist "%USERPROFILE%\\.gemini\\oauth_creds.json" (exit 0) else (exit 1)'
        : 'test -n "$GEMINI_API_KEY" || test -f "$HOME/.gemini/oauth_creds.json" || grep -qs \'"selectedType"\' "$HOME/.gemini/settings.json"',
    accountOf: () => "Google account",
    // Its sign-in is the CLI's own first screen ("Login with Google").
    signIn: "gemini",
    signOut: null,
    headless: (model) => ['gemini -p "" --output-format stream-json --skip-trust --approval-mode plan', ...(model ? [`--model ${model}`] : [])].join(" "),
    parse: (line) => {
      const d = json(line);
      if (!d) return null;
      if (d.type === "init" && typeof d.model === "string") return { kind: "model", model: d.model };
      if (d.type === "message" && d.role === "assistant" && typeof d.content === "string" && d.content) return { kind: "delta", text: d.content };
      if (d.type === "result") return { kind: "result", text: String(((d.error ?? {}) as { message?: string }).message ?? ""), error: d.status !== "success" };
      return null;
    },
    agent: (m, model, task) => ["gemini", "--approval-mode", { manual: "default", edit: "auto_edit", plan: "plan", auto: "auto_edit" }[m], ...(model ? ["--model", model] : []), ...(task ? ["-i", task] : [])].join(" "),
    signedOut: /set an auth method|not authenticated|login required|invalid api key|api key not valid|unauthenticated/i,
    limit: /quota|rate limit|resource_exhausted|429|too many requests/i,
  },
};

export const CLI_IDS = Object.keys(CLIS) as CliId[];

/** The CLI a mode is for (null: not a CLI mode). */
export function cliOf(mode: string): CliId | null {
  const m = /^cli:([a-z]+)(?:\/|$)/.exec(mode);
  return m && m[1] in CLIS ? (m[1] as CliId) : null;
}

export function isCliMode(mode: string): boolean {
  return cliOf(mode) !== null;
}

/** "sonnet" for "cli:claude/sonnet"; null for the CLI's own default (or a model id that isn't safe to pass). */
export function cliModelOf(mode: string): string | null {
  const id = cliOf(mode);
  if (!id) return null;
  const m = mode.slice(`cli:${id}/`.length);
  return mode.startsWith(`cli:${id}/`) && MODEL_RE.test(m) ? m : null;
}

export function cliModeLabel(mode: string): string {
  const id = cliOf(mode);
  if (!id) return mode;
  const m = cliModelOf(mode);
  return m ? `${CLIS[id].label} · ${CLIS[id].models.find((x) => x.id === m)?.label ?? m}` : CLIS[id].label;
}

export const validCliModel = (m: string) => MODEL_RE.test(m.trim());

/** Did an AI CLI answer (the `provider` of an answer)? */
export const isCliProvider = (provider: string | undefined) => CLI_IDS.some((id) => CLIS[id].label === provider);

export interface CliInfo {
  /** unknown: not checked yet; unavailable: can't run commands here (browser, no folder open). */
  state: "unknown" | "checking" | "ready" | "missing" | "signed-out" | "unavailable";
  version: string | null;
  /** "you@school.org · Pro" when signed in (as far as the CLI says). */
  account: string | null;
  detail: string | null;
  checkedAt: number;
}

const UNKNOWN: CliInfo = { state: "unknown", version: null, account: null, detail: null, checkedAt: 0 };
export const useAiClis = create<Record<CliId, CliInfo>>(() => ({ claude: UNKNOWN, codex: UNKNOWN, gemini: UNKNOWN }));
const setInfo = (id: CliId, p: Partial<CliInfo>) => useAiClis.setState((s) => ({ [id]: { ...s[id], ...p } }) as Partial<Record<CliId, CliInfo>>);

/** Runs a short command; its output and exit code (null code: it couldn't start or took too long). */
function run(command: string, timeoutMs: number): Promise<{ code: number | null; out: string; err: string }> {
  const proc = getPlatform().proc;
  if (!proc) return Promise.resolve({ code: null, out: "", err: "Commands can't run here." });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let id: number | null = null;
    const t = setTimeout(() => {
      if (id != null) void proc.kill(id).catch(() => {});
      resolve({ code: null, out, err: err || "It took too long." });
    }, timeoutMs);
    proc
      .run(command, "", (e) => {
        if (e.type === "stdout") out += e.data;
        else if (e.type === "stderr") err += e.data;
        else {
          clearTimeout(t);
          resolve({ code: e.code, out, err });
        }
      })
      .then((n) => (id = n))
      .catch((e) => {
        clearTimeout(t);
        resolve({ code: null, out, err: String((e as Error)?.message ?? e) });
      });
  });
}

const checking = new Map<CliId, Promise<CliInfo>>();
/** Is the CLI installed and signed in on this computer? Cached for five minutes (`force`: ask again). */
export function detectCli(id: CliId, force = false): Promise<CliInfo> {
  const now = useAiClis.getState()[id];
  if (!force && now.state !== "unknown" && now.state !== "checking" && Date.now() - now.checkedAt < 5 * 60_000) return Promise.resolve(now);
  const pending = checking.get(id);
  if (pending) return pending;
  if (!getPlatform().proc) {
    setInfo(id, { state: "unavailable", detail: "It runs in the TMCode desktop app.", checkedAt: Date.now() });
    return Promise.resolve(useAiClis.getState()[id]);
  }
  setInfo(id, { state: "checking" });
  const spec = CLIS[id];
  const p = (async () => {
    const v = await run(`${spec.bin} --version`, 15_000);
    let next: Partial<CliInfo>;
    if (v.code === 0) {
      const version = /(\d+\.\d+\.\d+)/.exec(v.out)?.[1] ?? (v.out.trim().slice(0, 30) || null);
      const status = spec.statusCommand(getPlatform().os === "windows");
      const s = status ? await run(status, 15_000) : null;
      // Claude Code says loggedIn:false with exit 0 or 1; the others exit non-zero when signed out.
      const signedOut = s ? s.code !== 0 || json(s.out)?.loggedIn === false : false;
      next = { state: signedOut ? "signed-out" : "ready", version, account: s && !signedOut ? spec.accountOf(s.out) : null, detail: null };
    } else if (v.code === null && !/not found|No such file/i.test(v.err)) {
      next = { state: "unavailable", version: null, account: null, detail: /folder/i.test(v.err) ? "Open a folder to use it." : v.err.trim().slice(0, 200) || "It couldn't be checked." };
    } else next = { state: "missing", version: null, account: null, detail: null };
    setInfo(id, { ...next, checkedAt: Date.now() });
    return useAiClis.getState()[id];
  })().finally(() => checking.delete(id));
  checking.set(id, p);
  return p;
}

export function detectAllClis(force = false): Promise<CliInfo[]> {
  return Promise.all(CLI_IDS.map((id) => detectCli(id, force)));
}

/** May the AI CLIs answer here? (null: yes; else why not, in the school's words) */
export function cliBlocked(): string | null {
  return thirdPartyMessage(aiGate());
}

/** The same rules Task Mentor gives its own models (tmcodeAi.controller.ts SYSTEM and TERMINAL_SYSTEM). */
const SYSTEM = `You are TMCode AI, the coding assistant inside TMCode, the code editor of New Generation Academy (a school).
Help the student learn while they code: explain clearly and briefly, show small correct code, and say why it works.
Use Markdown. Put code in fenced blocks with the language, and when a block replaces code in the student's file, write the file name on the line before it.
If the student asks you to do a graded assignment for them entirely, guide them step by step instead of writing all of it.
Answer from what is in this message: don't run commands or change files.`;

const TERMINAL_SYSTEM = `You are TMCode AI inside the integrated terminal of TMCode, the code editor of New Generation Academy (a school).
The user says in plain words what they want to do in their shell, asks how a command works, or asks why a command failed.
Answer with ONE JSON object and nothing else (no Markdown fence, no text before or after it):
{"commands":[{"command":"<one shell command line>","explanation":"<what it does, one short sentence>"}],"explanation":"<one or two short sentences>","risk":"safe"|"caution"|"danger","question":"<only when you must ask something before you can answer>"}
Rules:
- Write commands for the shell, operating system and folder you are given. Prefer one command; give at most 3 alternatives or steps, in order.
- Use real commands and flags only; prefer tools that come with the system or that the project already uses (package.json scripts, Makefile, git).
- For a failed command, explain the cause in "explanation" and put the corrected command first.
- "risk": "danger" for anything that deletes or overwrites data, force-pushes or rewrites git history, uses sudo or admin rights, formats disks, changes permissions recursively, or pipes a download into a shell; "caution" for installing or removing packages, changing configuration, or network and process changes; else "safe".
- Never include secrets or keys in a command. Use placeholders like <file> when you need a value you don't know, and say so.
- If it isn't a terminal task, answer it briefly in "explanation" with an empty "commands" list.
- Help the student learn: each explanation names the important flags.
- Don't run anything yourself: the user runs the commands.`;

const textOf = (c: WireMessage["content"]): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p.type === "text" ? p.text : "[an image]")).join("\n") : "");

/**
 * The whole request as one message (the CLIs take one prompt): the instructions, what the editor
 * knows (open file, selection, problems), earlier turns, then the question.
 */
export function cliPrompt(messages: WireMessage[], context: ChatContext | undefined): string {
  const c = context;
  const parts: string[] = [c?.purpose === "terminal" ? TERMINAL_SYSTEM : SYSTEM];
  if (c?.purpose === "grading" && c.grading) parts.push(`You are helping a teacher grade ${c.grading.student_name}'s work on "${c.grading.activity_title}". Only advise: the teacher decides and saves the grade.`);
  if (c?.task) parts.push(`The task the student is working on:\n${c.task}`);
  if (c?.file) parts.push(`Open file: ${c.file}${c.language ? ` (${c.language})` : ""}`);
  if (c?.selection) parts.push(`Selected code:\n\`\`\`${c.language ?? ""}\n${c.selection}\n\`\`\``);
  else if (c?.fileText) parts.push(`The file:\n\`\`\`${c.language ?? ""}\n${c.fileText}\n\`\`\``);
  if (c?.problems?.length) parts.push(`Problems the editor reports:\n${c.problems.map((p) => `- ${p}`).join("\n")}`);
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const last = turns[turns.length - 1];
  const earlier = turns.slice(0, -1).filter((m) => textOf(m.content).trim());
  if (earlier.length) parts.push(`The conversation so far:\n${earlier.map((m) => `${m.role === "user" ? "User" : "You"}: ${textOf(m.content)}`).join("\n\n")}`);
  parts.push(`${earlier.length ? "The new message" : "The message"}:\n${last ? textOf(last.content) : ""}`);
  return parts.join("\n\n");
}

/** The CLI's failure as TMCode AI's error (`reason` names the CLI, for the widgets' Install / Sign In buttons). */
export function cliError(id: CliId, text: string, exit: number | null = null): AiRequestError {
  const spec = CLIS[id];
  const t = text.trim();
  const e = (code: string, message: string) => new AiRequestError(code, message, id);
  if (exit === 127 || new RegExp(`command not found|is not recognized|No such file or directory.*${spec.bin}`, "i").test(t)) return e("CLI_MISSING", `${spec.label} isn't installed on this computer. Install it, or pick another AI.`);
  if (spec.signedOut.test(t) || (id === "gemini" && exit === 41)) return e("CLI_SIGNED_OUT", `${spec.label} isn't signed in. Sign in with your ${spec.account} account, then ask again.`);
  if (spec.limit.test(t)) return e("CLI_LIMIT", `${spec.label} can't answer right now (your ${spec.account} plan's limit, or too many requests): ${t.slice(0, 200)}`);
  if (/AI tools are off|turned off by your school/i.test(t)) return new AiRequestError("AI_DISABLED", t.slice(0, 300));
  return e("CLI_FAILED", t ? `${spec.label} couldn't answer: ${t.slice(0, 300)}` : `${spec.label} couldn't answer. Try again.`);
}

/** Asks the mode's CLI and streams its answer through TMCode AI's handlers (`provider` is its label). Returns a cancel function. */
export async function cliChat(messages: WireMessage[], context: ChatContext | undefined, on: StreamHandlers, mode: string): Promise<() => void> {
  const id = cliOf(mode);
  if (!id) throw new AiRequestError("FAILED", "That isn't an AI CLI.");
  const spec = CLIS[id];
  const blocked = cliBlocked();
  if (blocked) throw new AiRequestError("AI_DISABLED", blocked);
  const proc = getPlatform().proc;
  if (!proc) throw new AiRequestError("CLI_UNAVAILABLE", `${spec.label} answers in the TMCode desktop app. Pick another AI here.`, id);
  const info = useAiClis.getState()[id];
  if (info.state === "missing") throw cliError(id, "", 127);
  if (info.state === "signed-out") throw cliError(id, "not logged in", id === "gemini" ? 41 : null);

  const provider = spec.label;
  let model = cliModelOf(mode) ?? "";
  let buf = "";
  let streamed = "";
  let stderr = "";
  let finished = false;
  let pid: number | null = null;
  const stop = () => {
    if (pid != null) void proc.kill(pid).catch(() => {});
  };
  const finish = (fn: () => void) => {
    if (finished) return;
    finished = true;
    fn();
  };
  const line = (l: string) => {
    const e = spec.parse(l);
    if (!e || finished) return;
    if (e.kind === "model") {
      model = e.model;
      on.meta({ provider, model });
    } else if (e.kind === "delta") {
      streamed += e.text;
      on.delta(e.text);
    } else if (e.error) {
      finish(() => on.error(cliError(id, e.text || stderr)));
      stop();
    } else
      finish(() => {
        // A CLI without partial messages sends the whole answer at the end only.
        if (!streamed && e.text) on.delta(e.text);
        on.done({ provider, model });
      });
  };
  try {
    pid = await proc.run(
      spec.headless(cliModelOf(mode)),
      "",
      (e) => {
        if (e.type === "stdout") {
          buf += e.data;
          for (let cut = buf.indexOf("\n"); cut >= 0; cut = buf.indexOf("\n")) {
            line(buf.slice(0, cut));
            buf = buf.slice(cut + 1);
          }
        } else if (e.type === "stderr") stderr += e.data;
        else {
          if (buf.trim()) line(buf);
          buf = "";
          if (!finished && e.code === 0 && streamed) finish(() => on.done({ provider, model }));
          finish(() => on.error(cliError(id, stderr, e.code)));
          if (e.code === 127) setInfo(id, { state: "missing", checkedAt: Date.now() });
        }
      },
      { stdin: cliPrompt(messages, context) },
    );
  } catch (e) {
    throw cliError(id, String((e as Error)?.message ?? e));
  }
  return () => {
    finished = true;
    stop();
  };
}

/** `text` as one argument for the user's shell (PowerShell on Windows, else a POSIX shell). */
export function shellArg(text: string, windows: boolean): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
  return windows ? `'${flat.replace(/'/g, "''")}'` : `'${flat.replace(/'/g, "'\\''")}'`;
}

/** The interactive command for an agent task (the CLI in the terminal, asking before it acts). */
export function cliAgentCommand(mode: string, task: string, agentMode: AgentMode, windows: boolean): string {
  const id = cliOf(mode) ?? "claude";
  const t = task.trim() ? shellArg(agentMode === "plan" && id === "codex" ? `Plan only, don't change files yet: ${task}` : task, windows) : null;
  return CLIS[id].agent(agentMode, cliModelOf(mode), t);
}

/** Agent modes with an AI CLI: it works on the project in a terminal, in the matching permission mode. */
export async function openCliAgent(task: string, agentMode: AgentMode, mode: string): Promise<{ ok: true; command: string } | { ok: false; error: AiRequestError }> {
  const id = cliOf(mode);
  if (!id) return { ok: false, error: new AiRequestError("FAILED", "That isn't an AI CLI.") };
  const spec = CLIS[id];
  const blocked = cliBlocked();
  if (blocked) return { ok: false, error: new AiRequestError("AI_DISABLED", blocked) };
  if (!getPlatform().terminal) return { ok: false, error: new AiRequestError("CLI_UNAVAILABLE", `${spec.label} works in the TMCode desktop app's terminal.`, id) };
  const info = await detectCli(id);
  if (info.state === "missing") return { ok: false, error: cliError(id, "", 127) };
  if (info.state === "signed-out") return { ok: false, error: cliError(id, "not logged in", id === "gemini" ? 41 : null) };
  const command = cliAgentCommand(mode, task, agentMode, getPlatform().os === "windows");
  runInTerminal(command, { name: spec.label });
  recordActivity({
    kind: "ai",
    action: "cli-agent",
    text: `Asked ${spec.label} to work on the project (${agentMode}): "${task.length > 90 ? `${task.slice(0, 87)}…` : task}"`,
    data: { cli: id, task: task.slice(0, 600), agent_mode: agentMode, model: cliModelOf(mode) ?? "default" },
    actor: { type: "you" },
    ai: { by: spec.label, how: `working on the project in the terminal (${agentMode})`, model: cliModelOf(mode) ?? undefined },
  });
  return { ok: true, command: cliAgentCommand(mode, "", agentMode, false) };
}

/** Account actions, each in a terminal the user watches (sign-in opens the provider's page in the browser). */
export function signInCli(id: CliId) {
  runInTerminal(CLIS[id].signIn, { name: `${CLIS[id].label}: sign in` });
  recordActivity({ kind: "ai", action: "cli-sign-in", text: `Started signing in to ${CLIS[id].label}`, data: { cli: id }, actor: { type: "you" } });
  setInfo(id, { checkedAt: 0 });
}

export function signOutCli(id: CliId) {
  const cmd = CLIS[id].signOut;
  if (!cmd) return;
  runInTerminal(cmd, { name: `${CLIS[id].label}: sign out` });
  setInfo(id, { state: "signed-out", account: null, checkedAt: Date.now() });
}

export function installCli(id: CliId) {
  runInTerminal(CLIS[id].install, { name: `Install ${CLIS[id].label}` });
  setInfo(id, { checkedAt: 0 });
}

export function openCliPlans(id: CliId) {
  void getPlatform().openExternal?.(CLIS[id].plans);
}
