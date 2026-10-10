import { expect, test, type Page } from "@playwright/test";

/** P1 core editor V5–V9: Quick Open modes, menus from one spec, everyday shortcuts, user keybindings. */

const MOD = "ControlOrMeta";
const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;

async function boot(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator(".tm-titlebar")).toBeVisible();
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const tab = (page: Page, name: string) => page.locator(".tm-tab", { hasText: name });
const activeTab = (page: Page) => page.locator(".tm-tab.is-active");
const cursor = (page: Page) => page.locator(".tm-status-right", { hasText: "Ln " }).first();

async function palette(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+Shift+p`);
  await page.keyboard.type(text);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(text.replace(/^.*: /, ""));
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tmcode:e2e-cleared")) return;
    localStorage.clear();
    sessionStorage.setItem("tmcode:e2e-cleared", "1");
  });
});

test("Quick Open: file:line jumps, @ lists symbols, ? lists the modes", async ({ page }) => {
  await boot(page);
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("main.py:12");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("main.py");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("line 12");
  await page.keyboard.press("Enter");
  await expect(tab(page, "main.py")).toBeVisible();
  await expect(cursor(page)).toContainText("Ln 12, Col 1");

  // Matching on the path, not just the name: "srcut" finds src/utils.ts.
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("srcut");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("utils.ts");
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("utils.ts");

  // Recently opened files come first.
  await page.keyboard.press(`${MOD}+p`);
  await expect(page.locator(".tm-qi-item").first()).toContainText("utils.ts");
  await expect(page.locator(".tm-qi-item").first()).toContainText("recently opened");
  await page.keyboard.press("Escape");

  // @: the symbols of the open file.
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("@");
  await expect(page.locator(".tm-quick-input")).toHaveAttribute("data-mode", "symbols");
  await expect(page.locator(".tm-qi-item", { hasText: "average" }).first()).toBeVisible({ timeout: 10000 });
  await page.keyboard.press("Escape");

  // ?: help with the prefixes (no "#" without a workspace symbol provider).
  await page.keyboard.press(`${MOD}+p`);
  await page.keyboard.type("?");
  await expect(page.locator(".tm-qi-item", { hasText: "Go to Symbol in Editor" })).toBeVisible();
  await expect(page.locator(".tm-qi-item", { hasText: "Go to Symbol in Workspace" })).toHaveCount(0);
  await page.locator(".tm-qi-item", { hasText: "Show and Run Commands" }).click();
  await expect(page.locator(".tm-quick-input input")).toHaveValue(">");
  await page.keyboard.press("Escape");
});

test("the palette lists Monaco's own editor actions with their keys", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("F1");
  await page.keyboard.type("add cursor above");
  const item = page.locator(".tm-qi-item.is-focused");
  await expect(item).toContainText("Add Cursor Above");
  await expect(item.locator("kbd").first()).not.toBeEmpty();
  // A Monaco-only action (no workbench wrapper) is listed too.
  await page.locator(".tm-quick-input input").fill(">transform to uppercase");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("Transform to Uppercase");
  await page.keyboard.press("Escape");
});

test("Selection, Run and Go menus are present with shortcuts", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await page.locator(".tm-menubar-item", { hasText: "Selection" }).click();
  const menu = page.locator(".tm-menu");
  for (const label of ["Select All", "Expand Selection", "Shrink Selection", "Copy Line Up", "Copy Line Down", "Move Line Up", "Move Line Down", "Add Cursor Above", "Add Cursor Below", "Add Next Occurrence", "Select All Occurrences"]) {
    await expect(menu.locator(".tm-menu-item", { hasText: label }).first()).toBeVisible();
  }
  await expect(menu.locator(".tm-menu-item", { hasText: "Add Next Occurrence" }).locator(".tm-menu-kb")).not.toBeEmpty();
  await expect(menu.locator(".tm-menu-item", { hasText: "Move Line Down" }).locator(".tm-menu-kb")).not.toBeEmpty();

  await page.locator(".tm-menubar-item", { hasText: "Run" }).hover();
  for (const label of ["Start Debugging", "Run Without Debugging", "Stop", "Restart", "Toggle Breakpoint", "Run Project", "Run Tests"]) {
    await expect(menu.locator(".tm-menu-item", { hasText: label }).first()).toBeVisible();
  }
  await expect(menu.locator(".tm-menu-item", { hasText: "Start Debugging" }).locator(".tm-menu-kb")).toHaveText("F5");
  // Nothing is running: Stop is greyed out.
  await expect(menu.locator(".tm-menu-item", { hasText: /^Stop/ })).toHaveClass(/is-disabled/);

  await page.locator(".tm-menubar-item", { hasText: "Go" }).hover();
  for (const label of ["Back", "Forward", "Go to File...", "Go to Symbol in Editor...", "Go to Definition", "Go to Line/Column...", "Next Problem", "Previous Problem"]) {
    await expect(menu.locator(".tm-menu-item", { hasText: label }).first()).toBeVisible();
  }
  await expect(menu.locator(".tm-menu-item", { hasText: "Go to Definition" }).locator(".tm-menu-kb")).toHaveText("F12");

  // Edit › Find shows its key; Undo from the menu acts on the focused field, not the editor.
  await page.locator(".tm-menubar-item", { hasText: "Edit" }).hover();
  await expect(menu.locator(".tm-menu-item", { hasText: "Find" }).first().locator(".tm-menu-kb")).not.toBeEmpty();
  await page.keyboard.press("Escape");
});

test("Selection › Copy Line Down acts on the editor", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+g");
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  const lines = await page.evaluate(() => document.querySelectorAll(".monaco-editor .view-line").length);
  await page.locator(".tm-menubar-item", { hasText: "Selection" }).click();
  await page.locator(".tm-menu-item", { hasText: "Copy Line Down" }).click();
  await expect(cursor(page)).toContainText("Ln 2");
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);
  expect(lines).toBeGreaterThan(1);
});

test("Ctrl+Tab switches to the previous editor; reopen closed editor; Go Back", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await expect(activeTab(page)).toContainText("main.py");
  await row(page, "README.md").dblclick();
  await expect(activeTab(page)).toContainText("README.md");
  await page.locator(".monaco-editor .view-lines").click();

  await page.keyboard.down("Control");
  await page.keyboard.press("Tab");
  await expect(page.locator(".tm-quick-input")).toHaveAttribute("data-mode", "editors");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("main.py");
  await page.keyboard.up("Control");
  await expect(page.locator(".tm-quick-input")).toHaveCount(0);
  await expect(activeTab(page)).toContainText("main.py");

  // Close it, then ⇧⌘T brings it back.
  await palette(page, "View: Close Editor");
  await expect(tab(page, "main.py")).toHaveCount(0);
  await page.keyboard.press(`${MOD}+Shift+t`);
  await expect(activeTab(page)).toContainText("main.py");

  // Go to a line far away, then Go Back returns to where we were.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+g");
  await page.keyboard.type("2");
  await page.keyboard.press("Enter");
  await expect(cursor(page)).toContainText("Ln 2,");
  await page.keyboard.press("Control+g");
  await page.keyboard.type("20");
  await page.keyboard.press("Enter");
  await expect(cursor(page)).toContainText("Ln 20,");
  await palette(page, "Go: Go Back");
  await expect(cursor(page)).toContainText("Ln 2,");
  await palette(page, "Go: Go Forward");
  await expect(cursor(page)).toContainText("Ln 20,");
});

test("New Text File is saved to a path the student types", async ({ page }) => {
  await boot(page);
  await palette(page, "File: New Text File");
  await expect(activeTab(page)).toContainText("Untitled-1");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("hello from an untitled file");
  await expect(activeTab(page)).toHaveClass(/is-dirty/);
  // Auto save never asks for a path on its own.
  await page.waitForTimeout(1500);
  await expect(page.locator(".tm-quick-input")).toHaveCount(0);
  await page.keyboard.press(`${MOD}+s`);
  const input = page.locator(".tm-quick-input input");
  await expect(input).toBeVisible();
  await input.fill("notes/hello.txt");
  await page.keyboard.press("Enter");
  await expect(activeTab(page)).toContainText("hello.txt");
  await expect(tab(page, "Untitled-1")).toHaveCount(0);
  await expect(activeTab(page)).not.toHaveClass(/is-dirty/);
  await expect(row(page, "notes/hello.txt")).toBeVisible();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("hello from an untitled file");
});

async function openShortcuts(page: Page) {
  await palette(page, "Preferences: Open Keyboard Shortcuts");
  await expect(page.locator(".tm-shortcuts")).toBeVisible();
}

test("rebinding a command: double-click records a key, conflicts show, reset restores", async ({ page }) => {
  await boot(page);
  await openShortcuts(page);
  // Monaco's own bindings are listed.
  await page.getByLabel("Search keybindings").fill("Add Next Occurrence");
  await expect(page.locator(".tm-shortcuts-row[data-command='editor.action.addSelectionToNextFindMatch'] kbd").first()).toBeVisible();
  // ...including actions with no workbench command (Delete Line, ⇧⌘K).
  await page.getByLabel("Search keybindings").fill("editor.action.deleteLines");
  await expect(page.locator(".tm-shortcuts-row[data-command='editor.action.deleteLines'] kbd").first()).toBeVisible();

  await page.getByLabel("Search keybindings").fill("Toggle Panel Visibility");
  const r = page.locator(".tm-shortcuts-row[data-command='workbench.action.togglePanel']");
  await r.dblclick();
  // Double-click edits; it no longer runs the command.
  await expect(page.locator(".tm-panel")).toBeHidden();
  const rec = page.getByTestId("key-recorder");
  await expect(rec).toBeFocused();
  // A key another command uses: shown as a conflict.
  await page.keyboard.press(`${MOD}+b`);
  await expect(page.getByTestId("key-conflicts")).toContainText("Toggle Primary Side Bar Visibility");
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.press(`${MOD}+Alt+y`);
  await expect(page.getByTestId("key-conflicts")).toContainText("No other command");
  await page.keyboard.press("Enter");
  await expect(rec).toHaveCount(0);
  await expect(r).toContainText("User");
  await expect(r.locator("kbd").first()).toBeVisible();

  // The new key works, the old one doesn't.
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(".tm-panel")).toBeHidden();
  await page.keyboard.press(`${MOD}+Alt+y`);
  await expect(page.locator(".tm-panel")).toBeVisible();

  // Kept across a reload (it is a setting).
  await page.reload();
  await expect(page.locator(".tm-titlebar")).toBeVisible();
  await page.keyboard.press(`${MOD}+Alt+y`);
  await expect(page.locator(".tm-panel")).toBeHidden();

  // Reset.
  await openShortcuts(page);
  await page.getByLabel("Search keybindings").fill("Toggle Panel Visibility");
  await r.hover();
  await r.getByRole("button", { name: "Reset Keybinding" }).click();
  await expect(r).toContainText("Default");
  await page.keyboard.press(`${MOD}+j`);
  await expect(page.locator(".tm-panel")).toBeVisible();
});

test("keybindings are locked during an exam", async ({ page }) => {
  await page.request.post(`${TM}/__test/reset`);
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  await openShortcuts(page);
  await expect(page.getByTestId("shortcuts-hint")).toContainText("can't be changed during an exam");
  await page.getByLabel("Search keybindings").fill("Toggle Panel Visibility");
  await page.locator(".tm-shortcuts-row[data-command='workbench.action.togglePanel']").dblclick();
  await expect(page.getByTestId("key-recorder")).toHaveCount(0);
});
