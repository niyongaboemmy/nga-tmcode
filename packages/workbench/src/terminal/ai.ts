import type { OsKind } from "../platform/types";

/**
 * TMCode AI in the terminal: plain words in, shell commands out. The student asks ("find files
 * bigger than 100 MB", "undo my last commit", "why did this fail?"), TMCode AI answers with
 * commands the terminal shows as cards (Run, Insert, Copy). Nothing runs without a click, and a
 * command that deletes, overwrites or needs admin rights asks twice (assessRisk: TMCode's own
 * check, whatever the AI said).
 *
 * The pure parts live here (prompt, answer parsing, risk); the widget is parts/panel/TerminalAi.tsx.
 * Task Mentor (≥ 2026-11) answers `context.purpose: "terminal"` with its terminal prompt; the
 * question repeats the answer format so an older server answers in it too.
 */

export type TerminalAiKind = "ask" | "fix" | "explain";
export type Risk = "safe" | "caution" | "danger";

export interface TerminalAiCommand {
  command: string;
  explanation: string;
}

export interface TerminalAiAnswer {
  commands: TerminalAiCommand[];
  explanation: string;
  risk: Risk;
  /** The AI needs to know something first. */
  question?: string;
}

/** A command the terminal ran, as the AI sees it. */
export interface RecentCommand {
  command: string;
  exitCode?: number;
  output?: string;
}

export interface TerminalAiContext {
  os: OsKind;
  /** "zsh", "bash", "PowerShell", "Git Bash"… */
  shell: string;
  cwd?: string;
  /** Names in the folder's top level (package.json, src/…), so it can use the project's tools. */
  files?: string[];
  /** The last commands, oldest first; the last one may carry its output. */
  recent?: RecentCommand[];
}

/** Output sent with a failed command: its end (where errors are), at most this many characters. */
export const OUTPUT_TAIL = 3000;

const OS_NAME: Record<OsKind, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

export const ANSWER_FORMAT = `Answer with ONE JSON object and nothing else: {"commands":[{"command":"…","explanation":"…"}],"explanation":"…","risk":"safe"|"caution"|"danger","question":"…"} ("question" only if you must ask something first; "commands" empty if it isn't a terminal task).`;

/** The end of a command's output, with terminal colour codes removed. */
export function outputTail(text: string, max = OUTPUT_TAIL): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
  return clean.length > max ? `…${clean.slice(clean.length - max)}` : clean;
}

/** The text of the question: what the student asked, then what the AI needs to answer for this shell. */
export function buildTerminalPrompt(kind: TerminalAiKind, request: string, ctx: TerminalAiContext): string {
  const lines: string[] = [];
  const last = ctx.recent?.[ctx.recent.length - 1];
  if (kind === "fix" && last) {
    lines.push(`This command failed${last.exitCode !== undefined ? ` (exit code ${last.exitCode})` : ""}. Explain why in one or two sentences and give the corrected command.`, "", `$ ${last.command}`);
    if (last.output) lines.push("Its output:", "```", outputTail(last.output), "```");
    if (request.trim()) lines.push("", `The student adds: ${request.trim()}`);
  } else if (kind === "explain" && last) {
    lines.push("Explain this command for a student: what it does, and what each part and flag means. Put the command itself in \"commands\".", "", `$ ${last.command}`);
    if (last.output) lines.push("Its output:", "```", outputTail(last.output, 1500), "```");
  } else {
    lines.push(`What the student wants to do in the terminal: ${request.trim()}`);
  }
  lines.push("", `Shell: ${ctx.shell} on ${OS_NAME[ctx.os]}.`);
  if (ctx.cwd) lines.push(`Folder: ${ctx.cwd}`);
  if (ctx.files?.length) lines.push(`In this folder: ${ctx.files.slice(0, 40).join(", ")}${ctx.files.length > 40 ? ", …" : ""}`);
  const history = (kind === "ask" ? ctx.recent : ctx.recent?.slice(0, -1)) ?? [];
  if (history.length) lines.push(`Recent commands: ${history.slice(-5).map((c) => `\`${c.command}\`${c.exitCode ? ` (failed, ${c.exitCode})` : ""}`).join(", ")}`);
  lines.push("", ANSWER_FORMAT);
  return lines.join("\n");
}

const RISKS: Risk[] = ["safe", "caution", "danger"];
const asRisk = (v: unknown): Risk => (RISKS.includes(v as Risk) ? (v as Risk) : "safe");

/** The first balanced {…} in `text` (strings and escapes respected), or null. */
function firstJsonObject(text: string): string | null {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

const SHELL_FENCE = /```(?:bash|sh|shell|zsh|fish|console|powershell|pwsh|ps1|cmd|bat)?[ \t]*\n([\s\S]*?)```/g;

/**
 * The AI's answer as cards. The JSON format comes first; a model that answered in Markdown anyway
 * gives its shell code blocks as commands and its text as the explanation, so an answer is never lost.
 */
export function parseTerminalAnswer(text: string): TerminalAiAnswer {
  const json = firstJsonObject(text);
  if (json) {
    const o = JSON.parse(json) as Record<string, unknown>;
    if (Array.isArray(o.commands) || typeof o.explanation === "string") {
      const commands = (Array.isArray(o.commands) ? o.commands : [])
        .map((c) => (typeof c === "string" ? { command: c, explanation: "" } : c && typeof c === "object" ? { command: String((c as Record<string, unknown>).command ?? ""), explanation: String((c as Record<string, unknown>).explanation ?? "") } : null))
        .filter((c): c is TerminalAiCommand => !!c && !!c.command.trim())
        .map((c) => ({ command: c.command.trim().replace(/^\$\s+/, ""), explanation: c.explanation.trim() }))
        .slice(0, 5);
      const question = typeof o.question === "string" && o.question.trim() ? o.question.trim() : undefined;
      return { commands, explanation: typeof o.explanation === "string" ? o.explanation.trim() : "", risk: asRisk(o.risk), ...(question ? { question } : {}) };
    }
  }
  const commands: TerminalAiCommand[] = [];
  for (const m of text.matchAll(SHELL_FENCE)) {
    const body = m[1]
      .split("\n")
      .map((l) => l.replace(/^\s*[$>]\s+/, "").trimEnd())
      .filter((l) => l.trim() && !l.trim().startsWith("#"))
      .join("\n");
    if (body) commands.push({ command: body, explanation: "" });
  }
  const explanation = text.replace(SHELL_FENCE, "").replace(/\s+\n/g, "\n").trim();
  return { commands: commands.slice(0, 5), explanation, risk: "safe" };
}

/** Rules TMCode applies itself (the AI's "risk" can only make a command look safer to it, never to us). */
const RULES: { risk: Risk; re: RegExp; why: string }[] = [
  { risk: "danger", re: /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+)+/, why: "deletes files without asking" },
  { risk: "danger", re: /\b(Remove-Item|rd|rmdir|del)\b[^|]*\s-(Recurse|Force|s|q)\b/i, why: "deletes files and folders" },
  { risk: "danger", re: /\bsudo\b|\bdoas\b|\brunas\b/, why: "runs with administrator rights" },
  { risk: "danger", re: /\b(mkfs(\.\w+)?|diskutil\s+(erase\w*|partition\w*)|format\s+[a-z]:|fdisk|parted|wipefs)\b/i, why: "erases or formats a disk" },
  { risk: "danger", re: /\bdd\s+[^|]*\bof=/, why: "writes raw data to a device or file" },
  { risk: "danger", re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b|\|\s*(iex|Invoke-Expression)\b/i, why: "runs a script straight from the internet" },
  { risk: "danger", re: /\bchmod\s+(-R\s+)?[0-7]*777\b|\bchmod\s+-R\b|\bchown\s+-R\b/, why: "changes permissions of many files" },
  { risk: "danger", re: /\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, why: "overwrites history on the remote" },
  { risk: "danger", re: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.|restore\s+(--staged\s+)?\.(\s|$)|filter-branch|filter-repo)\b/, why: "throws away uncommitted work" },
  { risk: "danger", re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE|DELETE\s+FROM\s+\w+\s*;?\s*$)/i, why: "deletes database data" },
  { risk: "danger", re: /:\(\)\s*\{\s*:\|:&\s*\};:|\bshutdown\b|\breboot\b|\bkillall\b|\bpkill\s+-9\b/, why: "stops the computer or many programs" },
  { risk: "danger", re: /(^|[^>])>\s*\/(etc|usr|bin|System)\//, why: "overwrites a system file" },
  { risk: "caution", re: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|un|rm|update|upgrade)\b|\bpip3?\s+(install|uninstall)\b|\b(brew|apt(-get)?|dnf|yum|pacman|choco|winget|scoop|gem|cargo|go)\s+(install|uninstall|remove|upgrade|get)\b/, why: "installs or removes software" },
  { risk: "caution", re: /\bgit\s+(rebase|reset|revert|stash\s+(drop|clear)|branch\s+-D|tag\s+-d|push|merge|commit\s+--amend)\b/, why: "changes git history or the remote" },
  { risk: "caution", re: /\b(mv|move|Move-Item|cp\s+-[a-zA-Z]*f|Rename-Item)\b/, why: "moves or overwrites files" },
  { risk: "caution", re: /(^|\s)(rm|del|Remove-Item|unlink|rmdir)\s/, why: "deletes a file" },
  { risk: "caution", re: /\b(kill|taskkill|Stop-Process)\b/, why: "stops a program" },
  { risk: "caution", re: /\b(export|setx|set)\s+\w+=|\bchmod\b|\bchown\b/, why: "changes settings or permissions" },
  { risk: "caution", re: /(^|[^0-9>&|])>(?![>&])\s*(?!\/dev\/null\b)[\w./~-]+/, why: "writes over a file" },
];

/** TMCode's own reading of a command: the highest risk any rule finds, and why. */
export function assessRisk(command: string): { risk: Risk; why: string | null } {
  let best: { risk: Risk; why: string | null } = { risk: "safe", why: null };
  for (const r of RULES) {
    if (RISKS.indexOf(r.risk) <= RISKS.indexOf(best.risk)) continue;
    if (r.re.test(command)) best = { risk: r.risk, why: r.why };
  }
  return best;
}

/** The higher of two risks. */
export function maxRisk(a: Risk, b: Risk): Risk {
  return RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b;
}

/**
 * Plain words typed at the prompt for TMCode AI: a line that starts with "# " (a comment, so the
 * shell would ignore it anyway) or "?? ". Returns the request, or null for an ordinary command.
 */
export function naturalLanguageRequest(line: string): string | null {
  const m = /^\s*(?:#|\?\?)\s+(\S.*)$/.exec(line);
  return m ? m[1].trim() : null;
}

/** What to type so a command lands at the prompt without running (several lines: joined, each runnable). */
export function insertableText(command: string, shell: string): string {
  const lines = command.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return lines[0] ?? "";
  return lines.join(/powershell|pwsh/i.test(shell) ? "; " : " && ");
}

/** Exit codes that aren't failures worth a fix: Ctrl+C (130), killed by the user (137/143), Ctrl+Z (148). */
export function worthFixing(exitCode: number | undefined): boolean {
  return exitCode !== undefined && exitCode !== 0 && ![130, 137, 143, 148].includes(exitCode);
}
