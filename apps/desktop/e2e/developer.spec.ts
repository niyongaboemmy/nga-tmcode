import { expect, test, type Page } from "@playwright/test";

/** TMCode as an everyday editor: outside changes, restored editors, updates. */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

async function fresh(page: Page, storage: Record<string, string> = {}) {
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  await page.reload();
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

test("files changed outside TMCode reload in the editor and explorer", async ({ page }) => {
  await fresh(page);
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("def letter");
  await externalWrite(page, "main.py", 'print("changed by git pull")\n');
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("changed by git pull");
  await expect(page.locator(".tm-tab.is-active")).not.toHaveClass(/is-dirty/);
  // Undo brings the previous text back.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("F1");
  await page.keyboard.type("Edit: Undo");
  await page.keyboard.press("Enter");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("def letter");

  await externalWrite(page, "notes.txt", "new file");
  await expect(page.locator('.tm-explorer [data-path="notes.txt"]')).toBeVisible();
});

test("an outside change under unsaved edits warns instead of overwriting", async ({ page }) => {
  await fresh(page, { "tmcode:ui": JSON.stringify({ settings: { "files.autoSave": "off" } }) });
  await page.locator('.tm-explorer [data-path="README.md"]').dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("my edit ");
  await expect(page.locator(".tm-tab.is-active")).toHaveClass(/is-dirty/);
  await externalWrite(page, "README.md", "rewritten elsewhere\n");
  await expect(page.locator(".tm-toast")).toContainText("was changed on disk while you have unsaved changes");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("my edit");
});

test("open editors come back when the folder is opened again", async ({ page }) => {
  await fresh(page);
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await page.locator('.tm-explorer [data-path="README.md"]').dblclick();
  await page.waitForTimeout(700); // the editor list is saved after a short debounce
  await page.reload();
  await expect(page.locator(".tm-tab")).toHaveCount(2);
  await expect(page.locator(".tm-tab.is-active")).toContainText("README.md");
});

test("check for updates, read the notes, install", async ({ page }) => {
  const update = { version: "9.9.9", current_version: "0.1.0", notes: "- Faster previews\n- Bug fixes", date: null };
  await fresh(page, { "tmcode:mock-update": JSON.stringify(update) });
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.keyboard.type("check for updates");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast")).toContainText("TMCode 9.9.9 is available");
  await expect(page.locator(".tm-status-update")).toContainText("Update to 9.9.9");
  await page.locator(".tm-status-update").click();
  await expect(page.locator(".tm-dialog")).toContainText("Faster previews");
  await page.locator(".tm-dialog").getByRole("button", { name: "Install and Restart" }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tmcode:mock-installed"))).toContain("9.9.9");
});

test("up to date: a manual check says so", async ({ page }) => {
  await fresh(page);
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.keyboard.type("check for updates");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast")).toContainText("latest version of TMCode");
});

test("TMCode's own save reported back by the watcher is not a conflict", async ({ page }) => {
  await fresh(page, { "tmcode:ui": JSON.stringify({ settings: { "files.autoSave": "off" } }) });
  await externalWrite(page, "note.txt", "");
  await page.locator('.tm-explorer [data-path="note.txt"]').dblclick();
  const editor = page.locator(".monaco-editor .view-lines").first();
  await editor.click();
  await page.keyboard.type("saved text");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".tm-tab.is-active")).not.toHaveClass(/is-dirty/);
  // Keep typing, then the watcher reports the earlier save (disk = what TMCode wrote).
  await page.keyboard.type(" and more");
  await expect(page.locator(".tm-tab.is-active")).toHaveClass(/is-dirty/);
  await externalWrite(page, "note.txt", "saved text");
  await page.waitForTimeout(500);
  await expect(page.locator(".tm-toast", { hasText: "changed on disk" })).toHaveCount(0);
  await expect(editor).toContainText("saved text and more");
});
