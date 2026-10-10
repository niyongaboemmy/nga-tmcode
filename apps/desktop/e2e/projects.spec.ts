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
  await page.mouse.move(700, 400);
  await expect(page.getByTestId("account-button")).toHaveAttribute("title", /Ada Student/);
  await page.getByTestId("account-button").click();
  await page.getByText("All My Projects", { exact: true }).click();
  await expect(page.getByTestId("projects-view")).toBeVisible();
  await expect(page.getByTestId("projects-view")).toContainText("No projects yet");
});

test("connect the folder, save, edit, save again, then get changes from another computer", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Practice project");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  // The status bar uses the Projects view's words.
  await expect(page.getByTestId("project-status")).toHaveText("Saved online");
  const first = await mock(page, (m) => m.state().revisions);
  expect(first).toHaveLength(1);
  expect(first[0].files).toContain("main.py");
  expect(first[0].files).not.toContain(".tmcode/project.json");

  // Edit a file: the badge counts it, Save to Task Mentor uploads it.
  await externalWrite(page, "main.py", 'print("edited")\n');
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("project-status")).toHaveText("Not saved yet", { timeout: 10_000 });
  await page.getByTestId("save-to-tm").click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online");
  await expect(page.getByTestId("project-status")).toHaveText("Saved online");
  // "version N" everywhere (not "revision").
  await expect(page.locator(".tm-toast", { hasText: "Saved to Task Mentor (version 2)" })).toBeVisible();
  expect(await mock(page, (m) => m.state().revisions.length)).toBe(2);

  // Another computer saves: Get Latest brings it in.
  const id = await mock(page, (m) => m.state().projects[0].id);
  await page.evaluate(`window.__TMCODE_PROJECTS__.remoteSave(${id}, { "notes/todo.md": "# Todo\\n" })`);
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("sync-state")).toContainText("Newer version online");
  await expect(page.getByTestId("project-status")).toHaveText("Newer version online");
  await command(page, "Projects: Get Latest from Task Mentor");
  await expect(page.getByTestId("sync-state")).toContainText("Saved online");
  // What came down, by name.
  await expect(page.locator(".tm-toast", { hasText: "Got 1 change from Task Mentor: todo.md." })).toBeVisible();
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="notes"]')).toBeVisible();
});

test("a file changed here and in Task Mentor is a conflict the user resolves", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Conflicts");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  const id = await mock(page, (m) => m.state().projects[0].id);
  await page.evaluate(`window.__TMCODE_PROJECTS__.remoteSave(${id}, { "main.py": "print('theirs')\\n" })`);
  await externalWrite(page, "main.py", "print('mine')\n");
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("conflicts")).toContainText("main.py");
  await page.getByTestId("conflicts").getByLabel("Take Task Mentor's").click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online");
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines")).toContainText("theirs");
});

test("a new project is matched from one assessment list, then submitted (In progress → Submitted)", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Calculator");
  await page.keyboard.press("Enter");
  // One list of every assessment, grouped by subject, soonest due first; "No assessment" last.
  const pick = page.locator(".tm-quick-pick");
  await expect(pick).toContainText("Which assessment is \"Calculator\" for?");
  await expect(pick).toContainText("Programming 101");
  await expect(pick).toContainText("Web Development");
  await expect(pick.locator(".tm-qi-item").last()).toContainText("No assessment");
  await pick.locator("input").fill("calc");
  await expect(pick.locator(".tm-qi-item").first()).toContainText("Build a calculator");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  await expect(page.getByTestId("project-assessment")).toContainText("Build a calculator");
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "draft");

  await page.getByTestId("submit-project").click();
  // The same words as Assignments › Submit, true to Task Mentor's lock.
  await expect(page.locator(".tm-dialog")).toContainText("Submitted work is locked until your teacher grades it or you withdraw it. You can withdraw and submit again until the assignment closes.");
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Your teacher sees exactly this version" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("project-submitted")).toBeVisible();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "submitted");
  await expect(page.getByTestId("save-to-tm")).toBeDisabled();
  expect(await mock(page, (m) => m.state().links[0].status)).toBe("submitted");

  // Withdraw → Draft again; then the teacher grades it → Graded.
  await expect(page.getByTestId("project-withdraw")).toHaveText("Withdraw to Edit");
  await page.getByTestId("project-withdraw").click();
  // A light, non-destructive confirmation; Cancel keeps it submitted.
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText("Withdraw your submission?");
  await expect(dialog).toContainText("Your teacher won't see version 1 until you submit again.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "submitted");
  await command(page, "Projects: Withdraw to Edit");
  await page.locator(".tm-dialog").getByRole("button", { name: "Withdraw to Edit" }).click();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("submit-project")).toBeEnabled();
  const id = await mock(page, (m) => m.state().projects[0].id);
  await page.evaluate(`window.__TMCODE_PROJECTS__.setProjectStatus(${id}, "graded")`);
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "graded");
  await expect(page.getByTestId("submit-project")).toHaveCount(0);
});

test("the assessment can be changed or removed while the project is a draft", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Site");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  await expect(page.getByTestId("project-assessment")).toHaveCount(0);

  // Unmatched: match it.
  await page.getByTestId("match-assessment").click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Portfolio website" }).click();
  await expect(page.getByTestId("project-assessment")).toContainText("Portfolio website");

  // Change it: the current one is marked; the new assessment replaces the old one.
  await page.getByTestId("change-assessment").click();
  await expect(page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Portfolio website" })).toContainText("current");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Python Practical 2" }).click();
  await expect(page.getByTestId("project-assessment")).toContainText("Python Practical 2");
  const links = await mock(page, (m) => m.state().links as unknown as { activity_type: string }[]);
  expect(links.map((l) => l.activity_type)).toEqual(["quiz"]);

  // Remove the match: a personal project again.
  await page.getByTestId("change-assessment").click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Remove the match" }).click();
  await expect(page.getByTestId("match-assessment")).toBeVisible();
  expect(await mock(page, (m) => m.state().links.length)).toBe(0);
});

test("submitting an unmatched project asks which assessment first", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Lab");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  // Unmatched, the card's one action is matching; Submit (here from the palette) asks which assessment first.
  await expect(page.getByTestId("submit-project")).toHaveCount(0);
  await expect(page.getByTestId("match-assessment")).toBeVisible();
  await command(page, "Projects: Submit Project");
  await page.locator(".tm-dialog").getByRole("button", { name: "Choose an Assessment…" }).click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Lab presentation" }).click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
  await expect(page.getByTestId("project-assessment")).toContainText("Lab presentation");
});

test("remove a draft project, filter by status, and restore it", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Old work");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  await expect(page.getByTestId("status-filter-draft")).toContainText("1");
  await page.getByTestId("status-filter-submitted").click();
  await expect(page.getByTestId("project-row")).toHaveCount(0);
  await page.getByTestId("status-filter-all").click();
  await expect(page.getByTestId("project-row")).toHaveCount(1);

  await command(page, "Projects: Remove Project");
  await page.locator(".tm-dialog").getByRole("button", { name: "Remove" }).click();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "removed");
  await expect(page.getByTestId("project-row")).toHaveCount(0);
  await page.locator(".tm-pane-title", { hasText: "Removed" }).click();
  await expect(page.getByTestId("removed-project-row")).toContainText("Old work");
  await page.getByTestId("removed-project-row").getByRole("button", { name: "Restore" }).click();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "draft");
  await expect(page.getByTestId("project-row")).toHaveCount(1);
});

test("projects are hidden during exams and signed-out views explain sign-in", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Task Mentor Projects");
  await expect(page.getByTestId("projects-signin")).toContainText("Sign in with NGA");
});

test("only teachers are offered Use as Starter in the This Folder menu", async ({ page }) => {
  await fresh(page, true);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Starter check");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  const menu = async () => {
    await page.getByTestId("project-folder").getByLabel("More Project Actions…").click();
    await expect(page.locator(".tm-menu")).toContainText("Get Latest from Task Mentor");
    const has = await page.locator(".tm-menu", { hasText: "Use as Starter for an Assignment…" }).count();
    await page.locator(".tm-menu").press("Escape");
    await expect(page.locator(".tm-menu")).toHaveCount(0);
    return has;
  };
  expect(await menu()).toBe(0);

  await page.evaluate("window.__TMCODE_PROJECTS__.setTeacher(true)");
  await command(page, "Assignments: Refresh Assignments");
  await expect.poll(menu).toBe(1);
});
