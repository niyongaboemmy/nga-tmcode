import { expect, test, type Page } from "@playwright/test";

/**
 * Terminal shell integration (OSC 633), as in VS Code: a mark beside every
 * command (blue: worked, red: failed), its menu (Copy Command / Output, Re-run),
 * ⌘↑/⌘↓ between commands and the pinned command line (sticky scroll). The
 * simulated shell sends the same marks the desktop's injected scripts do.
 */

type Term = { write(s: string, cb?: () => void): void; buffer: { active: { viewportY: number; baseY: number } }; scrollToLine(n: number): void };

async function openTerminal(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("tmcode:e2e-started")) return;
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    if (Object.keys(s).length) localStorage.setItem("tmcode:ui", JSON.stringify({ settings: s }));
    sessionStorage.setItem("tmcode:e2e-started", "1");
  }, settings);
  await page.goto("/?terminal=sim");
  await expect(page.locator(".tm-titlebar")).toBeVisible();
  await page.keyboard.press("F1");
  await page.keyboard.type("Create New Terminal");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __TMCODE_TERM__?: Term }).__TMCODE_TERM__)).toBe(true);
  await expect(page.getByTestId("integrated-terminal")).toContainText("$");
}

async function run(page: Page, command: string) {
  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

const marks = (page: Page, state?: string) => page.locator(`[data-testid="integrated-terminal"] .tm-term-cmd-mark${state ? `.is-${state}` : ""}`);

test("each command gets a mark: blue when it worked, red when it failed, with its menu", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo hello");
  await expect(marks(page, "success")).toHaveCount(1);
  await run(page, "false");
  await expect(marks(page, "error")).toHaveCount(1);
  await expect(marks(page, "error")).toHaveAttribute("title", /failed \(exit code 1\): false/);

  // Its menu: what happened, copy, and run it again.
  await marks(page, "success").click();
  const menu = page.locator(".tm-menu");
  await expect(menu).toContainText("Command succeeded");
  await expect(menu.getByText("Copy Command")).toBeVisible();
  await expect(menu.getByText("Copy Output")).toBeVisible();
  await menu.getByText("Re-run Command").click();
  await expect(marks(page, "success")).toHaveCount(2);
  await expect(page.getByTestId("integrated-terminal")).toContainText(/hello[\s\S]*hello/);
});

test("Run Recent Command lists the commands the shell reported", async ({ page }) => {
  await openTerminal(page);
  await run(page, "echo from-the-shell");
  await expect(marks(page, "success")).toHaveCount(1);
  await page.keyboard.press("F1");
  await page.keyboard.type("Run Recent Command");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-quick-input")).toContainText("echo from-the-shell");
  await page.keyboard.press("Escape");
});

test("⌘↑ / ⌘↓ jump between commands, and the running command stays pinned while its output scrolls", async ({ page }) => {
  await openTerminal(page);
  // A long command output, marked the way the shell marks it.
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const t = (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__;
        const m = (s: string) => `\x1b]633;${s}\x07`;
        const out = Array.from({ length: 120 }, (_, i) => `build step ${i + 1}`).join("\r\n");
        t.write(`\r\n${m("A")}p $ ${m("B")}make all\r\n${m("E;make all")}${m("C")}${out}\r\n${m("D;0")}${m("A")}p $ ${m("B")}`, done);
      }),
  );
  const term = () =>
    page.evaluate(() => {
      const b = (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__.buffer.active;
      return { viewportY: b.viewportY, baseY: b.baseY };
    });
  const bottom = (await term()).baseY;
  expect(bottom).toBeGreaterThan(50);

  await page.getByTestId("integrated-terminal").click();
  await page.keyboard.press("ControlOrMeta+ArrowUp");
  await expect.poll(async () => (await term()).viewportY).toBeLessThan(bottom - 50);
  await page.keyboard.press("ControlOrMeta+ArrowDown");
  await expect.poll(async () => (await term()).viewportY).toBe(bottom);

  // Halfway through the output, the command's line is pinned on top; clicking it scrolls back to it.
  await page.evaluate(() => (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__.scrollToLine(60));
  const sticky = page.getByTestId("terminal-sticky");
  await expect(sticky).toContainText("make all");
  await sticky.click();
  await expect.poll(async () => (await term()).viewportY).toBeLessThan(60);
});

test("Shell Integration off: no marks", async ({ page }) => {
  await openTerminal(page, { "terminal.integrated.shellIntegration.enabled": false });
  await run(page, "echo plain");
  await expect(page.getByTestId("integrated-terminal")).toContainText("plain");
  await expect(marks(page)).toHaveCount(0);
});
