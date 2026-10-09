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
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
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
  // Beside the code the roster is folded: the switcher unfolds it.
  await page.getByTestId("grade-switcher-toggle").click();
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
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
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

test("beside the code the roster folds into a switcher; Full marks, the save hint and the finish line", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-start").click();
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
  // The student's files are one click away.
  await expect(page.locator(".tm-grade-files")).toContainText("app.js");

  // The grading tab is narrow beside the code: one bar names the student, the form gets the height.
  const switcher = page.getByTestId("grade-switcher");
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText("Ben Learner");
  await expect(switcher).toContainText("1 of 2");
  await expect(page.locator(".tm-grade-list")).toBeHidden();
  await expect(page.getByTestId("grade-feedback")).toBeInViewport();
  await page.getByTestId("grade-switcher-toggle").click();
  await expect(page.locator(".tm-grade-list")).toBeVisible();
  await page.getByTestId("grade-switcher-toggle").click();

  // Save explains what's missing; Full marks fills every criterion.
  await expect(page.getByTestId("grade-status")).toHaveText("Score every criterion to save");
  await page.getByTestId("grade-criterion").nth(0).getByRole("button", { name: "12" }).click();
  await expect(page.getByTestId("grade-status")).toHaveText("Score 1 more criterion to save");
  await page.getByTestId("grade-full-marks").click();
  await expect(page.getByTestId("grade-total")).toContainText("20");
  await page.getByTestId("grade-save-next").click();
  await expect(switcher).toContainText("Chloe Coder", { timeout: 15_000 });
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save-next").click();

  // Nothing left: the finish line, with the way back to the teacher's own folder.
  const done = page.getByTestId("grade-finished");
  await expect(done).toContainText("All handed-in work is graded", { timeout: 15_000 });
  await expect(done).toContainText("2 of 2 graded");
  await done.getByRole("button", { name: "Back to My Folder" }).click();
  await expect(page.getByTestId("grading-reviewing")).toHaveCount(0);
});

test("each practical in the list says what is waiting", async ({ page }) => {
  await teacher(page);
  await expect(activity(page, "assignment:51:").getByTestId("grading-workload")).toHaveText("2 to grade", { timeout: 10_000 });
  await expect(activity(page, "quiz:78:501").getByTestId("grading-workload")).toHaveText("1 to grade");
});

type Stored = { rubric_scores: { index: number; score: number; comment?: string | null }[] | null; feedback: string } | null;
const storedBen = (page: Page) => page.evaluate(`window.__TMCODE_PROJECTS__.gradeOf("assignment", 51, null, 21)`) as Promise<Stored>;

test("notes per criterion survive a re-save, from servers that keep them and from older ones that only have the feedback text", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-start").click();
  const panel = page.getByTestId("grade-panel");
  await expect(panel).toContainText("Ben Learner", { timeout: 15_000 });
  await panel.getByTestId("grade-criterion").nth(0).getByRole("button", { name: "12" }).click();
  await panel.getByTestId("grade-criterion").nth(1).getByLabel(/Code quality score/).fill("6");
  await panel.getByLabel("Note for Adding items works").click();
  await panel.locator(".tm-grade-note").fill("Adding works, even with an empty box.");
  await page.getByTestId("grade-feedback").fill("Nice and tidy.");
  await page.getByTestId("grade-save").click();
  await expect(page.locator(".tm-toast", { hasText: "Grade saved: 18/20" })).toBeVisible();
  let stored = await storedBen(page);
  expect(stored?.rubric_scores?.[0].comment).toBe("Adding works, even with an empty box.");
  expect(stored?.feedback).toBe("Nice and tidy.\n\nCriteria notes:\n• Adding items works: Adding works, even with an empty box.");

  // An older Task Mentor: the notes come back only inside the feedback. Reloaded, the form still has them apart.
  await page.evaluate("window.__TMCODE_PROJECTS__.setLegacyGradeComments(true)");
  await command(page, "Grading: Refresh Grading");
  await page.locator(".tm-tab", { hasText: "Grade: Build a to-do list" }).click();
  await page.getByTestId("grade-switcher-toggle").click();
  await page.getByTestId("grade-filter-graded").click();
  await page.getByTestId("grade-row").filter({ hasText: "Ben Learner" }).click();
  await expect(page.getByTestId("grade-panel")).toContainText("Ben Learner");
  await expect(page.getByTestId("grade-feedback")).toHaveValue("Nice and tidy.");
  const note = page.getByTestId("grade-panel").locator(".tm-grade-note");
  if ((await note.count()) === 0) await page.getByTestId("grade-panel").getByLabel("Note for Adding items works").click();
  await expect(note).toHaveValue("Adding works, even with an empty box.");

  // Re-saved with another score: the note is kept, and written once.
  await page.getByTestId("grade-panel").getByTestId("grade-criterion").nth(1).getByLabel(/Code quality score/).fill("7");
  await page.getByTestId("grade-save").click();
  await expect(page.locator(".tm-toast", { hasText: "Grade saved: 19/20" })).toBeVisible();
  stored = await storedBen(page);
  expect(stored?.feedback).toBe("Nice and tidy.\n\nCriteria notes:\n• Adding items works: Adding works, even with an empty box.");
  expect(stored?.rubric_scores?.[0].comment).toBe("Adding works, even with an empty box.");
});
