import { expect, test, type Page } from "@playwright/test";

/**
 * Your AI accounts (ai/aiClis.ts): Claude Code, ChatGPT (Codex), Gemini (Antigravity) and Gemini CLI answer TMCode AI
 * with the user's own account, in the terminal's AI, the chat and agent modes. The pretend CLIs
 * live in platform/memoryProc.ts (localStorage `tmcode:mock-clis`); the school's third-party
 * switch comes from the mock Task Mentor (`tmcode:mock-ai-policy`).
 */

type Term = { buffer: { active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } } };
type CliCall = { command: string; stdin: string };

async function launch(page: Page, clis: Record<string, string>, extra: Record<string, string> = {}) {
  await page.addInitScript(
    ({ clis, extra }) => {
      if (sessionStorage.getItem("tmcode:e2e-started")) return;
      localStorage.clear();
      localStorage.setItem("tmcode:e2e-no-home", "1");
      localStorage.setItem("tmcode:mock-account", "signed-in");
      localStorage.setItem("tmcode:mock-clis", JSON.stringify(clis));
      for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
      sessionStorage.setItem("tmcode:e2e-started", "1");
    },
    { clis, extra },
  );
  await page.goto("/?terminal=sim");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

async function openTerminal(page: Page) {
  await command(page, "Create New Terminal");
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __TMCODE_TERM__?: Term }).__TMCODE_TERM__)).toBe(true);
  await expect(page.getByTestId("integrated-terminal")).toContainText("$");
}

const screen = (page: Page) =>
  page.evaluate(() => {
    const b = (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__.buffer.active;
    return Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "").join("\n");
  });

const lastCli = (page: Page) => page.evaluate(() => (window as unknown as { __tmcodeCli?: CliCall }).__tmcodeCli ?? null);
const picker = (page: Page) => page.locator(".tm-quick-pick");

async function pick(page: Page, open: () => Promise<void>, option: RegExp) {
  await open();
  await expect(picker(page)).toContainText("Your AI accounts", { timeout: 15_000 });
  await picker(page).getByRole("option", { name: option }).click();
}

test("the terminal's AI answers with Claude Code: own account, the question on stdin, never on the command line", async ({ page }) => {
  await launch(page, { claude: "ready" });
  await openTerminal(page);
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+i");
  const ai = page.getByTestId("terminal-ai");
  await expect(ai).toBeVisible();
  await pick(page, () => page.getByTestId("terminal-ai-model").click(), /Claude Code · Haiku/);
  await expect(page.getByTestId("terminal-ai-model")).toContainText("Claude Code · Haiku");
  await expect(ai).toContainText("Ask Claude Code");
  await expect(ai).toContainText("your Claude account");

  await page.getByTestId("terminal-ai-input").fill("what is in this folder?");
  await page.getByTestId("terminal-ai-input").press("Enter");
  await expect(page.getByTestId("terminal-ai-card")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("terminal-ai-answer")).toContainText("Claude Code: this lists the folder.");
  const call = await lastCli(page);
  expect(call!.command).toContain("--model haiku");
  expect(call!.command).toContain('--tools ""');
  expect(call!.command).not.toContain("what is in this folder");
  expect(call!.stdin).toContain("ONE JSON object");
  expect(call!.stdin).toContain("what is in this folder?");

  // The box docks under the terminal: the terminal shrinks above it instead of being covered.
  const term = await page.locator(".tm-terminal-area").boundingBox();
  const box = await ai.boundingBox();
  expect(term!.y + term!.height).toBeLessThanOrEqual(box!.y + 1);
});

test("ChatGPT at its plan's limit: says so, links to the plan, and Free answers instead", async ({ page }) => {
  await launch(page, { codex: "limit" });
  await openTerminal(page);
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+i");
  await pick(page, () => page.getByTestId("terminal-ai-model").click(), /^ChatGPT \(Codex\)/);
  await expect(page.getByTestId("terminal-ai")).toContainText("Ask ChatGPT (Codex)");
  await page.getByTestId("terminal-ai-input").fill("stop whatever uses port 3000");
  await page.getByTestId("terminal-ai-input").press("Enter");
  const error = page.getByTestId("terminal-ai-error");
  await expect(error).toContainText("your ChatGPT plan's limit", { timeout: 10_000 });
  await expect(error.getByTestId("cli-plans")).toHaveText("Your ChatGPT Plan");
  await error.getByTestId("cli-use-free").click();
  await expect(page.getByTestId("terminal-ai-card").first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("terminal-ai-model")).toContainText("Free");
});

test("not installed or not signed in: the picker offers Install and Sign In, each in a terminal", async ({ page }) => {
  await launch(page, { codex: "signed-out" });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await page.getByTestId("ai-mode").click();
  await expect(picker(page)).toContainText("Install Claude Code…", { timeout: 15_000 });
  await expect(picker(page)).toContainText("Install Gemini CLI…");
  await picker(page).getByRole("option", { name: /Sign In to ChatGPT \(Codex\)/ }).click();
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(() => screen(page), { timeout: 10_000 }).toContain("codex login");
});

test("Gemini in the chat: answers in Chat mode; an agent mode opens Gemini CLI in the terminal in its matching mode", async ({ page }) => {
  await launch(page, { gemini: "ready" });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await pick(page, () => page.getByTestId("ai-mode").click(), /Gemini CLI · Flash(?!-)/);
  await expect(page.getByTestId("ai-mode")).toContainText("Gemini CLI · Flash");
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
  await page.getByTestId("ai-input").fill("What is a closure?");
  await page.getByTestId("ai-input").press("Enter");
  const answer = page.locator(".tm-chat-answer").last();
  await expect(answer).toContainText("Gemini here. You asked: What is a closure?", { timeout: 10_000 });
  await expect(answer.locator(".tm-chat-meta")).toContainText("gemini-flash · Gemini CLI");

  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-manual").click();
  await page.getByTestId("ai-input").fill("add a test for utils");
  await page.getByTestId("ai-input").press("Enter");
  await expect(page.locator(".tm-chat-answer").last()).toContainText("Gemini CLI is working on this in the terminal", { timeout: 10_000 });
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  // (the narrow terminal wraps the line)
  await expect.poll(async () => (await screen(page)).replace(/\n/g, ""), { timeout: 10_000 }).toContain("gemini --approval-mode default --model flash -i 'add a test for utils'");
});

test("where the school turns third-party AI tools off, none of the accounts can answer", async ({ page }) => {
  await launch(page, { claude: "ready", codex: "ready" }, { "tmcode:mock-ai-policy": JSON.stringify({ allowed: true, reason: "ALLOWED_BY_ROLE", message: "", thirdPartyExtensions: false }) });
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByTestId("ai-mode").click();
  await expect(picker(page)).toContainText("Claude Code, ChatGPT and Gemini", { timeout: 15_000 });
  await expect(picker(page).getByRole("option", { name: /^Claude Code · Sonnet/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await command(page, "TMCode AI: Manage Your API Keys");
  await expect(page.getByTestId("ai-accounts-blocked")).toBeVisible();
});

test("Settings › TMCode AI › Your AI accounts: each account's state, and one click to use it", async ({ page }) => {
  await launch(page, { claude: "ready", codex: "signed-out" });
  await command(page, "TMCode AI: Manage Your API Keys");
  const accounts = page.getByTestId("ai-accounts");
  await expect(accounts).toBeVisible();
  const row = (cli: string) => accounts.locator(`[data-cli="${cli}"]`);
  await expect(row("claude").getByTestId("ai-account-state")).toContainText("Signed in · student@nga.ac.rw · Pro · v2.1.310", { timeout: 15_000 });
  await expect(row("codex").getByTestId("ai-account-signin")).toHaveText("Sign In with ChatGPT");
  await expect(row("gemini").getByTestId("ai-account-install")).toBeVisible();
  await row("claude").getByTestId("ai-account-use").click();
  await expect(row("claude")).toContainText("In use");
});

test("Gemini (Antigravity): agy answers the terminal's AI with a Google account, the question on stdin, its install folder on PATH", async ({ page }) => {
  await launch(page, { agy: "ready" });
  await openTerminal(page);
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+i");
  const ai = page.getByTestId("terminal-ai");
  await expect(ai).toBeVisible();
  await pick(page, () => page.getByTestId("terminal-ai-model").click(), /Gemini \(Antigravity\) · Gemini 3\.1 Pro/);
  await expect(page.getByTestId("terminal-ai-model")).toContainText("Gemini (Antigravity) · Gemini 3.1 Pro");
  await expect(ai).toContainText("your Google account");

  await page.getByTestId("terminal-ai-input").fill("what is in this folder?");
  await page.getByTestId("terminal-ai-input").press("Enter");
  await expect(page.getByTestId("terminal-ai-answer")).toContainText("Antigravity: this lists the folder.", { timeout: 10_000 });
  const call = await lastCli(page);
  expect(call!.command).toBe('export PATH="$PATH:$HOME/.local/bin"; agy --output-format stream-json --mode plan --disable-slash-commands --model gemini-3.1-pro-high');
  expect(call!.command).not.toContain("what is in this folder");
  expect(call!.stdin).toContain("what is in this folder?");
});

test("Gemini (Antigravity) in the chat, and Plan mode opens agy in the terminal in its plan mode", async ({ page }) => {
  await launch(page, { agy: "ready" });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await pick(page, () => page.getByTestId("ai-mode").click(), /^Gemini \(Antigravity\)(?! ·)/);
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
  await page.getByTestId("ai-input").fill("What is a closure?");
  await page.getByTestId("ai-input").press("Enter");
  const answer = page.locator(".tm-chat-answer").last();
  await expect(answer).toContainText("Antigravity here. You asked: What is a closure?", { timeout: 10_000 });
  await expect(answer.locator(".tm-chat-meta")).toContainText("gemini-3.8-flash-medium · Gemini (Antigravity)");

  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-plan").click();
  await page.getByTestId("ai-input").fill("add a test for utils");
  await page.getByTestId("ai-input").press("Enter");
  await expect(page.locator(".tm-chat-answer").last()).toContainText("Gemini (Antigravity) is working on this in the terminal", { timeout: 10_000 });
  await expect.poll(async () => (await screen(page)).replace(/\n/g, ""), { timeout: 10_000 }).toContain("agy --mode plan -i 'add a test for utils");
});

test("Gemini (Antigravity) not signed in: Settings and the menu offer Sign In with Google, which runs agy in a terminal", async ({ page }) => {
  await launch(page, { agy: "signed-out" });
  await command(page, "TMCode AI: Manage Your API Keys");
  const row = page.getByTestId("ai-accounts").locator('[data-cli="agy"]');
  await expect(row.getByTestId("ai-account-state")).toContainText("Not signed in · v1.4.12", { timeout: 15_000 });
  await expect(row.getByTestId("ai-account-signin")).toHaveText("Sign In with Google");
  // Gemini CLI says which accounts it still takes.
  await expect(page.getByTestId("ai-accounts").locator('[data-cli="gemini"]').getByTestId("ai-account-note")).toContainText("Personal and AI Pro accounts: use Gemini (Antigravity)");
  await row.getByTestId("ai-account-signin").click();
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(() => screen(page), { timeout: 10_000 }).toMatch(/\$ agy\s*$/m);
});

test("Gemini (Antigravity) at its limit: says so and links to the Google plan", async ({ page }) => {
  await launch(page, { agy: "limit" });
  await openTerminal(page);
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+i");
  await pick(page, () => page.getByTestId("terminal-ai-model").click(), /^Gemini \(Antigravity\)(?! ·)/);
  await page.getByTestId("terminal-ai-input").fill("stop whatever uses port 3000");
  await page.getByTestId("terminal-ai-input").press("Enter");
  const error = page.getByTestId("terminal-ai-error");
  await expect(error).toContainText("your Google plan's limit", { timeout: 10_000 });
  await expect(error.getByTestId("cli-plans")).toHaveText("Your Google Plan");
});

test("Gemini CLI with a personal Google account: says Google moved it to agy, and offers agy (install) or an API key", async ({ page }) => {
  await launch(page, { gemini: "moved" });
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
  await pick(page, () => page.getByTestId("ai-mode").click(), /^Gemini CLI(?! ·)/);
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
  await page.getByTestId("ai-input").fill("What is a closure?");
  await page.getByTestId("ai-input").press("Enter");
  const error = page.locator(".tm-chat-error").last();
  await expect(error).toContainText("Google moved personal and AI Pro accounts from Gemini CLI to Antigravity CLI (agy). Install agy or add a Gemini API key.", { timeout: 10_000 });
  await expect(error.getByTestId("cli-gemini-key")).toBeVisible();
  await error.getByTestId("cli-use-agy").click();
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(async () => (await screen(page)).replace(/\n/g, ""), { timeout: 10_000 }).toContain("curl -fsSL https://antigravity.google/cli/install.sh | bash");
});
