import { expect, test, type Page } from "@playwright/test";

/**
 * TMCode AI in the terminal (docs/releases/1.2.0.md), on the simulated shell (`?terminal=sim`)
 * and the memory account's mock Task Mentor (platform/memoryAi.ts terminalAnswer): ⌘I asks in
 * plain words, "# words" + Enter at the prompt asks without reaching the shell, a failed command
 * offers Fix with AI, and a dangerous command asks twice before it runs. Nothing runs by itself.
 */

type Term = { buffer: { active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined } } };

async function openTerminal(page: Page, storage: Record<string, string> = {}) {
  await page.addInitScript((extra) => {
    if (sessionStorage.getItem("tmcode:e2e-started")) return;
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    localStorage.setItem("tmcode:mock-account", "signed-in");
    for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
    sessionStorage.setItem("tmcode:e2e-started", "1");
  }, storage);
  await page.goto("/?terminal=sim");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("F1");
  await page.keyboard.type("Create New Terminal");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __TMCODE_TERM__?: Term }).__TMCODE_TERM__)).toBe(true);
  await expect(page.getByTestId("integrated-terminal")).toContainText("$");
}

/** The terminal's text (xterm's buffer: the DOM renderer may not show every row). */
const screen = (page: Page) =>
  page.evaluate(() => {
    const b = (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__.buffer.active;
    return Array.from({ length: b.length }, (_, y) => b.getLine(y)?.translateToString(true) ?? "").join("\n");
  });

async function type(page: Page, text: string) {
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const marks = (page: Page, state?: string) => page.locator(`[data-testid="integrated-terminal"] .tm-term-cmd-mark${state ? `.is-${state}` : ""}`);
const ai = (page: Page) => page.getByTestId("terminal-ai");

test("⌘I in the terminal: plain words in, commands out; Insert puts one at the prompt without running it", async ({ page }) => {
  await openTerminal(page);
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(ai(page)).toBeVisible();
  // ⌘I in the terminal is the terminal's AI, not the chat in the side bar.
  await expect(page.getByTestId("tmcode-ai-chat")).toBeHidden();
  await expect(page.getByTestId("terminal-ai-input")).toBeFocused();
  await expect(page.getByTestId("terminal-ai-model")).toContainText("Free");

  await page.getByTestId("terminal-ai-input").fill("what is in this folder?");
  await page.getByTestId("terminal-ai-input").press("Enter");
  const cards = page.getByTestId("terminal-ai-card");
  await expect(cards).toHaveCount(2, { timeout: 10_000 });
  await expect(cards.first()).toContainText("ls -la");
  await expect(cards.first()).toContainText("Lists all files");
  await expect(page.getByTestId("terminal-ai-answer")).toContainText("Two ways to see what's in this folder.");

  await cards.nth(1).getByTestId("terminal-ai-insert").click();
  await expect(ai(page)).toBeHidden();
  await expect.poll(() => screen(page)).toContain("$ git status");
  // Inserted, not run: no command finished.
  await expect(marks(page)).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(marks(page)).toHaveCount(1);
});

test('"# words" + Enter at the prompt asks TMCode AI (the words never reach the shell); a dangerous command asks twice', async ({ page }) => {
  await openTerminal(page);
  await type(page, "# delete the build folder");
  await expect(ai(page)).toBeVisible();
  const card = page.getByTestId("terminal-ai-card");
  await expect(card).toHaveCount(1, { timeout: 10_000 });
  await expect(card).toHaveAttribute("data-risk", "danger");
  // The AI said "safe"; TMCode's own check knows better.
  await expect(card.getByTestId("terminal-ai-risk")).toContainText("Dangerous: this deletes files without asking.");
  expect(await screen(page)).not.toContain("# delete");

  await card.getByTestId("terminal-ai-run").click();
  await expect(card.getByTestId("terminal-ai-confirm")).toBeVisible();
  await expect(marks(page)).toHaveCount(0);
  await card.getByTestId("terminal-ai-confirm").click();
  await expect(ai(page)).toBeHidden();
  await expect(marks(page)).toHaveCount(1);
  await expect.poll(() => screen(page)).toContain("$ rm -rf build");
});

test("a failed command offers Fix with AI; the fix runs with one click and the Activity log names TMCode AI", async ({ page }) => {
  await openTerminal(page);
  await type(page, "npm tset");
  await expect(marks(page, "error")).toHaveCount(1);
  const hint = page.getByTestId("terminal-ai-hint");
  await expect(hint).toContainText("npm tset failed");
  await hint.getByTestId("terminal-ai-fix").click();
  await expect(hint).toBeHidden();
  await expect(page.getByTestId("terminal-ai-answer")).toContainText("you meant `npm test`", { timeout: 10_000 });
  await page.getByTestId("terminal-ai-input").press("ControlOrMeta+Enter");
  await expect(ai(page)).toBeHidden();
  await expect(marks(page)).toHaveCount(2);
  await expect.poll(() => screen(page)).toContain("$ npm test");

  // An answer in Markdown still gives cards.
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+i");
  await page.getByTestId("terminal-ai-input").fill("find big files");
  await page.getByTestId("terminal-ai-input").press("Enter");
  await expect(page.getByTestId("terminal-ai-card")).toContainText("find . -type f -size +100M", { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(ai(page)).toBeHidden();
});

test("off where the school turned AI off: the box says why and asks nothing", async ({ page }) => {
  await openTerminal(page, { "tmcode:mock-ai-policy": JSON.stringify({ allowed: false, reason: "GLOBAL_OFF", message: "Your school has turned AI off." }) });
  await page.getByTestId("terminal-ai-open").click();
  await expect(ai(page)).toBeVisible();
  await expect(page.getByTestId("terminal-ai-locked")).toContainText("Your school has turned AI off.", { timeout: 10_000 });
  await expect(page.getByTestId("terminal-ai-input")).toBeDisabled();
  // No Fix with AI either.
  await page.getByTestId("terminal-ai-close").click();
  await type(page, "false");
  await expect(marks(page, "error")).toHaveCount(1);
  await expect(page.getByTestId("terminal-ai-hint")).toBeHidden();
});
