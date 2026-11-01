import { expect, test, type Page } from "@playwright/test";

/**
 * TMCode AI (memory account + the mock /api/tmcode/ai, platform/memoryAi.ts): the chat in the
 * secondary side bar with its Free / Auto picker and today's allowance, a streamed answer whose
 * code is applied as a diff to accept, an exhausted Free pool with "Switch to Auto", ghost-text
 * suggestions, and every step in the Activity log as AI use.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const editorLines = (page: Page) => page.locator(".tm-editor-area .monaco-editor .view-lines").first();

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  // Signed in on a first run the side bar may move to Assignments: a key press keeps it on the Explorer.
  await page.keyboard.press("F1");
  await page.keyboard.type("View: Show Explorer");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

async function openFile(page: Page, path: string, content: string) {
  await externalWrite(page, path, content);
  const dir = path.split("/")[0];
  if (!(await row(page, path).isVisible())) await row(page, dir).click();
  await row(page, path).click();
  await expect(editorLines(page)).toContainText(content.split("\n")[0]);
}

test("TMCode AI: ask about the file, apply its fix as a diff, switch to Auto, ghost text, all in the Activity log", async ({ page }) => {
  await fresh(page);
  await openFile(page, "js/app.js", "console.log('hi');\nconst x = 1;\n");

  // ⌘I opens the chat in the secondary side bar; Free (OpenRouter) is the default.
  await page.keyboard.press("ControlOrMeta+i");
  const chat = page.getByTestId("tmcode-ai-chat");
  await expect(chat).toBeVisible();
  await expect(page.getByTestId("ai-mode")).toContainText("Free");
  await expect(page.getByTestId("ai-quota")).toHaveText("40 left today");

  // Chat mode (answers only): a starter question about the open file, streamed, with a code block.
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
  await chat.getByRole("button", { name: "Find and fix bugs" }).click();
  await expect(chat.locator(".tm-chat-q")).toContainText("Find the bugs in this code");
  await expect(chat.locator(".tm-chat-q .tm-chat-chip")).toContainText("app.js");
  const answer = chat.locator(".tm-chat-answer").last();
  await expect(answer.locator(".tm-chat-code")).toContainText("console.info('hi');", { timeout: 10000 });
  await expect(answer.locator(".tm-chat-meta")).toContainText("poolside/laguna-xs-2.1 · openrouter");
  await expect(page.getByTestId("ai-quota")).toHaveText("39 left today");
  if (process.env.AI_SHOTS) await page.screenshot({ path: `${process.env.AI_SHOTS}/chat.png` });

  // Apply: a diff of the file and TMCode AI's version, accepted into the file.
  await answer.getByTestId("ai-apply").click();
  await expect(page.locator(".tm-tab", { hasText: "TMCode AI's change" })).toBeVisible();
  if (process.env.AI_SHOTS) await page.screenshot({ path: `${process.env.AI_SHOTS}/apply-diff.png` });
  await page.getByTestId("ai-accept").click();
  await expect(page.locator(".tm-tab", { hasText: "TMCode AI's change" })).toHaveCount(0);
  await expect(editorLines(page)).toContainText("console.info('hi');");
  // The block rewrote the file: nothing of the old line is left, nothing duplicated.
  await expect(editorLines(page)).not.toContainText("console.log");
  await expect(editorLines(page).locator(".view-line", { hasText: "const x = 1;" })).toHaveCount(1);

  // Free's pool runs out: the answer says so and offers Auto, which answers with another free AI.
  await page.evaluate(() => localStorage.setItem("tmcode:mock-ai-fail", "PROVIDER_QUOTA"));
  await page.getByTestId("ai-input").fill("Explain this code");
  await page.getByTestId("ai-input").press("Enter");
  const error = chat.locator(".tm-chat-error").last();
  await expect(error).toContainText("Switch to Auto: it picks a free AI");
  await error.getByRole("button", { name: "Switch to Auto" }).click();
  await expect(page.getByTestId("ai-mode")).toContainText("Auto");
  await page.getByTestId("ai-input").fill("Explain this code");
  await page.getByTestId("ai-input").press("Enter");
  await expect(chat.locator(".tm-chat-answer").last().locator(".tm-chat-meta")).toContainText("openai/gpt-oss-20b · groq", { timeout: 10000 });

  // Ghost text while typing, once suggestions are on.
  await page.getByTestId("ai-suggestions").click();
  await expect(page.getByTestId("ai-suggestions")).toHaveAttribute("aria-pressed", "true");
  await editorLines(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\nfunction add(a, b) {\n  return ");
  await expect(page.locator(".tm-editor-area .ghost-text-decoration, .tm-editor-area .ghost-text").first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Tab");
  await expect(editorLines(page)).toContainText("return a + b;");

  // The Activity log names every AI step.
  await page.keyboard.press("ControlOrMeta+j");
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  const log = page.getByTestId("activity-view");
  await expect(log).toContainText('Asked TMCode AI: "Find the bugs in this code');
  await expect(log).toContainText("TMCode AI answered");
  await expect(log).toContainText("TMCode AI proposed a change to app.js");
  await expect(log).toContainText("Accepted TMCode AI's change to app.js");
  await expect(log).toContainText("Accepted a suggestion from TMCode AI");
  await page.getByTestId("activity-filter-ai").click();
  await expect(log.locator(".tm-actlog-row:not(.is-ai)")).toHaveCount(0);
  await expect(page.getByTestId("activity-ai-count")).toContainText("TMCode AI");
  if (process.env.AI_SHOTS) {
    await page.getByTestId("activity-filter-all").click();
    await page.screenshot({ path: `${process.env.AI_SHOTS}/activity.png` });
  }
});

test("signed out, TMCode AI is Industrial · Open: bring your own AI, or sign in for the school's", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  // The layer badge says so, in the status bar.
  await expect(page.getByTestId("ai-layer-badge")).toHaveAttribute("data-layer", "industrial");
  await expect(page.getByTestId("ai-layer-badge")).toHaveAttribute("data-profile", "open");
  await page.keyboard.press("ControlOrMeta+Alt+b");
  const chat = page.getByTestId("tmcode-ai-chat");
  await expect(chat).toContainText("You're not signed in to NGA");
  await expect(chat).toContainText("Industrial · Open");
  await expect(page.getByTestId("ai-pick-own")).toBeVisible();
  await expect(page.getByTestId("ai-sign-in")).toBeVisible();
});

test("TMCode AI shows why when Task Mentor says AI is off (AI usage control)", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
    localStorage.setItem("tmcode:mock-ai-policy", JSON.stringify({ allowed: false, reason: "TEACHER_OFF", message: "Your teacher turned AI off for this assignment." }));
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Alt+b");
  const chat = page.getByTestId("tmcode-ai-chat");
  await expect(chat).toHaveAttribute("data-reason", "TEACHER_OFF");
  await expect(page.getByTestId("ai-lock-message")).toHaveText("Your teacher turned AI off for this assignment.");
  // The school turns it back on: the next status (project change, minute poll, reload) lifts the lock.
  await page.evaluate(() => localStorage.removeItem("tmcode:mock-ai-policy"));
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("ai-input")).toBeVisible();
});
