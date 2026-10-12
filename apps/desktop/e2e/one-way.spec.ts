import { expect, test, type Page } from "@playwright/test";
import { command, gradeMoreAction, launch, mock, saveGradeAs, toast, visibleDoors } from "./journeys";

/**
 * 0.16 "One way to do it" (docs/plans/2026-10-12-workflow-ux-implementation-plan.md §6):
 * one primary action per screen, sign-in that carries on, quiz practicals with a brief,
 * grading that opens the first student, one grade panel button, plain words.
 */

const row = (page: Page, id: number) => page.locator(`[data-testid="assignment-row"][data-assignment-id="${id}"]`);

async function startPractical(page: Page) {
  await command(page, "View: Show Assignments");
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
}

test.describe("students: one door per step", () => {
  test("the side bar is one status line; Save and Submit live on the brief only", async ({ page }) => {
    await launch(page);
    await startPractical(page);
    await command(page, "View: Show Assignments");
    const line = page.getByTestId("this-folder-line");
    await expect(line).toBeVisible();
    await expect(line).toContainText("In progress");
    await expect(line).toContainText(/Saved online|Not saved|Saving/);
    // Guided plan C: saving is automatic, so the only door is Submit.
    expect(await visibleDoors(page)).toEqual({ submit: 1, save: 0 });
    // The live-status switch is in the line's "…" menu, locked on for an open assignment.
    await line.getByRole("button", { name: "More Project Actions…" }).click();
    await expect(page.locator(".tm-menu-item", { hasText: "Share Live Status with Teachers: On" })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    // The steps moved to the brief.
    await expect(page.getByTestId("assignment-steps")).toBeVisible();
    await line.getByTestId("project-assessment").click();
    await expect(page.locator(".tm-tab.is-active", { hasText: "Build a to-do list" })).toBeVisible();
  });

  test("on a 680 px tall window, six or more assignment rows show beside an open workspace", async ({ page }) => {
    await page.setViewportSize({ width: 1360, height: 680 });
    await launch(page);
    await mock(page, `(() => { for (let i = 1; i <= 6; i++) m.addAssignment({ title: "Practical " + i }); })()`);
    await startPractical(page);
    await command(page, "Assignments: Refresh Assignments");
    await command(page, "View: Show Assignments");
    await expect(page.locator('[data-testid="assignment-row"]')).toHaveCount(8, { timeout: 10_000 });
    const inView = await page.locator('[data-testid="assignment-row"]').evaluateAll((els) => els.filter((e) => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight - 22;
    }).length);
    expect(inView).toBeGreaterThanOrEqual(6);
  });

  test("a quiz practical goes row → brief → start → submit without leaving Assignments", async ({ page }) => {
    await launch(page);
    await command(page, "View: Show Assignments");
    const quizRow = page.getByTestId("quiz-practical-row");
    await quizRow.click();
    const brief = page.getByTestId("assignment-page");
    await expect(brief).toHaveAttribute("data-source", "quiz");
    await expect(page.getByTestId("assignment-next-step")).toHaveAttribute("data-status", "not_started");
    await page.getByTestId("assignment-start").click();
    await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("assignments-view")).toBeVisible();
    await page.getByTestId("assignment-submit").click();
    await page.locator("[data-dialog-button=submit]").click();
    await expect(page.getByTestId("assignment-next-step")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
    await expect(page.getByTestId("assignments-view")).toBeVisible();
  });

  test("until the quiz attempt is open, opening the quiz is the first step", async ({ page }) => {
    await launch(page);
    await mock(page, `m.setQuizPractical(78, { attempt_open: false })`);
    await command(page, "Assignments: Refresh Assignments");
    await command(page, "View: Show Assignments");
    await page.getByTestId("quiz-practical-row").click();
    await expect(page.getByTestId("quiz-step")).toContainText("First, open the quiz in Task Mentor");
    await expect(page.getByTestId("quiz-open-attempt")).toHaveClass(/tm-button--large/);
    await expect(page.getByTestId("assignment-start")).toHaveClass(/tm-button--secondary/);
  });

  test("an action started signed out carries on after the sign-in", async ({ page }) => {
    await launch(page, { signedIn: false });
    await command(page, "Projects: New Project…");
    // Sign-in messages replace each other (one owner, guided plan A); the action carries on.
    await expect(toast(page, /Signed in/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".tm-quick-pick")).toBeVisible();
  });
});

test.describe("teachers: grading", () => {
  test("opening a practical opens its first waiting student; the Feedback box fits without scrolling", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Grading");
    await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
    const panel = page.getByTestId("grade-panel");
    await expect(panel).toContainText("Chloe Coder", { timeout: 15_000 });
    await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
    // Progress once, in the header (L4); the side bar's summary goes while the tab is open.
    await expect(page.getByTestId("grading-progress")).toContainText("2 to grade");
    await expect(page.getByTestId("grading-summary")).toHaveCount(0);
    // L3: at 1360×820 the Feedback box is on screen for a rubric of 3 or fewer criteria.
    await expect(page.getByTestId("grade-feedback")).toBeInViewport();
    // One primary button; Return, Preview and Shortcuts are in More Actions.
    await expect(page.getByTestId("grade-return")).toHaveCount(0);
    await gradeMoreAction(page, "Shortcuts");
    await expect(page.getByTestId("grade-shortcuts")).toBeVisible();
  });

  test("the inline hint is on the first criterion without a score; ⌘Enter is Save & Next", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Grading");
    await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
    await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder", { timeout: 15_000 });
    await page.getByTestId("grade-criterion").first().getByRole("button").first().click();
    await expect(page.getByTestId("grade-criterion").nth(1)).toHaveClass(/is-missing/);
    await expect(page.getByTestId("grade-missing")).toContainText("Score this criterion to save");
    await page.getByTestId("grade-full-marks").click();
    await expect(page.getByTestId("grade-missing")).toHaveCount(0);
    await page.getByTestId("grade-feedback").click();
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("grade-panel")).toContainText("Ben Learner", { timeout: 10_000 });
    // T9: no toast over the Feedback box; the next student's footer says what was saved.
    await expect(page.locator(".tm-grade-footer")).toContainText("Saved Chloe Coder: 20/20");
    await expect(toast(page, "Grade saved")).toHaveCount(0);
  });

  test("the split button remembers the teacher's last choice", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Grading");
    await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
    await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder", { timeout: 15_000 });
    await page.getByTestId("grade-full-marks").click();
    await saveGradeAs(page, "draft");
    await expect(page.getByTestId("grade-status")).toContainText("Draft saved: 20/20", { timeout: 10_000 });
    // The main part is now Save Draft, for the next student too.
    await expect(page.getByTestId("grade-save-draft")).toBeVisible();
    await expect(page.getByTestId("grade-save-next")).toHaveCount(0);
  });
});
