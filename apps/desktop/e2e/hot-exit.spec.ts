import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3 (never lose work): hot exit and crash recovery, binary files
 * (Open Anyway, hex viewer) and large files, as in VS Code.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void>; beforeQuit(): Promise<boolean> };
const debug = <T,>(page: Page, fn: (d: Debug) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_DEBUG__)`) as Promise<T>;
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const tab = (page: Page, name: string) => page.locator(".tm-tab", { hasText: name });
const editor = (page: Page) => page.locator(".monaco-editor .view-lines").first();

async function fresh(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    localStorage.setItem("tmcode:ui", JSON.stringify({ settings: { "files.autoSave": "off", ...s } }));
  }, settings);
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function typeInto(page: Page, path: string, text: string) {
  await row(page, path).dblclick();
  await expect(editor(page)).toContainText("def letter");
  await editor(page).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type(text);
  await expect(tab(page, path)).toHaveClass(/is-dirty/);
}

test("after a crash, unsaved files and untitled buffers come back unsaved", async ({ page }) => {
  await fresh(page);
  await typeInto(page, "main.py", "# typed but never saved");
  await page.keyboard.press("ControlOrMeta+n");
  await editor(page).click();
  await page.keyboard.type("scratch notes");
  await expect(tab(page, "Untitled-1")).toHaveClass(/is-dirty/);
  // The backup is written a moment after the last edit; then the page dies (no quit).
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await expect(page.locator(".tm-notification, .tm-toast").filter({ hasText: "TMCode closed unexpectedly" })).toBeVisible();
  await expect(tab(page, "main.py")).toHaveClass(/is-dirty/);
  await tab(page, "main.py").click();
  await expect(editor(page)).toContainText("# typed but never saved");
  await tab(page, "Untitled-1").click();
  await expect(editor(page)).toContainText("scratch notes");
});

test("quitting with unsaved files doesn't ask; they come back next time", async ({ page }) => {
  await fresh(page);
  await typeInto(page, "main.py", "# kept by hot exit");
  expect(await debug(page, (d) => d.beforeQuit())).toBe(true);
  await expect(page.locator(".tm-dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".tm-notification, .tm-toast").filter({ hasText: "Restored 1 unsaved file from your last session." })).toBeVisible();
  await tab(page, "main.py").click();
  await expect(editor(page)).toContainText("# kept by hot exit");
});

test("saving clears the backup", async ({ page }) => {
  await fresh(page);
  await typeInto(page, "main.py", "# saved now");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(tab(page, "main.py")).not.toHaveClass(/is-dirty/);
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(".tm-notification, .tm-toast").filter({ hasText: /unsaved file/ })).toHaveCount(0);
});

test("a binary file offers Open Anyway (read-only) and the hex viewer", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "data.bin", "AB\u0000\u0001helloÿ");
  await row(page, "data.bin").dblclick();
  const notice = page.getByTestId("binary-notice");
  await expect(notice).toContainText("either binary or uses an unsupported text encoding");
  await notice.getByRole("button", { name: "Open in Hex Viewer" }).click();
  const hex = page.getByTestId("hex-view");
  await expect(hex).toContainText("00000000");
  await expect(hex).toContainText("41 42 00 01 68 65 6c 6c  6f ff");
  await expect(hex).toContainText("AB..hello.");
  await expect(hex).toContainText("10 bytes");

  await row(page, "main.py").dblclick();
  await row(page, "data.bin").dblclick();
  await page.getByTestId("binary-notice").getByRole("button", { name: "Open Anyway" }).click();
  await expect(editor(page)).toContainText("hello");
  await editor(page).click();
  await page.keyboard.type("x");
  await expect(tab(page, "data.bin")).not.toHaveClass(/is-dirty/);
});

test("a large file opens in large-file mode", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "big.log", `${"log line\n".repeat(700_000)}`);
  await row(page, "big.log").dblclick();
  const banner = page.getByTestId("large-file-banner");
  await expect(banner).toContainText("This file is large");
  await expect(page.locator(".monaco-editor .minimap").first()).toBeHidden();
  await banner.getByRole("button", { name: "OK" }).click();
  await expect(banner).toHaveCount(0);
});
