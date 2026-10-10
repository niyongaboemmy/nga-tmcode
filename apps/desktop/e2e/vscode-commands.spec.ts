import { expect, test, type Page } from "@playwright/test";

/** VS Code's default commands: Reload Window, browser keys, Open Recent, editor/group commands, layout toggles, notifications, tasks, snippets. */

const MOD = "ControlOrMeta";
const MAC = process.platform === "darwin";

async function boot(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator(".tm-titlebar")).toBeVisible();
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const tabs = (page: Page) => page.locator(".tm-editor-group").first().locator(".tm-tab .tm-tab-label");
const tab = (page: Page, name: string) => page.locator(".tm-tab", { hasText: name });
const activeTab = (page: Page) => page.locator(".tm-tab.is-active");

async function palette(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+Shift+p`);
  await page.keyboard.type(text);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(text.replace(/^.*: /, ""));
  await page.keyboard.press("Enter");
}

/** Auto save off, so edits stay unsaved. */
async function autoSaveOff(page: Page) {
  await palette(page, "File: Toggle Auto Save");
  await expect(page.locator(".tm-statusbar")).toContainText("Auto Save Off");
}

async function open(page: Page, ...paths: string[]) {
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = row(page, parts.slice(0, i).join("/"));
      if ((await dir.getAttribute("aria-expanded")) !== "true") await dir.click();
    }
    await row(page, p).dblclick();
    await expect(activeTab(page)).toContainText(parts[parts.length - 1]);
  }
}

async function typeInEditor(page: Page, text: string) {
  await page.locator(".tm-editor-group .monaco-editor .view-lines").first().click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type(text);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tmcode:e2e-cleared")) return;
    localStorage.clear();
    sessionStorage.setItem("tmcode:e2e-cleared", "1");
  });
});

test("Reload Window asks about unsaved files: Cancel keeps the page, Don't Save reloads", async ({ page }) => {
  await boot(page);
  await autoSaveOff(page);
  await open(page, "main.py");
  await typeInEditor(page, "\n# unsaved");
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);
  await page.evaluate(() => ((window as unknown as { __marker?: number }).__marker = 1));

  await page.keyboard.press(`${MOD}+r`);
  const dialog = page.getByRole("alertdialog").filter({ hasText: "Do you want to save the changes" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);

  // From the palette too, with VS Code's title.
  await palette(page, "Developer: Reload Window");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Don't Save" }).click();
  await page.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined);
  await expect(page.locator(".tm-titlebar")).toBeVisible();
});

test("F5 and other browser keys never reload the page", async ({ page }) => {
  await boot(page);
  await page.evaluate(() => ((window as unknown as { __marker?: number }).__marker = 1));
  // Nothing open to run: F5 has no command here.
  const prevented = await page.evaluate((mac) => {
    const mod = mac ? { metaKey: true } : { ctrlKey: true };
    const out: Record<string, boolean> = {};
    for (const [name, init] of [
      ["F5", { key: "F5", code: "F5" }],
      ["Ctrl+Shift+R", { key: "R", code: "KeyR", shiftKey: true, ...mod }],
      ["F7", { key: "F7", code: "F7" }],
      ["Ctrl+U", { key: "u", code: "KeyU", ...mod }],
    ] as const) {
      const e = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(e);
      out[name] = e.defaultPrevented;
    }
    // An ordinary key stays the page's.
    const a = new KeyboardEvent("keydown", { key: "a", code: "KeyA", bubbles: true, cancelable: true });
    document.body.dispatchEvent(a);
    out.a = a.defaultPrevented;
    return out;
  }, MAC);
  expect(prevented).toEqual({ F5: true, "Ctrl+Shift+R": true, F7: true, "Ctrl+U": true, a: false });
  await page.keyboard.press("F5");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
});

test("Open Recent lists other folders and opens one", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("tmcode:ui", JSON.stringify({ recent: [{ name: "other-project", root: "memory://folders/other-project" }] }));
    localStorage.setItem("tmcode:mock-folder:memory://folders/other-project", JSON.stringify({ "hello.py": "print('hi')\n" }));
  });
  await boot(page);
  await palette(page, "File: Open Recent");
  const item = page.locator(".tm-qi-item", { hasText: "other-project" }).first();
  await expect(item).toBeVisible();
  await expect(page.locator(".tm-qi-item", { hasText: "Clear Recently Opened" }).first()).toBeVisible();
  await item.click();
  await expect(row(page, "hello.py")).toBeVisible();
});

test("next / previous editor, move editor, close others / to the right / saved", async ({ page }) => {
  await boot(page);
  await autoSaveOff(page);
  await open(page, "main.py", "README.md", "src/utils.ts", "js/sum.js");
  await expect(tabs(page)).toHaveText(["main.py", "README.md", "utils.ts", "sum.js"]);

  const next = MAC ? "Meta+Alt+ArrowRight" : "Control+PageDown";
  const prev = MAC ? "Meta+Alt+ArrowLeft" : "Control+PageUp";
  await page.keyboard.press(prev);
  await expect(activeTab(page)).toContainText("utils.ts");
  await page.keyboard.press(next);
  await page.keyboard.press(next);
  // Past the last editor: back to the first.
  await expect(activeTab(page)).toContainText("main.py");

  await palette(page, "View: Move Editor Right");
  await expect(tabs(page)).toHaveText(["README.md", "main.py", "utils.ts", "sum.js"]);
  await palette(page, "View: Move Editor Left");
  await expect(tabs(page)).toHaveText(["main.py", "README.md", "utils.ts", "sum.js"]);

  // Close Editors to the Right of utils.ts.
  await tab(page, "utils.ts").click();
  await palette(page, "View: Close Editors to the Right in Group");
  await expect(tabs(page)).toHaveText(["main.py", "README.md", "utils.ts"]);

  // Close Saved (⌘K U) keeps the unsaved one.
  await tab(page, "README.md").click();
  await typeInEditor(page, "\nmore");
  await expect(tab(page, "README.md")).toHaveClass(/is-dirty/);
  await page.locator(".tm-statusbar").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await palette(page, "View: Close Saved Editors in Group");
  await expect(tabs(page)).toHaveText(["README.md"]);

  // Close Other Editors.
  await open(page, "main.py");
  await palette(page, "View: Close Other Editors in Group");
  await expect(page.getByRole("alertdialog").filter({ hasText: "README.md" })).toBeVisible();
  await page.getByRole("button", { name: "Don't Save" }).click();
  await expect(tabs(page)).toHaveText(["main.py"]);
});

test("move editor into the next group, compare with saved", async ({ page }) => {
  await boot(page);
  await autoSaveOff(page);
  await open(page, "main.py", "README.md");
  await palette(page, "View: Move Editor into Next Group");
  await expect(page.locator(".tm-editor-group")).toHaveCount(2);
  await expect(page.locator(".tm-editor-group").nth(1).locator(".tm-tab .tm-tab-label")).toHaveText(["README.md"]);
  await palette(page, "View: Move Editor into Previous Group");
  await expect(page.locator(".tm-editor-group")).toHaveCount(1);

  await open(page, "main.py");
  await typeInEditor(page, "\n# compare me");
  // ⌘K D from the tab (the e2e browser's Monaco takes a Windows ⌘K for its own chords).
  await tab(page, "main.py").click();
  await page.keyboard.press(`${MOD}+k`);
  await page.keyboard.press("d");
  await expect(page.getByTestId("saved-compare")).toBeVisible();
  await expect(activeTab(page)).toContainText("main.py (Saved) ↔ Current");
  await expect(page.locator(".tm-git-diff .modified .view-lines")).toContainText("compare me");
});

test("layout toggles hide the activity bar and status bar, and move the side bar", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".tm-activitybar")).toBeVisible();
  await palette(page, "View: Toggle Activity Bar Visibility");
  await expect(page.locator(".tm-activitybar")).toBeHidden();
  await palette(page, "View: Toggle Status Bar Visibility");
  await expect(page.locator(".tm-statusbar")).toBeHidden();
  await palette(page, "View: Toggle Primary Side Bar Position");
  const side = await page.locator(".tm-sidebar").first().boundingBox();
  const editor = await page.locator(".tm-editor-area").boundingBox();
  expect(side!.x).toBeGreaterThan(editor!.x);
  // Saved with the settings: still that way after a reload.
  await page.reload();
  await expect(page.locator(".tm-titlebar")).toBeVisible();
  await expect(page.locator(".tm-statusbar")).toBeHidden();
  await palette(page, "View: Toggle Status Bar Visibility");
  await palette(page, "View: Toggle Activity Bar Visibility");
  await palette(page, "View: Toggle Primary Side Bar Position");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await expect(page.locator(".tm-activitybar")).toBeVisible();
});

test("the notification centre keeps dismissed toasts; the bell opens it", async ({ page }) => {
  await boot(page);
  await palette(page, "Terminal: Clear Command History");
  const toast = page.locator(".tm-toast", { hasText: "Terminal command history cleared." });
  await expect(toast).toBeVisible();
  await toast.getByRole("button", { name: "Clear Notification" }).click();
  await expect(toast).toBeHidden();

  await page.locator(".tm-status-bell").click();
  const centre = page.getByTestId("notification-center");
  await expect(centre).toBeVisible();
  await expect(centre.getByTestId("notification-entry")).toContainText(["Terminal command history cleared."]);
  await centre.getByRole("button", { name: "Clear All Notifications" }).click();
  await expect(centre.getByTestId("notification-entry")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(centre).toBeHidden();

  await palette(page, "Notifications: Toggle Do Not Disturb Mode");
  await palette(page, "Terminal: Clear Command History");
  await expect(page.locator(".tm-toast", { hasText: "Terminal command history cleared." })).toHaveCount(0);
  await palette(page, "Notifications: Show Notifications");
  await expect(centre.getByTestId("notification-entry")).toContainText(["Terminal command history cleared."]);
});

test("Run Build Task runs the default build task from tasks.json", async ({ page }) => {
  await boot(page, "?terminal=sim");
  await page.evaluate(() =>
    (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite(
      ".vscode/tasks.json",
      JSON.stringify({ version: "2.0.0", tasks: [{ label: "Build It", type: "shell", command: "echo", args: ["built", "ok"], group: { kind: "build", isDefault: true } }] }),
    ),
  );
  await page.locator(".tm-explorer").click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press(`${MOD}+Shift+b`);
  await expect(page.getByTestId("terminal-title")).toHaveText("Build It");
  await expect(page.getByTestId("integrated-terminal")).toContainText("built ok");
});

test("Insert Snippet inserts a user snippet; Configure User Snippets opens its file", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("tmcode:userSnippets", JSON.stringify({ python: '{\n  "Hello": { "prefix": "hi", "body": "print(\\"hello ${1:name}\\")$0" }\n}\n' }));
  });
  await boot(page);
  await open(page, "main.py");
  await page.locator(".tm-editor-group .monaco-editor .view-lines").first().click();
  await page.keyboard.press(`${MOD}+Home`);
  await palette(page, "Snippets: Insert Snippet");
  await expect(page.locator(".tm-qi-item", { hasText: "Hello" }).first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-editor-group .monaco-editor .view-lines").first()).toContainText('print("hello name")');

  await palette(page, "Snippets: Configure User Snippets");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("Python");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("snippets-editor")).toBeVisible();
  await expect(activeTab(page)).toContainText("python.json");
});
