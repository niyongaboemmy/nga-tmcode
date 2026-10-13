import { expect, test, type Page } from "@playwright/test";
import { command, gradeMoreAction, launch, mock, openStudent, toast } from "./journeys";

/**
 * Task Mentor's code runner (0.17): when this computer can't run the code (tools missing), it runs on
 * Task Mentor. Practice uses the in-memory code runner (platform/memoryCodeRunner.ts), exams the mock
 * Task Mentor's /sessions/:sid/code endpoints (e2e/mock-tm.mjs), both with real streaming.
 * The fakes' programs ask "What is your name? " and answer "Hello, <name>!".
 */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;
const NO_TOOLS = { "tmcode:mock-no-tools": "1", "tmcode:mock-code-runner": "1", "tmcode:e2e-no-home": "1" };
const consoleEl = (page: Page) => page.getByTestId("run-console");
const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

/** Signed in, with the practice folder's Explorer in view. */
async function practice(page: Page, storage: Record<string, string>) {
  await launch(page, { storage });
  await page.locator('.tm-activitybar [data-view="explorer"]').click();
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("practice: a program whose tools are missing runs on Task Mentor, with typed input", async ({ page }) => {
  await practice(page, NO_TOOLS);
  await row(page, "js").click();
  await row(page, "js/sum.js").dblclick();
  await expect(page.locator(".tm-tab.is-active")).toBeVisible();
  await page.keyboard.press("F5");
  // The missing tool's message offers Task Mentor first.
  const note = toast(page, "could not find");
  await expect(note).toBeVisible({ timeout: 15_000 });
  await note.getByRole("button", { name: "Run on Task Mentor" }).click();
  await expect(consoleEl(page)).toContainText("runs on Task Mentor", { timeout: 15_000 });
  await expect(consoleEl(page)).toContainText("What is your name?");
  const bar = page.getByTestId("remote-run-bar");
  await expect(bar).toBeVisible();
  await bar.getByRole("textbox", { name: "Input for the program" }).fill("Ada");
  await bar.getByRole("textbox", { name: "Input for the program" }).press("Enter");
  await expect(consoleEl(page)).toContainText("Hello, Ada!");
  await expect(consoleEl(page)).toContainText("exited with code 0");
  await expect(bar).toHaveCount(0);

  // Ctrl+C stops it; End of Input lets it finish; Stop ends it.
  await command(page, "Run: Run on Task Mentor");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await bar.getByRole("button", { name: "Ctrl+C" }).click();
  await expect(consoleEl(page)).toContainText("stopped");
  await expect(bar).toHaveCount(0);
  await command(page, "Run: Run on Task Mentor");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await bar.getByRole("button", { name: "End of Input" }).click();
  await expect(consoleEl(page)).toContainText("Bye");
  await command(page, "Run: Run on Task Mentor");
  await expect(bar).toBeVisible({ timeout: 15_000 });
  await bar.getByRole("button", { name: "Stop" }).click();
  await expect(bar).toHaveCount(0);
  const sent = (await page.evaluate(() => (window as unknown as { __TMCODE_CODE__: { requests(): { path: string; body: { entry?: string; files?: { path: string }[] } }[] } }).__TMCODE_CODE__.requests())) as { path: string; body: { entry?: string; files?: { path: string }[] } }[];
  const start = sent.find((r) => r.path === "/sessions")!;
  expect(start.body.entry).toMatch(/(^|\/)sum\.js$/);
  // TMCode's own folder is never sent.
  expect(start.body.files!.some((f) => f.path.startsWith(".tmcode/"))).toBe(false);
});

test("practice: example tests run on Task Mentor when the tools are missing; a limit is orange", async ({ page }) => {
  await practice(page, NO_TOOLS);
  await command(page, "View: Show Testing");
  await page.getByRole("button", { name: "Run All Tests" }).click();
  await expect(page.locator(".tm-test-summary")).toContainText("3/3 passed", { timeout: 15_000 });
  await expect(page.locator(".tm-test-row").first()).toHaveAttribute("title", /Passed on Task Mentor/);
  await expect(page.getByTestId("server-run-status")).toContainText("run on Task Mentor");
  // A program that runs forever: the time limit, in the attention colour, in plain words.
  await page.locator('.tm-activitybar [data-view="explorer"]').click();
  await row(page, "js").click();
  await row(page, "js/sum.js").dblclick();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("\n// LOOP\n");
  await command(page, "View: Show Testing");
  await page.getByRole("button", { name: "Run All Tests" }).click();
  await expect(page.locator(".tm-test-row").first()).toHaveAttribute("title", /Too slow \(time limit\) \(on Task Mentor\)/, { timeout: 15_000 });
  await expect(page.locator(".tm-test-row .tm-test-icon.is-limit").first()).toBeVisible();
});

test("practice: without Task Mentor's code runner, nothing changes (an older Task Mentor)", async ({ page }) => {
  await practice(page, { "tmcode:mock-no-tools": "1", "tmcode:e2e-no-home": "1" });
  await row(page, "js").click();
  await row(page, "js/sum.js").dblclick();
  await expect(page.locator(".tm-tab.is-active")).toBeVisible();
  await page.keyboard.press("F5");
  const note = toast(page, "could not find");
  await expect(note).toBeVisible({ timeout: 15_000 });
  await expect(note.getByRole("button", { name: "Run on Task Mentor" })).toHaveCount(0);
  await expect(note.getByRole("button", { name: "Check My Computer" })).toBeVisible();
});

test("practice: unit tests on Task Mentor show failures first with file:line", async ({ page }) => {
  await practice(page, NO_TOOLS);
  // A pytest file (written as another program would), then the unit tests on Task Mentor.
  await page.evaluate(
    ([p, c]) => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite(p, c),
    ["py/test_stats.py", "def test_mean():\n    assert 2 == 2\n\ndef test_median():\n    assert False, 'median is wrong'\n"],
  );
  await command(page, "Test: Run Unit Tests on Task Mentor");
  const panel = page.getByTestId("server-unit-tests");
  await expect(panel).toContainText("1/2 passed", { timeout: 15_000 });
  const first = panel.locator('[role="treeitem"]').first();
  await expect(first).toHaveAttribute("data-status", "failed");
  await expect(first).toContainText("test_median");
  await expect(first).toContainText("AssertionError");
  await expect(panel.getByRole("button", { name: "py/test_stats.py:5" })).toBeVisible();
});

// ───────────── exams ─────────────

async function exam(page: Page, set: Record<string, unknown>, storage: Record<string, string> = {}) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("tmcode:e2e-cleared")) return;
    localStorage.clear();
    sessionStorage.setItem("tmcode:e2e-cleared", "1");
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
  }, storage);
  await page.request.post(`${TM}/__test/reset`);
  await page.request.post(`${TM}/__test/set`, { data: set });
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  const start = page.getByTestId("lobby-start");
  await expect(page.locator(".tm-taskview-quiz").or(start)).toBeVisible({ timeout: 15_000 });
  if (await start.isVisible()) await start.click();
  await expect(page.locator(".tm-taskview-quiz")).toHaveText("Practical 1 — JavaScript basics", { timeout: 15_000 });
}

const mockState = async (page: Page) => (await page.request.get(`${TM}/__test/state`)).json();

test("exam: a unit-test question says how it is checked and runs the student's own tests on Task Mentor", async ({ page }) => {
  await exam(page, { unitTask: true, codeRunner: { unit_tests: true, unit_test_languages: ["javascript"] } });
  await page.locator(".tm-taskview-task", { hasText: "A stack" }).click();
  const tests = page.getByTestId("task-tests");
  await expect(tests).toContainText("Your teacher's tests check this when you submit. You can run your own tests here.");
  // No empty "Run them".
  await expect(tests.getByRole("button", { name: "Run them" })).toHaveCount(0);
  await tests.getByRole("button", { name: "Open Testing" }).click();
  await expect(page.getByTestId("unit-question-note")).toBeVisible();
  await page.getByTestId("server-unit-tests").getByRole("button", { name: "Run Unit Tests on Task Mentor" }).first().click();
  const panel = page.getByTestId("server-unit-tests");
  await expect(panel).toContainText("1/2 passed", { timeout: 15_000 });
  await expect(panel.locator('[role="treeitem"]').first()).toContainText("pop is empty");
  await expect(panel.getByRole("button", { name: "stack.test.js:8" })).toBeVisible();
  const sent = (await mockState(page)).codeRequests.find((r: { path: string }) => r.path === "/test");
  expect(sent.body.question_id).toBe(503);
  expect(sent.body.files.map((f: { path: string }) => f.path).sort()).toEqual(["stack.js", "stack.test.js"]);
});

test("exam: a program reads input live on Task Mentor when the tool is missing", async ({ page }) => {
  await exam(page, { codeRunner: { interactive: true } }, { "tmcode:mock-no-tools": "1" });
  await page.locator(".tm-taskview-task", { hasText: "Greeting" }).click();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.insertText("const name = require('fs').readFileSync(0, 'utf8');\n");
  // Without Node.js, F5 runs JavaScript in the built-in console (no input); Task Mentor runs it with input.
  await command(page, "Run: Run on Task Mentor");
  await expect(consoleEl(page)).toContainText("What is your name?", { timeout: 15_000 });
  const input = page.getByTestId("remote-run-bar").getByRole("textbox", { name: "Input for the program" });
  await input.fill("Grace");
  await input.press("Enter");
  await expect(consoleEl(page)).toContainText("Hello, Grace!");
  await expect(consoleEl(page)).toContainText("exited with code 0");
  const st = await mockState(page);
  expect(st.codeRequests.map((r: { path: string }) => r.path)).toEqual(expect.arrayContaining(["/sessions", expect.stringMatching(/^\/sessions\/.+\/input$/)]));
});

test("exam: without the code runner a unit-test question still explains itself, with no dead buttons", async ({ page }) => {
  await exam(page, { unitTask: true });
  await page.locator(".tm-taskview-task", { hasText: "A stack" }).click();
  await expect(page.getByTestId("task-tests")).toContainText("Your teacher's tests check this when you submit.");
  await page.getByTestId("task-tests").getByRole("button", { name: "Open Testing" }).click();
  await expect(page.getByTestId("unit-question-note")).toBeVisible();
  await expect(page.getByTestId("server-unit-tests")).toHaveCount(0);
});

// ───────────── grading ─────────────

test("grading: Run the Student's Unit Tests on the graded version (Task Mentor when this computer can't)", async ({ page }) => {
  await launch(page, { teacher: true, storage: { "tmcode:mock-code-runner": "1" } });
  await mock(page, "m.setTeacher(true)");
  await command(page, "Grading: Refresh Grading");
  await command(page, "View: Show Grading");
  await expect(page.getByTestId("grading-view")).toBeVisible({ timeout: 15_000 });
  await page.locator('[data-testid="grading-activity"]', { hasText: "Build a to-do list" }).first().click();
  await openStudent(page, "Chloe Coder");
  await gradeMoreAction(page, "Run the Student's Unit Tests");
  const panel = page.getByTestId("server-unit-tests");
  await expect(panel).toContainText("Chloe Coder's graded version", { timeout: 20_000 });
  await expect(panel).toContainText("1/2 passed");
  await expect(panel.locator('[role="treeitem"]').first()).toContainText("removes an item");
  await expect(panel.getByRole("button", { name: "app.test.js:4" })).toBeVisible();
  await expect(toast(page, "Chloe Coder's graded version: 1/2 unit tests passed on Task Mentor")).toBeVisible();
});
