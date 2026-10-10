import { expect, test, type Page } from "@playwright/test";

/**
 * Exam readiness (review E1–E3, E5, E9, E11, F1–F3): the lobby system check,
 * running the example tests on Task Mentor, launch errors, the exam folder
 * after submitting, and the browser sign-in wait. Against e2e/mock-tm.mjs.
 */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  // Once per test (a reload keeps storage, as a restarted app keeps its disk).
  await page.addInitScript(() => {
    if (sessionStorage.getItem("tmcode:e2e-cleared")) return;
    localStorage.clear();
    sessionStorage.setItem("tmcode:e2e-cleared", "1");
  });
});

async function prepare(page: Page, set: Record<string, unknown> = {}, storage: Record<string, string> = {}) {
  await page.request.post(`${TM}/__test/reset`);
  if (Object.keys(set).length) await page.request.post(`${TM}/__test/set`, { data: set });
  if (Object.keys(storage).length) {
    await page.addInitScript((s) => {
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, storage);
  }
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  return deeplink as string;
}

async function typeCode(page: Page, code: string) {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("F1");
  await page.keyboard.type("Edit: Select All");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Delete");
  await page.keyboard.insertText(code);
}

const SUM = "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n";

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("lobby: a missing tool stops the exam with a fix; the example tests then run on Task Mentor", async ({ page }) => {
  const link = await prepare(page, { serverRunLimit: 1 }, { "tmcode:mock-no-tools": "1" });
  await page.goto(`/?launch=${encodeURIComponent(link)}`);
  const lobby = page.getByTestId("exam-lobby");
  await expect(lobby.locator("h2")).toHaveText("Check your computer before you start", { timeout: 15000 });
  const node = page.getByTestId("check-tool:node-22");
  await expect(node).toHaveAttribute("data-status", "warn");
  await expect(node).toContainText("can't find Node.js");
  await expect(node).toContainText("run on Task Mentor");
  await expect(node.getByRole("button", { name: "Node.js downloads" })).toBeVisible();
  for (const id of ["taskmentor", "clock", "disk"]) await expect(page.getByTestId(`check-${id}`)).toHaveAttribute("data-status", "ok");
  await expect(lobby).not.toContainText(/toolchain pack/i);
  // The timer is not shown running in the lobby.
  await expect(page.locator(".tm-exam-title .tm-countdown")).toHaveCount(0);
  await page.getByTestId("lobby-start").click();
  await expect(page.locator(".tm-taskview-quiz")).toHaveText("Practical 1 — JavaScript basics");

  await typeCode(page, SUM);
  await page.getByRole("button", { name: "Run them" }).click();
  await expect(page.getByTestId("server-run-status")).toBeVisible();
  await expect(page.locator(".tm-test-summary")).toContainText("2/2 passed", { timeout: 20000 });
  await expect(page.locator(".tm-test-row").first()).toHaveAttribute("title", /Passed on Task Mentor/);
  await expect(page.getByTestId("server-run-status")).toContainText("run on Task Mentor");
  // Task Mentor allows a limited number of runs a minute: say when the next one can start.
  await page.getByRole("button", { name: "Run All Tests" }).click();
  await expect(page.getByTestId("server-run-status")).toContainText(/Run again in \d+ s/, { timeout: 10000 });
});

test("launch errors: an outdated TMCode gets a plain title and Update TMCode, never a schema dump", async ({ page }) => {
  let link = await prepare(page, { minAppVersion: "99.0.0" });
  await page.goto(`/?launch=${encodeURIComponent(link)}`);
  const card = page.getByTestId("exam-launch-error");
  await expect(card.locator("h2")).toHaveText("This exam needs TMCode 99.0.0 or newer", { timeout: 15000 });
  await expect(card.getByTestId("launch-update")).toHaveText("Update TMCode");
  await expect(card.getByTestId("launch-taskmentor")).toBeVisible();

  link = await prepare(page, { badPackage: true });
  await page.goto(`/?launch=${encodeURIComponent(link)}`);
  await expect(card.locator("h2")).toHaveText("TMCode is out of date for this exam", { timeout: 15000 });
  await expect(card).not.toContainText("ZodError");
  await expect(card).not.toContainText("invalid_type");

  // A used link: only Task Mentor can help (a new link), so no Try Again.
  await page.goto(`/?launch=${encodeURIComponent(link)}`);
  await expect(card.locator("h2")).toHaveText("This exam link has expired", { timeout: 15000 });
  await expect(card.getByTestId("launch-retry")).toHaveCount(0);
  await expect(card.getByTestId("launch-taskmentor")).toBeVisible();
});

test("auto-save is forced in exams, results name the example tests, and the exam folder stays out of Recent and read-only", async ({ page }) => {
  // The student turned auto-save off in practice mode.
  const link = await prepare(page, {}, { "tmcode:ui": JSON.stringify({ settings: { "files.autoSave": "off" } }) });
  await page.goto(`/?launch=${encodeURIComponent(link)}`);
  await expect(page.locator(".tm-taskview-quiz")).toHaveText("Practical 1 — JavaScript basics", { timeout: 15000 });
  await typeCode(page, SUM);
  // No ⌘S: the exam saves and snapshots on its own.
  await expect(page.getByTestId("exam-sync")).toContainText("All work saved", { timeout: 15000 });
  await expect
    .poll(async () => {
      const st = await (await page.request.get(`${TM}/__test/state`)).json();
      return st.sessions[0].snapshots.some((s: { files: { content: string }[] }) => s.files[0].content.includes("a + b"));
    }, { timeout: 15000 })
    .toBe(true);
  const recent = await page.evaluate(() => JSON.parse(localStorage.getItem("tmcode:ui") ?? "{}").recent ?? []);
  expect(recent.map((r: { root: string }) => r.root)).not.toContain("memory://exam-9001");

  await page.getByTestId("exam-submit").click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Submit" }).click();
  const results = page.getByTestId("exam-visible-results");
  await expect(results.first()).toContainText("small", { timeout: 20000 });
  await expect(results.first()).toContainText("Passed");
  // Task 2 is empty: its example test says why it failed.
  await expect(results.nth(1)).toContainText("greeting");
  await expect(results.nth(1)).toContainText("Wrong answer");

  await page.getByRole("button", { name: "Close exam" }).click();
  // Still the exam folder: read-only, no terminal, never practice mode.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.type("x");
  await expect(page.locator(".monaco-editor-overlaymessage")).toContainText("This exam was submitted");
  await page.keyboard.press("ControlOrMeta+j");
  await expect(page.locator(".tm-panel-tab", { hasText: "Terminal" })).toHaveCount(0);
});

test("an exam still in progress is announced at the next start", async ({ page }) => {
  const link = await prepare(page);
  await page.goto(`/?launch=${encodeURIComponent(link)}`);
  await expect(page.locator(".tm-taskview-quiz")).toHaveText("Practical 1 — JavaScript basics", { timeout: 15000 });
  // TMCode closes (or crashes) and starts again without a link.
  await page.goto("/");
  await expect(page.locator(".tm-toast", { hasText: "You have an exam in progress" })).toBeVisible({ timeout: 10000 });
  await expect(page.locator(".tm-toast", { hasText: "You have an exam in progress" }).getByRole("button", { name: "Open Task Mentor" })).toBeVisible();
});

test("Check My Computer: install links for missing tools, Task Mentor and the clock", async ({ page }) => {
  await prepare(page, {}, { "tmcode:mock-no-tools": "1", "tmcode:mock-tm-api": TM });
  await page.goto("/?empty=1");
  await expect(page.getByTestId("welcome-check-computer")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("welcome-check-computer").click();
  const dialog = page.getByTestId("check-my-computer");
  await expect(dialog.getByTestId("check-again")).toBeEnabled({ timeout: 15000 });
  await expect(dialog.getByTestId("check-tool:python-3")).toHaveAttribute("data-status", "fail");
  await expect(dialog.getByTestId("check-tool:python-3").getByRole("button", { name: /Python/ })).toBeVisible();
  await expect(dialog.getByTestId("check-tool:java-21")).toContainText("Java JDK");
  await expect(dialog.getByTestId("check-taskmentor")).toHaveAttribute("data-status", "ok");
  await expect(dialog.getByTestId("check-clock")).toHaveAttribute("data-status", "ok");
  await expect(dialog.getByTestId("check-disk")).toHaveAttribute("data-status", "ok");
  await expect(dialog).toContainText("installed separately");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // A computer whose clock is 10 minutes off; from the command palette this time.
  await page.request.post(`${TM}/__test/set`, { data: { clockSkewMs: 10 * 60_000 } });
  await command(page, "Help: Check My Computer");
  await expect(page.getByTestId("check-clock")).toHaveAttribute("data-status", "warn", { timeout: 15000 });
  await expect(page.getByTestId("check-clock")).toContainText("10 min slow");
});

test("sign-in wait: Cancel, Open the Browser Again and Copy Sign-in Link; a keychain failure is reported once", async ({ page, context, browserName }) => {
  if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await prepare(page, {}, { "tmcode:mock-signin-wait": "1" });
  await page.goto("/");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await command(page, "View: Show Task Mentor Projects");
  await page.getByTestId("projects-signin-button").click();
  const wait = page.getByTestId("projects-signin").getByTestId("signin-waiting");
  await expect(wait).toContainText("Finish signing in in your browser");
  await wait.getByTestId("signin-reopen").click();
  expect(await page.evaluate(() => localStorage.getItem("tmcode:mock-signin-opened"))).toBe("1");
  await wait.getByTestId("signin-copy").click();
  await expect(page.locator(".tm-toast", { hasText: "Sign-in link copied" })).toBeVisible();
  await wait.getByTestId("signin-cancel").click();
  await expect(wait).toHaveCount(0);
  await expect(page.getByTestId("projects-signin-button")).toBeEnabled();

  // Now the sign-in completes, but the keychain refuses to keep it.
  await page.evaluate(() => {
    localStorage.removeItem("tmcode:mock-signin-wait");
    localStorage.setItem("tmcode:mock-keychain-fail", "1");
  });
  await page.getByTestId("projects-signin-button").click();
  await expect(page.locator(".tm-toast", { hasText: "couldn't save your sign-in" })).toHaveCount(1, { timeout: 10000 });
});
