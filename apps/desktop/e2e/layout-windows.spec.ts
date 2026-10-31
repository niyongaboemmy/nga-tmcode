import { expect, test, type Page } from "@playwright/test";

/** Phase 7: the Panel left / right / bottom, Centered Layout, and New Window only where windows exist. */

async function boot(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
  });
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(command);
  await page.keyboard.press("Enter");
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

test("Move Panel Right / Left / Bottom puts the Panel beside or below the editor, and it stays after a reload", async ({ page }) => {
  await boot(page);
  await palette(page, "View: Move Panel Right");
  await expect(page.locator(".tm-panel")).toBeVisible();
  let editor = await box(page, ".tm-editor-area");
  let panel = await box(page, ".tm-panel");
  expect(panel.x).toBeGreaterThan(editor.x + editor.width - 4);
  expect(Math.abs(panel.y - editor.y)).toBeLessThan(4);

  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  editor = await box(page, ".tm-editor-area");
  panel = await box(page, ".tm-panel");
  expect(panel.x).toBeGreaterThan(editor.x + editor.width - 4);

  await palette(page, "View: Move Panel Left");
  editor = await box(page, ".tm-editor-area");
  panel = await box(page, ".tm-panel");
  expect(panel.x + panel.width).toBeLessThan(editor.x + 4);

  await palette(page, "View: Move Panel Bottom");
  editor = await box(page, ".tm-editor-area");
  panel = await box(page, ".tm-panel");
  expect(panel.y).toBeGreaterThan(editor.y + editor.height - 4);
});

test("Centered Layout keeps the editor in the middle", async ({ page }) => {
  await boot(page);
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await palette(page, "View: Toggle Centered Layout");
  await expect(page.locator(".tm-editor-area")).toHaveClass(/is-centered/);
  await palette(page, "View: Toggle Centered Layout");
  await expect(page.locator(".tm-editor-area")).not.toHaveClass(/is-centered/);
});

test("New Window is a desktop command: the browser build doesn't offer it", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("F1");
  await page.keyboard.type("File: New Window");
  await expect(page.locator(".tm-qi-item", { hasText: "File: New Window" })).toHaveCount(0);
});
