import { expect, test } from "@playwright/test";

/**
 * The editor as the user sees it: cursor, current line, active line number,
 * syntax colours, glyph alignment, typing/scrolling stalls and CSP refusals,
 * measured by the same probe the native UI self-test runs in WKWebView
 * (TMCODE_DEV_SELFTEST=ui). 0.3.0 shipped with an invisible cursor and no
 * colours because runtime styles were refused; this keeps that visible.
 */
test("editor renders a visible cursor, line highlight and syntax colours", async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
  await page.goto("/");
  await page.locator(".tm-statusbar").waitFor();
  await page.waitForFunction(() => (window as unknown as { __TMCODE_DEBUG__?: { uiProbe?: unknown } }).__TMCODE_DEBUG__?.uiProbe);
  const checks = await page.evaluate(() =>
    (window as unknown as { __TMCODE_DEBUG__: { uiProbe: (o: object) => Promise<{ name: string; ok: boolean; detail: string }[]> } }).__TMCODE_DEBUG__.uiProbe({ file: "web/index.html" }),
  );
  // Stalls depend on the CI machine; everything else must hold exactly.
  const failed = checks.filter((c) => !c.ok && c.name !== "typing latency").map((c) => `${c.name}: ${c.detail}`);
  expect(failed).toEqual([]);
  expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(["cursor", "current line", "active line number", "syntax colours", "glyph alignment", "csp"]));
});
