import { expect, test, type Page } from "@playwright/test";

/** The Run hub: ▶ Run in the status bar and editor title, Run targets, live preview, the JavaScript Console, dev servers. */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const mod = process.platform === "darwin" ? "Meta" : "Control";
// Screenshots for the change description (RUN_HUB_SHOTS=<folder>).
const shot = async (page: Page, name: string, browserName: string) => {
  if (process.env.RUN_HUB_SHOTS) await page.screenshot({ path: `${process.env.RUN_HUB_SHOTS}/${browserName}-${name}.png` });
};

async function fresh(page: Page, query = "", settings: Record<string, unknown> = {}) {
  await page.goto(`/${query}`);
  await page.evaluate((s) => {
    localStorage.clear();
    if (Object.keys(s).length) localStorage.setItem("tmcode:ui", JSON.stringify({ settings: s }));
  }, settings);
  await page.reload();
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
async function open(page: Page, ...path: string[]) {
  for (const dir of path.slice(0, -1)) await row(page, dir).click();
  await row(page, path[path.length - 1]).dblclick();
  await expect(page.locator(".tm-tab.is-active")).toContainText(path[path.length - 1].split("/").pop()!);
}

const status = (page: Page) => page.getByTestId("run-hub-status");

async function chooseTarget(page: Page, label: string) {
  await page.locator(".tm-statusbar").getByRole("button", { name: "Run Menu" }).click();
  await page.getByTestId("run-menu").getByRole("menuitem", { name: /Change Run Target/ }).click();
  await expect(page.locator(".tm-quick-pick")).toContainText(label);
  await page.keyboard.type(label);
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveAttribute("aria-label", `Run Project: ${label}`);
}

test("the status bar runs the project target, and Change Run Target… is remembered per folder", async ({ page, browserName }) => {
  await fresh(page);
  // The browser build can't run Python, so the first runnable project is the React app (bundled by TMCode).
  await expect(status(page)).toHaveAttribute("aria-label", "Run Project: React - react-app (Live Preview)");

  await page.getByRole("button", { name: "Run Menu" }).click();
  const menu = page.getByTestId("run-menu");
  await expect(menu.getByRole("menuitem", { name: /Run Project: React/ })).toBeVisible();
  await shot(page, "run-menu-status", browserName);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await chooseTarget(page, "index.html - web (Live Preview)");
  // Remembered for this folder after a restart.
  await page.reload();
  await expect(status(page)).toHaveAttribute("aria-label", "Run Project: index.html - web (Live Preview)");

  // Run Project (Ctrl/Cmd+Shift+F10) runs it.
  await page.keyboard.press(`${mod}+Shift+F10`);
  await expect(page.frameLocator('[data-testid="preview-frame"]').locator("h1")).toHaveText("Hello, NGA!");
  await shot(page, "status-target", browserName);
});

test("static site live preview reloads on save and keeps the scroll position", async ({ page, browserName }) => {
  await fresh(page, "", { "livePreview.updateOn": "onSave", "files.autoSave": "off" });
  await externalWrite(page, "web/long.html", `<!doctype html>\n<h1 id="title">\nVersion 1\n</h1>\n<div style="height:3000px">filler</div>\n`);
  await open(page, "web", "web/long.html");
  // The editor title's ▶ is a split button whose main action for HTML is Live Preview.
  await expect(page.getByTestId("editor-run-button")).toHaveAttribute("aria-label", /^Live Preview/);
  await page.getByTestId("editor-run-button").click();
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect(frame.locator("#title")).toHaveText("Version 1");
  await expect(page.getByRole("button", { name: /Updates on Save/ })).toBeVisible();

  // Scroll the page down, then edit: nothing changes until the file is saved.
  const inner = async () => (await page.getByTestId("preview-frame").elementHandle())!.contentFrame();
  await (await inner())!.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(400);
  await page.locator(".tm-tab", { hasText: "long.html" }).first().click();
  await page.locator(".monaco-editor .view-lines").first().click();
  // Line 3 is "Version 1": make it "Version 2".
  await page.keyboard.press("Control+g");
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await page.keyboard.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("2");
  await page.waitForTimeout(1200);
  await expect(frame.locator("#title")).toHaveText("Version 1");
  await page.keyboard.press(`${mod}+s`);
  await expect(frame.locator("#title")).toHaveText("Version 2");
  await expect.poll(async () => (await inner())!.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  await shot(page, "live-preview", browserName);
});

test("a JavaScript file runs in the JavaScript Console with structured output and a REPL", async ({ page, browserName }) => {
  await fresh(page);
  await externalWrite(
    page,
    "js/shapes.js",
    [
      "const circle = { name: 'Ada', tags: ['math', 'code'], nested: { deep: { deeper: { deepest: 1 } } } };",
      "console.log('hello', circle);",
      "console.warn('careful');",
      "console.log([1, 2, 3]);",
      "function area(shape) {",
      "  return shape.size.width * 2;",
      "}",
      "area({});",
      "",
    ].join("\n"),
  );
  await open(page, "js", "js/shapes.js");
  await expect(page.getByTestId("editor-run-button")).toHaveAttribute("aria-label", "Run in JavaScript Console");
  await page.getByTestId("editor-run-button").click();
  const jsc = page.getByTestId("js-console");
  await expect(jsc).toBeVisible();
  await expect(jsc).toContainText("hello {name: 'Ada', tags: Array(2), nested: {…}}");
  await expect(jsc).toContainText("(3) [1, 2, 3]");
  await expect(jsc.locator(".tm-jsc-entry.is-warn")).toContainText("careful");
  // Objects expand (deeper levels load from the worker on demand).
  await jsc.locator(".tm-jsv-head", { hasText: "{name: 'Ada'" }).click();
  await expect(jsc).toContainText("tags");
  await jsc.locator(".tm-jsv-head", { hasText: /^nested/ }).click();
  await jsc.locator(".tm-jsv-head", { hasText: /^deep:/ }).click();
  await jsc.locator(".tm-jsv-head", { hasText: /^deeper/ }).click();
  await expect(jsc).toContainText("deepest: 1");
  // The uncaught error links to the line that threw.
  const error = jsc.locator(".tm-jsc-entry.is-error:not(.is-system)");
  await expect(error).toContainText("Uncaught TypeError");
  await expect(jsc.locator(".tm-jsc-entry.is-system.is-error")).toContainText("Failed after");
  await expect(page.getByTestId("run-state-badge")).toContainText("error");
  await shot(page, "js-console", browserName);
  await error.locator(".tm-jsv-link", { hasText: "js/shapes.js:6" }).first().click();
  await expect(page.locator(".tm-statusbar")).toContainText("Ln 6");

  // The REPL keeps the program's context and its own declarations.
  await page.locator(".tm-panel-tab", { hasText: "JavaScript Console" }).click();
  const input = page.getByTestId("js-console-input");
  await input.fill("circle.tags.length + 40");
  await input.press("Enter");
  await expect(jsc.locator(".tm-jsc-entry.is-result").last()).toHaveText("42");
  await input.fill("let twice = (n) => n * 2");
  await input.press("Enter");
  await input.fill("twice(21)");
  await input.press("Enter");
  await expect(jsc.locator(".tm-jsc-entry.is-result").last()).toHaveText("42");
  await input.fill("await Promise.resolve({ ok: true })");
  await input.press("Enter");
  await expect(jsc.locator(".tm-jsc-entry.is-result").last()).toContainText("{ok: true}");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("await Promise.resolve({ ok: true })");
});

test("TypeScript with imports runs in the JavaScript Console, errors mapped to the source", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "ts/math.ts", "export function half(n: number): number {\n  if (n < 0) throw new RangeError('negative');\n  return n / 2;\n}\n");
  await externalWrite(page, "ts/main.ts", "import { half } from './math';\nconst values: number[] = [8, 4];\nconsole.log(values.map(half));\nhalf(-1);\n");
  await open(page, "ts", "ts/main.ts");
  await page.getByTestId("editor-run-button").click();
  const jsc = page.getByTestId("js-console");
  // The first TypeScript run loads esbuild-wasm, which can take several seconds in a cold WebKit.
  await expect(jsc).toContainText("(2) [4, 2]", { timeout: 30_000 });
  await expect(jsc.locator(".tm-jsc-entry.is-error:not(.is-system)")).toContainText("Uncaught RangeError: negative");
  await expect(jsc.locator(".tm-jsv-link", { hasText: "ts/math.ts:2" }).first()).toBeVisible();
});

test("a runaway program in the JavaScript Console can be stopped", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "js/loop.js", "console.log('start');\nwhile (true) {}\n");
  await open(page, "js", "js/loop.js");
  await page.getByTestId("editor-run-button").click();
  await expect(page.getByTestId("js-console")).toContainText("start");
  await expect(status(page)).toHaveAttribute("aria-label", "Stop loop.js");
  await expect(status(page).locator(".tm-run-elapsed")).toHaveText(/0:0\d/);
  await page.keyboard.press("Shift+F5");
  await expect(page.getByTestId("js-console")).toContainText("Stopped");
  await expect(status(page)).toHaveAttribute("aria-label", /^Run Project/);
});

test("the editor title's Run menu offers every action for the file", async ({ page, browserName }) => {
  await fresh(page);
  await open(page, "js", "js/sum.js");
  // sum.js reads stdin, so Node (Run panel) is the main action and the console is in the menu.
  await expect(page.getByTestId("editor-run-button")).toHaveAttribute("aria-label", /^Run File/);
  await page.getByTestId("editor-run-menu").click();
  const menu = page.getByTestId("run-menu");
  await expect(menu.getByRole("menuitem", { name: /Run sum\.js with Node\.js/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Node\.js REPL/ })).toHaveAttribute("aria-disabled", "true");
  await shot(page, "run-menu-title", browserName);
  // Keyboard first: arrows + Enter.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("js-console")).toBeVisible();
  // The choice is remembered for .js files.
  await expect(page.getByTestId("editor-run-button")).toHaveAttribute("aria-label", "Run in JavaScript Console");
});

test("a dev server runs in a named terminal, opens the browser, and stops", async ({ page, browserName }) => {
  await fresh(page, "?terminal=sim");
  await externalWrite(page, "vite-app/node_modules/.package-lock.json", "{}");
  await externalWrite(page, "vite-app/index.html", "<!doctype html><title>Vite</title><div id=app></div>");
  await externalWrite(page, "vite-app/package.json", JSON.stringify({ name: "vite-app", devDependencies: { vite: "^6.0.0" }, scripts: { dev: "vite --port 5199 --slow", build: "vite build" } }));
  await chooseTarget(page, "npm: dev - vite-app");

  await status(page).click();
  // Starting… in a named terminal, then running with the browser beside the editor.
  await expect(status(page)).toHaveAttribute("aria-label", "Stop npm: dev - vite-app");
  await expect(status(page)).toHaveClass(/is-starting/);
  await expect(page.getByTestId("integrated-terminal")).toContainText("ready in", { timeout: 10_000 });
  await expect(status(page)).toHaveClass(/is-running/);
  await expect(page.locator(".tm-tab", { hasText: "localhost:5199" })).toBeVisible();
  await expect(page.locator(".tm-statusbar")).toContainText("localhost:5199");
  // The generic "available on port" toast stays quiet for servers the Run hub started.
  await expect(page.locator(".tm-toast", { hasText: "port 5199" })).toHaveCount(0);
  await shot(page, "dev-server", browserName);

  // Run Project again doesn't start a second copy.
  await page.keyboard.press(`${mod}+Shift+F10`);
  await expect(page.locator(".tm-tab", { hasText: "localhost:5199" })).toHaveCount(1);

  // Restart: stops (Ctrl+C) and starts again.
  await page.locator(".tm-statusbar").getByRole("button", { name: "Restart" }).click();
  await expect(status(page)).toHaveClass(/is-st(opping|arting)/);
  await expect(status(page)).toHaveClass(/is-running/, { timeout: 10_000 });

  // ■ Stop: Ctrl+C, the terminal ends, the item goes back to ▶ with the exit badge.
  await status(page).click();
  await expect(status(page)).toHaveAttribute("aria-label", "Run Project: npm: dev - vite-app");
  await expect(page.getByTestId("run-hub-outcome")).toContainText("exit 130");
});

test("a dev server that crashes on start shows the failure", async ({ page }) => {
  await fresh(page, "?terminal=sim");
  await externalWrite(page, "broken/node_modules/.keep", "");
  await externalWrite(page, "broken/package.json", JSON.stringify({ name: "broken", dependencies: { next: "15", react: "19" }, scripts: { dev: "next dev --fail" } }));
  await chooseTarget(page, "npm: dev - broken");
  await status(page).click();
  await expect(page.locator(".tm-toast", { hasText: "npm: dev - broken stopped with exit code 1 before it was ready" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("run-hub-outcome")).toContainText("exit 1");
  await expect(page.getByTestId("run-hub-outcome")).toHaveClass(/is-fail/);
});
