import { expect, test } from "@playwright/test";

/**
 * Phase 10: a performance budget the suite enforces. Generous on purpose (dev
 * server, CI machines): it catches a slowdown of several times, not noise.
 */

const BUDGET = { startMs: 8000, typing200Ms: 6000, openFileMs: 3000 };

test("the workbench starts, opens a file and takes typing within budget", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    localStorage.setItem("tmcode:ui", JSON.stringify({ settings: { "files.autoSave": "off" } }));
  });
  const t0 = Date.now();
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await expect(page.locator('.tm-explorer [data-path="main.py"]')).toBeVisible();
  const start = Date.now() - t0;

  const t1 = Date.now();
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  const lines = page.locator(".tm-editor-area .monaco-editor .view-lines").first();
  await expect(lines).toContainText("def letter");
  const open = Date.now() - t1;

  await lines.click();
  const text = "x".repeat(200);
  const t2 = Date.now();
  await page.keyboard.type(text);
  await expect(lines).toContainText(text.slice(0, 120));
  const typing = Date.now() - t2;

  test.info().annotations.push({ type: "performance", description: `start ${start} ms · open ${open} ms · 200 keys ${typing} ms` });
  expect(start).toBeLessThan(BUDGET.startMs);
  expect(open).toBeLessThan(BUDGET.openFileMs);
  expect(typing).toBeLessThan(BUDGET.typing200Ms);
});
