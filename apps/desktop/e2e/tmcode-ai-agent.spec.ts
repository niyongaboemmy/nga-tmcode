import { expect, test, type Page } from "@playwright/test";

/**
 * TMCode AI's agent modes, as Claude Code's (mock AI: platform/memoryAi.ts reads the file, then
 * edits console.log → console.info, or presents a plan): the modes menu (⇧Tab cycles), Manual's
 * approval with the diff, Reject, Undo all, Plan → Start building, and the prompt tools (copy,
 * refer to an answer, ↑ for earlier prompts, @-mention a file).
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const editor = (page: Page) => page.locator(".tm-editor-area .monaco-editor .view-lines").first();

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
  await externalWrite(page, "js/app.js", "console.log('hi');\n");
  if (!(await row(page, "js/app.js").isVisible())) await row(page, "js").click();
  await row(page, "js/app.js").click();
  await expect(editor(page)).toContainText("console.log('hi');");
  await page.keyboard.press("ControlOrMeta+i");
  await expect(page.getByTestId("tmcode-ai-chat")).toBeVisible();
}

async function prompt(page: Page, text: string) {
  await page.getByTestId("ai-input").fill(text);
  await page.getByTestId("ai-input").press("Enter");
}

test("Manual asks before each change (diff, Approve, Reject); Undo all puts the file back", async ({ page }) => {
  await fresh(page);
  const chat = page.getByTestId("tmcode-ai-chat");
  // Manual is the default; the menu lists Claude Code's modes.
  await expect(page.getByTestId("ai-agent-mode")).toContainText("Manual");
  await page.getByTestId("ai-agent-mode").click();
  const menu = page.getByTestId("ai-modes");
  await expect(menu).toContainText("to switch");
  if (process.env.AI_SHOTS) await page.waitForTimeout(600), await page.screenshot({ path: `${process.env.AI_SHOTS}/modes.png` });
  for (const m of ["Chat", "Manual", "Edit automatically", "Plan", "Auto"]) await expect(menu).toContainText(m);
  await page.keyboard.press("Escape");

  await prompt(page, "Use console.info for messages");
  const steps = chat.getByTestId("ai-step");
  await expect(steps.first()).toContainText("Read app.js");
  const waiting = chat.locator('[data-testid="ai-step"][data-status="waiting"]');
  await expect(waiting).toContainText("Edit app.js");
  await expect(waiting).toContainText("Needs your OK");
  await expect(waiting.locator(".tm-chat-diff .is-del")).toContainText("console.log('hi');");
  await expect(waiting.locator(".tm-chat-diff .is-add")).toContainText("console.info('hi');");
  if (process.env.AI_SHOTS) await page.screenshot({ path: `${process.env.AI_SHOTS}/approve.png` });
  // Nothing changed until it is approved.
  await expect(editor(page)).toContainText("console.log('hi');");
  await waiting.getByTestId("ai-approve").click();
  await expect(chat.locator('[data-testid="ai-step"][data-status="done"]').last()).toContainText("Edited app.js");
  await expect(editor(page)).toContainText("console.info('hi');");
  await expect(chat.locator(".tm-chat-answer").last()).toContainText("I changed console.log to console.info");
  await expect(chat.getByTestId("ai-checkpoint")).toContainText("Changed app.js");
  if (process.env.AI_SHOTS) await page.screenshot({ path: `${process.env.AI_SHOTS}/done.png` });

  // Undo all: the file is as it was.
  await chat.getByTestId("ai-undo-all").click();
  await expect(editor(page)).toContainText("console.log('hi');");
  await expect(chat.getByTestId("ai-checkpoint")).toContainText("Undone: app.js");

  // Reject: the AI is told, and nothing changes.
  await prompt(page, "Use console.info for messages");
  await chat.locator('[data-testid="ai-step"][data-status="waiting"]').getByTestId("ai-reject").click();
  await expect(chat.locator('[data-testid="ai-step"][data-status="rejected"]')).toContainText("Declined");
  await expect(chat.locator(".tm-chat-answer").last()).toContainText("I left the file as it was");
  await expect(editor(page)).toContainText("console.log('hi');");

  // The Activity log names the agent's work and the undo.
  await page.keyboard.press("ControlOrMeta+j");
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  const log = page.getByTestId("activity-view");
  await expect(log).toContainText("Asked TMCode AI (Manual)");
  await expect(log).toContainText("TMCode AI changed 1 file (Manual)");
  await expect(log).toContainText("Undid TMCode AI's changes to 1 file");
});

test("Plan explores and proposes; Start building carries it out without asking (Edit automatically)", async ({ page }) => {
  await fresh(page);
  const chat = page.getByTestId("tmcode-ai-chat");
  // ⇧Tab cycles the modes: Manual → Edit automatically → Plan.
  await page.getByTestId("ai-input").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("ai-agent-mode")).toContainText("Edit automatically");
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("ai-agent-mode")).toContainText("Plan");

  await prompt(page, "Make the messages clearer");
  await expect(chat.locator(".tm-chat-answer").last()).toContainText("Here is the plan for js/app.js");
  await expect(editor(page)).toContainText("console.log('hi');");
  await chat.getByTestId("ai-start-building").click();
  await expect(page.getByTestId("ai-agent-mode")).toContainText("Edit automatically");
  await expect(chat.locator('[data-testid="ai-step"][data-status="done"]').last()).toContainText("Edited app.js");
  await expect(editor(page)).toContainText("console.info('hi');");
  // Edit automatically never stopped to ask.
  await expect(chat.locator('[data-testid="ai-step"][data-status="waiting"]')).toHaveCount(0);
});

test("prompts: refer to an answer, ↑ for the last prompt, @ to add a file, copy and edit a message", async ({ page, browserName, context }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fresh(page);
  const chat = page.getByTestId("tmcode-ai-chat");
  await page.getByTestId("ai-agent-mode").click();
  await page.getByTestId("ai-mode-chat").click();
  await prompt(page, "Explain this code");
  const answer = chat.locator(".tm-chat-answer").last();
  await expect(answer).toContainText("runs from top to bottom");

  // Answers and prompts can be selected (the workbench itself isn't selectable).
  const selectable = await answer.locator(".tm-chat-md").first().evaluate((el) => getComputedStyle(el).userSelect || (getComputedStyle(el) as unknown as { webkitUserSelect: string }).webkitUserSelect);
  expect(selectable).toBe("text");
  // Select it as a mouse drag would (text the workbench marks unselectable reads back empty).
  await expect
    .poll(() =>
      answer
        .locator(".tm-chat-md")
        .first()
        .evaluate((el) => {
          const r = document.createRange();
          r.selectNodeContents(el);
          const sel = getSelection()!;
          sel.removeAllRanges();
          sel.addRange(r);
          return String(sel);
        }),
    )
    .toContain("runs from top to bottom");

  // Refer to the answer: the next prompt carries it.
  await answer.hover();
  await answer.getByTestId("ai-refer").click();
  await expect(page.getByTestId("ai-reference")).toContainText("runs from top to bottom");

  // ↑ brings back the last prompt.
  await page.getByTestId("ai-input").fill("");
  await page.getByTestId("ai-input").press("ArrowUp");
  await expect(page.getByTestId("ai-input")).toHaveValue("Explain this code");

  // @ suggests the project's files.
  await page.getByTestId("ai-input").fill("Compare with @sum");
  await expect(page.getByTestId("ai-mentions")).toContainText("js/sum.js");
  await page.getByTestId("ai-input").press("Enter");
  await expect(page.getByTestId("ai-input")).toHaveValue("Compare with @js/sum.js ");

  // Copy a message; edit a sent prompt (it comes back into the box).
  if (browserName === "chromium") {
    await answer.hover();
    await answer.getByTestId("ai-copy-message").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("runs from top to bottom");
  }
  const q = chat.locator(".tm-chat-q").first();
  await q.hover();
  await q.getByTestId("ai-edit-prompt").click();
  await expect(page.getByTestId("ai-input")).toHaveValue("Explain this code");
  await expect(chat.locator(".tm-chat-q")).toHaveCount(0);
});

test("the AI assistants hub lists Claude Code, Codex and Gemini with Install", async ({ page }) => {
  await fresh(page);
  await page.getByTestId("aihub-toggle").click();
  for (const id of ["anthropic.claude-code", "openai.chatgpt", "google.geminicodeassist"]) await expect(page.getByTestId(`aihub-${id}`)).toBeVisible();
  await expect(page.getByTestId("aihub-anthropic.claude-code")).toContainText("Claude Code");
  await expect(page.getByTestId("aihub-anthropic.claude-code").getByRole("button", { name: /Install/ })).toBeVisible();
});
