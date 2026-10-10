import { expect, test, type Page } from "@playwright/test";

/** 0.13 "core editor": Replace in Files, Explorer multi-select / compact folders / files.exclude, status bar pickers, window zoom. */

const MOD = "ControlOrMeta";
type Debug = { externalWrite(path: string, content: string): Promise<void> };

async function boot(page: Page) {
  await page.goto("/");
  await expect(page.locator(".tm-titlebar")).toBeVisible();
  await expect(row(page, "main.py")).toBeVisible();
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const tab = (page: Page, name: string) => page.locator(".tm-tab", { hasText: name });
const dialog = (page: Page) => page.locator(".tm-dialog");
const picker = (page: Page) => page.locator(".tm-quick-pick");
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

async function pick(page: Page, label: string) {
  await expect(picker(page)).toBeVisible();
  await picker(page).locator(".tm-qi-item", { hasText: label }).first().click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("Replace in Files with a files-to-include glob, then the results tree by keyboard", async ({ page }) => {
  await boot(page);
  await page.keyboard.press(`${MOD}+Shift+f`);
  await page.getByRole("textbox", { name: "Search" }).fill("average");
  await expect(page.locator(".tm-search-file").first()).toBeVisible();
  const allFiles = await page.locator(".tm-search-file").count();
  expect(allFiles).toBeGreaterThan(1);

  // files to include: only TypeScript.
  await page.getByRole("button", { name: "Toggle Search Details" }).click();
  await page.getByRole("textbox", { name: "files to include" }).fill("*.ts");
  await expect(page.locator(".tm-search-file")).toHaveCount(1);
  await expect(page.locator(".tm-search-file")).toContainText("utils.ts");

  // Replace: the list previews old → new; Replace All asks first.
  await page.getByRole("button", { name: "Toggle Replace" }).click();
  await page.getByRole("textbox", { name: "Replace" }).fill("meanValue");
  await expect(page.locator(".tm-search-hit.is-added").first()).toHaveText("meanValue");
  await page.getByRole("button", { name: /^Replace All \(/ }).click();
  await expect(dialog(page)).toContainText("with 'meanValue'");
  await dialog(page).getByRole("button", { name: "Replace" }).click();
  await expect(page.locator(".tm-search-message")).toContainText("No results found");

  // Only the included file changed.
  await page.getByRole("textbox", { name: "files to include" }).fill("");
  await page.getByRole("textbox", { name: "Search" }).fill("meanValue");
  await expect(page.locator(".tm-search-file")).toHaveCount(1);
  await expect(page.locator(".tm-search-file")).toContainText("utils.ts");
  await page.getByRole("textbox", { name: "Search" }).fill("average");
  await expect(page.locator(".tm-search-file")).toHaveCount(allFiles - 1);

  // Keyboard: ↓ from the box enters the tree, Delete dismisses a match, Enter opens it.
  await page.getByRole("button", { name: "Toggle Replace" }).click();
  const before = await page.locator(".tm-search-line").count();
  await page.getByRole("textbox", { name: "Search" }).press("ArrowDown");
  await expect(page.locator(".tm-search-results")).toBeFocused();
  await expect(page.locator(".tm-search-file.is-focused")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".tm-search-line.is-focused")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(page.locator(".tm-search-line")).toHaveCount(before - 1);
  await page.keyboard.press("ArrowLeft"); // to the file row
  await expect(page.locator(".tm-search-file.is-focused")).toHaveCount(1);
  await page.keyboard.press("ArrowLeft"); // collapses it
  await expect(page.locator(".tm-search-file.is-focused")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-tab").first()).toBeVisible();
});

test("Explorer: Cmd/Ctrl-click selects several files and Delete removes them together", async ({ page }) => {
  await boot(page);
  await row(page, "README.md").click();
  await row(page, "main.py").click({ modifiers: ["ControlOrMeta"] });
  await expect(row(page, "README.md")).toHaveAttribute("aria-selected", "true");
  await expect(row(page, "main.py")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect(dialog(page)).toContainText("delete the following 2 files or folders");
  await dialog(page).getByRole("button", { name: "Move to Trash" }).click();
  await expect(row(page, "README.md")).toHaveCount(0);
  await expect(row(page, "main.py")).toHaveCount(0);

  // Shift+↑ extends the selection (web is the last row now).
  await row(page, "web").click();
  await row(page, "web").click(); // collapse again
  await page.keyboard.press("Shift+ArrowUp");
  await expect(page.locator(".tm-explorer .tm-list-row.is-selected")).toHaveCount(2);
});

test("Explorer: compact folders open in one click; .git is hidden", async ({ page }) => {
  await boot(page);
  await externalWrite(page, "java/src/main/java/com/x/App.java", "class App {}\n");
  await externalWrite(page, ".git/HEAD", "ref: refs/heads/main\n");
  await expect(row(page, "java")).toBeVisible();
  await expect(row(page, ".git")).toHaveCount(0);
  await row(page, "java").click();
  const compact = row(page, "java/src/main/java/com/x");
  await expect(compact).toContainText("java/src/main/java/com/x");
  await expect(compact).toHaveClass(/is-compact/);
  await expect(row(page, "java/src/main/java/com/x/App.java")).toBeVisible();
  // ← collapses the whole chain.
  await compact.click();
  await expect(row(page, "java/src/main/java/com/x/App.java")).toHaveCount(0);
  // Type-ahead jumps to a name.
  await page.keyboard.type("readm");
  await expect(row(page, "README.md")).toHaveClass(/is-selected/);
});

test("status bar: indentation picker converts the file, EOL and language pickers", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("def letter");
  const indent = page.locator(".tm-status-indent");
  await expect(indent).toHaveText("Spaces: 4");
  await indent.click();
  await pick(page, "Convert Indentation to Tabs");
  await expect(indent).toHaveText("Tab Size: 4");
  // The file now starts its lines with tabs.
  await page.keyboard.press(`${MOD}+Shift+f`);
  await page.getByRole("button", { name: "Use Regular Expression" }).click();
  await page.getByRole("textbox", { name: "Search" }).fill("^\\t+return");
  await expect(page.locator(".tm-search-file", { hasText: "main.py" })).toBeVisible();

  await indent.click();
  await pick(page, "Indent Using Spaces");
  await pick(page, "2");
  await expect(indent).toHaveText("Spaces: 2");

  await page.locator(".tm-status-eol").click();
  await pick(page, "CRLF");
  await expect(page.locator(".tm-status-eol")).toHaveText("CRLF");
  await expect(tab(page, "main.py")).toBeVisible();

  await expect(page.locator(".tm-status-encoding")).toHaveText("UTF-8");
  await page.locator(".tm-status-language").click();
  await picker(page).locator("input").fill("Plain Text");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-status-language")).toHaveText("Plain Text");
});

test("⌘= / ⌘- / ⌘0 zoom the whole window", async ({ page }) => {
  await boot(page);
  await row(page, "README.md").click();
  const zoom = () => page.evaluate(() => document.documentElement.style.zoom);
  await page.keyboard.press(`${MOD}+Equal`);
  await expect.poll(zoom).toBe("1.2");
  await page.keyboard.press(`${MOD}+Minus`);
  await page.keyboard.press(`${MOD}+Minus`);
  await expect.poll(zoom).toBe("0.833");
  await page.keyboard.press(`${MOD}+Digit0`);
  await expect.poll(zoom).toBe("");
  // The editor font keeps its own zoom command.
  await page.keyboard.press(`${MOD}+Shift+p`);
  await page.keyboard.type("Editor Font Zoom In");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("Editor Font Zoom In");
});
