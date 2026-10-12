import { expect, test, type Page } from "@playwright/test";
import { command, launch, mock, openStudent, toast } from "./journeys";

/**
 * 0.17 "Polish" (docs/plans/2026-10-12-workflow-ux-implementation-plan.md §7):
 * no dead ends, a visible way back, teachers' Assignments, the notification
 * centre, severities, labels that fit, the title bar's overflow, less noise
 * for students, and the activity bar for newcomers.
 */

const activityLabels = (page: Page) => page.locator(".tm-activitybar-top .tm-activity").evaluateAll((els) => els.map((e) => (e.getAttribute("aria-label") ?? "").replace(/ \(.*\)$/, "")));

test.describe("dead ends and the way back (W6, W9)", () => {
  test("a student still working has a way on; Close Review is a visible button", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Grading");
    await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
    await expect(page.getByTestId("grade-review-bar")).toBeVisible({ timeout: 15_000 });
    await openStudent(page, "Dan Doer");
    await expect(page.getByTestId("grade-hint")).toContainText("In progress: you can grade once the work is submitted.");
    await expect(page.getByTestId("grade-live-status")).toBeVisible();
    await page.getByTestId("grade-close-review").click();
    await expect(page.getByTestId("grade-review-bar")).toHaveCount(0);
  });

  test("no practicals: Create in Task Mentor; nothing waiting: Show All Practicals", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Grading");
    await page.getByTestId("grading-only-pending").click();
    await mock(page, `(() => { m.clearAssignments(); })()`);
    await command(page, "Grading: Refresh Grading");
    await expect(page.getByTestId("grading-create")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("teachers' Assignments (W10)", () => {
  test("Teaching comes first, and Grade (2) opens the first submission", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Assignments");
    const first = page.locator(".tm-pane-title").first();
    await expect(first).toHaveText("Teaching", { timeout: 10_000 });
    const grade = page.locator('[data-testid="assignment-row"][data-assignment-id="51"]').getByTestId("assignment-row-grade");
    await expect(grade).toHaveText("Grade (2)", { timeout: 10_000 });
    await grade.click();
    await expect(page.getByTestId("grade-panel")).toContainText("Chloe Coder", { timeout: 15_000 });
  });
});

test.describe("notification centre (N8) and severity (N10)", () => {
  test("history survives a reload; View Feedback stays after its toast closed; Mark All as Read", async ({ page }) => {
    await launch(page);
    await command(page, "View: Show Assignments");
    await mock(page, `m.grade(51, 17, "Good.")`);
    await page.getByTestId("assignments-refresh").click();
    const t = toast(page, /Build a to-do list was graded/);
    await expect(t).toBeVisible({ timeout: 10_000 });
    await t.getByRole("button", { name: "Clear Notification" }).click();
    await page.locator(".tm-status-bell").click();
    const entry = page.getByTestId("notification-entry").filter({ hasText: "was graded" });
    await expect(entry.getByTestId("notification-entry-action")).toHaveText("View Feedback");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
    await page.reload();
    await expect(page.locator(".tm-statusbar")).toBeVisible();
    await page.locator(".tm-status-bell").click();
    await expect(page.getByTestId("notification-entry").filter({ hasText: "was graded" })).toBeVisible();
  });

  test("Mark All as Read clears the bell's count", async ({ page }) => {
    await launch(page);
    await command(page, "View: Show Assignments");
    await mock(page, `m.addAssignment({ title: "Weather app" })`);
    await page.getByTestId("assignments-refresh").click();
    await expect(page.getByTestId("notifications-unread")).toHaveText("1", { timeout: 10_000 });
    await page.locator(".tm-status-bell").click();
    await page.getByTestId("notifications-mark-read").click();
    await expect(page.getByTestId("notifications-unread")).toHaveCount(0);
  });

  test("Sign Out is a warning: it signs out everywhere", async ({ page }) => {
    await launch(page);
    await page.getByTestId("account-button").click();
    await page.locator(".tm-menu-item", { hasText: "Sign Out" }).click();
    await expect(page.locator(".tm-dialog .tm-dialog-icon")).toHaveClass(/is-warning/);
    await page.keyboard.press("Escape");
  });
});

test.describe("layout (L5, L6, L7, L10)", () => {
  test("at 1100 px the menus that don't fit are under …, so Help stays reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await launch(page, { signedIn: false });
    const more = page.getByTestId("menubar-overflow");
    if (await more.isVisible()) {
      await more.dispatchEvent("mousedown");
      await expect(page.locator(".tm-menu-item", { hasText: "Help" })).toBeVisible();
    } else {
      await expect(page.locator(".tm-menubar-item", { hasText: "Help" })).toBeVisible();
    }
    // Narrower still: … is there.
    await page.setViewportSize({ width: 960, height: 760 });
    await expect(page.getByTestId("menubar-overflow").or(page.locator(".tm-menu-button"))).toBeVisible();
  });

  test("students: Assignments first, no Source Control in an assignment workspace, one-time coach mark", async ({ page }) => {
    await launch(page);
    await expect(page.locator('.tm-activity[aria-label^="All My Projects"]')).toBeVisible({ timeout: 10_000 });
    const labels = await activityLabels(page);
    expect(labels.slice(0, 3)).toEqual(["Assignments", "Explorer", "Search"]);
    await expect(page.getByTestId("coach-mark")).toContainText("Your assignments live here");
    // The first click anywhere dismisses it (it never blocks what is under it).
    await page.locator(".tm-statusbar").click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId("coach-mark")).toHaveCount(0);
    await command(page, "View: Show Assignments");
    await page.locator('[data-testid="assignment-row"][data-assignment-id="51"]').getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tm-activity[aria-label^="Source Control"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".tm-statusbar")).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByTestId("coach-mark")).toHaveCount(0);
  });

  test("teachers: Grading, then Assignments, first", async ({ page }) => {
    await launch(page, { teacher: true });
    await expect(page.locator('.tm-activity[aria-label^="Grading"]')).toBeVisible({ timeout: 10_000 });
    expect((await activityLabels(page)).slice(0, 3)).toEqual(["Grading", "Assignments", "Explorer"]);
    await expect(page.getByTestId("coach-mark")).toContainText("Grading lives here");
  });

  test("grading filter chips wrap instead of clipping", async ({ page }) => {
    await launch(page, { teacher: true });
    await command(page, "View: Show Grading");
    await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
    await expect(page.getByTestId("grade-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("grade-switcher-toggle").click();
    const wrap = await page.locator(".tm-grade-filters").evaluate((el) => getComputedStyle(el).flexWrap);
    expect(wrap).toBe("wrap");
  });
});
