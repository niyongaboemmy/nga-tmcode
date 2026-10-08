import { expect, test, type Page } from "@playwright/test";

/**
 * Project tests in the Testing view: the pytest suite of a Python project is
 * detected, run (the memory platform's pretend pytest writes a real JUnit
 * report), its results fill a tree, failures go to their line (marker,
 * Problems) and one test can be re-run from its row or its CodeLens.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

const TESTS = `from main import greet


def test_greet():
    assert greet("Ada") == "Hello, Ada!"


def test_sum():
    assert 4 == 5
`;

test("pytest results in the Testing view: run all, failure at its line, run one test, CodeLens", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();

  await command(page, "File: New Project from Template");
  await page.locator(".tm-quick-pick input").fill("Python");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: /^Python/ }).first().click();
  await page.locator(".tm-quick-pick input").fill("py-tests");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast", { hasText: "Created py-tests" })).toBeVisible({ timeout: 15_000 });
  await externalWrite(page, "test_main.py", TESTS);

  await command(page, "View: Show Testing");
  const view = page.locator(".tm-testing");
  const suite = view.locator(".tm-fwtests-suite", { hasText: "pytest" });
  await expect(suite).toBeVisible({ timeout: 10_000 });
  // Not run yet: the command it will run is shown.
  await expect(suite).toContainText("python3 -m pytest");
  // The practice input/output tests from .tmcode/tests.json are still there below.
  await expect(view.locator(".tm-pane-title", { hasText: "main.py" })).toBeVisible();

  await view.getByRole("button", { name: "Run All Project Tests" }).click();
  await expect(view.locator(".tm-fwtests .tm-test-summary")).toContainText("1/2 passed", { timeout: 10_000 });
  const failed = view.locator('[data-status="failed"]', { hasText: "test_sum" });
  const passed = view.locator('[data-status="passed"]', { hasText: "test_greet" });
  await expect(failed).toBeVisible();
  await expect(passed).toBeVisible();
  // Failures sort first.
  await expect(view.locator("[data-status]").first()).toHaveAttribute("data-status", "failed");
  await expect(failed).toContainText("AssertionError: assert 4 == 5");

  // Clicking a failure shows its details and opens the test at its line.
  await failed.locator(".tm-list-row").click();
  await expect(failed.locator(".tm-fwtests-detail")).toContainText("test_main.py:9");
  await expect(page.locator(".tm-tab.is-active")).toContainText("test_main.py");
  await expect(page.locator(".monaco-editor .squiggly-error").first()).toBeVisible();
  await command(page, "View: Show Problems");
  await expect(page.locator(".tm-panel")).toContainText("test_sum: AssertionError: assert 4 == 5");

  // ▶ Run Test lenses above each test (and Run File Tests at the top).
  // Monaco asks for lenses while the editor has focus (as VS Code does).
  await page.locator(".monaco-editor .view-lines").click();
  const lenses = page.locator(".monaco-editor .codelens-decoration");
  await expect(lenses.filter({ hasText: "Run File Tests" })).toHaveCount(1);
  await expect(lenses.filter({ hasText: /Run Test$/ })).toHaveCount(2);
  await expect(lenses.filter({ hasText: /Run Test$/ }).first()).toContainText("Run Test");

  // Fix the test outside TMCode, then re-run just that test from its row.
  await externalWrite(page, "test_main.py", TESTS.replace("assert 4 == 5", "assert 5 == 5"));
  await page.mouse.move(0, 0);
  await failed.locator(".tm-list-row").hover();
  await failed.getByRole("button", { name: "Run test_sum" }).click();
  await expect(view.locator('[data-status="passed"]', { hasText: "test_sum" })).toBeVisible({ timeout: 10_000 });
  // The other result was kept from the full run.
  await expect(passed).toBeVisible();
  await expect(view.locator(".tm-fwtests .tm-test-summary")).toContainText("2/2 passed");
  await expect(page.locator(".monaco-editor .squiggly-error")).toHaveCount(0);

  // The run is logged in the Output panel's Tests channel.
  await view.getByRole("button", { name: "Show Test Output" }).click();
  await expect(page.locator(".tm-panel")).toContainText("test_main.py::test_sum");
});

test("filter and only-failed narrow the results; a missing tool explains how to install it", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await command(page, "File: New Project from Template");
  await page.locator(".tm-quick-pick input").fill("Python");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: /^Python/ }).first().click();
  await page.locator(".tm-quick-pick input").fill("py-filter");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast", { hasText: "Created py-filter" })).toBeVisible({ timeout: 15_000 });
  await externalWrite(page, "test_main.py", TESTS);
  // A Go module next to it: the pretend shell has no `go`.
  await externalWrite(page, "calc/go.mod", "module example.com/calc\n\ngo 1.21\n");

  await command(page, "View: Show Testing");
  const view = page.locator(".tm-testing");
  await expect(view.locator(".tm-fwtests-suite", { hasText: "go test · calc" })).toBeVisible({ timeout: 10_000 });
  await view.getByRole("button", { name: "Run All Project Tests" }).click();
  await expect(view.locator(".tm-fwtests .tm-test-summary")).toContainText("1/2 passed", { timeout: 10_000 });
  await expect(view.locator(".tm-fwtests-suite", { hasText: "go test · calc" }).locator(".tm-fwtests-problem")).toContainText("not installed");

  await view.getByLabel("Filter tests").fill("greet");
  await expect(view.locator("[data-status]")).toHaveCount(1);
  await view.getByLabel("Filter tests").fill("");
  await view.getByRole("button", { name: "Show Only Failed Tests" }).click();
  await expect(view.locator("[data-status]")).toHaveCount(1);
  await expect(view.locator("[data-status]")).toHaveAttribute("data-status", "failed");
});
