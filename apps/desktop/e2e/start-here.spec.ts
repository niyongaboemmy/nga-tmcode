import { expect, test, type Page } from "@playwright/test";
import { clicksTo, command, launch, mock, toast } from "./journeys";

/**
 * 0.15 "Start here" (docs/plans/2026-10-12-workflow-ux-implementation-plan.md §5):
 * Home on every start, the role remembered, one status, notifications that
 * stay, the silent events told, and the rename bug. Memory account + mock
 * Task Mentor: practical 51 (due in 2 days), case study 52 (overdue).
 */

const home = (page: Page) => page.getByTestId("home-page");
const activityLabels = (page: Page) => page.locator(".tm-activitybar-top .tm-activity").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));

test.describe("Home", () => {
  test("a returning student sees Home in front and starts the next assignment in one click", async ({ page }) => {
    await launch(page);
    await expect(home(page)).toBeVisible();
    await expect(page.locator(".tm-tab.is-active")).toContainText("Home");
    // Next up: the overdue case study first, then the counters.
    await expect(page.getByTestId("home-next-title")).toHaveText("Library case study", { timeout: 10_000 });
    await expect(page.getByTestId("home-next-status")).toHaveAttribute("data-status", "not_started");
    await expect(page.getByTestId("home-count-todo")).toContainText("2 To do");
    await page.getByTestId("home-next-action").click();
    // No starter files: TMCode offers templates (the workspace is already open).
    await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Start with an empty project" }).click();
    await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
    expect(await clicksTo(page, "first-start")).toBe(1);
  });

  test("the first run starts the side bar on Assignments, and the counters open a group", async ({ page }) => {
    await launch(page);
    await expect(page.getByTestId("assignments-view")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("home-count-todo").click();
    await expect(page.getByTestId("assignments-group")).toContainText("To do");
    await expect(page.locator('[data-testid="assignment-row"]')).toHaveCount(2);
    await page.getByTestId("assignments-group-clear").click();
    await expect(page.getByTestId("assignments-group")).toHaveCount(0);
  });

  test("signed out: one card to sign in", async ({ page }) => {
    await launch(page, { signedIn: false });
    await expect(page.getByTestId("home-signin-card")).toBeVisible();
    await page.getByTestId("welcome-signin").click();
    await expect(page.getByTestId("home-next-up")).toBeVisible({ timeout: 10_000 });
  });

  test("a teacher reaches grading in one click", async ({ page }) => {
    await launch(page, { teacher: true });
    await expect(home(page)).toHaveAttribute("data-role", "teacher", { timeout: 10_000 });
    await expect(page.getByTestId("home-to-grade-summary")).toContainText(/submissions? to grade/, { timeout: 10_000 });
    await expect(page.getByTestId("home-practical").first()).toBeVisible();
    await page.getByTestId("home-start-grading").click();
    await expect(page.getByTestId("grading-view")).toBeVisible();
  });

  test('"none" keeps the folder\'s tabs as they were, without Home', async ({ page }) => {
    await launch(page, { storage: { "tmcode:ui": JSON.stringify({ settings: { "workbench.startupEditor": "none" } }) } });
    await expect(page.locator(".tm-explorer [data-path='main.py']")).toBeVisible();
    await expect(page.locator(".tm-tab", { hasText: "Home" })).toHaveCount(0);
  });

  test("the Explorer with no folder points to Assignments", async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.clear();
    });
    await page.goto("/?empty=1");
    await command(page, "View: Show Explorer");
    await page.getByTestId("explorer-open-assignments").click();
    await expect(page.getByTestId("assignments-signed-out")).toBeVisible();
  });
});

test.describe("role", () => {
  test("a remembered teacher sees Grading on the first frame; the network corrects a wrong memory", async ({ page }) => {
    // This account is a student; the last launch remembered "teacher"; Task Mentor answers slowly.
    await launch(page, { storage: { "tmcode:role.7": JSON.stringify("teacher"), "tmcode:mock-latency": "1500" } });
    await expect(page.locator('.tm-activity[aria-label^="Grading"]')).toBeVisible();
    // Never the student "All My Projects" while it's a teacher layout.
    expect((await activityLabels(page)).some((l) => l.startsWith("All My Projects"))).toBe(false);
    await expect(toast(page, "Your layout changed to student.")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.tm-activity[aria-label^="Grading"]')).toHaveCount(0);
    await expect(page.locator('.tm-activity[aria-label^="All My Projects"]')).toBeVisible();
  });

  test("first sign-in: a teacher lands on Grading, and the account menu has Grading", async ({ page }) => {
    await launch(page, { signedIn: false, teacher: true });
    await page.getByTestId("welcome-signin").click();
    await expect(page.getByTestId("grading-view")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("account-button").click();
    await expect(page.locator(".tm-menu-item", { hasText: "Grading" })).toBeVisible();
  });
});

test.describe("notifications", () => {
  test("an important result stays past 10 s; hovering pauses an ordinary one", async ({ page }) => {
    test.setTimeout(60_000);
    await launch(page);
    await command(page, "View: Show Assignments");
    await page.locator('[data-testid="assignment-row"][data-assignment-id="51"]').getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
    // The workspace-ready toast is a result (8 s): hovering keeps it.
    const ready = toast(page, "is ready");
    await expect(ready).toBeVisible();
    await ready.hover();
    await page.waitForTimeout(9_000);
    await expect(ready).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(ready).toHaveCount(0, { timeout: 10_000 });

    await page.getByTestId("assignment-submit").click();
    await page.locator("[data-dialog-button=submit]").click();
    const submitted = toast(page, /Submitted "Build a to-do list"/);
    await expect(submitted).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(10_500);
    await expect(submitted).toBeVisible();
  });

  test("work returned for changes is announced, unread in the bell, even in Do Not Disturb", async ({ page }) => {
    await launch(page, { storage: { "tmcode:notifications.doNotDisturb": "true" } });
    await command(page, "View: Show Assignments");
    await page.locator('[data-testid="assignment-row"][data-assignment-id="51"]').getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("assignment-submit").click();
    await page.locator("[data-dialog-button=submit]").click();
    await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
    await mock(page, `m.returnForChanges(51, "Add a delete button to each item.")`);
    await page.getByTestId("assignments-refresh").click();
    const notice = toast(page, /Your teacher returned "Build a to-do list": "Add a delete button/);
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("notifications-unread")).toHaveText("1");
    await notice.getByRole("button", { name: "Open" }).click();
    await expect(page.getByTestId("notifications-unread")).toHaveCount(0);
  });
});

test.describe("one status (W4)", () => {
  test("returned and graded read the same everywhere: header, card, row and status bar", async ({ page }) => {
    await launch(page);
    await command(page, "View: Show Assignments");
    const row = page.locator('[data-testid="assignment-row"][data-assignment-id="51"]');
    await row.getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("assignment-submit").click();
    await page.locator("[data-dialog-button=submit]").click();
    await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });

    const everywhere = async (status: string) => {
      await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", status, { timeout: 15_000 });
      await expect(page.getByTestId("assignment-next-step")).toHaveAttribute("data-status", status);
      await expect(row).toHaveAttribute("data-status", status);
      await expect(page.getByTestId("project-student-status")).toHaveAttribute("data-status", status);
      await expect(page.getByTestId("assignment-updating")).toHaveCount(0, { timeout: 15_000 });
    };
    await mock(page, `m.returnForChanges(51, "Add a delete button.")`);
    await page.getByTestId("assignments-refresh").click();
    await everywhere("returned");
    await expect(page.getByTestId("assignment-submit")).toHaveText(/Submit Again/);

    await page.getByTestId("assignment-submit").click();
    await page.locator("[data-dialog-button=submit]").click();
    await everywhere("submitted");
    await mock(page, `m.grade(51, 17, "Good work.")`);
    await page.getByTestId("assignments-refresh").click();
    await everywhere("graded");
    // L8: the result is the card at the top.
    await expect(page.getByTestId("assignment-next-step").getByTestId("assignment-result")).toContainText("17");
  });
});

test.describe("silent events (N2) and rename (N9)", () => {
  test("Move to Trash says so, with Undo", async ({ page }) => {
    await launch(page, { signedIn: false });
    await command(page, "View: Show Explorer");
    await page.locator('.tm-explorer [data-path="README.md"]').click();
    await page.keyboard.press("Delete");
    await page.locator("[data-dialog-button=trash], [data-dialog-button=delete]").first().click();
    await expect(page.locator('.tm-explorer [data-path="README.md"]')).toHaveCount(0);
    const t = toast(page, /README\.md/);
    await expect(t).toBeVisible();
    await t.getByTestId("toast-undo").click();
    await expect(page.locator('.tm-explorer [data-path="README.md"]')).toBeVisible();
  });

  test("a rename to a taken name keeps the box open with the error", async ({ page }) => {
    await launch(page, { signedIn: false });
    await command(page, "View: Show Explorer");
    await page.locator('.tm-explorer [data-path="README.md"]').click();
    await page.keyboard.press("F2");
    const input = page.locator(".tm-explorer-edit input");
    await input.fill("main.py");
    await page.keyboard.press("Enter");
    await expect(page.locator(".tm-explorer-edit")).toBeVisible();
    await expect(page.locator(".tm-explorer-edit")).toContainText(/already exists/i);
  });
});
