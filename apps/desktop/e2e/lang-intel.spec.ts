import { expect, test, type Page } from "@playwright/test";

/** Review V2/V3: Go to Definition into other files, the whole TypeScript project known, Go Back. */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const mac = process.platform === "darwin";
const mod = mac ? "Meta" : "Control";
const editorText = (page: Page) => page.locator(".monaco-editor .view-lines").first();
/** Monaco picks its keys by the user agent (Playwright's Chrome device claims Windows), TMCode by the real OS. */
const editorMod = async (page: Page) => ((await page.evaluate(() => navigator.userAgent.includes("Macintosh"))) ? "Meta" : "Control");

const HELPER = `/** Says hello. */\nexport function greet(name: string): string {\n  return "Hello, " + name;\n}\n\nexport const VERSION = 2;\n`;
const MAIN = `import { greet, VERSION } from "./lib/helper";\n\nconst label: string = VERSION;\nconsole.log(label);\n${"\n".repeat(3)}greet("Ada");`;

async function openProject(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await externalWrite(page, "intel/lib/helper.ts", HELPER);
  await externalWrite(page, "intel/main.ts", MAIN);
  await externalWrite(page, "intel/uses.ts", 'import { greet } from "./lib/helper";\nexport const twice = greet("a") + greet("b");\n');
  await page.locator('.tm-explorer [data-path="intel"]').click();
  await page.locator('.tm-explorer [data-path="intel/main.ts"]').dblclick();
  await expect(editorText(page)).toContainText("greet");
  await editorText(page).click();
  // The last line starts with the call: put the cursor on `greet`.
  await page.keyboard.press((await editorMod(page)) === "Meta" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.press("Home");
}

test("a relative import of an unopened file resolves, with its real types", async ({ page }) => {
  await openProject(page);
  await page.keyboard.press(`${mod}+Shift+M`);
  const problems = page.locator(".tm-problems");
  // VERSION's type comes from the unopened helper.ts.
  await expect(problems).toContainText("Type 'number' is not assignable to type 'string'.", { timeout: 20_000 });
  await expect(problems).not.toContainText("Cannot find module");
  // helper.ts was only read for IntelliSense: it is not listed in Problems or opened.
  await expect(page.locator(".tm-tab", { hasText: "helper.ts" })).toHaveCount(0);
});

test("F12 opens the definition in another file; Go Back returns", async ({ page }) => {
  await openProject(page);
  // Wait until the service knows helper.ts (hover-free check: the import error is gone).
  await page.keyboard.press(`${mod}+Shift+M`);
  await expect(page.locator(".tm-problems")).toContainText("is not assignable", { timeout: 20_000 });
  await editorText(page).click();
  await page.keyboard.press((await editorMod(page)) === "Meta" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.press("Home");
  await page.keyboard.press("F12");
  await expect(page.locator(".tm-tab.is-active")).toContainText("helper.ts", { timeout: 10_000 });
  await expect(editorText(page)).toContainText("Hello, ");
  // Monaco picks the keys by the user agent (Playwright's Chrome device claims Windows).
  const uaMac = await page.evaluate(() => navigator.userAgent.includes("Macintosh"));
  await page.keyboard.press(uaMac ? "Control+Minus" : "Alt+ArrowLeft");
  await expect(page.locator(".tm-tab.is-active")).toContainText("main.ts");
  await page.keyboard.press(uaMac ? "Control+Shift+Minus" : "Alt+ArrowRight");
  await expect(page.locator(".tm-tab.is-active")).toContainText("helper.ts");
});

test("Rename Symbol changes and saves unopened files too", async ({ page }) => {
  await openProject(page);
  await page.keyboard.press(`${mod}+Shift+M`);
  await expect(page.locator(".tm-problems")).toContainText("is not assignable", { timeout: 20_000 });
  await editorText(page).click();
  await page.keyboard.press((await editorMod(page)) === "Meta" ? "Meta+ArrowDown" : "Control+End");
  await page.keyboard.press("Home");
  await page.keyboard.press("F2");
  const input = page.locator(".rename-box input");
  await expect(input).toBeVisible();
  await input.fill("welcome");
  await page.keyboard.press("Enter");
  await expect(editorText(page)).toContainText('welcome("Ada")');
  // The files no editor showed were written to disk.
  await page.locator('.tm-explorer [data-path="intel/uses.ts"]').dblclick();
  await expect(editorText(page)).toContainText('welcome("a") + welcome("b")');
  await expect(page.locator(".tm-tab", { hasText: "uses.ts" })).not.toContainText("●");
  await page.locator('.tm-explorer [data-path="intel/lib"]').click();
  await page.locator('.tm-explorer [data-path="intel/lib/helper.ts"]').dblclick();
  await expect(editorText(page)).toContainText("export function welcome(name: string)");
});

test("Python: the Pyright download offer, then its errors and F12 into another file", async ({ page }) => {
  // A Pyright stand-in speaking real LSP (platform/memoryLanguageServer.ts).
  await page.addInitScript(() => ((window as unknown as { __TMCODE_FAKE_LSP__: boolean }).__TMCODE_FAKE_LSP__ = true));
  await page.goto("/");
  await expect(page.locator(".tm-explorer")).toBeVisible();
  await externalWrite(page, "pyintel/helpers.py", "def shout(text):\n    return text.upper()\n");
  await externalWrite(page, "pyintel/app.py", "from helpers import shout\n\nprint(shout('hi'))\nundefined_thing\n");
  await page.locator('.tm-explorer [data-path="pyintel"]').click();
  await page.locator('.tm-explorer [data-path="pyintel/app.py"]').dblclick();
  await expect(page.getByText("needs Pyright, about 6 MB")).toBeVisible();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByText("Pyright is ready.")).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+M`);
  await expect(page.locator(".tm-problems")).toContainText('"undefined_thing" is not defined', { timeout: 10_000 });
  await editorText(page).click();
  await page.keyboard.press((await editorMod(page)) === "Meta" ? "Meta+ArrowUp" : "Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Home");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F12");
  await expect(page.locator(".tm-tab.is-active")).toContainText("helpers.py", { timeout: 10_000 });
  await expect(editorText(page)).toContainText("return text.upper()");
});
