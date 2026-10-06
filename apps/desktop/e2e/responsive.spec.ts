import { expect, test, type Page } from "@playwright/test";

/** The workbench at common window sizes: nothing overflows, essentials stay reachable. */

const SIZES = [
  { name: "desktop-1920", width: 1920, height: 1080, size: "lg" },
  { name: "laptop-1366", width: 1366, height: 768, size: "lg" },
  { name: "small-1024", width: 1024, height: 700, size: "md" },
  { name: "half-800", width: 800, height: 600, size: "sm" },
  { name: "narrow-600", width: 600, height: 760, size: "xs" },
] as const;

async function noOverflow(page: Page) {
  const r = await page.evaluate(() => {
    const doc = document.documentElement;
    const tb = document.querySelector(".tm-titlebar")!.getBoundingClientRect();
    const sb = document.querySelector(".tm-statusbar")!.getBoundingClientRect();
    const overflowing = [...document.querySelectorAll(".tm-titlebar *, .tm-statusbar *")]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => el.getBoundingClientRect())
      .filter((b) => b.width > 0 && (b.right > window.innerWidth + 1 || b.left < -1)).length;
    return { scroll: doc.scrollWidth - window.innerWidth, titleH: tb.height, statusH: sb.height, overflowing };
  });
  expect(r.scroll, "page scrolls sideways").toBeLessThanOrEqual(0);
  expect(r.overflowing, "title/status bar items off screen").toBe(0);
  expect(r.titleH).toBeLessThanOrEqual(36);
  expect(r.statusH, "status bar wrapped").toBeLessThanOrEqual(23);
}

for (const s of SIZES) {
  test(`layout at ${s.width}×${s.height}`, async ({ page }, info) => {
    await page.addInitScript(() => localStorage.clear());
    await page.setViewportSize({ width: s.width, height: s.height });
    await page.goto("/");
    await expect(page.locator(".tm-root")).toHaveAttribute("data-size", s.size);
    await noOverflow(page);

    if (s.size === "xs") {
      await expect(page.locator(".tm-sidebar")).toBeHidden();
      await page.keyboard.press("ControlOrMeta+b");
    }
    await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
    await expect(page.locator(".monaco-editor .view-lines")).toContainText("def letter");
    if (s.size === "xs") await page.keyboard.press("ControlOrMeta+b");
    await page.locator(".monaco-editor .view-lines").click();
    await page.keyboard.type("# ok");
    await expect(page.locator(".tm-tab.is-active")).toBeVisible();
    await noOverflow(page);

    if (s.size === "xs" || s.size === "sm") {
      await expect(page.locator(".tm-menubar")).toHaveCount(0);
      await page.getByRole("button", { name: "Application Menu" }).dispatchEvent("mousedown");
      await page.locator(".tm-menu-item", { hasText: "View" }).click();
      await expect(page.locator(".tm-menu")).toContainText("Toggle Primary Side Bar Visibility");
      await page.keyboard.press("Escape");
    } else {
      await expect(page.locator(".tm-menubar")).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath(`${s.name}.png`) });
  });
}

test("the quick input and dialogs fit a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 760 });
  await page.goto("/");
  // Keybindings attach once the workbench has booted.
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await expect(page.locator(".tm-quick-input")).toBeVisible();
  const box = await page.locator(".tm-quick-input").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(600);
});
