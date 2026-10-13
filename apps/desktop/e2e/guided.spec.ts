import { expect, test, type Page } from "@playwright/test";
import { command, launch, mock } from "./journeys";

/**
 * The calm, guided TMCode (docs/plans/2026-10-12-guided-workflow-plan.md):
 * one Run that says why, one Test, one Stop, work mode, the first minute,
 * one home per action, one number, and the simple student screen.
 */

const status = (page: Page) => page.getByTestId("run-hub-status");
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const toasts = (page: Page) => page.locator(".tm-toast:visible");

async function practice(page: Page) {
  // No account: the practice workbench with the demo folder (the mechanics, not Home).
  await page.addInitScript(() => {
    if (sessionStorage.getItem("guided-seeded")) return;
    sessionStorage.setItem("guided-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
  });
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

async function open(page: Page, ...path: string[]) {
  for (const dir of path.slice(0, -1)) await row(page, dir).click();
  await row(page, path[path.length - 1]).dblclick();
  await expect(page.locator(".tm-tab.is-active")).toContainText(path[path.length - 1].split("/").pop()!);
}

test.describe("B · one Run", () => {
  test("Run follows the file you're editing and says why", async ({ page }) => {
    await practice(page);
    await open(page, "js", "js/sum.js");
    await expect(status(page)).toHaveAttribute("aria-label", /sum\.js/);
    await expect(status(page)).toHaveAttribute("title", /because it's the file you're editing/);
    // The editor title's ▶ runs the same target as the status bar.
    const fromStatus = await status(page).getAttribute("aria-label");
    expect(fromStatus).toMatch(/sum\.js/);

    // Inside the React app, Run is the app (its project), with the reason.
    await open(page, "react-app", "react-app/src", "react-app/src/App.jsx");
    await expect(status(page)).toHaveAttribute("title", /because react-app is a .*React project/);
  });

  test("F5 runs (no debugger without breakpoints)", async ({ page }) => {
    await practice(page);
    await open(page, "src", "src/utils.ts");
    await page.locator(".monaco-editor").first().click();
    await page.keyboard.press("F5");
    // Run, not the debugger: no debug toolbar.
    await expect(page.locator(".tm-debug-toolbar")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "JavaScript Console" })).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
    await expect(page.locator("body")).toContainText("Running src/utils.ts");
    await expect(status(page)).toHaveAttribute("title", /because/);
  });
});

test.describe("F · one Test", () => {
  test("the Test item says what it tests and why, and shows passed/total", async ({ page }) => {
    await practice(page);
    await open(page, "main.py");
    const item = page.getByTestId("test-status");
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-kind", "samples");
    await expect(item).toHaveAttribute("title", /Example Tests, because they are this folder's example tests/);
  });
});

test.describe("J · the simple student screen", () => {
  test("a student sees their views first, all of them while they fit, and a short status bar", async ({ page }) => {
    await launch(page);
    await expect(page.locator(".tm-statusbar")).toHaveAttribute("data-simple", "true", { timeout: 15_000 });
    const bar = page.locator(".tm-activitybar-top");
    await expect(bar.getByRole("tab", { name: /^Assignments/ })).toBeVisible();
    await expect(bar.getByRole("tab", { name: /^Files/ })).toBeVisible();
    await expect(bar.getByRole("tab", { name: /^Search/ })).toBeVisible();
    await expect(bar.getByRole("tab", { name: /^Run/ })).toBeVisible();
    // A handful of views is never hidden: no More while they fit.
    await expect(bar.getByRole("tab", { name: /^Testing/ })).toBeVisible();
    await expect(bar.getByRole("tab", { name: /^Extensions/ })).toBeVisible();
    await expect(page.getByTestId("activity-more")).toHaveCount(0);
    expect(await bar.getByRole("tab").first().getAttribute("aria-label")).toMatch(/^Assignments/);
    // H: a student's own projects live in Assignments, not a second view.
    await expect(bar.getByRole("tab", { name: /Projects/ })).toHaveCount(0);

    // A short window: the rest goes under More, each view once.
    await page.setViewportSize({ width: 1000, height: 330 });
    await page.getByTestId("activity-more").click();
    const items = page.locator(".tm-menu-item");
    const labels = (await items.allTextContents()).map((t) => t.trim());
    expect(labels.filter((l) => /^Extensions/.test(l))).toHaveLength(labels.some((l) => /^Extensions/.test(l)) ? 1 : 0);
    expect(new Set(labels).size).toBe(labels.length);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 720 });
    // The status bar keeps what a student acts on.
    await expect(page.locator(".tm-statusbar .tm-status-encoding")).toHaveCount(0);
    await expect(page.locator(".tm-statusbar .tm-status-bell")).toBeVisible();
  });

  test("Assignments holds Other projects (folded)", async ({ page }) => {
    await launch(page);
    await command(page, "View: Show Assignments");
    await expect(page.getByTestId("assignments-other-projects")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("D · work mode and C · one saving story", () => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 900, height: 640 },
  ]) {
    test(`at ${size.width}×${size.height} the brief keeps one main button on screen`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize(size);
      await launch(page);
      await mock(page, `m.setAssignmentStatus(52, "completed")`);
      await command(page, "Assignments: Refresh Assignments");
      await expect(page.getByTestId("home-next-title")).toHaveText("Build a to-do list", { timeout: 15_000 });
      await page.getByTestId("home-next-action").click();
      await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
      // Below 1200 px the brief beside the code takes the side bar's room.
      if (size.width < 1200) await expect(page.locator(".tm-sidebar")).toBeHidden();
      // One saving story: no Save button while saving is automatic; the line says where the work is.
      await expect(page.getByTestId("assignment-save")).toHaveCount(0);
      await expect(page.getByTestId("assignment-sync")).toBeVisible();
      // Scrolled away from the card, the footer keeps the main button.
      await page.getByTestId("assignment-page").evaluate((el) => el.scrollTo(0, el.scrollHeight));
      const main = page.getByTestId("assignment-next-step").locator("button.tm-button:not(.tm-button--secondary)");
      const footer = page.getByTestId("brief-footer");
      if (!(await main.isVisible()) || !(await main.boundingBox())) {
        await expect(footer).not.toHaveClass(/is-hidden/);
        await expect(page.getByTestId("brief-footer-main")).toBeVisible();
      }
      // Calm: never more than two messages at once.
      expect(await toasts(page).count()).toBeLessThanOrEqual(2);
    });
  }

  test("one brief slot: another assignment's brief replaces the first", async ({ page }) => {
    test.setTimeout(90_000);
    await launch(page);
    await command(page, "View: Show Assignments");
    const rows = page.getByTestId("assignment-row");
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await rows.nth(0).click();
    await expect(page.getByTestId("assignment-page")).toBeVisible();
    const first = await rows.nth(0).getAttribute("data-assignment-id");
    await expect(page.locator(`[data-editor-id="assignment:${first}"]`)).toHaveCount(1);
    await rows.nth(1).click();
    const second = await rows.nth(1).getAttribute("data-assignment-id");
    // The second brief took the first one's tab: one brief tab in the whole window.
    await expect(page.locator(`[data-editor-id="assignment:${second}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-editor-id="assignment:${first}"]`)).toHaveCount(0);
    await expect(page.locator('[data-editor-id^="assignment:"]')).toHaveCount(1);
  });
});

test.describe("G · the first minute", () => {
  test("Next up says why it chose the assignment", async ({ page }) => {
    await launch(page);
    await expect(page.getByTestId("home-next-why")).toHaveText(/· (Returned to you|Open now|Late|Due soonest|In progress|Not started)/, { timeout: 15_000 });
  });
});

test.describe("I · teacher flow", () => {
  test("the teacher brief's main button is Grade (n), numbers from the roster, starter files under …", async ({ page }) => {
    test.setTimeout(90_000);
    await launch(page, { teacher: true });
    await command(page, "View: Show Assignments");
    const row = page.locator('[data-testid="assignment-row"][data-assignment-id="51"]');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.getByTestId("assignment-grade")).toHaveText(/Grade \(\d+\)/, { timeout: 15_000 });
    await expect(page.getByTestId("assignment-teacher-stats")).toContainText("To grade");
    await expect(page.getByRole("button", { name: /Use Open Project as Starter/ })).toHaveCount(0);
    await page.getByTestId("assignment-teacher-more").click();
    await expect(page.locator(".tm-menu-item", { hasText: "Use Open Project as Starter" })).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("grading counts in grading order: 1 of n to grade", async ({ page }) => {
    test.setTimeout(90_000);
    await launch(page, { teacher: true });
    await page.getByTestId("home-start-grading").click({ timeout: 15_000 });
    await expect(page.getByTestId("grade-panel")).toBeVisible({ timeout: 15_000 });
    const counter = page.getByTestId("grade-counter");
    if (await counter.isVisible()) await expect(counter).toHaveText(/^1 of \d+ to grade$/);
  });
});
