import { expect, test } from "@playwright/test";

/** Local History / Timeline: every save keeps a copy; compare and restore. */

const mod = process.platform === "darwin" ? "Meta" : "Control";

test("saves appear in the Timeline, compare opens a diff, restore brings the old text back", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:ui", JSON.stringify({ settings: { "files.autoSave": "off" } }));
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  const editor = page.locator(".monaco-editor .view-lines").first();
  await expect(editor).toContainText("def letter");
  await editor.click();
  // Select-all + type (Home/End keys differ between WebKit builds).
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("# version one");
  await page.keyboard.press(`${mod}+s`);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("# version two");
  await page.keyboard.press(`${mod}+s`);

  const timeline = page.getByTestId("timeline");
  await timeline.locator(".tm-pane-header").click();
  await expect(timeline.locator(".tm-timeline-row")).toHaveCount(2);
  // .tmcode stays out of the explorer.
  await expect(page.locator('.tm-explorer [data-path=".tmcode"]')).toHaveCount(0);

  // The older save against now.
  await timeline.locator(".tm-timeline-row").nth(1).click();
  await expect(page.getByTestId("history-diff")).toBeVisible();
  await expect(page.locator(".tm-tab.is-active")).toContainText("↔ Current");

  // Restore it into the editor (Undo-able), from the main.py tab.
  await page.locator(".tm-tab", { hasText: "main.py" }).first().click();
  await timeline.locator(".tm-timeline-row").nth(1).hover();
  await timeline.locator(".tm-timeline-row").nth(1).getByLabel("Restore This Version").click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".tm-toast").last()).toContainText("Restored main.py");
  await expect(editor).toContainText("# version one");
  await expect(editor).not.toContainText("# version two");
});

test("the Outline lists the active file's symbols and jumps to them", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite(
      "shapes.ts",
      "export class Circle {\n  radius = 1;\n  area() {\n    return 3.14 * this.radius ** 2;\n  }\n}\n\nexport function makeCircle(r: number) {\n  const c = new Circle();\n  c.radius = r;\n  return c;\n}\n",
    ),
  );
  await page.locator('.tm-explorer [data-path="shapes.ts"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("class Circle");
  const outline = page.getByTestId("outline");
  await outline.locator(".tm-pane-header").click();
  await expect(outline.locator(".tm-outline-row", { hasText: "Circle" }).first()).toBeVisible({ timeout: 15_000 });
  await expect(outline).toContainText("makeCircle");
  await expect(outline).toContainText("area");
  await outline.locator(".tm-outline-row", { hasText: "makeCircle" }).click();
  await expect(page.locator(".tm-statusbar")).toContainText("Ln 8");
});
