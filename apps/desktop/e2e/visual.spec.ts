import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 10: visual regression of the main parts in Dark Modern and Light
 * Modern. Screenshots differ by OS and fonts, so this runs only on request:
 *   VISUAL=1 npx playwright test e2e/visual.spec.ts --project=chromium [--update-snapshots]
 */

test.skip(!process.env.VISUAL, "Visual checks run with VISUAL=1 (screenshots are per machine).");

async function boot(page: Page, theme: string) {
  await page.addInitScript((t) => {
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    localStorage.setItem("tmcode:ui", JSON.stringify({ settings: { "workbench.colorTheme": t, "editor.cursorBlinking": "solid" } }));
  }, theme);
  await page.goto("/");
  await expect(page.locator('.tm-explorer [data-path="main.py"]')).toBeVisible();
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await expect(page.locator(".tm-editor-area .monaco-editor .view-lines").first()).toContainText("def letter");
  // Fonts and icon themes settle.
  await page.waitForTimeout(800);
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`@visual workbench, explorer and editor (${theme})`, async ({ page }) => {
    await boot(page, theme);
    await expect(page.locator(".tm-sidebar")).toHaveScreenshot(`explorer-${theme}.png`, { maxDiffPixelRatio: 0.02 });
    await expect(page.locator(".tm-editor-area")).toHaveScreenshot(`editor-${theme}.png`, { maxDiffPixelRatio: 0.02, mask: [page.locator(".cursors-layer")] });
    await expect(page.locator(".tm-statusbar")).toHaveScreenshot(`statusbar-${theme}.png`, { maxDiffPixelRatio: 0.02 });
  });
}
