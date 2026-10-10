import { expect, test, type Page } from "@playwright/test";

/**
 * 0.11 "One place for my work": what is handed in, the rubric in the brief,
 * honest sync words, automatic saving for assignments, pulls kept in Local
 * History, Save before switching, and Compare for conflicts.
 */

type Mock = {
  state(): { projects: { id: number; assignment_id?: number | null }[]; revisions: { project_id: number; number: number; files: string[] }[]; links: { status: string }[] };
  grade(id: number, grade: number, feedback: string, rubricScores?: { index: number; score: number; comment?: string | null }[] | null): void;
  setScanLimit(bytes: number): void;
  setQuota(bytes: number | null): void;
  setOldServer(on: boolean): void;
  closeAssignment(id: number, on?: boolean): void;
  setDueDate(id: number, iso: string | null): void;
  remoteSave(id: number, files: Record<string, string>): Promise<void>;
};
const mock = <T>(page: Page, fn: (m: Mock) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_PROJECTS__)`) as Promise<T>;
const externalWrite = (page: Page, path: string, content: string) =>
  page.evaluate(([p, c]) => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite(p, c), [path, content]);

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

async function command(page: Page, name: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

const row = (page: Page, id: number) => page.locator(`[data-testid="assignment-row"][data-assignment-id="${id}"]`);
const brief = (page: Page) => page.locator(".tm-tab", { hasText: "Build a to-do list" });

async function startPractical(page: Page) {
  await page.locator('.tm-activity[aria-label^="Assignments"]').click();
  await expect(row(page, 51)).toContainText("Build a to-do list");
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-sync")).toContainText("Saved online", { timeout: 15_000 });
}

const workspace = (page: Page) => mock(page, (m) => m.state().projects.find((p) => p.assignment_id === 51)!.id);
const revisionsOf = (page: Page, id: number) => page.evaluate(`window.__TMCODE_PROJECTS__.state().revisions.filter((r) => r.project_id === ${id})`) as Promise<{ number: number; files: string[] }[]>;

test("the submit dialog says what is handed in and lists what is not", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await mock(page, (m) => m.setScanLimit(500));
  await externalWrite(page, "data.csv", "x".repeat(600));
  await externalWrite(page, "node_modules/lib/index.js", "module.exports = 1;\n");
  await brief(page).click();
  await page.getByTestId("assignment-submit").click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText(/\d+ files?, [\d.]+ (bytes|KB|MB) will be handed in\./);
  await expect(dialog).toContainText("2 not included: Show to see what and why.");
  await dialog.getByRole("button", { name: "Show Not Included" }).click();
  const pick = page.locator(".tm-quick-pick");
  await expect(pick).toContainText("2 not included");
  await expect(pick.locator(".tm-qi-item", { hasText: "data.csv" })).toContainText("larger than 10 MB");
  await expect(pick.locator(".tm-qi-item", { hasText: "node_modules/" })).toContainText("build output or dependencies");
  await page.keyboard.press("Escape");
  // Back to the same confirmation: nothing was submitted.
  await expect(dialog).toContainText("will be handed in");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await mock(page, (m) => m.state().links.filter((l) => l.status === "submitted").length)).toBe(0);
});

test("a file that grows past the size limit stays in Task Mentor instead of being deleted", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  const ws = await workspace(page);
  expect((await revisionsOf(page, ws)).at(-1)!.files).toContain("app.js");
  await mock(page, (m) => m.setScanLimit(200));
  await externalWrite(page, "app.js", `// grew\n${"x".repeat(400)}\n`);
  await externalWrite(page, "notes.txt", "a new file\n");
  await command(page, "Projects: Save to Task Mentor");
  await expect(page.locator(".tm-toast", { hasText: /Saved to Task Mentor \(version \d+\)/ })).toBeVisible({ timeout: 15_000 });
  const last = (await revisionsOf(page, ws)).at(-1)!;
  expect(last.files).toContain("notes.txt");
  expect(last.files).toContain("app.js");
});

test("the brief shows how it's graded, then the score and note per criterion", async ({ page }) => {
  await fresh(page);
  await page.locator('.tm-activity[aria-label^="Assignments"]').click();
  await row(page, 51).click();
  const rubric = page.getByTestId("assignment-rubric");
  await expect(rubric).toContainText("How it's graded");
  await expect(rubric).toContainText("Adding items works");
  await expect(rubric).toContainText("Typing a task and pressing Add shows it in the list");
  await expect(rubric.locator("tfoot")).toContainText("20");

  await mock(page, (m) =>
    m.grade(51, 18, "Nice work\n\nCriteria notes:\n• Adding items works: Empty tasks get added\n• Code quality: Clear names", [
      { index: 0, score: 11, comment: "Empty tasks get added" },
      { index: 1, score: 7, comment: "Clear names" },
    ]),
  );
  await command(page, "Assignments: Refresh Assignments");
  const scores = page.getByTestId("assignment-rubric-scores");
  await expect(scores).toContainText("11 / 12");
  await expect(scores).toContainText("Empty tasks get added");
  await expect(scores.locator("tfoot")).toContainText("18 / 20");
  // The feedback without the notes block (the table shows the notes).
  await expect(page.locator(".tm-assignment-feedback")).toHaveText("Nice work");
  await expect(page.getByTestId("assignment-rubric")).toHaveCount(0);

  // An older Task Mentor: the notes come from the feedback text, scores unknown.
  await mock(page, (m) => {
    m.setOldServer(true);
    m.grade(51, 18, "Good\n\nCriteria notes:\n• Code quality: Clear names");
  });
  await command(page, "Assignments: Refresh Assignments");
  await expect(page.getByTestId("assignment-rubric-scores")).toContainText("Clear names");
  await expect(page.locator(".tm-assignment-feedback")).toHaveText("Good");
});

test("assignment work saves itself: the brief's sync line, leaving the window, and failures said once", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  const ws = await workspace(page);
  await brief(page).click();
  await expect(page.getByTestId("assignment-next-step")).toContainText("saves to Task Mentor by itself");
  await expect(page.getByTestId("assignment-save")).toHaveText(/Save to Task Mentor/);
  const before = (await revisionsOf(page, ws)).length;

  await externalWrite(page, "app.js", "const items = ['auto'];\n");
  await command(page, "Projects: Refresh Projects");
  await brief(page).click();
  await expect(page.getByTestId("assignment-sync")).toContainText("Not saved yet · 1 change");
  await expect(page.getByTestId("project-status")).toHaveText("Not saved yet");
  // Leaving the window saves at once.
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByTestId("assignment-sync")).toContainText("Saved online · just now", { timeout: 15_000 });
  expect((await revisionsOf(page, ws)).length).toBe(before + 1);

  // Two automatic saves fail in a row: one toast, with the cause.
  await mock(page, (m) => m.setQuota(10));
  await externalWrite(page, "app.js", "const items = ['too big for the quota'];\n");
  await command(page, "Projects: Refresh Projects");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByTestId("project-status")).toHaveText("Sync problem", { timeout: 15_000 });
  await expect(page.locator(".tm-toast", { hasText: "Automatic saving" })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const toast = page.locator(".tm-toast", { hasText: "Automatic saving to Task Mentor isn't working" });
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(toast).toContainText("too large");
});

test("a closed assignment says Closed and can't be submitted; late work is explained", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await mock(page, (m) => m.setDueDate(51, new Date(Date.now() - 3600_000).toISOString()));
  await command(page, "Assignments: Refresh Assignments");
  await brief(page).click();
  await expect(page.getByTestId("assignment-late-policy")).toContainText("Late work is accepted until your teacher closes the assignment; it will be marked late.");
  await mock(page, (m) => m.closeAssignment(51));
  await command(page, "Assignments: Refresh Assignments");
  await expect(page.getByTestId("assignment-state")).toHaveText("Closed");
  await expect(page.getByTestId("assignment-submit")).toBeDisabled();
  await expect(page.getByTestId("assignment-submit")).toHaveText(/Closed/);
});

test("opening another assignment offers to save this one first", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  const ws = await workspace(page);
  const before = (await revisionsOf(page, ws)).length;
  // Not saved by itself yet (no blur, no 30 s): the switch asks.
  await externalWrite(page, "app.js", "const items = ['switch'];\n");
  await command(page, "View: Show Assignments");
  await row(page, 52).getByRole("button", { name: "Start" }).click();
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText('Save "Build a to-do list" to Task Mentor before opening "Library case study"?');
  await expect(dialog.getByRole("button", { name: "Open Without Saving" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save and Open" }).click();
  await expect.poll(async () => (await revisionsOf(page, ws)).length, { timeout: 15_000 }).toBe(before + 1);
});

test("conflicts: Compare opens Task Mentor's copy beside mine; taking theirs keeps mine in Local History", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Compare");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  const id = await mock(page, (m) => m.state().projects[0].id);
  await page.evaluate(`window.__TMCODE_PROJECTS__.remoteSave(${id}, { "main.py": "print('theirs')\\n" })`);
  await externalWrite(page, "main.py", "print('mine')\n");
  await command(page, "Projects: Refresh Projects");
  await expect(page.getByTestId("conflicts")).toContainText("main.py");
  await expect(page.getByTestId("project-status")).toHaveText("Conflicts to resolve");

  await command(page, "Projects: Compare Conflict with Task Mentor's Copy");
  await expect(page.locator(".tm-tab", { hasText: "main.py (Task Mentor) ↔ Yours" })).toBeVisible();
  const bar = page.getByTestId("conflict-compare");
  await expect(bar).toContainText("Task Mentor's copy");
  await expect(page.getByTestId("history-diff").locator(".view-lines").first()).toContainText("theirs");
  await bar.getByRole("button", { name: "Take Task Mentor's" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  await expect(page.locator(".tm-tab", { hasText: "(Task Mentor)" })).toHaveCount(0);

  // My version was kept in Local History before Task Mentor's replaced it.
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await page.locator('.tm-explorer [data-path="main.py"]').dblclick();
  await expect(page.locator(".monaco-editor .view-lines").first()).toContainText("theirs");
  const timeline = page.getByTestId("timeline");
  await timeline.locator(".tm-pane-header").click();
  await expect(timeline.locator(".tm-timeline-row").first()).toBeVisible();
});
