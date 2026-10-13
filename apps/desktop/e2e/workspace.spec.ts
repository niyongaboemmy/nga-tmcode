import { expect, test, type Page } from "@playwright/test";
import { command, launch, mock } from "./journeys";

/**
 * Workspace fixes (2026-10-13): the brief's footer pinned to the tab's edge, Sync Now, moving files
 * by dragging, Paste showing its result, an open file coming to the front, and the preview's device
 * frames and Full Screen.
 */

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const mod = process.platform === "darwin" ? "Meta" : "Control";

async function practice(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("ws-seeded")) return;
    sessionStorage.setItem("ws-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
  });
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

async function startAssignment(page: Page) {
  await launch(page);
  await mock(page, `m.setAssignmentStatus(52, "completed")`);
  await command(page, "Assignments: Refresh Assignments");
  await expect(page.getByTestId("home-next-title")).toHaveText("Build a to-do list", { timeout: 15_000 });
  await page.getByTestId("home-next-action").click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
}

test("the brief's footer sits on the tab's bottom edge, full width, and the brief offers Sync Now", async ({ page }) => {
  test.setTimeout(90_000);
  // A short window: the next-step card scrolls out of sight, so the footer takes over.
  await page.setViewportSize({ width: 1280, height: 520 });
  await startAssignment(page);
  await expect(page.getByTestId("assignment-sync-now")).toBeVisible();
  await page.getByTestId("assignment-page").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const footer = page.getByTestId("brief-footer");
  await expect(footer).not.toHaveClass(/is-hidden/);
  const shell = (await page.locator(".tm-assignment-shell").boundingBox())!;
  // Pinned (once it has slid in): the footer's bottom is the tab's bottom, and it spans the tab.
  await expect.poll(async () => {
    const f = (await footer.boundingBox())!;
    return Math.round(Math.abs(f.y + f.height - (shell.y + shell.height)));
  }).toBeLessThan(2);
  expect(Math.abs((await footer.boundingBox())!.width - shell.width)).toBeLessThan(2);
});

test("a file dragged onto a folder moves there (pointer drag)", async ({ page }) => {
  await practice(page);
  await row(page, "web").click();
  await expect(row(page, "web/style.css")).toBeVisible();
  await row(page, "web/style.css").dragTo(row(page, "js"));
  await expect(row(page, "js/style.css")).toBeVisible({ timeout: 10_000 });
  await expect(row(page, "web/style.css")).toHaveCount(0);
});

test("Paste into a closed folder opens it and says what it did", async ({ page }) => {
  await practice(page);
  await row(page, "main.py").click();
  await page.keyboard.press(`${mod}+c`);
  await row(page, "py").click();
  await row(page, "py").click(); // closed again, still selected
  await expect(row(page, "py/stats.py")).toHaveCount(0);
  await page.keyboard.press(`${mod}+v`);
  await expect(row(page, "py/main.py")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".tm-toast", { hasText: 'Copied "main.py" to py.' })).toBeVisible();
});

test("with the brief focused, clicking an open file brings its tab to the front in the code's group", async ({ page }) => {
  test.setTimeout(90_000);
  await startAssignment(page);
  await page.locator('.tm-activitybar [data-view="explorer"]').click();
  await row(page, "index.html").dblclick();
  await row(page, "app.js").dblclick();
  const groups = page.locator(".tm-editor-group");
  const code = groups.filter({ has: page.locator('[role=tab][data-editor-id="app.js"]') });
  const briefGroup = groups.filter({ has: page.locator('[role=tab][data-editor-id^="assignment:"]') });
  await expect(code.locator('[role=tab].is-active[data-editor-id="app.js"]')).toBeVisible();
  // Focus the brief, then click index.html (open, but behind app.js).
  await briefGroup.locator('[role=tab][data-editor-id^="assignment:"]').click();
  await row(page, "index.html").click();
  await expect(code.locator('[role=tab].is-active[data-editor-id="index.html"]')).toBeVisible();
  await expect(briefGroup.locator('[role=tab][data-editor-id="index.html"]')).toHaveCount(0);
  await expect(page.locator('[role=tab][data-editor-id="index.html"]')).toHaveCount(1);
});

test("the preview shows a device in its own shape, turns it, and goes full screen", async ({ page }) => {
  await practice(page);
  await row(page, "web").click();
  await row(page, "web/index.html").dblclick();
  await page.keyboard.press("F5");
  await expect(page.frameLocator('[data-testid="preview-frame"]').locator("h1")).toHaveText("Hello, NGA!");
  await page.getByRole("radio", { name: "Mobile (375)" }).click();
  await expect(page.getByTestId("preview-dims")).toContainText("375 × 667");
  await page.getByTestId("preview-rotate").click();
  await expect(page.getByTestId("preview-dims")).toContainText("667 × 375");
  await expect(page.locator(".tm-preview-device")).toHaveCSS("width", "667px");
  await page.getByTestId("preview-fullscreen").click();
  await expect(page.locator(".tm-preview.is-fullscreen")).toBeVisible();
  const box = (await page.locator(".tm-preview.is-fullscreen").boundingBox())!;
  expect(box.width).toBe(page.viewportSize()!.width);
  await page.keyboard.press("Escape");
  await expect(page.locator(".tm-preview.is-fullscreen")).toHaveCount(0);
  // Remembered: the next preview opens on the same device.
  await page.getByTestId("preview-rotate").click();
});
