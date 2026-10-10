import { expect, test, type Page } from "@playwright/test";

/** Phase 3 acceptance (client side), against the mock Task Mentor in e2e/mock-tm.mjs. */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;

// Exams share one mock server: run these tests one at a time.
test.describe.configure({ mode: "serial" });

async function launch(page: Page, opts: { deadlineInMs?: number; policy?: Record<string, unknown> } = {}) {
  await page.request.post(`${TM}/__test/reset`);
  if (opts.deadlineInMs) await page.request.post(`${TM}/__test/set`, { data: { deadlineMs: Date.now() + opts.deadlineInMs } });
  if (opts.policy) await page.request.post(`${TM}/__test/set`, { data: { policy: opts.policy } });
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
  // Once per test: a relaunch in the same tab keeps the journal, as a crashed app's disk does.
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tmcode:e2e-cleared")) return;
    localStorage.clear();
    sessionStorage.setItem("tmcode:e2e-cleared", "1");
  });
});

/**
 * Fires a clipboard event at the editor's input, as ⌘C / ⌘V do; returns the
 * text on the event afterwards (what a copy put there). A paste carries `text`.
 */
function clipboardEvent(page: Page, type: "copy" | "paste", text = "") {
  return page.evaluate(
    ([type, t]) => {
      const dt = new DataTransfer();
      if (t) dt.setData("text/plain", t);
      const focused = document.activeElement;
      const input = focused?.closest(".monaco-editor") ? focused : document.querySelector(".monaco-editor .native-edit-context, .monaco-editor textarea");
      input!.dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
      return dt.getData("text/plain");
    },
    [type, text] as const,
  );
}
const pasteIntoEditor = (page: Page, text: string) => clipboardEvent(page, "paste", text);

const editorText = (page: Page) => page.locator(".monaco-editor .view-lines").first();

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
  // A hovered element lends its title to the workbench tooltip; it comes back when the pointer leaves.
  await page.mouse.move(1, 1);
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
  await expect(page.locator(".tm-exam-card h2")).toHaveText("This link isn't from Task Mentor");
  await expect(page.locator(".tm-exam-card")).toContainText("unknown server");
});

test("paste from outside TMCode is refused in an exam; copies made inside are allowed", async ({ page }) => {
  await launch(page);
  await typeCode(page, "const inside = 42;");
  await pasteIntoEditor(page, "/*from-the-web*/");
  await expect(page.locator(".tm-toast", { hasText: "Pasting from outside TMCode is off in this exam." })).toBeVisible();
  await expect(editorText(page)).not.toContainText("from-the-web");

  // Copy inside the editor (Monaco puts the selection on the copy event), then paste it back.
  await page.keyboard.press("F1");
  await page.keyboard.type("Edit: Select All");
  await page.keyboard.press("Enter");
  const copied = await clipboardEvent(page, "copy");
  expect(copied).toBe("const inside = 42;");
  await page.keyboard.press("End");
  await pasteIntoEditor(page, copied);
  await expect(editorText(page)).toContainText("const inside = 42;const inside = 42;");
});

test("restricted terminal is off, and secure mode says it is monitored", async ({ page }) => {
  await launch(page, { policy: { terminal: "restricted", mode: "secure" } });
  await expect(page.locator(".tm-status-mode")).toContainText("Monitored exam");
  await expect(page.locator(".tm-status-mode")).toHaveAttribute("title", /lab lockdown/);
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.locator(".tm-panel-tab", { hasText: "Problems" })).toBeVisible();
  await expect(page.locator(".tm-panel-tab", { hasText: "Terminal" })).toHaveCount(0);
  await page.getByTestId("editor-run-menu").click();
  const menu = page.getByTestId("run-menu");
  await expect(menu.getByRole("menuitem", { name: /Node\.js REPL/ })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
});

test("offline at time-up: one card, stamped at the deadline, submitted on reconnect", async ({ page }) => {
  const deadlineMs = Date.now() + 20000;
  await page.request.post(`${TM}/__test/reset`);
  await page.request.post(`${TM}/__test/set`, { data: { deadlineMs } });
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  await page.request.post(`${TM}/__test/set`, { data: { offline: true } });
  await typeCode(page, "console.log('Hello, NGA!');\n");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("exam-sync")).toContainText("Offline", { timeout: 15000 });

  const card = page.getByTestId("exam-submitting");
  await expect(card.locator("h2")).toHaveText("Time is up", { timeout: 30000 });
  await expect(card).toContainText("Your work is saved on this computer and will be sent when you're back online.");
  await expect(page.getByTestId("exam-retry")).toBeVisible();
  // One card and no Submit button, and it stays that way while the retries go on.
  await page.waitForTimeout(4000);
  await expect(page.locator(".tm-exam-overlay")).toHaveCount(1);
  await expect(card.locator("h2")).toHaveText("Time is up");
  await expect(page.getByTestId("exam-submit")).toHaveCount(0);

  await page.request.post(`${TM}/__test/set`, { data: { offline: false } });
  await expect(page.locator(".tm-exam-results h2")).toHaveText("Submitted", { timeout: 30000 });
  const st = await mockState(page);
  expect(st.submitted.final).toHaveLength(2);
  const finals = st.sessions[0].snapshots.filter((x: { kind: string }) => x.kind === "offline_final");
  expect(finals).toHaveLength(2);
  for (const f of finals) expect(Date.parse(f.client_ts)).toBeLessThanOrEqual(deadlineMs + 1000);
});

test("relaunch after a crash keeps newer local work that never reached Task Mentor", async ({ page }) => {
  await launch(page);
  await typeCode(page, "console.log('first version');\n");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("exam-sync")).toContainText("All work saved", { timeout: 15000 });
  await page.request.post(`${TM}/__test/set`, { data: { offline: true } });
  await typeCode(page, "console.log('newer offline work');\n");
  await page.keyboard.press("F5");
  await expect(page.getByTestId("exam-sync")).toContainText("Offline", { timeout: 15000 });

  // "Crash" and relaunch from Task Mentor on the same computer: the journal survives, the session is new.
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(editorText(page)).toContainText("newer offline work", { timeout: 15000 });
  await expect(page.locator(".tm-toast", { hasText: "restored work that had not reached Task Mentor" })).toBeVisible();

  await page.request.post(`${TM}/__test/set`, { data: { offline: false } });
  await expect(page.getByTestId("exam-sync")).toContainText("All work saved", { timeout: 30000 });
  const st = await mockState(page);
  expect(st.sessions.map((s: { status: string }) => s.status)).toEqual(["superseded", "active"]);
  const latest = st.sessions[1].snapshots.filter((x: { question_id: number }) => x.question_id === 501).at(-1);
  expect(latest.files[0].content).toContain("newer offline work");
});
