import { expect, test, type Page } from "@playwright/test";

/**
 * Syntax colouring comes from VS Code's TextMate grammars and themes
 * (vscode-textmate + Oniguruma wasm): the rendered token colours must be
 * VS Code's exact palette.
 */

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

/** Computed colour of the first rendered token whose text is exactly `text`. */
async function tokenColor(page: Page, text: string) {
  const span = page.locator(".monaco-editor .view-lines span span", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first();
  await expect(span).toBeVisible();
  return span.evaluate((el) => getComputedStyle(el).color);
}

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

/** Waits until the textmate tokenizer has coloured the editor (it loads lazily). */
async function waitForColour(page: Page, text: string, hex: string) {
  await expect.poll(() => tokenColor(page, text), { timeout: 15_000 }).toBe(rgb(hex));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("Python in Dark Modern uses VS Code's colours", async ({ page }) => {
  await page.goto("/");
  await row(page, "main.py").dblclick();
  await waitForColour(page, "def", "#569CD6");
  expect(await tokenColor(page, "letter")).toBe(rgb("#DCDCAA"));
  expect(await tokenColor(page, "return")).toBe(rgb("#C586C0"));
  expect(await tokenColor(page, "float")).toBe(rgb("#4EC9B0"));
  expect(await tokenColor(page, '"A"')).toBe(rgb("#CE9178"));
  expect(await tokenColor(page, "80")).toBe(rgb("#B5CEA8"));
  expect(await tokenColor(page, "average")).toBe(rgb("#9CDCFE"));
});

test("TypeScript, JSX and HTML colours; Light Modern recolours tokens and chrome", async ({ page }) => {
  await page.goto("/");
  await row(page, "src").click();
  await row(page, "src/utils.ts").dblclick();
  await waitForColour(page, "export", "#C586C0");
  expect(await tokenColor(page, "function")).toBe(rgb("#569CD6"));
  expect(await tokenColor(page, "average")).toBe(rgb("#DCDCAA"));
  expect(await tokenColor(page, "number")).toBe(rgb("#4EC9B0"));
  expect(await tokenColor(page, "values")).toBe(rgb("#9CDCFE"));

  await row(page, "web").click();
  await row(page, "web/index.html").dblclick();
  await waitForColour(page, "head", "#569CD6");
  expect(await tokenColor(page, "lang")).toBe(rgb("#9CDCFE"));
  expect(await tokenColor(page, '"en"')).toBe(rgb("#CE9178"));

  await row(page, "react-app").click();
  await row(page, "react-app/src").click();
  await row(page, "react-app/src/App.jsx").dblclick();
  await waitForColour(page, "log", "#DCDCAA");
  expect(await tokenColor(page, "main")).toBe(rgb("#569CD6"));
  expect(await tokenColor(page, "onClick")).toBe(rgb("#9CDCFE"));

  // Light Modern: keywords are #0000FF / control flow #AF00DB, like VS Code.
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.type("Light Modern");
  await page.keyboard.press("Enter");
  await waitForColour(page, "return", "#AF00DB");
  expect(await tokenColor(page, "log")).toBe(rgb("#795E26"));
  await expect(page.locator(".tm-root")).toHaveAttribute("data-theme", "light-modern");
});

test("Dark+ recolours the workbench like VS Code", async ({ page }) => {
  await page.goto("/");
  await row(page, "main.py").dblclick();
  await waitForColour(page, "def", "#569CD6");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("ControlOrMeta+t");
  await page.keyboard.type("Dark+");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-root")).toHaveAttribute("data-color-theme", "dark-plus");
  // Dark+'s chrome comes from VS Code's colour registry defaults.
  await expect(page.locator(".tm-statusbar")).toHaveCSS("background-color", rgb("#007ACC"));
  await expect(page.locator(".tm-activitybar")).toHaveCSS("background-color", rgb("#333333"));
  await expect(page.locator(".tm-sidebar")).toHaveCSS("background-color", rgb("#252526"));
  await expect(page.locator(".monaco-editor .monaco-editor-background").first()).toHaveCSS("background-color", rgb("#1E1E1E"));
  expect(await tokenColor(page, "def")).toBe(rgb("#569CD6"));
});
