import { expect, test, type Page } from "@playwright/test";

/**
 * Bottom panel views fill the panel and scroll inside it. The terminal fills the panel exactly and keeps its newest line in view, as in VS Code: long
 * output scrolls inside it (it never grows past the panel, hiding the prompt), and resizing the
 * panel re-fits it.
 */

type Term = { write(s: string, cb?: () => void): void; rows: number; buffer: { active: { viewportY: number; baseY: number; cursorY: number } } };

async function openTerminal(page: Page) {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
  });
  await page.goto("/?terminal=sim");
  await expect(page.locator(".tm-titlebar")).toBeVisible();
  await page.keyboard.press("F1");
  await page.keyboard.type("Create New Terminal");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __TMCODE_TERM__?: Term }).__TMCODE_TERM__)).toBe(true);
}

const write = (page: Page, lines: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        const t = (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__;
        t.write(Array.from({ length: n }, (_, i) => `line ${i + 1} of output`).join("\r\n") + "\r\n$ ", done);
      }),
    lines,
  );

/** The terminal's box against the panel's, and whether the cursor's row is in view. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const body = document.querySelector(".tm-panel-body")!.getBoundingClientRect();
    const term = document.querySelector(".tm-terminal")!.getBoundingClientRect();
    const screen = document.querySelector('[data-testid="integrated-terminal"] .xterm-screen')!.getBoundingClientRect();
    const t = (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__;
    const b = t.buffer.active;
    return { bodyBottom: Math.round(body.bottom), termBottom: Math.round(term.bottom), screenBottom: Math.round(screen.bottom), atBottom: b.viewportY === b.baseY, scrolled: b.baseY > 0, rows: t.rows };
  });

test("long output stays inside the panel, scrolls, and shows the newest line", async ({ page }) => {
  await openTerminal(page);
  await write(page, 400);
  await expect.poll(async () => (await layout(page)).scrolled).toBe(true);
  const l = await layout(page);
  expect(l.termBottom).toBeLessThanOrEqual(l.bodyBottom + 1);
  expect(l.screenBottom).toBeLessThanOrEqual(l.bodyBottom + 1);
  expect(l.atBottom).toBe(true);
  // The scrollback is reachable with the mouse wheel, as in VS Code.
  const viewportY = () => page.evaluate(() => (window as unknown as { __TMCODE_TERM__: Term }).__TMCODE_TERM__.buffer.active.viewportY);
  const bottom = await viewportY();
  await page.getByTestId("integrated-terminal").hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(viewportY).toBeLessThan(bottom);
});

test("a smaller panel re-fits the terminal (fewer rows), still showing the prompt", async ({ page }) => {
  await openTerminal(page);
  await write(page, 200);
  const before = await layout(page);
  await page.setViewportSize({ width: 1360, height: 560 });
  await expect.poll(async () => (await layout(page)).rows).toBeLessThan(before.rows);
  const after = await layout(page);
  expect(after.screenBottom).toBeLessThanOrEqual(after.bodyBottom + 1);
  expect(after.atBottom).toBe(true);
});

test("a long Problems list scrolls inside the panel", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
  });
  await page.goto("/");
  await page.locator('.tm-explorer [data-path="src"]').click();
  await page.locator('.tm-explorer [data-path="src/utils.ts"]').dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await page.keyboard.insertText("\n" + Array.from({ length: 40 }, (_, i) => `const n${i}: number = 'oops';`).join("\n") + "\n");
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+m`);
  await expect.poll(() => page.locator(".tm-problem").count(), { timeout: 30_000 }).toBeGreaterThan(30);
  const box = await page.evaluate(() => {
    const body = document.querySelector(".tm-panel-body")!.getBoundingClientRect();
    const list = document.querySelector(".tm-problems") as HTMLElement;
    return { bodyBottom: Math.round(body.bottom), listBottom: Math.round(list.getBoundingClientRect().bottom), scrolls: list.scrollHeight > list.clientHeight };
  });
  expect(box.listBottom).toBeLessThanOrEqual(box.bodyBottom + 1);
  expect(box.scrolls).toBe(true);
});
