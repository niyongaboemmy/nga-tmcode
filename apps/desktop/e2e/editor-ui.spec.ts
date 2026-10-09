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

test("the editor's context menu takes the theme: opaque, bordered and rounded, in light, dark and high contrast", async ({ page }) => {
  for (const theme of ["dark-modern", "light-modern", "dark-hc"]) {
    await page.goto("/");
    await page.evaluate((t) => {
      localStorage.clear();
      localStorage.setItem("tmcode:ui", JSON.stringify({ settings: { "workbench.colorTheme": t } }));
    }, theme);
    await page.reload();
    await page.locator(".tm-statusbar").waitFor();
    await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
    await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("def", { timeout: 15_000 });
    const box = (await page.locator(".monaco-editor .view-lines").first().boundingBox())!;
    await page.mouse.click(box.x + 80, box.y + 40, { button: "right" });
    // The menu lives in a shadow root under the editor host (Monaco's context view).
    const menu = await page.waitForFunction(() => {
      const root = (document.querySelector(".shadow-root-host") as HTMLElement & { shadowRoot: ShadowRoot | null })?.shadowRoot;
      const el = root?.querySelector(".monaco-scrollable-element") as HTMLElement | null;
      if (!el || !root!.querySelector(".monaco-menu")) return null;
      const cs = getComputedStyle(el);
      // Monaco draws the border on .monaco-menu with var(--vscode-strokeThickness): undefined, there is none.
      const menuCs = getComputedStyle(root!.querySelector(".monaco-menu")!);
      return { bg: cs.backgroundColor, fg: cs.color, border: menuCs.borderTopWidth, radius: menuCs.borderTopLeftRadius };
    });
    const m = (await menu.jsonValue())!;
    expect(m.bg, theme).not.toBe("rgba(0, 0, 0, 0)");
    expect(m.fg, theme).not.toBe(m.bg);
    expect(m.border, theme).toBe("1px");
    expect(m.radius, theme).not.toBe("0px");
    await page.keyboard.press("Escape");
  }
});
