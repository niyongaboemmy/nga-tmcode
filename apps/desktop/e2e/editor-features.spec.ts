import { expect, test, type Page } from "@playwright/test";

/** v0.3 developer features: previews, Simple Browser, Prettier, Emmet, Zen Mode. */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const mod = process.platform === "darwin" ? "Meta" : "Control";

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator(".tm-explorer")).toBeVisible();
}

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("Markdown preview to the side follows typing", async ({ page }) => {
  await fresh(page);
  await page.locator('.tm-explorer [data-path="README.md"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("Practice project");
  await page.locator('[aria-label^="Open Preview to the Side"]').click();
  const preview = page.getByTestId("markdown-preview");
  await expect(preview.locator("h1")).toHaveText("Practice project");
  await expect(page.locator(".tm-tab", { hasText: "Preview README.md" })).toBeVisible();
  // Edit the source: the preview re-renders.
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type("\n## Live heading\n");
  await expect(preview.locator("h2")).toHaveText("Live heading");
});

test("SVG opens as text with a rendered preview beside it", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="red"/></svg>');
  await page.locator('.tm-explorer [data-path="logo.svg"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("<svg");
  await page.locator('[aria-label^="Open Preview to the Side"]').click();
  const viewer = page.getByTestId("media-viewer");
  await expect(viewer.locator("img")).toBeVisible();
  await expect(viewer.locator(".tm-media-footer")).toContainText("40 × 20");
});

test("Simple Browser opens a local URL with history and device sizes", async ({ page, baseURL }) => {
  await fresh(page);
  await command(page, "Simple Browser: Show");
  const host = new URL(baseURL!).host;
  await page.keyboard.type(host);
  await expect(page.locator(".tm-quick-pick .tm-qi-item").first()).toContainText("Open this address");
  await page.keyboard.press("Enter");
  const frame = page.getByTestId("browser-frame");
  await expect(frame).toHaveAttribute("src", `http://${host}/`);
  await expect(page.locator(".tm-browser-url")).toHaveValue(`http://${host}/`);
  await page.getByRole("radio", { name: "Mobile (375)" }).click();
  await expect(page.locator(".tm-browser .tm-preview-device")).toHaveCSS("width", "375px");
});

test("Format Document uses Prettier", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "messy.js", "const  x={a:1,b:[1,2]}\nfunction f( ){return x}\n");
  await page.locator('.tm-explorer [data-path="messy.js"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("const");
  await page.locator(".monaco-editor .view-lines").click();
  await command(page, "Format Document");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("const x = { a: 1, b: [1, 2] };", { timeout: 15_000 });
});

test("Emmet expands abbreviations in HTML", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "emmet.html", "\n");
  await page.locator('.tm-explorer [data-path="emmet.html"]').dblclick();
  await page.locator(".monaco-editor .view-lines").click();
  await page.keyboard.type("ul>li.item*2");
  await page.keyboard.press("Tab");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText('<li class="item"></li>');
});

test("Zen Mode hides everything but the editor; Escape twice leaves", async ({ page }) => {
  await fresh(page);
  await expect(page.locator(".tm-activitybar")).toBeVisible();
  await command(page, "View: Toggle Zen Mode");
  await expect(page.locator(".tm-activitybar")).toBeHidden();
  await expect(page.locator(".tm-statusbar")).toBeHidden();
  await expect(page.locator(".tm-explorer")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator(".tm-activitybar")).toBeVisible();
  await expect(page.locator(".tm-explorer")).toBeVisible();
});

test("IntelliSense reads installed packages' types from node_modules", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "node_modules/greet/package.json", JSON.stringify({ name: "greet", types: "dist/index.d.ts" }));
  await externalWrite(page, "node_modules/greet/dist/index.d.ts", 'export * from "./util";\nexport default function greet(name: string): string;\n');
  await externalWrite(page, "node_modules/greet/dist/util.d.ts", "export declare const VERSION: number;\n");
  await externalWrite(page, "node_modules/@types/plain/index.d.ts", "export declare function plain(): boolean;\n");
  await externalWrite(page, "app.ts", 'import greet, { VERSION } from "greet";\nimport { plain } from "plain";\nconst n: number = greet("x");\nconst v: string = VERSION;\nplain();\n');
  // package.json arriving (as after `npm install`) triggers type acquisition.
  await externalWrite(page, "package.json", JSON.stringify({ dependencies: { greet: "1.0.0", plain: "1" } }));
  await page.locator('.tm-explorer [data-path="app.ts"]').dblclick();
  await page.keyboard.press(`${mod}+Shift+M`);
  const problems = page.locator(".tm-problems");
  // Real type errors from the packages' declarations, and no unresolved modules.
  await expect(problems).toContainText("Type 'string' is not assignable to type 'number'.", { timeout: 20_000 });
  await expect(problems).toContainText("Type 'number' is not assignable to type 'string'.");
  await expect(problems).not.toContainText("Cannot find module");
});

test("Format Document With… lists the formatters; the configured default is used", async ({ page }) => {
  await fresh(page);
  await externalWrite(page, "two.js", "const  a={b:1}\n");
  await page.locator('.tm-explorer [data-path="two.js"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("const");
  await page.locator(".monaco-editor .view-lines").click();
  await command(page, "Format Document With");
  const items = page.locator(".tm-quick-pick .tm-qi-item");
  await expect(items.first()).toBeVisible();
  await expect(page.locator(".tm-quick-pick")).toContainText("Prettier (built in)");
  await page.keyboard.press("Escape");
  await command(page, "Configure Default Formatter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Prettier (built in)" }).click();
  await expect(page.locator(".tm-toast").last()).toContainText("Prettier (built in) now formats javascript files");
  await page.locator(".monaco-editor .view-lines").click();
  await command(page, "Format Document");
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("const a = { b: 1 };", { timeout: 15_000 });
});
