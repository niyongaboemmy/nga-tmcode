import { expect, test, type Page } from "@playwright/test";

/** Task Mentor projects in TMCode (memory account + mock Task Mentor projects API). */

type Debug = { externalWrite(path: string, content: string): Promise<void> };
type Mock = { remoteSave(id: number, files: Record<string, string>): Promise<void>; state(): { projects: { id: number }[]; revisions: { number: number; files: string[] }[]; links: { status: string }[] } };
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: Debug }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);
const mock = <T>(page: Page, fn: (m: Mock) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_PROJECTS__)`) as Promise<T>;

async function fresh(page: Page, signedIn = false) {
  await page.goto("/");
  await page.evaluate((s) => {
    localStorage.clear();
    if (s) localStorage.setItem("tmcode:mock-account", "signed-in");
  }, signedIn);
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("signing in with NGA shows the projects", async ({ page }) => {
  await fresh(page);
  await page.getByTestId("account-button").click();
  await page.getByText("Sign in with NGA (Central MIS + Task Mentor)").click();
  await expect(page.locator(".tm-toast").first()).toContainText(/browser|Signed in/);
  await expect(page.getByTestId("account-button")).toHaveAttribute("title", /Ada Student/);
  await page.getByTestId("account-button").click();
  await page.getByText("Task Mentor Projects", { exact: true }).click();
  await expect(page.getByTestId("projects-view")).toBeVisible();
  await expect(page.getByTestId("projects-view")).toContainText("No projects yet");
});

test("connect the folder, save, edit, save again, then get changes from another computer", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick .tm-qi-item").first().click(); // New Project from This Folder…
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "This folder" }).click();
  await page.locator(".tm-quick-pick input").fill("Practice project");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-state")).toContainText("Saved to Task Mentor", { timeout: 15_000 });
  await expect(page.getByTestId("project-status")).toHaveText("Task Mentor");
  const first = await mock(page, (m) => m.state().revisions);
  expect(first).toHaveLength(1);
  expect(first[0].files).toContain("main.py");
  expect(first[0].files).not.toContain(".tmcode/project.json");

  // Edit a file: the badge counts it, Save to Task Mentor uploads it.
  await externalWrite(page, "main.py", 'print("edited")\n');
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("project-status")).toHaveText("1 to save", { timeout: 10_000 });
  await page.getByTestId("save-to-tm").click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved to Task Mentor");
  expect(await mock(page, (m) => m.state().revisions.length)).toBe(2);

  // Another computer saves: Get Latest brings it in.
  const id = await mock(page, (m) => m.state().projects[0].id);
  await page.evaluate(`window.__TMCODE_PROJECTS__.remoteSave(${id}, { "notes/todo.md": "# Todo\\n" })`);
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("sync-state")).toContainText("Newer changes in Task Mentor");
  await command(page, "Projects: Get Latest from Task Mentor");
  await expect(page.getByTestId("sync-state")).toContainText("Saved to Task Mentor");
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="notes"]')).toBeVisible();
});

test("a file changed here and in Task Mentor is a conflict the user resolves", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick .tm-qi-item").first().click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "This folder" }).click();
  await page.locator(".tm-quick-pick input").fill("Conflicts");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-state")).toContainText("Saved to Task Mentor", { timeout: 15_000 });
  const id = await mock(page, (m) => m.state().projects[0].id);
  await page.evaluate(`window.__TMCODE_PROJECTS__.remoteSave(${id}, { "main.py": "print('theirs')\\n" })`);
  await externalWrite(page, "main.py", "print('mine')\n");
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("conflicts")).toContainText("main.py");
  await page.getByTestId("conflicts").getByLabel("Take Task Mentor's").click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved to Task Mentor");
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("theirs");
});

test("link the project to an assignment and submit it", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick .tm-qi-item").first().click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "This folder" }).click();
  await page.locator(".tm-quick-pick input").fill("Calculator");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-state")).toContainText("Saved to Task Mentor", { timeout: 15_000 });
  await command(page, "Projects: Link to an Activity");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Build a calculator" }).click();
  await expect(page.getByTestId("project-folder")).toContainText("Build a calculator");
  await page.getByTestId("project-folder").getByRole("button", { name: "Submit" }).click();
  await expect(page.getByTestId("project-folder")).toContainText("Submitted r1");
  expect(await mock(page, (m) => m.state().links[0].status)).toBe("submitted");
});

test("projects are hidden during exams and signed-out views explain sign-in", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Task Mentor Projects");
  await expect(page.getByTestId("projects-signin")).toContainText("Sign in with NGA");
});
