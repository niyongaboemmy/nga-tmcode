import { aiGate, thirdPartyMessage } from "../ai/gate";
import { getPlatform, notify } from "../state/store";
import { runInTerminal } from "../tasks/service";
import { CLI_PROMPT, README_FILE } from "./aiDraft";
import { setWatching, writeGradingFiles } from "./aiGrading";
import { draftKey } from "./drafts";
import { useGrading } from "./service";

/**
 * "Grade with Claude Code / Gemini (Antigravity) / Gemini CLI / Codex": a terminal in the review folder runs the AI CLI
 * with a prompt that points it to .tmcode/grading/README.md; it writes .tmcode/grading/draft.json,
 * which TMCode puts in the grade form (aiGrading.ts). "Copy Grading Prompt" is the same for an
 * extension's chat (the Claude Code or Gemini Code Assist extension). Third-party AI tools only
 * where the school allows them for staff (the AI gate's `thirdParty`).
 */

export type GradingCli = "claude" | "agy" | "gemini" | "codex";

export const GRADING_CLIS: Record<GradingCli, { label: string; bin: string; command: (prompt: string) => string; install: string; installWindows?: string; docs: string }> = {
  claude: { label: "Claude Code", bin: "claude", command: (p) => `claude "${p}"`, install: "npm install -g @anthropic-ai/claude-code", docs: "https://docs.anthropic.com/en/docs/claude-code" },
  agy: { label: "Gemini (Antigravity)", bin: "agy", command: (p) => `agy -i "${p}"`, install: "curl -fsSL https://antigravity.google/cli/install.sh | bash", installWindows: "irm https://antigravity.google/cli/install.ps1 | iex", docs: "https://antigravity.google/docs/cli" },
  gemini: { label: "Gemini CLI", bin: "gemini", command: (p) => `gemini -i "${p}"`, install: "npm install -g @google/gemini-cli", docs: "https://github.com/google-gemini/gemini-cli" },
  codex: { label: "Codex", bin: "codex", command: (p) => `codex "${p}"`, install: "npm install -g @openai/codex", docs: "https://github.com/openai/codex" },
};

/** The shell command that starts the CLI (the prompt has no quotes or shell characters in it). */
export function cliCommand(tool: GradingCli, prompt = CLI_PROMPT): string {
  return GRADING_CLIS[tool].command(prompt.replace(/["`$\\]/g, ""));
}

/** Third-party AI tools allowed here? (null: yes; else why not) */
export function gradingToolsBlocked(): string | null {
  return thirdPartyMessage(aiGate());
}

/** Is the CLI on this computer? (null: can't tell, e.g. the browser build) */
async function installed(bin: string): Promise<boolean | null> {
  const p = getPlatform();
  if (!p.proc || p.kind !== "desktop") return null;
  // agy's installer puts it in ~/.local/bin, which a login shell may not have on PATH yet.
  const check = p.os === "windows" ? `where ${bin}` : `command -v ${bin}${bin === "agy" ? ' || test -x "$HOME/.local/bin/agy"' : ""}`;
  return new Promise<boolean | null>((resolve) => {
    const t = setTimeout(() => resolve(null), 5000);
    p.proc!.run(check, "", (e) => {
      if (e.type === "exit") {
        clearTimeout(t);
        resolve(e.code === 0);
      }
    }).catch(() => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

const copy = (text: string) => (getPlatform().clipboard?.writeText(text) ?? navigator.clipboard.writeText(text)).catch(() => undefined);

export async function gradeWithCli(tool: GradingCli): Promise<boolean> {
  const cli = GRADING_CLIS[tool];
  const blocked = gradingToolsBlocked();
  if (blocked) {
    notify("info", blocked);
    return false;
  }
  const review = useGrading.getState().review;
  if (!review) {
    notify("info", `Open a student's work first (pick them in the grading tab), then grade it with ${cli.label}.`);
    return false;
  }
  if (!getPlatform().terminal) {
    notify("info", `${cli.label} runs in a terminal: use the TMCode desktop app, or Copy Grading Prompt for an extension's chat.`);
    return false;
  }
  const has = await installed(cli.bin);
  if (has === false) {
    const install = (getPlatform().os === "windows" && cli.installWindows) || cli.install;
    notify("warning", `${cli.label} isn't installed on this computer. Install it in a terminal with: ${install}`, [
      { label: "Copy Install Command", run: () => void copy(install) },
      { label: "Open Install Guide", run: () => void getPlatform().openExternal?.(cli.docs) },
    ], { kind: "result" });
    return false;
  }
  await writeGradingFiles();
  setWatching(draftKey(review.key, review.student_id), { tool: cli.label, student: review.student });
  runInTerminal(cliCommand(tool), { name: `Grading: ${cli.label}` });
  notify("info", `${cli.label} is grading ${review.student}'s work in the terminal. TMCode fills the grade form when it writes its draft; nothing is saved until you click Save.`, undefined, { kind: "hint" });
  return true;
}

/** For an extension's chat panel: the instructions themselves (it may not open files on its own). */
export async function gradingPrompt(): Promise<string | null> {
  if (!useGrading.getState().review) return null;
  await writeGradingFiles();
  const readme = await getPlatform().fs.readFile(README_FILE).catch(() => null);
  return readme ? `${CLI_PROMPT}\n\nThe instructions in ${README_FILE}:\n\n${readme}` : CLI_PROMPT;
}

export async function copyGradingPrompt(): Promise<boolean> {
  const blocked = gradingToolsBlocked();
  if (blocked) {
    notify("info", blocked);
    return false;
  }
  const review = useGrading.getState().review;
  const prompt = await gradingPrompt();
  if (!review || !prompt) {
    notify("info", "Open a student's work first (pick them in the grading tab), then copy the grading prompt.");
    return false;
  }
  await copy(prompt);
  setWatching(draftKey(review.key, review.student_id), { tool: "Your AI extension", student: review.student });
  notify("info", `Grading prompt copied. Paste it into your AI extension's chat (Claude Code, Gemini Code Assist…): it writes ${review.student}'s draft, and TMCode fills the form.`, undefined, { kind: "hint" });
  return true;
}
