import { expect, test, type Page } from "@playwright/test";

/** Phase 2 acceptance (browser build): run, visible tests, diff, static + React preview. */

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
});

async function open(page: Page, ...path: string[]) {
  for (const dir of path.slice(0, -1)) await row(page, dir).click();
  await row(page, path[path.length - 1]).dblclick();
  await expect(page.locator(".tm-tab.is-active")).toBeVisible();
}

test("F5 runs a JavaScript file and shows the exit status", async ({ page }) => {
  await open(page, "js", "js/sum.js");
  await page.keyboard.press("F5");
  const consoleEl = page.getByTestId("run-console");
  await expect(consoleEl).toContainText("node sum.js");
  await expect(consoleEl).toContainText("exited with code 0");
  await expect(page.locator(".tm-panel-run-label")).toHaveText("JavaScript (Node.js): sum.js");
});

test("runtime errors become Problems", async ({ page }) => {
  await open(page, "js", "js/sum.js");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+g");
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.type("\nnull.boom();");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("run-console")).toContainText("exited with code 1");
});

test("visible tests run locally and failures open a diff", async ({ page }) => {
  await page.locator('.tm-activity[aria-label^="Testing"]').click();
  await expect(page.locator(".tm-test-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Run All Tests" }).click();
  await expect(page.locator(".tm-test-summary")).toContainText("3/3 passed");

  // Break the program: every test now fails, and the diff shows expected vs actual.
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await open(page, "js", "js/sum.js");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type('console.log("wrong");');
  await page.locator('.tm-activity[aria-label^="Testing"]').click();
  await page.getByRole("button", { name: "Run All Tests" }).click();
  await expect(page.locator(".tm-test-summary")).toContainText("0/3 passed");
  await expect(page.locator(".tm-activity-badge.is-error")).toHaveText("3");
  await page.locator(".tm-test-row").first().click();
  await expect(page.locator(".tm-testdiff-head")).toContainText("Output does not match");
  await expect(page.locator(".tm-testdiff-editor")).toContainText("wrong");
});

test("static preview with console output and in-preview navigation", async ({ page }) => {
  await open(page, "web", "web/index.html");
  await page.keyboard.press("F5");
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator("h1")).toHaveText("Hello, NGA!");
  // style.css was applied (inlined in the browser build)
  await expect(frame.locator("body")).toHaveCSS("margin", "32px");
  await frame.locator("#theme").click();
  await expect(page.locator(".tm-preview-console")).toContainText("dark mode: true");
  await frame.getByRole("link", { name: "About me" }).click();
  await expect(frame.locator("h1")).toHaveText("About me");
  await expect(page.locator(".tm-preview-address")).toContainText("web/about.html");
});

test("live preview reloads while typing", async ({ page }) => {
  await open(page, "web", "web/index.html");
  await page.keyboard.press("F5");
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator("h1")).toHaveText("Hello, NGA!");
  await page.locator(".tm-tab", { hasText: "index.html" }).first().click();
  await page.locator(".monaco-editor .view-lines").first().click();
  // Line 10 is `    <h1>Hello, NGA!</h1>`: select "NGA" and retype it.
  await page.keyboard.press("Control+g");
  await page.keyboard.type("10");
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.type("Kigali");
  await expect(frame.locator("h1")).toHaveText("Hello, Kigali!", { timeout: 5000 });
});

test("React preview bundles offline with vendored React", async ({ page }) => {
  await open(page, "react-app", "react-app/src", "react-app/src/App.jsx");
  await page.keyboard.press("F5");
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  const button = frame.getByRole("button");
  await expect(button).toHaveText("Clicked 0 times", { timeout: 20000 });
  await button.click();
  await expect(button).toHaveText("Clicked 1 times");
  await expect(page.locator(".tm-preview-console")).toContainText("render 1");
});

test("unknown packages give a clear React build error", async ({ page }) => {
  await open(page, "react-app", "react-app/src", "react-app/src/App.jsx");
  await page.locator(".monaco-editor .view-lines").click();
  // Go to line 1 (Ctrl/Cmd+Home isn't reliable across WebKit builds).
  await page.keyboard.press("Control+g");
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await page.keyboard.type('import axios from "axios";\n');
  await page.keyboard.press("F5");
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator("body")).toContainText("Package 'axios' is not available", { timeout: 20000 });
});

test("device presets scale the page", async ({ page }) => {
  await open(page, "web", "web/index.html");
  await page.keyboard.press("F5");
  await page.getByRole("radio", { name: "Mobile (375)" }).click();
  await expect(page.locator(".tm-preview-device")).toHaveCSS("width", "375px");
});
