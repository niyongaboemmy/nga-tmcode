import { expect, test, type Page } from "@playwright/test";

/** 0.10.6: docs/reviews/2026-10-10-ux-gap-review P0-1 (folder switch), P0-8 (quit guard), P0-12 (Trash). */

const mod = process.platform === "darwin" ? "Meta" : "Control";
const B = "memory://folders/folder-b";

async function fresh(page: Page) {
  // Seed storage before any app code runs (once per test), so a save from a still-starting page can't overwrite it.
  await page.addInitScript((b) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    // No auto save: the edits stay unsaved. Folder B is a second project with its own main.py.
    localStorage.setItem("tmcode:ui", JSON.stringify({ settings: { "files.autoSave": "off" }, recent: [{ name: "folder-b", root: b }] }));
    localStorage.setItem(`tmcode:mock-folder:${b}`, JSON.stringify({ "main.py": "print('folder B')\n", "b-only.txt": "B\n" }));
  }, B);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const tab = (page: Page, name: string) => page.locator(".tm-tab", { hasText: name });
const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();
const dialog = (page: Page) => page.locator(".tm-dialog");

async function editMainPy(page: Page, text: string) {
  await row(page, "main.py").dblclick();
  await expect(editor(page)).toContainText("def letter");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);
}

/** Welcome page → Recent: the same openRecent as File > Open Recent. */
async function openRecent(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type("Help: Welcome");
  await page.keyboard.press("Enter");
  await page.locator(".tm-welcome-recent", { hasText: name }).first().click();
}

test("switching folders asks about unsaved files; Cancel keeps the folder, and B's main.py is B's", async ({ page }) => {
  await fresh(page);
  await editMainPy(page, "# unsaved in A");

  await openRecent(page, "folder-b");
  await expect(dialog(page)).toContainText("Do you want to save the changes you made to main.py?");
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(dialog(page)).toBeHidden();
  // Still folder A, with the edit.
  await expect(row(page, "README.md")).toBeVisible();
  await expect(row(page, "b-only.txt")).toHaveCount(0);
  await tab(page, "main.py").click();
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);
  await expect(editor(page)).toContainText("# unsaved in A");

  await openRecent(page, "folder-b");
  await dialog(page).getByRole("button", { name: "Don't Save" }).click();
  await expect(row(page, "b-only.txt")).toBeVisible();
  await expect(page.locator(".tm-tab")).toHaveCount(0);
  await row(page, "main.py").dblclick();
  await expect(editor(page)).toContainText("print('folder B')");
  await expect(editor(page)).not.toContainText("unsaved in A");
  await expect(tab(page, "main.py")).not.toHaveClass(/is-dirty/);

  // Back in A: the dropped edit is gone, the file is A's.
  await openRecent(page, "practice-project");
  await expect(row(page, "README.md")).toBeVisible();
  await row(page, "main.py").dblclick();
  await expect(editor(page)).toContainText("def letter");
  await expect(editor(page)).not.toContainText("unsaved in A");
});

test("Save writes A's file before switching, and never into B", async ({ page }) => {
  await fresh(page);
  await editMainPy(page, "# saved in A");
  await openRecent(page, "folder-b");
  await expect(dialog(page)).toContainText("main.py");
  await dialog(page).getByRole("button", { name: "Save", exact: true }).click();
  await expect(row(page, "b-only.txt")).toBeVisible();
  await row(page, "main.py").dblclick();
  await expect(editor(page)).toContainText("print('folder B')");

  await openRecent(page, "practice-project");
  await row(page, "main.py").dblclick();
  await expect(editor(page)).toContainText("# saved in A");
});

test("the quit guard asks about unsaved files: Cancel keeps TMCode open, Don't Save quits", async ({ page }) => {
  await fresh(page);
  expect(await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { beforeQuit: () => Promise<boolean> } }).__TMCODE_DEBUG__.beforeQuit())).toBe(true);
  await editMainPy(page, "# not saved yet");
  const ask = () =>
    page.evaluate(() => {
      const w = window as unknown as { __TMCODE_DEBUG__: { beforeQuit: () => Promise<boolean> }; __quit?: Promise<boolean> };
      w.__quit = w.__TMCODE_DEBUG__.beforeQuit();
    });
  const result = () => page.evaluate(() => (window as unknown as { __quit: Promise<boolean> }).__quit);
  await ask();
  await expect(dialog(page)).toContainText("Do you want to save the changes you made to main.py?");
  await expect(dialog(page).getByRole("button", { name: "Save", exact: true })).toBeFocused();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  expect(await result()).toBe(false);
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);

  await ask();
  await dialog(page).getByRole("button", { name: "Don't Save" }).click();
  expect(await result()).toBe(true);
});

test("Delete moves to the Trash (Move to Trash focused); if that fails, a permanent delete asks with Cancel focused", async ({ page }) => {
  await fresh(page);
  await row(page, "README.md").click({ button: "right" });
  await page.locator(".tm-menu-item", { hasText: "Delete" }).click();
  await expect(dialog(page)).toContainText("Are you sure you want to delete 'README.md'?");
  await expect(dialog(page)).toContainText("You can restore this file from the Trash.");
  await expect(dialog(page).getByRole("button", { name: "Move to Trash" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row(page, "README.md")).toHaveCount(0);

  // No Trash (a network drive, a full disk…): ask again, and Enter keeps the file.
  await page.evaluate(() => localStorage.setItem("tmcode:mock-trash-fail", "1"));
  await row(page, "main.py").click();
  await page.keyboard.press(process.platform === "darwin" ? `${mod}+Backspace` : "Delete");
  await dialog(page).getByRole("button", { name: "Move to Trash" }).click();
  await expect(dialog(page)).toContainText("Could not move 'main.py' to the Trash. Do you want to permanently delete it instead?");
  await expect(dialog(page)).toContainText("This cannot be undone.");
  await expect(dialog(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeHidden();
  await expect(row(page, "main.py")).toBeVisible();

  await page.keyboard.press(process.platform === "darwin" ? `${mod}+Backspace` : "Delete");
  await dialog(page).getByRole("button", { name: "Move to Trash" }).click();
  await dialog(page).getByRole("button", { name: "Delete Permanently" }).click();
  await expect(row(page, "main.py")).toHaveCount(0);
});
