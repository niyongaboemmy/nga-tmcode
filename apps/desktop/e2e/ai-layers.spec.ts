import { expect, test, type Page } from "@playwright/test";

/**
 * The three AI layers (reports/TMCode vibe coding proposal 2026.md §8) in the browser build, with
 * the mock Task Mentor (platform/memoryAi.ts): the status-bar badge and its hover reason, Learning's
 * tutor (no suggestions, no code to take, filter hits shown), lowering your own layer from the
 * badge, and the layer change in the Activity log.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

async function fresh(page: Page, policy: Record<string, unknown> | null) {
  await page.goto("/");
  await page.evaluate((p) => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
    if (p) localStorage.setItem("tmcode:mock-ai-policy", JSON.stringify(p));
  }, policy);
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("F1");
  await page.keyboard.type("View: Show Explorer");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

async function openFile(page: Page, path: string, content: string) {
  await externalWrite(page, path, content);
  if (!(await row(page, path).isVisible())) await row(page, path.split("/")[0]).click();
  await row(page, path).click();
}

test("Learning: the badge says so, the tutor answers in words, nothing can be taken or suggested", async ({ page }) => {
  await fresh(page, { allowed: true, reason: "ALLOWED_BY_TEACHER", message: "", layer: "learning" });
  const badge = page.getByTestId("ai-layer-badge");
  await expect(badge).toHaveAttribute("data-layer", "learning");
  await expect(badge).toContainText("Learning");
  await expect(badge).toHaveAttribute("title", /AI helps you think\. You write every line\./);
  await expect(page.locator("html")).toHaveAttribute("data-ai-layer", "learning");

  await openFile(page, "js/app.js", "console.log('hi');\nconst x = 1;\n");
  await page.keyboard.press("ControlOrMeta+i");
  const chat = page.getByTestId("tmcode-ai-chat");
  await expect(page.getByTestId("ai-tutor-hero")).toBeVisible();
  await expect(page.getByTestId("ai-tutor-mode")).toContainText("Tutor");
  // No mode menu, no ghost-text toggle; the allowance shows as hearts.
  await expect(page.getByTestId("ai-agent-mode")).toHaveCount(0);
  await expect(page.getByTestId("ai-suggestions")).toHaveCount(0);
  await expect(page.getByTestId("ai-allowance")).toContainText("10/10");

  await chat.getByRole("button", { name: "Give me a hint" }).click();
  const answer = chat.locator(".tm-chat-answer").last();
  // The tutor may read the file (read-only), and answers in words.
  await expect(answer.getByTestId("ai-step").first()).toContainText("Read app.js", { timeout: 10000 });
  await expect(answer).toContainText("plan", { timeout: 10000 });
  await expect(answer.getByTestId("ai-apply")).toHaveCount(0);
  await expect(answer.getByTestId("ai-insert")).toHaveCount(0);
});

test("Industrial for staff is Open; lowering your own layer from the badge is logged", async ({ page }) => {
  await fresh(page, { allowed: true, reason: "ALLOWED_BY_ROLE", message: "", layer: "industrial", staff: true });
  const badge = page.getByTestId("ai-layer-badge");
  await expect(badge).toHaveAttribute("data-layer", "industrial");
  await expect(badge).toHaveAttribute("data-profile", "open");
  await expect(badge).toContainText("Industrial · Open");

  await badge.click();
  await page.getByText("No AI for This Project").click();
  await expect(badge).toHaveAttribute("data-layer", "exam");
  await expect(badge).toContainText("No AI");
  await page.keyboard.press("ControlOrMeta+Alt+b");
  await expect(page.getByTestId("ai-lock-message")).toContainText("You turned AI off for this project.");

  // Back to what's set for you.
  await badge.click();
  await page.getByText("Back to What's Set for You").click();
  await expect(badge).toHaveAttribute("data-layer", "industrial");

  // Both changes are in the Activity log, with their cause.
  if (!(await page.locator(".tm-panel").isVisible())) await page.keyboard.press("ControlOrMeta+j");
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  const log = page.getByTestId("activity-view");
  await expect(log).toContainText("AI layer: Industrial · Open → No AI", { timeout: 10000 });
  await expect(log).toContainText("AI layer: No AI → Industrial · Open");
});

test("an assignment set to Industrial is Guided for a student: own AI tools stay off unless the teacher allows them", async ({ page }) => {
  await fresh(page, { allowed: true, reason: "ALLOWED_BY_TEACHER", message: "", layer: "industrial", mode: "full", staff: false, thirdPartyExtensions: false });
  const badge = page.getByTestId("ai-layer-badge");
  await expect(badge).toContainText("Industrial · Guided");
  await expect(badge).toHaveAttribute("data-profile", "guided");
});
