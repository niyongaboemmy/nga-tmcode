import { expect, test, type Page } from "@playwright/test";

/** Phase 3 acceptance (client side), against the mock Task Mentor in e2e/mock-tm.mjs. */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;

// Exams share one mock server: run these tests one at a time.
test.describe.configure({ mode: "serial" });

async function launch(page: Page, opts: { deadlineInMs?: number } = {}) {
  await page.request.post(`${TM}/__test/reset`);
  if (opts.deadlineInMs) await page.request.post(`${TM}/__test/set`, { data: { deadlineMs: Date.now() + opts.deadlineInMs } });
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toHaveText("Practical 1 — JavaScript basics", { timeout: 15000 });
}

async function typeCode(page: Page, code: string) {
  await page.locator(".monaco-editor .view-lines").first().click();
  // Select All through the command palette (⌘A is a native-menu action on macOS).
  await page.keyboard.press("F1");
  await page.keyboard.type("Edit: Select All");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Delete");
  // insertText avoids Monaco's auto-closing brackets/quotes while "typing".
  await page.keyboard.insertText(code);
}

const mockState = async (page: Page) => (await page.request.get(`${TM}/__test/state`)).json();

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("opens an exam: task view, timer, exam policy", async ({ page }) => {
  await launch(page);
  await expect(page.locator(".tm-taskview-task")).toHaveCount(2);
  await expect(page.locator(".tm-taskview-brief h1")).toHaveText("Sum of two numbers");
  await expect(page.locator(".tm-exam-title .tm-countdown")).toBeVisible();
  await expect(page.locator(".tm-status-mode")).toContainText("Monitored exam");
  await expect(page.locator(".tm-tab.is-active")).toContainText("main.js");
  // terminal: "off" in the exam policy
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.locator(".tm-panel-tab", { hasText: "Terminal" })).toHaveCount(0);
  // Run hub: running code is allowed, terminals, tasks and dev servers are not.
  await page.getByTestId("editor-run-menu").click();
  const menu = page.getByTestId("run-menu");
  await expect(menu.getByRole("menuitem", { name: /in JavaScript Console/ })).toHaveAttribute("aria-disabled", "false");
  await expect(menu.getByRole("menuitem", { name: /Node\.js REPL/ })).toHaveAttribute("aria-disabled", "true");
  await expect(menu.getByRole("menuitem", { name: /Node\.js REPL/ })).toHaveAttribute("title", "Not available during an exam");
  await expect(menu.getByRole("menuitem", { name: "Run Task..." })).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("run, local tests, submit and see released results", async ({ page }) => {
  await launch(page);
  await typeCode(page, "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("run-console")).toContainText("exited with code 0");

  await page.getByRole("button", { name: "Run them" }).click();
  await expect(page.locator(".tm-test-summary")).toContainText("2/2 passed");

  // The run was snapshotted and synced, chain verified by the mock.
  await expect(page.getByTestId("exam-sync")).toContainText("All work saved", { timeout: 15000 });
  const st = await mockState(page);
  expect(st.sessions[0].snapshots.some((s: { kind: string; files: { content: string }[] }) => s.kind === "run" && s.files[0].content.includes("a + b"))).toBe(true);

  await page.getByTestId("exam-submit").click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Submit" }).click();
  await expect(page.locator(".tm-exam-results h2")).toHaveText("Submitted");
  // Task 1 passes all tests (10), task 2 is empty (0).
  await expect(page.locator(".tm-exam-score")).toContainText("10 / 15", { timeout: 20000 });
});

test("keeps working offline and syncs when the connection returns", async ({ page }) => {
  await launch(page);
  await page.request.post(`${TM}/__test/set`, { data: { offline: true } });
  await typeCode(page, "console.log('offline work');\n");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("exam-sync")).toContainText("Offline", { timeout: 15000 });
  await page.request.post(`${TM}/__test/set`, { data: { offline: false } });
  await expect(page.getByTestId("exam-sync")).toContainText("All work saved", { timeout: 30000 });
  const st = await mockState(page);
  expect(st.sessions[0].snapshots.some((s: { files: { content: string }[] }) => s.files[0].content.includes("offline work"))).toBe(true);
});

test("relaunching resumes the latest synced code", async ({ page }) => {
  await launch(page);
  await typeCode(page, "console.log('resume me');\n");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("exam-sync")).toContainText("All work saved", { timeout: 15000 });
  // A new launch (e.g. another computer): fresh browser storage, same mock server.
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.evaluate(() => localStorage.clear());
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("resume me", { timeout: 15000 });
  const st = await mockState(page);
  expect(st.sessions.map((s: { status: string }) => s.status)).toEqual(["superseded", "active"]);
});

test("time up locks the editor and submits automatically", async ({ page }) => {
  // Long enough for a slow CI WebKit to boot and type before time is up.
  await launch(page, { deadlineInMs: 15000 });
  await typeCode(page, "console.log('Hello, NGA!');\n");
  await expect(page.locator(".tm-exam-results h2")).toHaveText("Submitted", { timeout: 40000 });
  const st = await mockState(page);
  expect(st.submitted.final).toHaveLength(2);
});

test("refuses exam links that point at an unknown server", async ({ page }) => {
  await page.goto(`/?launch=${encodeURIComponent("tmcode://launch?t=abc&api=https%3A%2F%2Fevil.example.com")}`);
  await expect(page.locator(".tm-exam-card h2")).toHaveText("The exam could not be opened");
  await expect(page.locator(".tm-exam-card")).toContainText("unknown server");
});
