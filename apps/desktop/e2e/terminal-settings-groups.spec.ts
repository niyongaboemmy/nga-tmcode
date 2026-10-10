import { expect, test, type Page } from "@playwright/test";

/**
 * V15–V17, V12 (docs/reviews/2026-10-10-ux-gap-review): editor groups in a
 * grid (Split Down, drop-to-split, pinned tabs, ←/→ between tabs, the layout
 * restored after a reload), settings.json with [language] scopes, merge
 * conflict CodeLens, hunk staging, and split / renamed terminals.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const groups = (page: Page) => page.locator(".tm-editor-group");
const tab = (page: Page, name: string, group = groups(page).first()) => group.getByRole("tab", { name: new RegExp(`^${name.replace(".", "\\.")}`) });

async function boot(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator(".tm-titlebar")).toBeVisible();
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await expect(page.locator(".tm-quick-input")).toContainText(command);
  await page.keyboard.press("Enter");
}

async function revealFolder(page: Page, folder: string) {
  const row = page.locator(`.tm-explorer [data-path="${folder}"]`);
  if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
}

async function openPinned(page: Page, path: string) {
  if (path.includes("/")) await revealFolder(page, path.slice(0, path.lastIndexOf("/")));
  await page.locator(`.tm-explorer [data-path="${path}"]`).dblclick();
}

/**
 * Replaces the (short) text of settings.json: ⌘A is a native-menu action in
 * Chromium on macOS, so the old text is deleted key by key; insertText avoids
 * Monaco's auto-closing brackets.
 */
async function replaceSettingsText(page: Page, text: string) {
  const json = page.getByTestId("settings-json");
  await json.locator(".monaco-editor").click();
  const old = (await json.locator(".view-lines").innerText()).length;
  for (let i = 0; i < old + 4; i++) await page.keyboard.press("Backspace");
  for (let i = 0; i < old + 4; i++) await page.keyboard.press("Delete");
  await expect(json.locator(".view-lines")).toHaveText("");
  await page.keyboard.insertText(text);
}

test.beforeEach(async ({ page }) => {
  // Cleared once per test: a reload keeps what the test saved.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tmcode:e2e-started")) {
      localStorage.clear();
      sessionStorage.setItem("tmcode:e2e-started", "1");
    }
  });
});

test("Split Down puts a group under the editor; a tab dropped on an edge splits there", async ({ page }) => {
  await boot(page);
  await openPinned(page, "main.py");
  await palette(page, "Split Editor Down");
  await expect(groups(page)).toHaveCount(2);
  const [top, bottom] = [await groups(page).nth(0).boundingBox(), await groups(page).nth(1).boundingBox()];
  expect(bottom!.y).toBeGreaterThan(top!.y + top!.height / 2);
  expect(Math.abs(bottom!.x - top!.x)).toBeLessThan(4);
  await expect(tab(page, "main.py", groups(page).nth(1))).toBeVisible();

  // Drag README.md's tab onto the right edge of the top editor: a third group appears on the right.
  await groups(page).nth(0).click({ position: { x: 200, y: 80 } });
  await openPinned(page, "README.md");
  const target = (await groups(page).nth(0).locator(".tm-editor-content").boundingBox())!;
  await tab(page, "README.md").dragTo(groups(page).nth(0).locator(".tm-editor-content"), { targetPosition: { x: target.width - 15, y: target.height / 2 } });
  await expect(groups(page)).toHaveCount(3);
  const right = groups(page).filter({ has: page.getByRole("tab", { name: /^README\.md/ }) });
  await expect(right).toHaveCount(1);
  const rb = (await right.boundingBox())!;
  expect(rb.x).toBeGreaterThan(target.x + target.width / 3);
  await expect(page.getByTestId("editor-drop-overlay")).toHaveCount(0);
});

test("pinned tabs stay at the left and a preview never replaces them", async ({ page }) => {
  await boot(page);
  await openPinned(page, "main.py");
  await openPinned(page, "README.md");
  await tab(page, "README.md").click({ button: "right" });
  await page.locator(".tm-menu").getByText("Pin", { exact: true }).click();
  const tabs = groups(page).first().getByRole("tab");
  await expect(tabs.first()).toHaveClass(/is-pinned/);
  await expect(tabs.first()).toContainText("README.md");
  await expect(tabs.first().getByRole("button", { name: "Unpin README.md" })).toBeVisible();
  // A single click opens a preview: it goes after the pinned tab and replaces only previews.
  await revealFolder(page, "web");
  await page.locator('.tm-explorer [data-path="web/app.js"]').click();
  await page.locator('.tm-explorer [data-path="web/about.html"]').click();
  await expect(tabs).toHaveCount(3);
  await expect(tabs.first()).toContainText("README.md");
  await tabs.first().getByRole("button", { name: "Unpin README.md" }).click();
  await expect(tabs.first()).not.toHaveClass(/is-pinned/);
});

test("←/→ move between tabs (an ARIA tablist with a roving tabindex)", async ({ page }) => {
  await boot(page);
  await openPinned(page, "main.py");
  await openPinned(page, "README.md");
  await openPinned(page, "web/style.css");
  const list = groups(page).first().getByRole("tablist");
  await expect(list.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await tab(page, "style.css").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(tab(page, "README.md")).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, "README.md")).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  // Wraps around, as VS Code's tabs do.
  await expect(tab(page, "style.css")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(tab(page, "main.py")).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(tab(page, "README.md")).toHaveAttribute("aria-selected", "true");
  await expect(list.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
});

test("settings.json: valid edits apply as you type; problems are marked", async ({ page }) => {
  await boot(page);
  await palette(page, "Open User Settings (JSON)");
  const json = page.getByTestId("settings-json");
  await expect(json).toBeVisible();
  await replaceSettingsText(page, '{ "editor.fontSize": 20, "editor.tabSize": 99 }');
  // fontSize applies; tabSize is out of range and is marked, not applied.
  await expect(json.locator(".squiggly-error")).toHaveCount(1);
  await page.locator(".tm-settings-json-bar").getByRole("button", { name: "Open Settings" }).click();
  await expect(page.locator("#setting-editor\\.fontSize")).toHaveValue("20");
  await expect(page.locator("#setting-editor\\.tabSize")).toHaveValue("4");
  // The Settings editor writes back into settings.json.
  await page.locator("#setting-editor\\.fontSize").fill("16");
  await tab(page, "settings.json").click();
  await expect(json.locator(".view-lines")).toContainText('"editor.fontSize": 16');
});

test("[python] settings apply to Python files only", async ({ page }) => {
  await boot(page);
  await openPinned(page, "main.py");
  await expect(groups(page).first().locator(".monaco-editor .line-numbers").first()).toBeVisible();
  await palette(page, "Open User Settings (JSON)");
  await replaceSettingsText(page, '{ "[python]": { "editor.lineNumbers": "off", "editor.tabSize": 7 } }');
  await expect(page.getByTestId("settings-json").locator(".squiggly-error")).toHaveCount(0);
  await tab(page, "main.py").click();
  const editor = groups(page).first().locator(".tm-editor-slot .monaco-editor");
  await expect(editor.locator(".line-numbers")).toHaveCount(0);
  // Tab at the start of line 1 inserts the Python scope's 7 spaces.
  const first = editor.locator(".view-line").first();
  await first.click({ position: { x: 1, y: 5 } });
  await page.keyboard.press("Tab");
  await expect(first).toHaveText(/^ {7}"""Grade/);
  // Another language keeps its line numbers.
  await openPinned(page, "README.md");
  await expect(editor.locator(".line-numbers").first()).toBeVisible();
});

test("merge conflict CodeLens: Accept Incoming / Current / Both", async ({ page }) => {
  await boot(page);
  await externalWrite(page, "grades.py", 'x = 0\n<<<<<<< HEAD\nlimit = 90\n=======\nlimit = 85\n>>>>>>> feature/grades\nprint(limit)\n');
  await openPinned(page, "grades.py");
  const editor = groups(page).first().locator(".tm-editor-slot .monaco-editor");
  const lens = editor.locator(".codelens-decoration");
  await expect(lens).toContainText("Accept Current Change");
  await expect(lens).toContainText("Accept Both Changes");
  await expect(lens).toContainText("Compare Changes");
  await lens.getByText("Accept Incoming Change").click();
  await expect(editor.locator(".view-lines")).toContainText("limit = 85");
  await expect(editor.locator(".view-lines")).not.toContainText("<<<<<<<");
  await expect(editor.locator(".view-lines")).not.toContainText("limit = 90");
  await expect(lens).toHaveCount(0);
  // Undo brings the conflict back; Compare shows both sides.
  await editor.locator(".view-lines").click();
  await palette(page, "Edit: Undo");
  await expect(editor.locator(".view-lines")).toContainText("<<<<<<< HEAD");
  await editor.locator(".codelens-decoration").getByText("Compare Changes").click();
  await expect(page.getByTestId("merge-compare")).toBeVisible();
  await expect(page.getByTestId("history-diff").locator(".modified .view-lines")).toContainText("limit = 85");
});

test("stage one change from the diff editor, and step through changes", async ({ page }) => {
  await boot(page);
  await page.getByRole("tab", { name: /^Source Control/ }).click();
  await page.locator('.tm-scm-section[data-section="changes"] .tm-scm-row[data-path="main.py"]').click();
  const diff = page.getByTestId("git-diff");
  await expect(diff.locator(".modified .view-lines")).toContainText('return "C"');
  await diff.getByRole("button", { name: "Next Change (Alt+F5)" }).click();
  await diff.getByRole("button", { name: "Stage Change at Cursor" }).click();
  // main.py now has its one change staged: it shows under Staged Changes.
  await expect(page.locator('.tm-scm-section[data-section="staged"] .tm-scm-row[data-path="main.py"]')).toBeVisible();
  await diff.getByRole("button", { name: "Show Inline" }).click();
  await expect(diff.getByRole("button", { name: "Show Side by Side" })).toBeVisible();
});

test("the layout comes back after a reload: groups, splits, tabs and pins", async ({ page }) => {
  await boot(page);
  await openPinned(page, "main.py");
  await openPinned(page, "README.md");
  await tab(page, "README.md").click({ button: "right" });
  await page.locator(".tm-menu").getByText("Pin", { exact: true }).click();
  await palette(page, "Split Editor Down");
  await expect(groups(page)).toHaveCount(2);
  await openPinned(page, "web/style.css");
  // Saved half a second after the last change.
  await page.waitForTimeout(900);
  await page.reload();
  await expect(groups(page)).toHaveCount(2, { timeout: 15_000 });
  const [top, bottom] = [await groups(page).nth(0).boundingBox(), await groups(page).nth(1).boundingBox()];
  expect(bottom!.y).toBeGreaterThan(top!.y + top!.height / 2);
  await expect(groups(page).nth(0).getByRole("tab").first()).toHaveClass(/is-pinned/);
  await expect(groups(page).nth(0).getByRole("tab")).toHaveCount(2);
  await expect(tab(page, "style.css", groups(page).nth(1))).toHaveAttribute("aria-selected", "true");
});

test("terminals: real shell names, a profile menu, split side by side, rename", async ({ page }) => {
  await boot(page, "?terminal=sim");
  await palette(page, "Toggle Terminal");
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect(page.getByTestId("terminal-title")).toHaveText("zsh");
  await page.getByRole("button", { name: "Launch Profile..." }).click();
  await page.locator(".tm-menu").getByText("bash", { exact: true }).click();
  const list = page.getByRole("list", { name: "Terminals" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("bash");
  await page.getByRole("button", { name: "Split Terminal" }).first().click();
  await expect(page.locator(".tm-terminal-pane")).toHaveCount(2);
  const panes = page.locator(".tm-terminal-pane");
  const [a, b] = [await panes.nth(0).boundingBox(), await panes.nth(1).boundingBox()];
  expect(b!.x).toBeGreaterThan(a!.x + 50);
  // The split runs the same shell.
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await list.getByRole("listitem").last().getByRole("button").first().dblclick();
  await page.getByRole("textbox", { name: "Terminal name" }).fill("server");
  await page.keyboard.press("Enter");
  await expect(list).toContainText("server");
});
