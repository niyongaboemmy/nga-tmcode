import { expect, test, type Page } from "@playwright/test";

/** Phase 10: French menus and Settings, the Accessible View, signals, and Report a Problem. */

async function boot(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    localStorage.setItem("tmcode:ui", JSON.stringify({ settings: s }));
  }, settings);
  await page.goto("/?terminal=sim");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(command);
  await page.keyboard.press("Enter");
}

test("Configure Display Language: French menus, views and Settings", async ({ page }) => {
  await boot(page);
  await palette(page, "Preferences: Configure Display Language");
  await page.locator(".tm-qi-item", { hasText: "Français" }).click();
  await expect(page.locator(".tm-titlebar")).toContainText("Fichier");
  await expect(page.locator(".tm-titlebar")).toContainText("Affichage");
  await expect(page.locator(".tm-panel-tab").first()).toBeAttached();
  await page.keyboard.press("F1");
  await page.keyboard.type("Preferences: Open Settings");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-settings")).toContainText("Éditeur de texte");
  await expect(page.locator(".tm-settings")).toContainText("Taille de police");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
});

test("the Accessible View shows the terminal's output as plain text", async ({ page }) => {
  await boot(page);
  await palette(page, "Terminal: Create New Terminal");
  const term = page.getByTestId("integrated-terminal");
  await expect(term).toContainText("$");
  await term.click();
  await page.keyboard.type("echo readable output");
  await page.keyboard.press("Enter");
  await expect(term).toContainText("readable output");
  await page.keyboard.press("Alt+F2");
  const view = page.getByTestId("accessible-view");
  await expect(view).toBeVisible();
  await expect(view.locator("textarea")).toHaveValue(/readable output/);
  await expect(view.locator("textarea")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
});

test("signals sound when a terminal command fails (Accessibility Signals: Always)", async ({ page }) => {
  await boot(page, { "accessibility.signals": "on" });
  await palette(page, "Terminal: Create New Terminal");
  const term = page.getByTestId("integrated-terminal");
  await expect(term).toContainText("$");
  await term.click();
  await page.keyboard.type("false");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => page.evaluate(() => ((window as unknown as { __TMCODE_SIGNALS__?: string[] }).__TMCODE_SIGNALS__ ?? []).join(",")))
    .toContain("terminalCommandFailed");
});

test("Report a Problem opens a report to fill in and copy", async ({ page }) => {
  await boot(page);
  await palette(page, "Help: Report a Problem...");
  await expect(page.locator(".tm-editor-area .view-lines").first()).toContainText("# Problem report");
  await expect(page.locator(".tm-editor-area .view-lines").first()).toContainText("About this computer");
  await expect(page.locator(".tm-toast").filter({ hasText: "TMCode doesn't send it" })).toBeVisible();
});
