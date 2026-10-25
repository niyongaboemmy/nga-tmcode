import { expect, test, type Page } from "@playwright/test";

/**
 * Explorer file management, VS Code style (2026-10-25): Paste in the empty space (files copied in
 * Finder / File Explorer too), cut files dimmed, ⌘Z / Ctrl+Z undoes file operations, Option/Ctrl-drag
 * copies, Find in Folder, Select for Compare / Compare with Selected.
 */

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const mod = process.platform === "darwin" ? "Meta" : "Control";
const menuItem = (page: Page, label: string) => page.locator(".tm-menu-item").filter({ has: page.locator(".tm-menu-label", { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });

async function practice(page: Page, osClipboard?: { path: string; content: string }[]) {
  await page.addInitScript((clip) => {
    if (sessionStorage.getItem("fo-seeded")) return;
    sessionStorage.setItem("fo-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    if (clip) localStorage.setItem("tmcode:mock-os-clipboard", JSON.stringify(clip));
  }, osClipboard ?? null);
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await expect(row(page, "main.py")).toBeVisible();
}

/** The empty space under the files. */
const blank = (page: Page) => page.locator(".tm-explorer").click({ button: "right", position: { x: 60, y: 560 } });

test("the empty space offers Paste and the folder tools; nothing to paste says so", async ({ page }) => {
  await practice(page);
  await blank(page);
  await expect(menuItem(page, "Paste")).toBeVisible();
  await expect(menuItem(page, "Find in Folder...")).toBeVisible();
  await menuItem(page, "Paste").click();
  await expect(page.locator(".tm-toast", { hasText: "Nothing to paste" })).toBeVisible();
});

test("files copied in Finder paste into the project, and ⌘Z / Ctrl+Z takes them out again", async ({ page }) => {
  await practice(page, [
    { path: "/Users/student/Desktop/notes.txt", content: "from the desktop" },
    { path: "/Users/student/Desktop/data.csv", content: "a,b\n1,2" },
  ]);
  await blank(page);
  await menuItem(page, "Paste").click();
  await expect(row(page, "notes.txt")).toBeVisible({ timeout: 10_000 });
  await expect(row(page, "data.csv")).toBeVisible();
  await page.locator(".tm-explorer").focus();
  await page.keyboard.press(`${mod}+z`);
  await expect(row(page, "notes.txt")).toHaveCount(0, { timeout: 10_000 });
  await expect(row(page, "data.csv")).toHaveCount(0);
  await expect(page.locator(".tm-toast", { hasText: "Undone: copy of 2 files into the project." })).toBeVisible();
});

test("cut files are dimmed until pasted; the move can be undone", async ({ page }) => {
  await practice(page);
  await row(page, "README.md").click({ button: "right" });
  await menuItem(page, "Cut").click();
  await expect(row(page, "README.md")).toHaveClass(/is-cut/);
  await row(page, "py").click({ button: "right" });
  await menuItem(page, "Paste").click();
  await expect(row(page, "py/README.md")).toBeVisible({ timeout: 10_000 });
  await expect(row(page, "README.md")).toHaveCount(0);
  await row(page, "py/README.md").click();
  await page.keyboard.press(`${mod}+z`);
  await expect(row(page, "README.md")).toBeVisible({ timeout: 10_000 });
  await expect(row(page, "README.md")).not.toHaveClass(/is-cut/);
  await expect(row(page, "py/README.md")).toHaveCount(0);
});

test("a rename, a duplicate and a new file can each be undone", async ({ page }) => {
  await practice(page);
  await row(page, "main.py").click();
  await page.keyboard.press("F2");
  await page.locator(".tm-inline-input").fill("app.py");
  await page.keyboard.press("Enter");
  await expect(row(page, "app.py")).toBeVisible();
  await row(page, "app.py").click({ button: "right" });
  await menuItem(page, "Duplicate").click();
  await expect(row(page, "app copy.py")).toBeVisible();
  await page.locator(".tm-explorer").focus();
  await page.keyboard.press(`${mod}+z`); // the duplicate
  await expect(row(page, "app copy.py")).toHaveCount(0, { timeout: 10_000 });
  await page.keyboard.press(`${mod}+z`); // the rename
  await expect(row(page, "main.py")).toBeVisible({ timeout: 10_000 });
  await expect(row(page, "app.py")).toHaveCount(0);

  await blank(page);
  await menuItem(page, "New File...").click();
  await page.locator(".tm-inline-input").fill("scratch.txt");
  await page.keyboard.press("Enter");
  await expect(row(page, "scratch.txt")).toBeVisible();
  await row(page, "scratch.txt").click();
  await page.keyboard.press(`${mod}+z`);
  await expect(row(page, "scratch.txt")).toHaveCount(0, { timeout: 10_000 });
});

test("dragging with Option (macOS) / Ctrl copies instead of moving", async ({ page }) => {
  await practice(page);
  // The workbench decides by its own OS: read it from the Cut shortcut it shows.
  await row(page, "README.md").click({ button: "right" });
  const mac = (await menuItem(page, "Cut").innerText()).includes("⌘");
  await page.keyboard.press("Escape");
  const from = await row(page, "README.md").boundingBox();
  const to = await row(page, "py").boundingBox();
  await page.mouse.move(from!.x + 20, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(from!.x + 30, from!.y + 20, { steps: 3 });
  await page.keyboard.down(mac ? "Alt" : "Control");
  await page.mouse.move(to!.x + 20, to!.y + to!.height / 2, { steps: 5 });
  await expect(page.getByTestId("explorer-drag-ghost")).toHaveClass(/is-copy/);
  await page.mouse.up();
  await page.keyboard.up(mac ? "Alt" : "Control");
  await expect(row(page, "py/README.md")).toBeVisible({ timeout: 10_000 });
  await expect(row(page, "README.md")).toBeVisible();
});

test("Find in Folder opens Search limited to the folder", async ({ page }) => {
  await practice(page);
  await row(page, "py").click({ button: "right" });
  await menuItem(page, "Find in Folder...").click();
  await expect(page.getByRole("textbox", { name: "files to include" })).toHaveValue("py/**");
});

test("Select for Compare, then Compare with Selected, opens a diff", async ({ page }) => {
  await practice(page);
  await row(page, "main.py").click({ button: "right" });
  await menuItem(page, "Select for Compare").click();
  await row(page, "README.md").click({ button: "right" });
  await menuItem(page, "Compare with Selected").click();
  await expect(page.locator(".tm-editor-area .monaco-diff-editor")).toBeVisible({ timeout: 10_000 });
});
