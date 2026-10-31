import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 5: tasks.json as in VS Code — dependencies in order, problem matchers
 * into Problems, ${input:…} prompts, a failing dependency stops the rest,
 * folder-open tasks after the student allows them, and Configure Task.
 */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

const TASKS = JSON.stringify({
  version: "2.0.0",
  tasks: [
    { label: "prep", command: "echo preparing" },
    { label: "compile", command: "echo main.py:2:1: error: something broke", problemMatcher: "$gcc" },
    { label: "build", dependsOn: ["prep", "compile"], dependsOrder: "sequence", group: { kind: "build", isDefault: true } },
    { label: "greet", command: "echo hello ${input:name}" },
    { label: "fails", command: "false" },
    { label: "after", command: "echo after", dependsOn: "fails" },
  ],
  inputs: [{ id: "name", type: "promptString", description: "Your name" }],
});

async function boot(page: Page, files: Record<string, string> = {}) {
  await page.addInitScript((f) => {
    if (sessionStorage.getItem("tmcode:e2e-seeded")) return;
    sessionStorage.setItem("tmcode:e2e-seeded", "1");
    localStorage.clear();
    localStorage.setItem("tmcode:e2e-no-home", "1");
    // The practice folder starts with these files (and keeps them across a reload).
    localStorage.setItem("tmcode:mock-folder:memory://practice-project", JSON.stringify(f));
  }, files);
  await page.goto("/?terminal=sim");
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await expect(page.locator(".tm-qi-item.is-focused")).toContainText(command);
  await page.keyboard.press("Enter");
}

const toast = (page: Page, text: string | RegExp) => page.locator(".tm-toast").filter({ hasText: text });

test("Run Build Task runs the dependencies in order, and the problem matcher fills Problems", async ({ page }) => {
  await boot(page, { ".vscode/tasks.json": TASKS });
  await palette(page, "Run Build Task");
  const list = page.getByRole("list", { name: "Terminals" });
  await expect(list).toContainText("prep");
  await expect(list).toContainText("compile");
  const found = toast(page, "The task 'compile' found 1 problem.");
  await expect(found).toBeVisible({ timeout: 10_000 });
  await found.getByRole("button", { name: "Show Problems" }).click();
  await expect(page.locator(".tm-problems")).toContainText("something broke");
});

test("Run Task lists tasks.json first and asks for ${input:…}", async ({ page }) => {
  await boot(page, { ".vscode/tasks.json": TASKS });
  await palette(page, "Run Task");
  const qi = page.locator(".tm-quick-input");
  await expect(qi).toContainText("tasks.json");
  await page.keyboard.type("greet");
  await page.keyboard.press("Enter");
  await expect(qi).toContainText("Your name");
  await page.keyboard.type("Ada");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("integrated-terminal")).toContainText("hello Ada");
});

test("a failing dependency stops the task that depends on it", async ({ page }) => {
  await boot(page, { ".vscode/tasks.json": TASKS });
  await palette(page, "Run Task");
  await page.keyboard.type("after");
  await page.keyboard.press("Enter");
  await expect(toast(page, "The task 'fails' failed (exit code 1).")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("integrated-terminal")).not.toContainText("echo after");
});

test("folder-open tasks run once the student allows them", async ({ page }) => {
  await boot(page, { ".vscode/tasks.json": JSON.stringify({ version: "2.0.0", tasks: [{ label: "welcome", command: "echo ready to code", runOptions: { runOn: "folderOpen" } }] }) });
  const ask = toast(page, "This folder has tasks that run when it opens: 'welcome'");
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Allow and Run" }).click();
  await expect(page.getByTestId("integrated-terminal")).toContainText("ready to code");
});

test("Configure Task creates tasks.json from a template", async ({ page }) => {
  await boot(page);
  await palette(page, "Tasks: Configure Task");
  await expect(page.locator(".tm-tab.is-active")).toContainText("tasks.json");
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText('"version": "2.0.0"');
});
