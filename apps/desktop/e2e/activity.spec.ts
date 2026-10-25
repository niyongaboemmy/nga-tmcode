import { expect, test, type Page } from "@playwright/test";

/**
 * The Activity panel: everything done in the folder except typing, kept per folder.
 * Files (create, rename, delete), copy and paste (inside TMCode or from outside),
 * runs, and the filters; AI use is covered by ai-extensions.spec.ts.
 */

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

async function boot(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
  });
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

async function openActivity(page: Page) {
  if (!(await page.locator(".tm-panel").isVisible())) await page.keyboard.press("ControlOrMeta+j");
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  return page.getByTestId("activity-view");
}

test("files created, renamed and deleted, copy and paste, and runs are recorded; typing is not", async ({ page, browserName, context }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await boot(page);

  // Create, rename, delete in the Explorer.
  await row(page, "web").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "New File..." }).click();
  await page.locator(".tm-inline-input").fill("notes.js");
  await page.keyboard.press("Enter");
  await expect(row(page, "web/notes.js")).toBeVisible();
  await page.keyboard.type("console.log('typed');");
  await row(page, "web/notes.js").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "Rename..." }).click();
  await page.locator(".tm-inline-input").fill("hello.js");
  await page.keyboard.press("Enter");
  await expect(row(page, "web/hello.js")).toBeVisible();

  const log = await openActivity(page);
  await expect(log).toContainText("Created file notes.js");
  await expect(log).toContainText("Renamed notes.js to hello.js");
  // Typing itself is never an entry (only the save that follows).
  await expect(log).not.toContainText("typed");

  // Copy inside TMCode, then paste: the paste says where the text came from.
  await externalWrite(page, "web/source.js", "const answer = 42;\n");
  await row(page, "web/source.js").click();
  const editor = page.locator(".tm-editor-area .monaco-editor").first();
  await editor.locator(".view-line").first().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.press("ControlOrMeta+c");
  await row(page, "web/hello.js").click();
  await page.locator(".tm-editor-area .monaco-editor").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(log).toContainText("Copied 1 line, 18 characters in source.js");
  await expect(log).toContainText("Pasted 1 line, 18 characters into hello.js (copied inside TMCode)");

  // A paste from outside TMCode (another app's text on the clipboard).
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "from the web");
    const target = document.querySelector(".tm-editor-area .monaco-editor textarea") ?? document.activeElement!;
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(log).toContainText("Pasted 1 line, 12 characters into hello.js (from outside TMCode)");

  // A run (in web/, the Run button runs the page: Live Preview).
  await page.keyboard.press("ControlOrMeta+s");
  await page.getByTestId("editor-run-button").click();
  await page.locator(".tm-panel-tab", { hasText: "Activity" }).click();
  await expect(log).toContainText(/Ran index\.html - web \(Live Preview\)|Ran web\/hello\.js/);

  // Delete.
  await row(page, "web/hello.js").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "Delete" }).click();
  await page.getByRole("button", { name: /Move to Trash|Delete Permanently/ }).click();
  await expect(row(page, "web/hello.js")).toHaveCount(0);
  await expect(log).toContainText(/(Moved hello\.js to the Trash|Deleted hello\.js)/);

  // Filters and search.
  await page.getByTestId("activity-filter-clipboard").click();
  await expect(log.locator(".tm-actlog-row")).toHaveCount(3);
  await page.getByTestId("activity-filter-file").click();
  await expect(log).toContainText("Renamed notes.js to hello.js");
  await expect(log).not.toContainText("Pasted");
  await page.getByTestId("activity-filter-all").click();
  await page.locator(".tm-panel-filter input").fill("rename");
  await expect(log.locator(".tm-actlog-row")).toHaveCount(1);
  // Details: who, when, and the file to open.
  await log.locator(".tm-actlog-main").first().click();
  await expect(log.locator(".tm-actlog-details")).toContainText("You");
});

test("Explorer copy and cut, the editor's own Paste, and text dragged in from another app are recorded", async ({ page }) => {
  await boot(page);

  // Files copied and cut in the Explorer.
  await row(page, "main.py").click({ button: "right" });
  await page.locator(".tm-menu-item").filter({ has: page.locator(".tm-menu-label", { hasText: /^Copy$/ }) }).click();
  await row(page, "README.md").click({ button: "right" });
  await page.locator(".tm-menu-item").filter({ has: page.locator(".tm-menu-label", { hasText: /^Cut$/ }) }).click();
  const log = await openActivity(page);
  await expect(log).toContainText("Copied main.py in the Explorer");
  await expect(log).toContainText("Cut README.md in the Explorer");

  // A paste through the clipboard API (no DOM paste event) still records the paste and its origin.
  await row(page, "main.py").dblclick();
  await page.locator(".tm-editor-area .monaco-editor .view-line").first().click();
  // Monaco's Paste through the clipboard API (its menu, Edit › Paste on macOS): no DOM paste event.
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { pasteViaApi(t: string): void } }).__TMCODE_DEBUG__.pasteViaApi("print('from a website')"));
  await expect(log).toContainText("Pasted 1 line, 23 characters into main.py (from outside TMCode)");

  // Text dragged in from a browser or a document.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "dragged from a web page");
    const target = document.querySelector(".tm-editor-area .monaco-editor .view-lines")!;
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(log).toContainText("Dragged 1 line, 23 characters into main.py (from outside TMCode)");
});
