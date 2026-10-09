import { expect, test, type Page } from "@playwright/test";

/**
 * Run and Debug (browser build): the simulated Python debug adapter speaks
 * real DAP through the same session code the desktop uses with debugpy.
 */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const debugView = (page: Page) => page.getByTestId("debug-view");
const section = (page: Page, id: string) => page.locator(`.tm-debug-section[data-section="${id}"]`);
const toolbar = (page: Page) => page.getByTestId("debug-toolbar");

async function openStats(page: Page) {
  await row(page, "py").click();
  await row(page, "py/stats.py").dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("scores = [72, 85, 90]");
}

async function gotoLine(page: Page, line: number) {
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+g");
  await page.keyboard.type(String(line));
  await page.keyboard.press("Enter");
}

/** Clicks the glyph margin (where breakpoints go) next to `line`. */
async function clickGutter(page: Page, line: number, button: "left" | "right" = "left") {
  const ln = await page.locator(".monaco-editor .line-numbers", { hasText: new RegExp(`^${line}$`) }).first().boundingBox();
  const margin = await page.locator(".monaco-editor .glyph-margin").first().boundingBox();
  if (!ln || !margin) throw new Error("editor margin not found");
  await page.mouse.click(margin.x + margin.width / 2, ln.y + ln.height / 2, { button });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("Run and Debug view: welcome, then create a launch.json from a template", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await page.locator('.tm-activity[aria-label^="Run and Debug"]').click();
  await expect(page.locator(".tm-sidebar-title h2")).toHaveText("Run and Debug");
  await expect(debugView(page).getByRole("button", { name: "Run and Debug" })).toBeVisible();
  await expect(section(page, "breakpoints")).toBeVisible();

  await debugView(page).getByRole("button", { name: "create a launch.json file" }).click();
  const pick = page.getByRole("dialog");
  // Python ×2, Node ×2, Ruby, Swift, C#, PHP ×2, Kotlin, Java ×2, Go, Dart, Flutter, lldb, gdb
  await expect(pick.getByRole("option")).toHaveCount(17);
  for (const label of ["Kotlin: Current File", "Java: Current File", "Java: Attach to JVM (port 5005)", "C#: Debug Project", "PHP: Launch current script", "Ruby: Debug current file", "Swift: Debug Package"]) {
    await expect(pick.getByRole("option", { name: new RegExp(label.replace(/[()]/g, "\\$&")) })).toBeVisible();
  }
  await expect(pick.getByRole("option").filter({ hasText: "Node.js: Launch Program" })).toBeVisible();
  await expect(pick.getByRole("option").filter({ hasText: "C/C++: (lldb) Launch" })).toBeVisible();
  await page.keyboard.type("python file with");
  await page.keyboard.press("Enter");

  await expect(page.locator(".tm-tab.is-active")).toContainText("launch.json");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText('"version": "0.2.0"');
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("${command:pickArgs}");
  await expect(debugView(page).getByRole("combobox", { name: "Debug Launch Configurations" })).toHaveValue("Python Debugger: Current File with Arguments");
  await page.keyboard.press("ControlOrMeta+Shift+e");
  await expect(row(page, ".vscode")).toBeVisible();
});

test("breakpoints, F5, variables, watch, hover, stepping, the Debug Console and continue", async ({ page }) => {
  await page.goto("/");
  await openStats(page);

  // Click in the gutter: a red dot, listed under Breakpoints.
  await clickGutter(page, 5);
  await expect(page.locator(".monaco-editor .tm-bp")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+Shift+d");
  await expect(section(page, "breakpoints").locator(".tm-debug-bp", { hasText: "stats.py" })).toContainText("5");

  // F5 starts debugging (Python has a debugger here) and stops on the breakpoint.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("F5");
  await expect(toolbar(page)).toBeVisible();
  await expect(page.locator(".tm-statusbar")).toHaveClass(/is-debugging/);
  await expect(page.locator(".tm-status-debug")).toContainText("Python Debugger: Current File");
  await expect(section(page, "callstack")).toContainText("Paused on breakpoint");
  await expect(section(page, "callstack").locator(".tm-debug-frame.is-selected")).toContainText("stats.py");
  await expect(page.locator(".monaco-editor .tm-debug-top-frame-line")).toHaveCount(1);
  const vars = section(page, "variables");
  await expect(vars.locator(".tm-debug-var", { hasText: "total" })).toContainText("247");
  await expect(vars.locator(".tm-debug-var", { hasText: "count" })).toContainText("3");

  // Lists expand.
  await vars.locator(".tm-debug-var", { hasText: "scores" }).click();
  await expect(vars.locator(".tm-debug-var", { hasText: /^\s*2\s*90\s*$/ })).toHaveCount(1);

  // Watch.
  await section(page, "watch").hover();
  await section(page, "watch").getByRole("button", { name: "Add Expression", exact: true }).click();
  await page.getByRole("textbox", { name: "Expression to watch" }).fill("total * 2");
  await page.keyboard.press("Enter");
  await expect(section(page, "watch").locator(".tm-debug-watch")).toContainText("494");

  // Hover to evaluate.
  const line3 = await page.locator(".monaco-editor .view-line", { hasText: "total = sum(scores)" }).boundingBox();
  if (!line3) throw new Error("line 3 not rendered");
  await page.mouse.move(line3.x + 12, line3.y + line3.height / 2);
  await expect(page.locator(".monaco-hover:not(.hidden)")).toContainText("total", { timeout: 5000 });
  await expect(page.locator(".monaco-hover:not(.hidden)")).toContainText("247");

  // Step over (F10): line 6, `mean` appears.
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("F10");
  await expect(section(page, "callstack")).toContainText("Paused on step");
  await expect(vars.locator(".tm-debug-var", { hasText: "mean" })).toContainText("82.3");
  await expect(section(page, "watch").locator(".tm-debug-watch")).toContainText("494");

  // The Debug Console evaluates in the paused frame.
  // It opened by itself (the program's output goes there); Ctrl/Cmd+Shift+Y toggles it.
  await expect(page.getByTestId("debug-console")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+y");
  await expect(page.getByTestId("debug-console")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+y");
  const repl = page.getByRole("textbox", { name: "Debug Console input" });
  await repl.fill("best_guess = max(scores) + 1");
  await repl.press("Enter");
  await repl.fill("best_guess - total");
  await repl.press("Enter");
  await expect(page.getByTestId("debug-console")).toContainText("-156");
  await expect(vars.locator(".tm-debug-var", { hasText: "best_guess" })).toContainText("91");

  // Continue to the end: output in the Debug Console, the session ends.
  await toolbar(page).getByRole("button", { name: /^Continue/ }).click();
  await expect(page.getByTestId("debug-console")).toContainText("mean: 82.33333333333333");
  await expect(page.getByTestId("debug-console")).toContainText("best: 90");
  await expect(toolbar(page)).toHaveCount(0);
  await expect(page.locator(".tm-statusbar")).not.toHaveClass(/is-debugging/);
  await expect(page.locator(".monaco-editor .tm-debug-top-frame-line")).toHaveCount(0);
});

test("conditional breakpoint from the gutter menu, the toolbar's step and stop", async ({ page }) => {
  await page.goto("/");
  await openStats(page);

  await clickGutter(page, 4, "right");
  await page.locator(".tm-menu").getByText("Add Conditional Breakpoint...").click();
  await page.getByRole("textbox", { name: /Expression: break when/ }).fill("total > 1000");
  await page.keyboard.press("Enter");
  await expect(page.locator(".monaco-editor .codicon-debug-breakpoint-conditional")).toHaveCount(1);
  // F9 on line 7 adds a plain one.
  await gotoLine(page, 7);
  await page.keyboard.press("F9");
  await expect(page.locator(".monaco-editor .tm-bp")).toHaveCount(2);

  // The condition is false, so the first stop is line 7.
  await page.keyboard.press("F5");
  await expect(section(page, "callstack")).toContainText("Paused on breakpoint");
  await expect(section(page, "variables").locator(".tm-debug-var", { hasText: "mean" })).toBeVisible();
  await expect(section(page, "variables").locator(".tm-debug-var", { hasText: "best" })).toHaveCount(0);

  await toolbar(page).getByRole("button", { name: /^Step Over/ }).click();
  await expect(section(page, "variables").locator(".tm-debug-var", { hasText: "best" })).toContainText("90");
  await toolbar(page).getByRole("button", { name: /^Stop/ }).click();
  await expect(toolbar(page)).toHaveCount(0);

  // Remove the breakpoints from the Breakpoints section.
  await section(page, "breakpoints").hover();
  await section(page, "breakpoints").getByRole("button", { name: "Remove All Breakpoints", exact: true }).click();
  await expect(page.locator(".monaco-editor .tm-bp")).toHaveCount(0);
});

test("Ctrl+F5 runs without debugging; F5 runs a file no debugger covers", async ({ page }) => {
  await page.goto("/");
  await row(page, "js").click();
  await row(page, "js/sum.js").dblclick();
  await expect(page.locator(".tm-tab.is-active")).toContainText("sum.js");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+F5");
  await expect(page.getByTestId("run-console")).toContainText("exited with code 0");
  await expect(toolbar(page)).toHaveCount(0);
  await page.keyboard.press("F5");
  await expect(page.getByTestId("run-console")).toContainText("exited with code 0");
  await expect(toolbar(page)).toHaveCount(0);
});

test("how-to-install cards per language", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await page.keyboard.press("F1");
  await page.keyboard.type("How to Install a Language");
  await page.keyboard.press("Enter");
  const pick = page.getByRole("dialog");
  for (const lang of ["Python", "JavaScript / TypeScript", "Java", "C", "C++", "Go"]) await expect(pick.getByRole("option").filter({ hasText: lang }).first()).toBeVisible();
  await page.keyboard.type("Go");
  await page.keyboard.press("Enter");

  const card = page.getByTestId("install-card");
  await expect(card).toHaveAttribute("data-guide", "go");
  await expect(card).toContainText("Go runs in TMCode's terminal");
  await expect(card).toContainText("Install the Go toolchain first");
  await expect(card).toContainText("go install github.com/go-delve/delve/cmd/dlv@latest");
  await card.getByRole("tab", { name: "Linux" }).click();
  await expect(card).toContainText("sudo apt install golang-go");
  await card.getByRole("tab", { name: "Windows" }).click();
  await expect(card).toContainText("winget install -e --id GoLang.Go");
  await expect(card).toContainText("go version");
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);

  // Java can't run in the browser build: the card says what to install for the desktop app.
  await page.keyboard.press("F1");
  await page.keyboard.type("How to Install a Language");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Java");
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("data-guide", "java");
  await expect(card).toContainText("Java runs in the TMCode desktop app");
});

test.describe("exams", () => {
  test.describe.configure({ mode: "serial" });

  async function launch(page: Page, debuggerAllowed: boolean) {
    await page.request.post(`${TM}/__test/reset`);
    if (debuggerAllowed) await page.request.post(`${TM}/__test/set`, { data: { debugger: true } });
    const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
    await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
    await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  }

  test("Run and Debug is off in an exam by default", async ({ page }) => {
    await launch(page, false);
    await expect(page.locator(".tm-status-mode")).toContainText("Monitored exam");
    await expect(page.locator('.tm-activity[aria-label^="Run and Debug"]')).toHaveCount(0);
    await expect(page.locator(".tm-panel-tab", { hasText: "Debug Console" })).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+d");
    await expect(page.getByTestId("debug-view")).toHaveCount(0);
  });

  test("an exam policy can allow the debugger", async ({ page }) => {
    await launch(page, true);
    await expect(page.locator(".tm-status-mode")).toContainText("Monitored exam");
    await page.locator('.tm-activity[aria-label^="Run and Debug"]').click();
    await expect(page.getByTestId("debug-view")).toBeVisible();
  });
});
