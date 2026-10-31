import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 6: Find in the Explorer, file nesting, Open Editors, Explorer files
 * dragged onto TMCode AI's chat, git blame, the commit graph, the merge
 * editor and the Search Editor.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const editorLines = (page: Page) => page.locator(".tm-editor-area .monaco-editor .view-lines").first();

async function boot(page: Page, opts: { settings?: Record<string, unknown>; signedIn?: boolean } = {}) {
  await page.addInitScript((o) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    if (o.signedIn) localStorage.setItem("tmcode:mock-account", "signed-in");
    if (o.settings) localStorage.setItem("tmcode:ui", JSON.stringify({ settings: o.settings }));
  }, opts);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  // Signed in, the side bar starts on Assignments.
  if (!opts.signedIn) await expect(row(page, "main.py")).toBeVisible();
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(command);
  await page.keyboard.press("Enter");
}

test("Find in the Explorer shows matches in folders not opened yet, and Enter opens the first", async ({ page }) => {
  await boot(page);
  await externalWrite(page, "deep/inner/needle_file.py", "print('found')\n");
  await palette(page, "Explorer: Find in Explorer");
  const find = page.getByTestId("explorer-find");
  await find.getByRole("textbox").fill("needle");
  await expect(row(page, "deep/inner/needle_file.py")).toBeVisible();
  await expect(row(page, "deep/inner/needle_file.py").locator("mark")).toHaveText("needle");
  await expect(find).toContainText("1 found");
  await find.getByRole("textbox").press("Enter");
  await expect(page.locator(".tm-tab.is-active")).toContainText("needle_file.py");
  await find.getByRole("textbox").press("Escape");
  await expect(find).toHaveCount(0);
});

test("file nesting: package-lock.json sits under package.json", async ({ page }) => {
  await boot(page, { settings: { "explorer.fileNesting.enabled": true } });
  await externalWrite(page, "package.json", '{ "name": "x" }\n');
  await externalWrite(page, "package-lock.json", "{}\n");
  await expect(row(page, "package.json")).toBeVisible();
  await expect(row(page, "package-lock.json")).toHaveCount(0);
  await row(page, "package.json").locator(".tm-twistie").click();
  await expect(row(page, "package-lock.json")).toBeVisible();
});

test("Open Editors lists open files with their unsaved dot, and closes them", async ({ page }) => {
  await boot(page, { settings: { "files.autoSave": "off" } });
  await row(page, "main.py").dblclick();
  await row(page, "README.md").dblclick();
  const pane = page.getByTestId("open-editors");
  await pane.locator(".tm-pane-header").click();
  await expect(pane.getByTestId("open-editor")).toHaveCount(2);
  await editorLines(page).click();
  await page.keyboard.type("x");
  await expect(pane.locator(".tm-open-editor-close.is-dirty")).toHaveCount(1);
  // The close button shows on hover, as in VS Code.
  // README.md (the active editor) has the unsaved change; main.py closes without asking.
  await pane.getByTestId("open-editor").filter({ hasText: "main.py" }).hover();
  await pane.getByRole("button", { name: "Close main.py" }).click();
  await expect(pane.getByTestId("open-editor")).toHaveCount(1);
});

test("an Explorer file dragged onto TMCode AI's chat is attached", async ({ page }) => {
  await boot(page, { signedIn: true });
  // Signed in, the side bar starts on Assignments: show the Explorer, then the chat (which takes the focus).
  // (The signed-in start may switch to Assignments once the account loads: show the Explorer until it stays.)
  // On a slow machine that switch can come after the chat opens, so both must hold together.
  const chat = page.getByTestId("tmcode-ai-chat");
  await expect(async () => {
    await palette(page, "View: Show Explorer");
    await expect(row(page, "main.py")).toBeVisible({ timeout: 1500 });
    await palette(page, "TMCode AI: Ask TMCode AI");
    await expect(chat).toBeVisible({ timeout: 3000 });
    await page.waitForTimeout(500);
    await expect(row(page, "main.py")).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 30_000 });
  const from = (await row(page, "main.py").boundingBox())!;
  const to = (await chat.boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(chat).toHaveAttribute("data-drag-over", "");
  await page.mouse.up();
  await expect(page.getByTestId("ai-attachment")).toContainText("main.py");
  // Nothing moved in the project.
  await expect(row(page, "main.py")).toBeVisible();
});

test("git blame shows in the status bar and, when asked, after the line", async ({ page }) => {
  await boot(page);
  await row(page, "main.py").dblclick();
  await editorLines(page).click();
  const item = page.locator(".tm-statusbar").getByText(/Ada, \d+ \w+ ago/);
  await expect(item).toBeVisible();
  await palette(page, "Git: Toggle Git Blame Editor Decoration");
  await expect(page.locator(".tm-inline-blame").first()).toBeVisible();
});

test("Source Control shows the commit graph", async ({ page }) => {
  await boot(page);
  await page.getByRole("tab", { name: /^Source Control/ }).click();
  const graph = page.getByTestId("scm-graph");
  await expect(graph.getByRole("listitem")).toHaveCount(2);
  await expect(graph.locator("svg.tm-graph-lanes circle")).toHaveCount(2);
  await expect(graph).toContainText("Add letter grades");
  await expect(graph).toContainText("main");
});

test("the merge editor resolves each conflict and completes the merge", async ({ page }) => {
  await boot(page);
  await externalWrite(page, "grades.py", "x = 0\n<<<<<<< HEAD\nlimit = 90\n=======\nlimit = 85\n>>>>>>> feature/grades\nprint(limit)\n<<<<<<< HEAD\nname = 'a'\n=======\nname = 'b'\n>>>>>>> feature/grades\n");
  await row(page, "grades.py").dblclick();
  await page.locator(".codelens-decoration").getByText("Resolve in Merge Editor").first().click();
  const merge = page.getByTestId("merge-editor");
  await expect(merge.getByTestId("merge-conflict")).toHaveCount(2);
  await expect(merge.getByTestId("merge-count")).toHaveText("0 of 2 conflicts resolved");
  await expect(merge.getByTestId("merge-complete")).toBeDisabled();
  await merge.getByTestId("merge-conflict").nth(0).getByRole("button", { name: "Accept Incoming" }).click();
  await merge.getByTestId("merge-conflict").nth(1).getByRole("button", { name: "Accept Both" }).click();
  await expect(merge.getByTestId("merge-result").nth(1)).toHaveText("name = 'a'\nname = 'b'");
  await expect(merge.getByTestId("merge-count")).toHaveText("2 of 2 conflicts resolved");
  await merge.getByTestId("merge-complete").click();
  await expect(page.locator(".tm-toast").filter({ hasText: "grades.py is merged" })).toBeVisible();
  await expect(editorLines(page)).toContainText("limit = 85");
  await expect(editorLines(page)).not.toContainText("<<<<<<<");
});

test("Search: Open in editor lists the results, and F12 on one opens it", async ({ page }) => {
  await boot(page);
  await page.getByRole("tab", { name: /^Search/ }).click();
  await page.locator(".tm-search input").first().fill("def letter");
  await expect(page.locator(".tm-search-message")).toContainText("result");
  await page.getByTestId("search-open-editor").click();
  await expect(editorLines(page)).toContainText("# Query: def letter");
  await expect(editorLines(page)).toContainText("main.py:");
  // A result line (not the "# Query:" header).
  await page.locator(".tm-editor-area .view-line").filter({ hasText: /\d+:\sdef\sletter/ }).first().click();
  await page.keyboard.press("F12");
  await expect(page.locator(".tm-tab.is-active")).toContainText("main.py");
});
