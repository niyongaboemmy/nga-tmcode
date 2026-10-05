import { expect, test, type Page } from "@playwright/test";

/** Phase 1 acceptance: the VS Code-style workbench, on Chromium and WebKit. */

const MOD = "ControlOrMeta";

async function boot(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator(".tm-titlebar")).toBeVisible();
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const tab = (page: Page, name: string) => page.locator(".tm-tab", { hasText: name });

test.beforeEach(async ({ page }) => {
  // Each test starts from default settings.
  await page.addInitScript(() => localStorage.clear());
});

test("welcome page when no folder is open", async ({ page }) => {
  await boot(page, "?empty=1");
  await expect(page.locator(".tm-welcome h1")).toHaveText("TMCode");
  await expect(page.getByRole("button", { name: "Open Folder" }).first()).toBeVisible();
  await expect(page.locator(".tm-status-mode")).toContainText("Practice");
});

test("single click opens a preview tab, double click pins it", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").click();
  await expect(tab(page, "main.py")).toHaveClass(/is-preview/);
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("def letter");
  await row(page, "README.md").click();
  // The preview tab is replaced, not added.
  await expect(page.locator(".tm-tab")).toHaveCount(1);
  await row(page, "README.md").dblclick();
  await expect(tab(page, "README.md")).not.toHaveClass(/is-preview/);
  await expect(page.locator(".tm-breadcrumbs")).toContainText("README.md");
});

test("editing marks the file dirty and auto save clears it", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\n# edited");
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);
  // files.autoSave = afterDelay (1000 ms)
  await expect(tab(page, "main.py")).not.toHaveClass(/is-dirty/, { timeout: 4000 });
});

test("Go to File and the command palette", async ({ page }) => {
  await boot(page);
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("styl");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("style.css");
  await page.keyboard.press("Enter");
  await expect(tab(page, "style.css")).toBeVisible();

  await page.keyboard.press(`${MOD}+Shift+p`);
  await page.keyboard.type("toggle panel");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("Toggle Panel Visibility");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-panel")).toBeVisible();
});

test("new file validation, rename and delete in the explorer", async ({ page }) => {
  await boot(page);
  await row(page, "web").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "New File..." }).click();
  const input = page.locator(".tm-inline-input");
  await input.fill("app.js");
  await expect(page.locator(".tm-input-message")).toContainText("already exists");
  await input.fill("gallery.html");
  await input.press("Enter");
  await expect(row(page, "web/gallery.html")).toBeVisible();
  await expect(tab(page, "gallery.html")).toBeVisible();

  await row(page, "web/gallery.html").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "Rename..." }).click();
  await page.locator(".tm-inline-input").fill("contact.html");
  await page.keyboard.press("Enter");
  await expect(row(page, "web/contact.html")).toBeVisible();
  await expect(tab(page, "contact.html")).toBeVisible();

  await row(page, "web/contact.html").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "Delete" }).click();
  await expect(page.locator(".tm-dialog")).toContainText("Are you sure you want to delete 'contact.html'?");
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "web/contact.html")).toHaveCount(0);
  await expect(tab(page, "contact.html")).toHaveCount(0);
});

test("TypeScript errors appear in Problems and the explorer", async ({ page }) => {
  await boot(page);
  await row(page, "src").click();
  await row(page, "src/utils.ts").dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type("\nconst n: number = 'oops';\n");
  await page.keyboard.press(`${MOD}+Shift+m`);
  await expect(page.locator(".tm-problem")).toContainText("is not assignable to type 'number'", { timeout: 15000 });
  await expect(page.locator(".tm-status-item").filter({ hasText: /^\s*1\s*0\s*$/ })).toHaveCount(1);
  await expect(row(page, "src/utils.ts")).toHaveClass(/has-error/);
});

test("split editor, layout toggles and theme", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await page.keyboard.press(`${MOD}+\\`);
  await expect(page.locator(".tm-editor-group")).toHaveCount(2);

  await page.keyboard.press(`${MOD}+b`);
  await expect(page.locator(".tm-sidebar")).toBeHidden();
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.locator(".tm-sidebar")).toBeVisible();

  await page.keyboard.press(`${MOD}+Shift+p`);
  await page.keyboard.type("color theme");
  await page.keyboard.press("Enter");
  await page.keyboard.type("light");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-root")).toHaveAttribute("data-theme", "light-modern");
});

test("search across the workspace", async ({ page }) => {
  await boot(page);
  await page.keyboard.press(`${MOD}+Shift+f`);
  await page.locator(".tm-search input").fill("average");
  await expect(page.locator(".tm-search-message")).toContainText(/results? in 3 files/);
  await page.locator(".tm-search-line").first().click();
  await expect(page.locator(".tm-tab.is-active")).toBeVisible();
});

test("menu bar opens and switches on hover", async ({ page }) => {
  await boot(page);
  await page.locator(".tm-menubar-item", { hasText: "File" }).click();
  await expect(page.locator(".tm-menu")).toContainText("Open Folder...");
  await page.locator(".tm-menubar-item", { hasText: "View" }).hover();
  await expect(page.locator(".tm-menu")).toContainText("Toggle Primary Side Bar Visibility");
  await page.keyboard.press("Escape");
  await expect(page.locator(".tm-menu")).toHaveCount(0);
});
