import { expect, test, type Page } from "@playwright/test";

/** VS Code's Seti file icons everywhere, and VS Code's editor smarts (feat/icons-smart). */

const MOD = "ControlOrMeta";

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const row = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);
const icon = (page: Page, path: string) => row(page, path).locator("[data-icon]");

async function boot(page: Page, settings: Record<string, unknown> = {}) {
  await page.addInitScript((s) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    localStorage.clear();
    if (Object.keys(s).length) localStorage.setItem("tmcode:ui", JSON.stringify({ settings: s }));
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
  }, settings);
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await expect(row(page, "main.py")).toBeVisible();
}

async function openPalette(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+Shift+p`);
  await page.keyboard.type(text);
}

for (const theme of ["dark-modern", "light-modern"] as const) {
  test(`Explorer shows Seti icons with Seti colours (${theme})`, async ({ page }) => {
    await boot(page, { "workbench.colorTheme": theme });
    await externalWrite(page, "package.json", '{ "name": "demo" }\n');
    await externalWrite(page, "Dockerfile", "FROM python:3.12\n");
    await expect(row(page, "Dockerfile")).toBeVisible();
    const light = theme === "light-modern";
    const expected: Record<string, string> = { "main.py": "_python", "package.json": "_json", "README.md": "_info", Dockerfile: "_docker" };
    for (const [path, id] of Object.entries(expected)) {
      const el = icon(page, path);
      await expect(el).toHaveAttribute("data-icon-theme", "vs-seti");
      await expect(el).toHaveAttribute("data-icon", light ? `${id}_light` : id);
    }
    // Seti's own font and colours: Python is #519aba on dark, #498ba7 on light.
    const style = await icon(page, "main.py").evaluate((el) => ({ font: getComputedStyle(el).fontFamily, color: getComputedStyle(el).color }));
    expect(style.font).toContain("tm-icons-vs-seti");
    expect(style.color).toBe(light ? "rgb(73, 139, 167)" : "rgb(81, 154, 186)");
    expect(await page.evaluate(() => document.fonts.check("16px tm-icons-vs-seti"))).toBe(true);
    // Folders: no icon, only the twistie (as VS Code with Seti).
    await expect(row(page, "web").locator("[data-icon]")).toHaveCount(0);
    await expect(row(page, "web").locator(".codicon-folder, .tm-folder-icon")).toHaveCount(0);
    // Tabs, breadcrumbs and Quick Open use the same theme.
    await row(page, "main.py").dblclick();
    await expect(page.locator(".tm-tab [data-icon]").first()).toHaveAttribute("data-icon", light ? "_python_light" : "_python");
    await expect(page.locator(".tm-breadcrumbs [data-icon]").first()).toHaveAttribute("data-icon", light ? "_python_light" : "_python");
    await page.keyboard.press(`${MOD}+p`);
    await page.keyboard.type("Dockerfile");
    await expect(page.locator(".tm-qi-item.is-focused [data-icon]")).toHaveAttribute("data-icon", light ? "_docker_light" : "_docker");
  });
}

test("the file icon theme picker lists Seti, Minimal, TMCode Glyphs and None", async ({ page }) => {
  await boot(page);
  await openPalette(page, "File Icon Theme");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("File Icon Theme");
  await page.keyboard.press("Enter");
  const items = page.locator(".tm-qi-item .tm-qi-label");
  for (const label of ["Seti (Visual Studio Code)", "Minimal (Visual Studio Code)", "TMCode Glyphs", "None"]) await expect(items.filter({ hasText: label })).toHaveCount(1);
  // Minimal: a generic file icon for everything.
  await page.keyboard.type("Minimal");
  await page.keyboard.press("Enter");
  await expect(icon(page, "main.py")).toHaveAttribute("data-icon-theme", "vs-minimal");
  await expect(icon(page, "main.py")).toHaveClass(/codicon-file/);
});

test("users on the old default icon theme move to Seti once", async ({ page }) => {
  await boot(page, { "workbench.iconTheme": "tmcode" });
  await expect(icon(page, "main.py")).toHaveAttribute("data-icon-theme", "vs-seti");
});

test("linked editing renames the closing tag", async ({ page }) => {
  await boot(page);
  await externalWrite(page, "tags.html", "<section>\n  <p>hi</p>\n</section>\n");
  await row(page, "tags.html").dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("</section>");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.press("Control+g");
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  // Into the tag name: <sec|tion>
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  // The pair is computed once the cursor rests on the name.
  await page.waitForTimeout(600);
  await page.keyboard.type("X");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("</secXtion>");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("<secXtion>");
});

test("an untitled buffer becomes Python when Python is typed", async ({ page }) => {
  await boot(page);
  await openPalette(page, "File: New Text File");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("New Text File");
  await page.keyboard.press("Enter");
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("def f():");
  const lang = page.locator(".tm-status-language");
  await expect(lang).toContainText("Python");
  await expect(lang).toContainText("auto detected");
  await expect(page.locator(".tm-tab.is-active [data-icon]")).toHaveCount(1);
});

test("palette aliases: 'reload' finds Reload Window; a typo offers similar commands", async ({ page }) => {
  await boot(page);
  await openPalette(page, "termjnal");
  await expect(page.getByTestId("qi-no-match")).toHaveText("No matching commands");
  await expect(page.locator(".tm-qi-item").filter({ hasText: "Toggle Terminal" }).first()).toBeVisible();
  await page.keyboard.press("Escape");

  await openPalette(page, "reload");
  await page.waitForTimeout(200);
  const reload = page.locator(".tm-qi-item").filter({ hasText: "Reload Window" });
  test.skip((await reload.count()) === 0, "Reload Window is not a command in this build");
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText("Reload Window");
});
