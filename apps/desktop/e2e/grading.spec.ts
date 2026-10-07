import { expect, test, type Page } from "@playwright/test";

/**
 * Teachers grade TMCode practicals in TMCode (grading/*) against the memory
 * account's mock Task Mentor: assignment 51 has two submissions (Ben, Chloe),
 * Dan is still working and Eve hasn't started; quiz 78's practical question
 * 501 has Ben's submission.
 */

type Mock = { setTeacher(on: boolean): void; setGradingList(on: boolean): void };
const mock = <T>(page: Page, fn: (m: Mock) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_PROJECTS__)`) as Promise<T>;

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

async function teacher(page: Page, list = true) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await mock(page, (m) => m.setTeacher(true));
  if (!list) await mock(page, (m) => m.setGradingList(false));
  await command(page, "Grading: Refresh Grading");
  await expect(page.locator('.tm-activity[aria-label^="Grading"]')).toBeVisible({ timeout: 10_000 });
  await command(page, "View: Show Grading");
  await expect(page.getByTestId("grading-view")).toBeVisible();
}

const activity = (page: Page, key: string) => page.locator(`[data-testid="grading-activity"][data-key="${key}"]`);

test("the Grading view lists practicals by subject with their progress and a to-grade badge", async ({ page }) => {
  await teacher(page);
  await expect(activity(page, "assignment:51:")).toContainText("Build a to-do list");
  await expect(activity(page, "quiz:78:501")).toContainText("Build a navbar");
  await expect(activity(page, "quiz:78:501")).toContainText("Web Quiz 3");
  await expect(page.locator(".tm-grade-subject-title", { hasText: "Web Development" })).toBeVisible();
  await expect(activity(page, "assignment:51:").locator(".tm-badge")).toHaveText("2", { timeout: 10_000 });
  await expect(page.locator('.tm-activity[aria-label^="Grading"] .tm-activity-badge')).toHaveText("3");
  await expect(page.locator(".tm-grade-summary")).toContainText("3 to grade");
  // Only what waits for grading.
  await page.getByTestId("grading-only-pending").click();
  await expect(page.getByTestId("grading-activity")).toHaveCount(2);
});

test("select a submission: the project loads read-only, criteria grade it, Save & Next moves on and progress follows", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  const pageEl = page.getByTestId("grading-page");
  await expect(pageEl.getByTestId("grading-progress")).toContainText("2 to grade");
  await expect(pageEl.getByTestId("grading-progress")).toContainText("1 working");
  await expect(pageEl.getByTestId("grade-row")).toHaveCount(2); // the "To grade" filter
  await pageEl.getByTestId("grade-start").click();

  // Ben's submitted version is loaded in this window, read-only, with the grading tab beside it.
  await expect(page.getByTestId("load-project")).toHaveText(/Loaded in this window/, { timeout: 15_000 });
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="app.js"]')).toBeVisible();
  await page.locator('.tm-explorer [data-path="app.js"]').dblclick();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.type("x");
  await expect(page.locator(".monaco-editor-overlaymessage")).toContainText("Reviewing Ben Learner's submission");

  await page.locator(".tm-tab", { hasText: "Grade: Build a to-do list" }).click();
  const panel = page.getByTestId("grade-panel");
  await expect(panel).toContainText("Ben Learner");
  await expect(page.getByTestId("grade-save-next")).toBeDisabled(); // every criterion needs a score
  await panel.getByTestId("grade-criterion").nth(0).getByRole("button", { name: "12" }).click();
  await panel.getByTestId("grade-criterion").nth(1).getByLabel(/Code quality score/).fill("6");
  await expect(page.getByTestId("grade-total")).toContainText("18");
  await page.getByTestId("grade-feedback").fill("Nice and tidy.");
  await page.getByTestId("grade-save-next").click();
  await expect(page.locator(".tm-toast", { hasText: "Grade saved: 18/20" })).toBeVisible();

  // Next: Chloe, and the progress moved.
  await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder", { timeout: 15_000 });
  await expect(page.getByTestId("grading-progress")).toContainText("1 graded");
  await expect(page.getByTestId("grading-progress")).toContainText("50%");
  await page.getByTestId("grade-filter-graded").click();
  await expect(page.getByTestId("grade-row")).toContainText("18/20");
});

test("a quiz practical question is graded the same way", async ({ page }) => {
  await teacher(page);
  await activity(page, "quiz:78:501").click();
  await page.getByTestId("grade-start").click();
  await expect(page.getByTestId("grade-panel")).toContainText("Ben Learner");
  await page.getByTestId("grade-criterion").nth(0).getByRole("button", { name: "6" }).click();
  await page.getByTestId("grade-criterion").nth(1).getByRole("button", { name: "2" }).click();
  await page.getByTestId("grade-save").click();
  await expect(page.locator(".tm-toast", { hasText: "Grade saved: 8/10" })).toBeVisible();
  await expect(page.getByTestId("grading-progress")).toContainText("100%");
});

test("students still working or not started can't be graded yet; Back to my folder ends the review", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-filter-all").click();
  await page.getByTestId("grade-row").filter({ hasText: "Dan Doer" }).click();
  await expect(page.getByTestId("grade-hint")).toContainText("Still working");
  await expect(page.getByTestId("load-project")).toBeDisabled();
  await page.getByTestId("grade-row").filter({ hasText: "Chloe Coder" }).click();
  await expect(page.getByTestId("load-project")).toHaveText(/Loaded in this window/, { timeout: 15_000 });
  await command(page, "View: Show Grading");
  await page.getByTestId("grading-reviewing").getByRole("button", { name: "Back to my folder" }).click();
  await expect(page.getByTestId("grading-reviewing")).toHaveCount(0);
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="main.py"]')).toBeVisible();
});

test("without GET /grading (older Task Mentor), the list comes from the teaching assignments and practical quizzes", async ({ page }) => {
  await teacher(page, false);
  await expect(activity(page, "assignment:51:")).toBeVisible();
  await expect(activity(page, "quiz:78:501")).toBeVisible();
});

test("icons show styled tooltips with their shortcut, and the title comes back afterwards", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  const explorer = page.locator('.tm-activity[aria-label^="Explorer"]');
  await explorer.hover();
  const tip = page.getByTestId("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("Explorer");
  await expect(tip.locator(".tm-tooltip-keys")).toBeVisible();
  await page.mouse.move(700, 400);
  await expect(tip).toHaveCount(0);
  await expect(explorer).toHaveAttribute("title", /Explorer/);
});
