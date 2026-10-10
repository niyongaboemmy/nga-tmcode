import { expect, test, type Page } from "@playwright/test";

/**
 * Grading like a code reviewer (docs/reviews/2026-10-10-ux-gap-review, G1–G14)
 * against the memory account's mock Task Mentor: assignment 51 has Ben's
 * submission (versions 1 = starter, 2, 3 = submitted) and Chloe's; quiz 78's
 * question 501 has Ben's.
 */

const mock = (page: Page, js: string) => page.evaluate(`(() => { const m = window.__TMCODE_PROJECTS__; return ${js}; })()`);

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

async function teacher(page: Page, opts: { clear?: boolean } = {}) {
  await page.goto("/");
  if (opts.clear !== false) {
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem("tmcode:mock-account", "signed-in");
    });
    await page.reload();
  }
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await mock(page, "m.setTeacher(true)");
  await command(page, "Grading: Refresh Grading");
  await expect(page.locator('.tm-activity[aria-label^="Grading"]')).toBeVisible({ timeout: 10_000 });
  await command(page, "View: Show Grading");
  await expect(page.getByTestId("grading-view")).toBeVisible();
}

const activity = (page: Page, key: string) => page.locator(`[data-testid="grading-activity"][data-key="${key}"]`);
const gradingTab = (page: Page) => page.locator(".tm-tab", { hasText: "Grade: Build a to-do list" });
const toast = (page: Page, text: string | RegExp) => page.locator(".tm-toast", { hasText: text });
const ben = (page: Page) => mock(page, `m.gradeOf("assignment", 51, null, 21)`) as Promise<{ score: number; released: boolean; annotations: { path: string; line: number; text: string }[] } | null>;

/** Opens assignment 51 and Ben's submission (loaded read-only beside the grading tab). */
async function gradeBen(page: Page) {
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-start").click();
  await expect(page.getByTestId("grade-panel")).toContainText("Ben Learner");
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
}

async function openFileInExplorer(page: Page, path: string) {
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await page.locator(`.tm-explorer [data-path="${path}"]`).dblclick();
  await expect(page.locator(".tm-tab.is-active", { hasText: path }).first()).toBeVisible();
}

test("line comments: + in the gutter, Edit and Delete, listed in the panel and saved with the grade", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  await openFileInExplorer(page, "app.js");

  // Hover a line: a "+" in the gutter starts a comment under it.
  await page.locator(".monaco-editor .view-line").first().hover();
  await page.locator(".monaco-editor .tm-review-comment-add").click();
  const input = page.getByTestId("review-comment-input");
  await expect(input).toBeFocused();
  await input.fill("Use const for values that never change.");
  await page.getByTestId("review-comment-save").click();
  const comment = page.getByTestId("review-comment");
  await expect(comment).toContainText("Use const for values that never change.");
  await expect(comment).toContainText("line 1");

  // Grading: Add Line Comment, at the cursor (⌘Enter keeps it).
  await page.locator(".monaco-editor .view-lines").first().click();
  await command(page, "Grading: Add Line Comment");
  await expect(page.getByTestId("review-comment-input")).toBeFocused();
  await page.keyboard.type("Second thought");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(page.getByTestId("review-comment")).toHaveCount(2);

  // Edit, then delete one.
  await page.getByTestId("review-comment").nth(1).getByRole("button", { name: "Edit comment" }).click();
  await page.getByTestId("review-comment-input").fill("Second thought, edited");
  await page.getByTestId("review-comment-save").click();
  await expect(page.getByTestId("review-comment").nth(1)).toContainText("Second thought, edited");
  await page.getByTestId("review-comment").nth(1).getByRole("button", { name: "Delete comment" }).click();
  await expect(page.getByTestId("review-comment")).toHaveCount(1);

  // The grade panel lists them; a click shows the line.
  await gradingTab(page).click();
  const panel = page.getByTestId("grade-panel");
  await expect(panel.getByTestId("grade-comments")).toContainText("1 line comment");
  await expect(panel.getByTestId("grade-comment-link")).toContainText("app.js:1");
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save").click();
  await expect(toast(page, "Grade saved: 20/20")).toBeVisible();
  const stored = await ben(page);
  expect(stored?.annotations).toEqual([{ path: "app.js", line: 1, text: "Use const for values that never change." }]);
  await expect(page.getByTestId("graded-by")).toContainText("Graded by Mr Teacher");

  await panel.getByTestId("grade-comment-link").click();
  await expect(page.locator(".tm-tab.is-active", { hasText: "app.js" }).first()).toBeVisible();
});

test("diffs: changed files since the starter, Changes vs Starter and Compare with Version N", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  const changes = page.getByTestId("grade-changes");
  await expect(changes.getByTestId("grade-change")).toHaveCount(2);
  await expect(changes).toContainText("app.js");
  await expect(changes.getByTestId("grade-change").first().locator(".is-modified")).toHaveText("M");

  await changes.getByTestId("grade-change").filter({ hasText: "app.js" }).click();
  await expect(page.locator(".tm-tab", { hasText: "app.js (Starter) ↔ Submitted" })).toBeVisible();
  await expect(page.getByTestId("grading-diff")).toContainText("Starter");
  await expect(page.locator(".monaco-diff-editor").first()).toContainText("TODO: add items");
  await expect(page.locator(".monaco-diff-editor").first()).toContainText("const items");

  // Compare with Version…: the student's other saves (not the submitted one).
  await gradingTab(page).click();
  await page.getByTestId("grade-compare-version").click();
  const picker = page.locator(".tm-quick-pick");
  await expect(picker).toContainText("Version 2");
  await expect(picker).toContainText("Version 1");
  await expect(picker).not.toContainText("Version 3");
  await picker.getByRole("option", { name: /Version 2/ }).click();
  await expect(page.locator(".tm-tab", { hasText: "(Version 2) ↔ Submitted" })).toBeVisible();
  await expect(page.locator(".monaco-diff-editor").first()).toContainText("let x");
});

test("Save Draft keeps the grade from the student; Release N Drafts shows it; quiz toasts say when students see it", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save-draft").click();
  await expect(toast(page, "Draft saved: 20/20. The student doesn't see it until you release it.")).toBeVisible();
  expect((await ben(page))?.released).toBe(false);
  await expect(page.getByTestId("grade-draft-chip")).toBeVisible();
  await expect(page.getByTestId("grade-status")).toHaveText("Draft saved. The student doesn't see it yet.");

  // The roster marks it (still "To grade" for the student); the header releases every draft.
  await page.getByTestId("grade-switcher-toggle").click();
  await page.getByTestId("grade-filter-to-grade").click();
  await expect(page.getByTestId("grade-row").filter({ hasText: "Ben Learner" }).locator(".tm-chip.is-draft")).toHaveText("Draft");
  await page.getByTestId("grade-release-drafts").click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Release" }).click();
  await expect(toast(page, "Released 1 grade.")).toBeVisible();
  expect((await ben(page))?.released).toBe(true);
  await expect(page.getByTestId("grade-release-drafts")).toHaveCount(0);

  // Quiz practicals: held until the quiz results are released.
  await command(page, "View: Show Grading");
  await activity(page, "quiz:78:501").click();
  await page.getByTestId("grade-start").click();
  await page.getByTestId("grade-criterion").nth(0).getByRole("button", { name: "6" }).click();
  await page.getByTestId("grade-criterion").nth(1).getByRole("button", { name: "4" }).click();
  await page.getByTestId("grade-save").click();
  await expect(toast(page, "Grade saved: 10/10. The student sees it when the quiz results are released.")).toBeVisible();
  // No "Return for changes" for quiz practicals.
  await expect(page.getByTestId("grade-return")).toHaveCount(0);
});

test("Return for Changes… sends the work back with a message", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-row").filter({ hasText: "Chloe Coder" }).click();
  await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder");
  await page.getByTestId("grade-return").click();
  await page.getByTestId("grade-return-message").fill("Add a README with how to run it.");
  await page.getByTestId("grade-return-send").click();
  await expect(toast(page, "Returned to Chloe Coder for changes")).toBeVisible();
  const returned = (await mock(page, "m.returnedProjects()")) as { owner: string; message: string }[];
  expect(returned).toEqual([expect.objectContaining({ owner: "Chloe Coder", message: "Add a README with how to run it." })]);
  await expect(page.getByTestId("grade-panel")).toContainText("Working", { timeout: 10_000 });
  await expect(page.getByTestId("grade-return")).toHaveCount(0);
});

test("graded work: Return answers PROJECT_GRADED, and Allow Resubmission takes the grade back", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save").click();
  await expect(toast(page, "Grade saved: 20/20")).toBeVisible();
  await page.getByTestId("grade-return").click();
  await page.getByTestId("grade-return-message").fill("Please add delete buttons.");
  await page.getByTestId("grade-return-send").click();
  await expect(page.getByTestId("grade-return-error")).toContainText("Allow Resubmission takes the grade back");
  await page.getByTestId("grade-allow-resubmission").click();
  await expect(toast(page, "Ben Learner can change their work and submit again")).toBeVisible();
  expect(await ben(page)).toBeNull();
  await expect(page.getByTestId("grade-panel")).toContainText("Working", { timeout: 10_000 });
});

test("a tmcode://grading link opens that practical on that student", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  // A teacher across the reload: the link opens at startup.
  await mock(page, "m.setTeacher(true, { persist: true })");
  await page.goto(`/?grading=${encodeURIComponent("tmcode://grading?type=assignment&id=51&student=22")}`);
  await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder", { timeout: 15_000 });
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
});

test("unsaved grades survive a restart; a failed save shows Retry and marks the student", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-row").filter({ hasText: "Chloe Coder" }).click();
  await page.getByTestId("grade-feedback").fill("Half done, keep going.");
  await expect(page.getByTestId("grade-status")).toHaveText(/Score every criterion/);

  // Quit and reopen: the draft is still there.
  await page.reload();
  await teacher(page, { clear: false });
  await activity(page, "assignment:51:").click();
  const chloe = page.getByTestId("grade-row").filter({ hasText: "Chloe Coder" });
  await expect(chloe.getByTestId("grade-row-unsaved")).toBeVisible();
  await chloe.click();
  await expect(page.getByTestId("grade-feedback")).toHaveValue("Half done, keep going.");

  // Task Mentor fails: an inline error with Retry, and the row says "not saved".
  await mock(page, "m.failGradeSaves(500)");
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save").click();
  const error = page.getByTestId("grade-save-error");
  await expect(error).toContainText("Not saved: Task Mentor had a problem saving the grade.");
  await expect(page.getByTestId("grade-status")).toHaveText("Not saved");
  await expect(chloe.getByTestId("grade-row-unsaved")).toHaveAttribute("aria-label", "Not saved");
  await mock(page, "m.failGradeSaves(null)");
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(toast(page, "Grade saved: 20/20")).toBeVisible();
  await expect(error).toHaveCount(0);
  await expect(page.getByTestId("grade-row-unsaved")).toHaveCount(0);
});

test("two teachers: a grade saved meanwhile is shown, with Use Theirs and Keep Mine and Save", async ({ page }) => {
  await teacher(page);
  await gradeBen(page);
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save").click();
  await expect(toast(page, "Grade saved: 20/20")).toBeVisible();

  // I lower a score; meanwhile another teacher saves 15.
  await page.getByTestId("grade-criterion").nth(1).getByLabel(/Code quality score/).fill("4");
  await mock(page, `m.simulateOtherTeacherGrade("assignment", 51, null, 21, { score: 15, rubric_scores: [{ index: 0, score: 9 }, { index: 1, score: 6 }], feedback: "From Ms Other" })`);
  await page.getByTestId("grade-save").click();
  const conflict = page.getByTestId("grade-conflict");
  await expect(conflict).toContainText("Graded by Ms Other");
  await expect(conflict).toContainText("while you were editing");
  await expect(conflict).toContainText("15/20");
  await conflict.getByRole("button", { name: "Keep Mine and Save" }).click();
  await expect(toast(page, "Grade saved: 16/20")).toBeVisible();
  expect((await ben(page))?.score).toBe(16);
  await expect(conflict).toHaveCount(0);

  // Again, and this time take theirs.
  await page.getByTestId("grade-criterion").nth(1).getByLabel(/Code quality score/).fill("8");
  await mock(page, `m.simulateOtherTeacherGrade("assignment", 51, null, 21, { score: 15, rubric_scores: [{ index: 0, score: 9 }, { index: 1, score: 6 }], feedback: "From Ms Other" })`);
  await page.getByTestId("grade-save").click();
  await expect(conflict).toBeVisible();
  await conflict.getByRole("button", { name: "Use Theirs" }).click();
  await expect(page.getByTestId("grade-feedback")).toHaveValue("From Ms Other");
  await expect(page.getByTestId("grade-total")).toContainText("15");
  await expect(page.getByTestId("graded-by")).toContainText("Graded by Ms Other");
});

test("keyboard: ⌥↓/⌥↑ change student, ⌘Enter saves and moves on, roster arrows move focus and Enter loads", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-filter-all").click();
  // Arrows move the focus only; Enter selects.
  const rows = page.getByTestId("grade-row");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(page.getByTestId("grade-panel")).toHaveCount(0);
  await expect(rows.nth(1)).toHaveAttribute("role", "option");
  await page.keyboard.press("Enter");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  const second = (await rows.nth(1).locator(".tm-project-name").textContent())!;
  await expect(page.getByTestId("grade-panel")).toContainText(second);

  // ⌥↓ / ⌥↑ while the grading tab is active.
  await page.getByTestId("grade-panel").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt+ArrowUp");
  const first = (await rows.nth(0).locator(".tm-project-name").textContent())!;
  await expect(page.getByTestId("grade-panel")).toContainText(first);
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.getByTestId("grade-panel")).toContainText(second);

  // ⌘Enter from anywhere in the tab: Save & Next (Ben first). Beside the code the roster is folded.
  await page.getByTestId("grade-switcher-toggle").click();
  await page.getByTestId("grade-filter-to-grade").click();
  await page.getByTestId("grade-row").filter({ hasText: "Ben Learner" }).click();
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-shortcuts-toggle").click();
  await expect(page.getByTestId("grade-shortcuts")).toContainText("Save & Next");
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(toast(page, "Grade saved: 20/20")).toBeVisible();
  await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder", { timeout: 15_000 });
  // Grading: Focus Grade Panel.
  await command(page, "Grading: Focus Grade Panel");
  await expect(page.getByTestId("grade-panel").locator(":focus")).toHaveCount(1);
});

test("scores: quick chips like the web with aria-pressed, typed values are clamped with a warning", async ({ page }) => {
  await teacher(page);
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-row").filter({ hasText: "Ben Learner" }).click();
  const first = page.getByTestId("grade-criterion").nth(0);
  await expect(first.locator(".tm-grade-quick button")).toHaveText(["0", "3", "6", "9", "12"]);
  await first.getByRole("button", { name: "9" }).click();
  await expect(first.getByRole("button", { name: "9" })).toHaveAttribute("aria-pressed", "true");
  await expect(first.getByRole("button", { name: "12" })).toHaveAttribute("aria-pressed", "false");
  await first.getByLabel(/Adding items works score/).fill("15");
  await expect(first.getByLabel(/Adding items works score/)).toHaveValue("12");
  await expect(first.getByTestId("grade-clamped")).toContainText("Scores go from 0 to 12");
  // The rubric adds up to the points here: no warning.
  await expect(page.getByTestId("grade-points-mismatch")).toHaveCount(0);
  // Labelled controls and an announced status.
  await expect(page.getByLabel("Feedback")).toBeVisible();
  await expect(page.getByTestId("grade-status")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("grade-preview")).toBeVisible();
});

test("an older Task Mentor (no draft grades): Save Draft goes away once a grade shows it", async ({ page }) => {
  await teacher(page);
  await mock(page, "m.setGradingReview(false)");
  await activity(page, "assignment:51:").click();
  await page.getByTestId("grade-row").filter({ hasText: "Ben Learner" }).click();
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save").click();
  await expect(toast(page, "Grade saved: 20/20")).toBeVisible();
  await expect(page.getByTestId("grade-save-draft")).toHaveCount(0);
  await expect(page.getByTestId("graded-by")).toHaveCount(0);
});
