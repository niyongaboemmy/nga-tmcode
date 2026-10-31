import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 8: keybindings.json (rules, "-" removal), the Settings editor's
 * Workspace tab writing .vscode/settings.json, profiles, and Settings Sync
 * through the NGA account (the mock keeps the account's copy in localStorage).
 */

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

async function boot(page: Page, storage: Record<string, string> = {}) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(command);
  await page.keyboard.press("Enter");
}

const fontSize = (page: Page) => page.locator('[data-setting="editor.fontSize"] input');

test("keybindings.json: a rule adds a key, and it works at once", async ({ page }) => {
  await boot(page);
  await expect(row(page, "main.py")).toBeVisible();
  await palette(page, "Preferences: Open Keyboard Shortcuts (JSON)");
  const editor = page.getByTestId("keybindings-json");
  await expect(editor).toContainText("0 rules");
  // The cursor after "[" (the editor uses the browser's platform keys).
  const mod = (await page.evaluate(() => navigator.userAgent.includes("Macintosh"))) ? "Meta" : "Control";
  await editor.locator(".monaco-editor").click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("End");
  await page.keyboard.insertText('\n  { "key": "ctrl+alt+j", "command": "workbench.action.toggleSidebarVisibility" }');
  await expect(editor).toContainText("1 rule");
  await page.locator(".tm-statusbar").click();
  await page.keyboard.press("Control+Alt+j");
  await expect(row(page, "main.py")).toBeHidden();
  await page.keyboard.press("Control+Alt+j");
  await expect(row(page, "main.py")).toBeVisible();
});

test("the Workspace tab writes this folder's .vscode/settings.json", async ({ page }) => {
  await boot(page);
  await palette(page, "Preferences: Open Settings");
  await page.getByRole("tab", { name: "Workspace" }).click();
  // Only what a folder may set is listed (the font size stays your own).
  await expect(page.locator('[data-setting="editor.fontSize"]')).toHaveCount(0);
  const tabSize = page.locator('[data-setting="editor.tabSize"]');
  await tabSize.locator("input").fill("3");
  await expect(tabSize).toContainText("Set in this folder");
  await row(page, ".vscode").click();
  await row(page, ".vscode/settings.json").dblclick();
  await expect(page.locator(".tm-editor-area .view-lines").first()).toContainText(/"editor.tabSize":\s3/);
  // Reset removes it from the folder's file.
  await palette(page, "Preferences: Open Settings");
  await page.getByRole("tab", { name: "Workspace" }).click();
  await tabSize.getByRole("button", { name: "Reset" }).click();
  await expect(tabSize).not.toContainText("Set in this folder");
});

test("profiles keep their own settings; switching back restores yours", async ({ page }) => {
  await boot(page);
  await palette(page, "Preferences: Open Settings");
  await fontSize(page).fill("17");
  await palette(page, "Profiles: Create Profile...");
  await page.keyboard.type("Web");
  await page.keyboard.press("Enter");
  await page.locator(".tm-qi-item", { hasText: "TMCode's defaults" }).click();
  await expect(page.locator(".tm-statusbar")).toContainText("Web");
  await expect(fontSize(page)).not.toHaveValue("17");
  await fontSize(page).fill("21");
  await palette(page, "Profiles: Switch Profile...");
  await page.locator(".tm-qi-item", { hasText: "Default" }).click();
  await expect(fontSize(page)).toHaveValue("17");
  await expect(page.locator(".tm-statusbar")).not.toContainText("Web");
  await palette(page, "Profiles: Switch Profile...");
  await page.locator(".tm-qi-item", { hasText: "Web" }).click();
  await expect(fontSize(page)).toHaveValue("21");
});

test("Settings Sync: the account's settings come to this computer, and changes go up", async ({ page }) => {
  const other = {
    data: { version: 1, current: { settings: { "editor.fontSize": 22 }, languages: {}, other: {}, keybindings: "[]" }, profiles: { active: "Default", profiles: {} } },
    updated_at: "2026-10-30T10:00:00.000Z",
  };
  await boot(page, { "tmcode:mock-account": "signed-in", "tmcode:mock-settings-sync": JSON.stringify(other) });
  await palette(page, "Settings Sync: Turn On Settings Sync...");
  await page.locator(".tm-dialog").getByRole("button", { name: "Use Synced Settings" }).click();
  await palette(page, "Preferences: Open Settings");
  await expect(fontSize(page)).toHaveValue("22");
  await fontSize(page).fill("15");
  await expect
    .poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem("tmcode:mock-settings-sync"))) ?? "{}").data?.current?.settings?.["editor.fontSize"], { timeout: 10_000 })
    .toBe(15);
});
