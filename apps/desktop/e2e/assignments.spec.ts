import { expect, test, type Page } from "@playwright/test";

/**
 * TMCode practicals (docs/ASSIGNMENTS_PLAN.md) against the memory account's
 * mock Task Mentor: practical 51 has two starter files, case study 52 is overdue.
 */

type Mock = {
  state(): { projects: { id: number; assignment_id?: number | null }[]; revisions: { project_id: number; number: number; files: string[] }[]; links: { status: string; revision_number: number | null }[] };
  setAssignmentStatus(id: number, status: string): void;
  grade(id: number, grade: number, feedback: string): void;
  setTeacher(on: boolean): void;
  clearAssignments(): void;
  setLifecycle(on: boolean): void;
  setQuizOpen(on: boolean): void;
  returnForChanges(id: number, message: string | null): void;
  setDueDate(id: number, iso: string | null): void;
  failAssignments(code: string | null): void;
  setQuota(bytes: number | null): void;
};
const mock = <T>(page: Page, fn: (m: Mock) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_PROJECTS__)`) as Promise<T>;

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

async function startPractical(page: Page) {
  await page.locator('.tm-activity[aria-label^="Assignments"]').click();
  await expect(page.getByTestId("assignments-view")).toBeVisible();
  await expect(row(page, 51)).toContainText("Build a to-do list");
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
}

test("the Assignments view lists practicals by state with a to-do badge", async ({ page }) => {
  await fresh(page);
  const button = page.locator('.tm-activity[aria-label^="Assignments"]');
  await expect(button.locator(".tm-activity-badge")).toHaveText("2", { timeout: 10_000 });
  await button.click();
  const view = page.getByTestId("assignments-view");
  await expect(view.locator(".tm-pane-title", { hasText: "To Do" })).toBeVisible();
  // Sorted by due date: the overdue case study first, with its lateness in red.
  await expect(view.getByTestId("assignment-row").first()).toContainText("Library case study");
  await expect(row(page, 52).locator(".tm-due.is-late")).toContainText("late");
  await expect(row(page, 51).locator(".tm-due")).toContainText("left");
  await view.getByLabel("Filter assignments").fill("to-do");
  await expect(view.getByTestId("assignment-row")).toHaveCount(1);
});

test("the brief opens as a tab, sanitised, with links kept out of the workbench", async ({ page }) => {
  await fresh(page);
  await page.locator('.tm-activity[aria-label^="Assignments"]').click();
  await row(page, 51).click();
  const brief = page.getByTestId("assignment-page");
  await expect(brief.locator("h1")).toHaveText("Build a to-do list");
  await expect(brief).toContainText("20 points");
  await expect(brief).toContainText("your teacher's 2 starter files"); // in the next-step card
  await expect(brief.locator("script")).toHaveCount(0);
  await expect(brief.locator(".tm-markdown-body li")).toHaveCount(3);
  await expect(page.locator(".tm-tab", { hasText: "Build a to-do list" })).toBeVisible();
});

test("start copies the starter files, then save and submit reach the teacher", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  // The starter files are in the new folder, which is bound to the student's own project.
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="index.html"]')).toBeVisible();
  await expect(page.locator('.tm-explorer [data-path="app.js"]')).toBeVisible();
  const ws = await mock(page, (m) => m.state().projects.find((p) => p.assignment_id === 51)?.id);
  expect(ws).toBeTruthy();

  // Edit, then Submit: TMCode saves first, so the teacher gets exactly this version.
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("app.js", "const items = [];\n"));
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await page.getByTestId("assignment-submit").click();
  // The same words as Projects › Submit Project, true to Task Mentor's lock.
  await expect(page.locator(".tm-dialog")).toContainText("Submitted work is locked until your teacher grades it or you withdraw it. You can withdraw and submit again until the assignment closes.");
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Submitted" })).toBeVisible({ timeout: 15_000 });
  const state = await mock(page, (m) => m.state());
  expect(state.revisions.filter((r) => r.project_id === ws).map((r) => r.number)).toEqual([1, 2]);
  expect(state.links.find((l) => l.status === "submitted")?.revision_number).toBe(2);
  await expect(page.getByTestId("assignment-state")).toContainText("Submitted");
  // Task Mentor locks submitted work: Withdraw to change it, no "Submit Again".
  await command(page, "Projects: Refresh Projects");
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await expect(page.getByTestId("assignment-withdraw")).toBeVisible();

  // Graded: the grade and feedback show on the page and the row.
  await mock(page, (m) => m.grade(51, 18, "Nice work"));
  await command(page, "Assignments: Refresh Assignments");
  await expect(page.getByTestId("assignment-result")).toContainText("Nice work");
  await command(page, "View: Show Assignments");
  await expect(row(page, 51)).toContainText("18/20");
  // …and in the project's assessment card, without leaving TMCode.
  await page.evaluate(`window.__TMCODE_PROJECTS__.setProjectStatus(${ws}, "graded")`);
  await command(page, "Projects: Refresh Projects");
  await command(page, "View: Show Task Mentor Projects");
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "graded");
  await expect(page.getByTestId("project-grade")).toContainText("18");
  await expect(page.getByTestId("project-grade")).toContainText("Nice work");
});

test("starting again continues the same workspace instead of copying the starter twice", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await command(page, "View: Show Assignments");
  await row(page, 51).click({ button: "right" });
  await page.locator(".tm-menu").getByText("Continue in TMCode").click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible();
  expect(await mock(page, (m) => m.state().projects.filter((p) => p.assignment_id === 51).length)).toBe(1);
});

test("a completed assignment is read-only: no editing, saving or submitting", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await mock(page, (m) => m.setAssignmentStatus(51, "completed"));
  await command(page, "Projects: Refresh Projects");
  await command(page, "Assignments: Refresh Assignments");
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await expect(page.getByTestId("assignment-readonly")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("assignment-submit")).toHaveCount(0);
  await expect(page.getByTestId("assignment-save")).toHaveCount(0);

  // The editor refuses typing, with the reason.
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await page.locator('.tm-explorer [data-path="app.js"]').dblclick();
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.type("x");
  await expect(page.locator(".monaco-editor-overlaymessage")).toContainText("is completed: this workspace is read-only");

  // Save to Task Mentor is disabled in the Projects view.
  await page.locator('.tm-activity[aria-label^="All My Projects"]').click();
  await expect(page.getByTestId("save-to-tm")).toBeDisabled();
  await command(page, "View: Show Assignments");
  await page.locator(".tm-pane-title", { hasText: "Completed (Read-only)" }).click();
  await expect(row(page, 51)).toContainText("Read-only");
});

test("disconnect stops syncing; live status sharing is locked on for open assignments", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await page.locator('.tm-activity[aria-label^="All My Projects"]').click();
  const share = page.getByTestId("share-presence");
  await expect(share).toBeChecked();
  await expect(share).toBeDisabled();
  // The assessment card names the assignment and opens its brief.
  await expect(page.getByTestId("project-assessment")).toContainText("Build a to-do list");
  await expect(page.getByTestId("project-status-panel")).toContainText("due");

  await command(page, "Projects: Disconnect This Folder from Task Mentor");
  await page.locator(".tm-dialog").getByRole("button", { name: "Disconnect" }).click();
  await expect(page.getByTestId("connect-folder")).toBeVisible();
  await expect(page.getByTestId("project-status")).toHaveCount(0);
  // The files stay.
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="app.js"]')).toBeVisible();
});

test("a personal project can stop sharing its live status", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Private work");
  await page.keyboard.press("Enter");
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "No assessment" }).click();
  await expect(page.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  const share = page.getByTestId("share-presence");
  await expect(share).toBeChecked();
  await share.click();
  await expect(share).not.toBeChecked();
  await expect(page.locator(".tm-switch-row")).toContainText("Only you see");
});

test("teachers see counts and students' workspaces, and can publish starter files", async ({ page }) => {
  await fresh(page);
  await mock(page, (m) => m.setTeacher(true));
  await command(page, "Assignments: Refresh Assignments");
  await command(page, "View: Show Assignments");
  const view = page.getByTestId("assignments-view");
  await expect(view.locator(".tm-pane-title", { hasText: "Teaching" })).toBeVisible();
  await expect(row(page, 51)).toContainText("0/24 submitted");
  await row(page, 51).click();
  const ws = page.getByTestId("assignment-workspaces");
  await expect(ws).toContainText("Ada Student");
  await expect(ws).toContainText("Not started");
  await expect(page.getByTestId("assignment-start")).toHaveCount(0);
});

test("the side bar stays tidy at narrow widths", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 700 });
  await fresh(page);
  await command(page, "View: Show Task Mentor Projects");
  const button = page.getByTestId("connect-folder");
  await expect(button).toBeVisible();
  const [b, sidebar] = await Promise.all([button.boundingBox(), page.locator(".tm-sidebar").boundingBox()]);
  expect(b!.x + b!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);
  await page.locator('.tm-activity[aria-label^="Assignments"]').click();
  const r = await row(page, 51).boundingBox();
  expect(r!.x + r!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width + 1);
});

test("with Task Mentor's project lifecycle, a submitted workspace is locked until withdrawn", async ({ page }) => {
  await fresh(page);
  await mock(page, (m) => m.setLifecycle(true));
  await startPractical(page);
  await page.getByTestId("assignment-submit").click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Submitted" })).toBeVisible({ timeout: 15_000 });
  await command(page, "Projects: Refresh Projects");
  // Locked: no Save / Submit, a Withdraw action instead; the editor explains why.
  await expect(page.getByTestId("assignment-withdraw")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("assignment-submit")).toHaveCount(0);
  await command(page, "View: Show Task Mentor Projects");
  await expect(page.getByTestId("project-submitted")).toBeVisible();
  await expect(page.getByTestId("save-to-tm")).toBeDisabled();

  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await expect(page.getByTestId("assignment-withdraw")).toHaveText("Withdraw to Edit");
  await page.getByTestId("assignment-withdraw").click();
  // A light confirmation: nothing is lost, the teacher just stops seeing this version.
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText("Withdraw your submission?");
  await expect(dialog).toContainText("Your teacher won't see version 1 until you submit again.");
  await dialog.getByRole("button", { name: "Withdraw to Edit" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Submission withdrawn" })).toBeVisible();
  await expect(page.getByTestId("assignment-submit")).toBeVisible();
  await command(page, "View: Show Task Mentor Projects");
  await expect(page.getByTestId("save-to-tm")).toBeEnabled();
});

test("a quiz's TMCode practical starts from the Assignments view, then is submitted as the quiz answer", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Assignments");
  const row = page.getByTestId("quiz-practical-row");
  await expect(row).toContainText("Build a navbar");
  await expect(row).toContainText("Web Quiz 3");
  await row.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Your workspace for \"Build a navbar\" is ready" })).toBeVisible({ timeout: 15_000 });
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="index.html"]')).toBeVisible();

  await command(page, "View: Show Task Mentor Projects");
  await expect(page.getByTestId("project-assessment")).toContainText("Web Quiz 3");
  await expect(page.getByTestId("project-status-panel")).toContainText("Quiz practical");
  await page.getByTestId("submit-project").click();
  await expect(page.locator(".tm-dialog")).toContainText("keep the quiz open in Task Mentor");
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });

  // The row says so; opening it again opens the same workspace.
  await command(page, "View: Show Assignments");
  await expect(page.getByTestId("quiz-practical-state")).toHaveText("Submitted", { timeout: 10_000 });
  await expect(page.getByTestId("quiz-practical-row")).toContainText("Open here");
  await page.getByTestId("quiz-practical-row").click();
  await expect(page.locator(".tm-toast", { hasText: "Opened your work" })).toBeVisible({ timeout: 15_000 });
  const state = await mock(page, (m) => m.state() as unknown as { links: { question_id: number | null }[] });
  expect(state.links.filter((l) => l.question_id === 501)).toHaveLength(1);
});

test("the assessment list offers a quiz's practical questions directly and starts the practical", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Task Mentor Projects");
  await page.getByRole("button", { name: "Connect This Folder to Task Mentor" }).click();
  await page.locator(".tm-quick-pick input").fill("Navbar");
  await page.keyboard.press("Enter");
  const navbar = page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Build a navbar" });
  await expect(navbar).toContainText("Quiz practical · Web Quiz 3");
  await navbar.click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Start the Practical" }).click();
  await expect(page.getByTestId("project-status-panel")).toContainText("Quiz practical", { timeout: 15_000 });
  await page.locator('.tm-activity[aria-label^="Explorer"]').click();
  await expect(page.locator('.tm-explorer [data-path="index.html"]')).toBeVisible();
});

test("with nothing assigned, the view says what will appear and how (students and teachers differ)", async ({ page }) => {
  await fresh(page);
  await mock(page, (m) => m.clearAssignments());
  await command(page, "View: Show Assignments");
  await page.getByTestId("assignments-refresh").click();
  const empty = page.getByTestId("assignments-empty");
  await expect(empty).toContainText("Nothing to do in TMCode yet", { timeout: 10_000 });
  await expect(empty).toContainText("Start button");
  await expect(empty.getByRole("button", { name: "Refresh" })).toBeVisible();
  await expect(empty.getByRole("button", { name: "Open Task Mentor" })).toBeVisible();
  await expect(empty).toContainText("Signed in as");
  await expect(page.getByTestId("assignments-checked")).toContainText("Checked just now");

  // A teacher learns which option makes an assignment appear here, with a way to create one.
  await mock(page, (m) => m.setTeacher(true));
  await empty.getByRole("button", { name: "Refresh" }).click();
  await expect(empty).toContainText("No TMCode assignments in your subjects yet");
  await expect(empty).toContainText("choose TMCode as the way students hand it in");
  await expect(page.getByTestId("assignments-create")).toBeVisible();
});

test("a brief written in Task Mentor's rich editor reads in the theme's colours, with its images", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Assignments");
  await row(page, 52).click();
  const brief = page.getByTestId("assignment-page").locator(".tm-rich").first();
  await expect(brief).toContainText("Model a small library");
  // The black, serif, white-background look the rich editor baked in is gone: the theme decides.
  const html = await brief.innerHTML();
  expect(html).not.toMatch(/color|background|font-family|Times/i);
  const colours = await brief.evaluate((el) => {
    const page = getComputedStyle(el.closest(".tm-assignment-page")!);
    return { text: getComputedStyle(el.querySelector("p")!).color, page: page.color, h2: getComputedStyle(el.querySelector("h2")!).textAlign };
  });
  expect(colours.text).toBe(colours.page);
  expect(colours.h2).toBe("center"); // structure is kept
  // An image the app can load is shown; one from another site becomes a link.
  await expect(brief.locator("img")).toHaveCount(1);
  await expect(brief.locator("img")).toHaveJSProperty("complete", true);
  await expect(brief.locator("a.tm-ext-image")).toHaveText("Open image (images.example.org)");
});

test("the assignment open in this window is highlighted, and the one whose brief is showing is selected", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await command(page, "View: Show Assignments");
  const open = row(page, 51);
  await expect(open).toHaveClass(/is-current/);
  await expect(open).toContainText("Open here");
  await expect(open).toHaveAttribute("aria-selected", "true"); // its brief is the tab in front
  await row(page, 52).click();
  await expect(row(page, 52)).toHaveAttribute("aria-selected", "true");
  await expect(open).toHaveClass(/is-current/); // still the open workspace
  await expect(row(page, 52)).not.toHaveClass(/is-current/);
});

test("loading shows the instant a request starts, on a slow network too", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Assignments");
  await expect(row(page, 51)).toBeVisible();
  await page.evaluate("window.__TMCODE_PROJECTS__.setLatency(1500)");
  const t0 = Date.now();
  await page.getByTestId("assignments-refresh").click();
  // Within a frame or two of the click, not after the round trip.
  await expect(page.getByTestId("progress-line")).toHaveClass(/is-busy/, { timeout: 400 });
  await expect(page.getByTestId("status-busy")).toBeVisible({ timeout: 400 });
  expect(Date.now() - t0).toBeLessThan(1200);
  await expect(page.getByTestId("progress-line")).not.toHaveClass(/is-busy/, { timeout: 10_000 });
  await expect(page.getByTestId("status-busy")).toHaveCount(0);

  // Save: the button says "Saving…" from the click, before the folder scan and the upload.
  await page.evaluate("window.__TMCODE_PROJECTS__.setLatency(0)");
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("app.js", "const items = [1];\n"));
  await page.evaluate("window.__TMCODE_PROJECTS__.setLatency(1500)");
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await page.getByTestId("assignment-save").click();
  await expect(page.getByTestId("assignment-save")).toContainText("Saving…", { timeout: 400 });
  await expect(page.getByTestId("status-busy")).toContainText("Saving to Task Mentor", { timeout: 400 });
  await expect(page.getByTestId("assignment-save")).toContainText("Save", { timeout: 15_000 });
  await expect(page.getByTestId("assignment-save")).not.toContainText("Saving…", { timeout: 15_000 });
});

test("a new student: opening the brief offers Start; Enter starts; the code opens with the brief beside it", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Assignments");
  await row(page, 51).click();
  const next = page.getByTestId("assignment-next-step");
  await expect(next).toContainText("Start this assignment");
  await expect(next).toContainText("your teacher's 2 starter files");
  // The offer has the keyboard: Enter starts.
  await expect(page.getByTestId("assignment-start")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(next).toContainText("You're working on it in this window", { timeout: 15_000 });
  // The starter file is open for coding, in another group than the brief.
  await expect(page.locator(".tm-tab", { hasText: "index.html" })).toBeVisible();
  const groupOf = (text: string) => page.locator(".tm-editor-group", { has: page.locator(".tm-tab", { hasText: text }) });
  await expect(groupOf("index.html")).toHaveCount(1);
  await expect(groupOf("Build a to-do list")).toHaveCount(1);
  expect(await groupOf("index.html").evaluate((g, other) => g !== document.querySelectorAll(".tm-editor-group")[other], 1)).toBe(true);
  // One brief tab, not two.
  await expect(page.locator(".tm-tab", { hasText: "Build a to-do list" })).toHaveCount(1);
});

test("an assignment without starter files offers starters, saves the choice and opens it", async ({ page }) => {
  await fresh(page);
  await command(page, "View: Show Assignments");
  await row(page, 52).click();
  await expect(page.getByTestId("assignment-next-step")).toContainText("no starter files");
  await page.getByTestId("assignment-start").click();
  const pick = page.locator(".tm-quick-pick");
  await expect(pick).toContainText("is empty. How do you want to begin?", { timeout: 15_000 });
  await expect(pick.locator(".tm-qi-item").last()).toContainText("Start with an empty project");
  await pick.locator(".tm-qi-item", { hasText: /^Python/ }).first().click();
  await expect(page.locator(".tm-tab", { hasText: "main.py" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".tm-toast", { hasText: "starts from the Python template" })).toBeVisible();
  // Saved to Task Mentor as the first revision of the student's project.
  const revs = await mock(page, (m) => m.state().revisions.filter((r) => r.files.includes("main.py")).length);
  expect(revs).toBeGreaterThan(0);
});

test("a started assignment offers Open on its row (and double-click), and its project opens with the brief from Projects too", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  // Leave it: open another folder.
  await command(page, "View: Show Assignments");
  await row(page, 52).getByRole("button", { name: "Start" }).click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Start with an empty project" }).click();
  await expect(row(page, 52)).toContainText("Open here", { timeout: 15_000 });
  const practical = row(page, 51);
  await expect(practical.getByRole("button", { name: "Open" })).toBeVisible();
  await practical.dblclick();
  await expect(practical).toContainText("Open here", { timeout: 15_000 });
  await expect(page.getByTestId("assignment-next-step")).toContainText("You're working on it");

  // From Projects: the case study's workspace opens with its brief beside the code.
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).locator(".tm-tab-close, [aria-label^='Close']").first().click();
  await command(page, "View: Show Task Mentor Projects");
  await page.getByTestId("project-row").filter({ hasText: "Library case study" }).click();
  await expect(page.locator(".tm-tab", { hasText: "Library case study" })).toBeVisible({ timeout: 15_000 });
});

async function submitFromBrief(page: Page) {
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await page.getByTestId("assignment-submit").click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
}

test("a quiz practical submitted while the quiz isn't open says so, offers the quiz, and claims nothing", async ({ page }) => {
  await fresh(page);
  await mock(page, (m) => m.setQuizOpen(false));
  await command(page, "View: Show Assignments");
  await page.getByTestId("quiz-practical-row").getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".tm-toast", { hasText: "is ready" })).toBeVisible({ timeout: 15_000 });
  await command(page, "View: Show Task Mentor Projects");
  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = ((url: string) => {
      w.__opened.push(url);
      return null;
    }) as typeof window.open;
  });
  await page.getByTestId("submit-project").click();
  await expect(page.locator(".tm-dialog")).toContainText("until the quiz closes");
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();

  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText("The quiz isn't open in Task Mentor. Open the quiz, then submit again.", { timeout: 15_000 });
  await expect(page.locator(".tm-toast", { hasText: "Your teacher sees exactly this version" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Open the Quiz in Task Mentor" }).click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([expect.stringContaining("/quizzes/78/take")]);
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "draft");
  expect(await mock(page, (m) => m.state().links.find((l) => (l as unknown as { question_id: number | null }).question_id === 501)?.status)).toBe("linked");

  // With the quiz open, the same submit goes through.
  await mock(page, (m) => m.setQuizOpen(true));
  await page.getByTestId("submit-project").click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.locator(".tm-toast", { hasText: "Your teacher sees exactly this version" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("project-status-panel")).toHaveAttribute("data-status", "submitted");
});

test("work returned for changes shows the teacher's message on the brief and the row, until it is handed in again", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await submitFromBrief(page);
  await expect(page.locator(".tm-toast", { hasText: "Submitted" }).last()).toBeVisible({ timeout: 15_000 });

  await mock(page, (m) => m.returnForChanges(51, "Add a Delete button to each item."));
  await command(page, "Projects: Refresh Projects");
  await command(page, "Assignments: Refresh Assignments");
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  const banner = page.getByTestId("assignment-returned");
  await expect(banner).toContainText("Returned by your teacher", { timeout: 10_000 });
  await expect(banner).toContainText("Add a Delete button to each item.");
  // Attention (orange), not an error.
  expect(await banner.evaluate((el) => el.className)).toContain("is-warning");
  await expect(page.getByTestId("assignment-submit")).toBeVisible();
  await command(page, "View: Show Assignments");
  const chip = row(page, 51).getByTestId("assignment-returned-chip");
  await expect(chip).toHaveText("Returned");
  await expect(chip).toHaveAttribute("title", "Returned by your teacher: Add a Delete button to each item.");

  // Handed in again: the banner and the chip go.
  await submitFromBrief(page);
  await expect(page.locator(".tm-toast", { hasText: "Submitted" }).last()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-returned")).toHaveCount(0);
  await command(page, "View: Show Assignments");
  await expect(row(page, 51).getByTestId("assignment-returned-chip")).toHaveCount(0);
});

test("late is the submission's: on time stays on time after the due date, a late hand-in says so, and no countdown once handed in", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  await submitFromBrief(page);
  await expect(page.locator(".tm-toast", { hasText: "Submitted" }).last()).toBeVisible({ timeout: 15_000 });

  // The due date passes after an on-time hand-in.
  await mock(page, (m) => m.setDueDate(51, new Date(Date.now() - 3_600_000).toISOString()));
  await command(page, "Assignments: Refresh Assignments");
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await expect(page.getByTestId("assignment-result")).toContainText("Submitted");
  await expect(page.getByTestId("assignment-result-late")).toHaveCount(0);
  await expect(page.getByTestId("assignment-due")).not.toContainText("late");
  await expect(page.getByTestId("assignment-due")).not.toHaveClass(/is-late/);
  await command(page, "View: Show Assignments");
  await expect(row(page, 51)).toContainText("Submitted");
  await expect(row(page, 51).getByTestId("assignment-late-chip")).toHaveCount(0);
  await expect(row(page, 51).locator(".tm-due")).toHaveCount(0);

  // Withdrawn and handed in again after the due date: late.
  await command(page, "Projects: Refresh Projects");
  await page.locator(".tm-tab", { hasText: "Build a to-do list" }).click();
  await page.getByTestId("assignment-withdraw").click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Withdraw to Edit" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("assignment-submit").click();
  await expect(page.locator(".tm-dialog")).toContainText("The due date has passed, so it will be marked late.");
  await page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" }).click();
  await expect(page.locator(".tm-toast", { hasText: "(late)" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-result-late")).toBeVisible();
  await command(page, "View: Show Assignments");
  await expect(row(page, 51).getByTestId("assignment-late-chip")).toBeVisible();
});

test("when Task Mentor can't check the student's subjects, the view says so instead of 'Nothing to do'", async ({ page }) => {
  await fresh(page);
  await mock(page, (m) => m.clearAssignments());
  await command(page, "View: Show Assignments");
  await page.getByTestId("assignments-refresh").click();
  await expect(page.getByTestId("assignments-empty")).toContainText("Nothing to do in TMCode yet", { timeout: 10_000 });

  // Central MIS is down (MIS_SCOPE_UNAVAILABLE).
  await mock(page, (m) => m.failAssignments("MIS_SCOPE_UNAVAILABLE"));
  await page.getByTestId("assignments-refresh").click();
  const error = page.getByTestId("assignments-error");
  await expect(error).toContainText("Couldn't check your subjects in Task Mentor.", { timeout: 10_000 });
  await expect(error).toContainText("Central MIS");
  await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(error.getByRole("button", { name: "Sign in again" })).toBeVisible();
  await expect(page.getByTestId("assignments-empty")).toHaveCount(0);

  // An expired sign-in (401) too.
  await mock(page, (m) => m.failAssignments("UNAUTHENTICATED"));
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(error).toContainText("Your sign-in has expired.");

  // Back: Retry clears it.
  await mock(page, (m) => m.failAssignments(null));
  await error.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("assignments-error")).toHaveCount(0);
  await expect(page.getByTestId("assignments-empty")).toBeVisible();
});

test("submit errors say why: offline keeps the work safe, and a project over the size limit says the limit", async ({ page }) => {
  await fresh(page);
  await startPractical(page);
  const write = (text: string) => page.evaluate((t) => (window as unknown as { __TMCODE_DEBUG__: { externalWrite(p: string, c: string): Promise<void> } }).__TMCODE_DEBUG__.externalWrite("app.js", t), text);

  // Offline (the browser says so): nothing is sent, and the work stays here.
  await write("const items = [1];\n");
  await page.evaluate(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false }));
  await submitFromBrief(page);
  await expect(page.locator(".tm-toast", { hasText: "You're offline. Your work is safe on this computer; submit when you're back online." })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".tm-toast", { hasText: "unsaved changes or conflicts" })).toHaveCount(0);
  await page.evaluate(() => Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true }));

  // Over Task Mentor's size limit (413 QUOTA_EXCEEDED): the limit, and what to do.
  await mock(page, (m) => m.setQuota(40));
  await write("const items = ['a much longer line than forty bytes in all'];\n");
  await submitFromBrief(page);
  await expect(page.locator(".tm-toast", { hasText: "This project is too large to submit: a project can be at most 40 bytes in all." })).toBeVisible({ timeout: 15_000 });
  expect(await mock(page, (m) => m.state().links.filter((l) => l.status === "submitted").length)).toBe(0);
  await mock(page, (m) => m.setQuota(null));
});
