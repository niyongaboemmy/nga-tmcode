import { expect, test, type Page } from "@playwright/test";

/**
 * 0.11 "One place for my work": the student's Assignments view is home.
 * Memory account + mock Task Mentor (TMC/platform/memoryProjects.ts): practical 51
 * (due in 2 days, starter files), case study 52 (overdue), quiz 78 with practical 501.
 */

type Mock = {
  grade(id: number, grade: number, feedback: string): void;
  setAssignmentStatus(id: number, status: string): void;
  clearAssignments(): void;
  addAssignment(fields: Record<string, unknown>): void;
  setQuizPractical(quizId: number, quiz: Record<string, unknown>, questions?: Record<number, Record<string, unknown>>): void;
  expireSession(reason?: string): void;
};
const mock = <T>(page: Page, fn: (m: Mock) => T | Promise<T>) => page.evaluate(`(${fn.toString()})(window.__TMCODE_PROJECTS__)`) as Promise<T>;

async function fresh(page: Page, signedIn = true, query = "") {
  await page.goto(`/${query}`);
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

const row = (page: Page, id: number) => page.locator(`[data-testid="assignment-row"][data-assignment-id="${id}"]`);
const assignmentsIcon = (page: Page) => page.locator('.tm-activity[aria-label^="Assignments"]');

async function openAssignments(page: Page) {
  await command(page, "View: Show Assignments");
  await expect(page.getByTestId("assignments-view")).toBeVisible();
  await expect(row(page, 51)).toBeVisible({ timeout: 10_000 });
}

async function refresh(page: Page) {
  await page.getByTestId("assignments-refresh").click();
  await expect(page.getByTestId("assignments-checked")).toContainText("Checked", { timeout: 10_000 });
}

const opacity = (_page: Page, sel: ReturnType<Page["locator"]>) => sel.evaluate((el) => Number(getComputedStyle(el).opacity));

test("#4 students: Assignments comes first, Projects is the secondary All My Projects list", async ({ page }) => {
  await fresh(page);
  const labels = await page.locator(".tm-activitybar-top .tm-activity").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
  const a = labels.findIndex((l) => l.startsWith("Assignments"));
  const p = labels.findIndex((l) => l.startsWith("All My Projects"));
  expect(a).toBeGreaterThan(-1);
  expect(p).toBe(a + 1);
  expect(labels.some((l) => l.startsWith("Task Mentor Projects"))).toBe(false);
  // Assignments has the mortar board; the exam Task view has its own icon.
  await expect(assignmentsIcon(page).locator(".codicon-mortar-board")).toHaveCount(1);

  // A plain folder is not an assignment workspace: no This Folder card.
  await openAssignments(page);
  await expect(page.getByTestId("assignments-this-folder")).toHaveCount(0);

  // "…" › Show All My Projects.
  await page.locator(".tm-sidebar-title").getByRole("button", { name: "Views and More Actions..." }).click();
  await page.locator(".tm-menu-item", { hasText: "Show All My Projects" }).click();
  await expect(page.getByTestId("projects-view")).toBeVisible();
  await expect(page.locator(".tm-sidebar-title h2")).toHaveText("All My Projects");
});

test("#4 an open assignment workspace shows This Folder (sync, Save, status, Submit) on top of Assignments", async ({ page }) => {
  await fresh(page);
  await openAssignments(page);
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
  await command(page, "View: Show Assignments");
  const folder = page.getByTestId("assignments-this-folder");
  await expect(folder).toBeVisible({ timeout: 15_000 });
  await expect(folder.getByTestId("sync-state")).toContainText("Saved online", { timeout: 15_000 });
  await expect(folder.getByTestId("save-to-tm")).toBeVisible();
  await expect(folder.getByTestId("project-status-panel")).toHaveAttribute("data-status", "draft");
  await expect(folder.getByTestId("project-assessment")).toContainText("Build a to-do list");
  await expect(folder.getByTestId("submit-project")).toBeVisible();
  await expect(folder.getByTestId("share-presence")).toBeChecked();
  // It sits above the list.
  const top = await folder.boundingBox();
  const list = await page.locator(".tm-pane-title", { hasText: "To Do" }).boundingBox();
  expect(top!.y).toBeLessThan(list!.y);
});

test("#10 Welcome: sign in from the Your assignments card, then Assignments opens once", async ({ page }) => {
  await fresh(page, false, "?empty=1");
  const card = page.getByTestId("welcome-assignments-card");
  await expect(card).toContainText("Your assignments");
  await card.getByTestId("welcome-signin").click();
  // After the first sign-in the Assignments view opens by itself.
  await expect(page.getByTestId("assignments-view")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("welcome-assignments-summary")).toHaveText(/^2 to do · next due \S+/, { timeout: 10_000 });
  await expect(card.getByTestId("welcome-open-assignments")).toBeVisible();

  // Only once: sign out on purpose and in again, the view stays where it is.
  await command(page, "View: Show Explorer");
  await page.getByTestId("account-button").click();
  await page.locator(".tm-menu-item", { hasText: "Sign Out" }).click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Sign Out" }).click();
  await expect(card.getByTestId("welcome-signin")).toBeVisible();
  await card.getByTestId("welcome-signin").click();
  await expect(page.getByTestId("welcome-assignments-summary")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("assignments-view")).toHaveCount(0);
  // Open Assignments from the card.
  await card.getByTestId("welcome-open-assignments").click();
  await expect(page.getByTestId("assignments-view")).toBeVisible();
});

test("#10 Welcome: nothing due, and the exam and practice cards do something", async ({ page }) => {
  await fresh(page, true, "?empty=1");
  await mock(page, (m) => m.clearAssignments());
  await command(page, "Assignments: Refresh");
  await expect(page.getByTestId("welcome-assignments-summary")).toHaveText("Nothing due", { timeout: 10_000 });

  await page.evaluate(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    window.open = ((url: string) => {
      w.__opened.push(url);
      return null;
    }) as typeof window.open;
  });
  await page.getByTestId("welcome-exam-card").click();
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([expect.stringMatching(/\/quizzes$/)]);

  const practice = page.getByTestId("welcome-practice-card");
  await expect(practice.getByRole("button", { name: "Open Folder..." })).toBeVisible();
  await practice.getByRole("button", { name: "New Project from Template..." }).click();
  await expect(page.locator(".tm-quick-pick")).toBeVisible();
});

test("#11 row actions are quiet: shown on hover or selection, solid for the most urgent to-do", async ({ page }) => {
  await fresh(page);
  await openAssignments(page);
  await page.mouse.move(700, 790);
  // The overdue case study (soonest due, not started) keeps a solid, visible Start.
  const urgent = row(page, 52).getByTestId("assignment-row-action");
  await expect(row(page, 52)).toHaveClass(/is-urgent/);
  await expect(urgent).not.toHaveClass(/tm-button--secondary/);
  expect(await opacity(page, urgent)).toBe(1);
  // The others are secondary and hidden until hover.
  const quiet = row(page, 51).getByTestId("assignment-row-action");
  await expect(quiet).toHaveClass(/tm-button--secondary/);
  await expect.poll(() => opacity(page, quiet)).toBe(0);
  await row(page, 51).hover();
  await expect.poll(() => opacity(page, quiet)).toBe(1);
  await page.mouse.move(700, 790);
  await expect.poll(() => opacity(page, quiet)).toBe(0);
  // Selected (its brief in front): shown.
  await row(page, 51).click();
  await page.mouse.move(700, 790);
  await expect(row(page, 51)).toHaveClass(/is-viewing/);
  await expect.poll(() => opacity(page, quiet)).toBe(1);
});

test("S8 quiz practical rows: opening time, attempt, state and grade", async ({ page }) => {
  await fresh(page);
  const opens = new Date(Date.now() + 3 * 86_400_000);
  opens.setHours(9, 0, 0, 0);
  await page.evaluate((iso) => (window as unknown as { __TMCODE_PROJECTS__: Mock }).__TMCODE_PROJECTS__.setQuizPractical(78, { start_date: iso, attempt_open: false }), opens.toISOString());
  await openAssignments(page);
  await refresh(page);
  const practical = page.getByTestId("quiz-practical-row");
  await expect(practical.getByTestId("quiz-practical-state")).toHaveText("Not started");
  await expect(practical.getByTestId("quiz-practical-opens")).toContainText(/^Opens \S+ 9:00/);
  await expect(practical.getByRole("button", { name: "Start" })).toBeDisabled();
  await expect(practical.getByTestId("quiz-practical-attempt")).toHaveCount(0);

  // Open now, the attempt not yet open in Task Mentor (attention), then open (info).
  await mock(page, (m) => m.setQuizPractical(78, { start_date: new Date(Date.now() - 60_000).toISOString(), attempt_open: false }));
  await refresh(page);
  await expect(practical.getByTestId("quiz-practical-attempt")).toHaveText("Quiz not open in Task Mentor");
  await expect(practical.getByTestId("quiz-practical-attempt")).toHaveClass(/is-warning/);
  await mock(page, (m) => m.setQuizPractical(78, { attempt_open: true }));
  await refresh(page);
  await expect(practical.getByTestId("quiz-practical-attempt")).toHaveText("Quiz open in Task Mentor");
  await practical.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".tm-toast", { hasText: 'Your workspace for "Build a navbar" is ready' })).toBeVisible({ timeout: 15_000 });
  await command(page, "View: Show Assignments");
  await expect(practical.getByTestId("quiz-practical-state")).toHaveText("In progress", { timeout: 10_000 });
  await expect(practical).toContainText("Open here");

  // Graded, with the grade from Task Mentor.
  await mock(page, (m) => m.setQuizPractical(78, {}, { 501: { state: "graded", grade: 8 } }));
  await refresh(page);
  await expect(practical.getByTestId("quiz-practical-state")).toHaveText("8/10");
  await expect(practical).toHaveAttribute("data-state", "graded");
});

test("S9 new and graded work is announced between checks, never on the first load", async ({ page }) => {
  await fresh(page);
  await openAssignments(page);
  await expect(page.locator(".tm-toast", { hasText: "New assignment" })).toHaveCount(0);
  await mock(page, (m) => m.addAssignment({ title: "Weather app" }));
  await refresh(page);
  const added = page.locator(".tm-toast", { hasText: "New assignment: Weather app" });
  await expect(added).toBeVisible();
  await added.getByRole("button", { name: "Show Brief" }).click();
  await expect(page.locator(".tm-tab", { hasText: "Weather app" })).toBeVisible();

  await mock(page, (m) => m.grade(51, 17, "Nice work"));
  await refresh(page);
  const graded = page.locator(".tm-toast", { hasText: "Build a to-do list was graded: 17/20" });
  await expect(graded).toBeVisible();
  await graded.getByRole("button", { name: "View Feedback" }).click();
  await expect(page.locator(".tm-tab.is-active", { hasText: "Build a to-do list" })).toBeVisible();
  // Told once: the action closed it, and another check says nothing new.
  await refresh(page);
  await expect(page.locator(".tm-toast", { hasText: "was graded" })).toHaveCount(0);
});

test("S16 completed rows show the grade and a lock", async ({ page }) => {
  await fresh(page);
  await mock(page, (m) => {
    m.grade(51, 17, "Good");
    m.setAssignmentStatus(51, "completed");
  });
  await command(page, "View: Show Assignments");
  await expect(row(page, 52)).toBeVisible({ timeout: 10_000 });
  await refresh(page);
  await page.locator(".tm-pane-title", { hasText: "Completed (Read-only)" }).click();
  await expect(row(page, 51).getByTestId("assignment-grade-chip")).toHaveText("17/20");
  await expect(row(page, 51).getByTestId("assignment-locked-chip")).toContainText("Read-only");
  await expect(row(page, 51).getByTestId("assignment-locked-chip").locator(".codicon-lock")).toHaveCount(1);
});

test("#17 Assignments rows: arrows, Home/End, Space and Enter, one row in the Tab order", async ({ page }) => {
  await fresh(page);
  await openAssignments(page);
  const view = page.getByTestId("assignments-view");
  const rows = view.locator("[data-row-nav]");
  await expect(rows).toHaveCount(3); // 52, 51 and the quiz practical
  await expect(view.locator('[data-row-nav][tabindex="0"]')).toHaveCount(1);
  // From the filter, ↓ enters the list.
  await view.getByLabel("Filter assignments").focus();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, 52)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row(page, 51)).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByTestId("quiz-practical-row")).toBeFocused();
  await page.keyboard.press("Home");
  await expect(row(page, 52)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, 52)).toBeFocused();
  await expect(view.locator('[data-row-nav][tabindex="0"]')).toHaveCount(1);
  // Space shows the brief; Enter starts the work too.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press(" ");
  await expect(page.locator(".tm-tab", { hasText: "Build a to-do list" })).toBeVisible();
  await row(page, 51).focus();
  await page.keyboard.press("Enter");
  await expect(row(page, 51)).toContainText("Open here", { timeout: 15_000 });
});

test("#17 Projects rows: arrows, Home/End and Enter", async ({ page }) => {
  await fresh(page);
  await openAssignments(page);
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(row(page, 51)).toContainText("Open here", { timeout: 15_000 });
  await row(page, 52).getByRole("button", { name: "Start" }).click();
  await page.locator(".tm-quick-pick .tm-qi-item", { hasText: "Start with an empty project" }).click();
  await expect(row(page, 52)).toContainText("Open here", { timeout: 15_000 });
  await command(page, "View: Show Task Mentor Projects");
  const rows = page.getByTestId("project-row");
  await expect(rows).toHaveCount(2, { timeout: 10_000 });
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(rows.nth(1)).toBeFocused();
  // Enter opens the focused row's project: go to the one not open here.
  const lastIsOpen = await rows.nth(1).evaluate((el) => el.classList.contains("is-current"));
  await page.keyboard.press(lastIsOpen ? "Home" : "End");
  const name = (await page.locator(".tm-project-row:focus .tm-project-name").textContent())!.trim();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-project-row.is-current .tm-project-name")).toHaveText(name, { timeout: 15_000 });
});

test("S4 the session ends: a sticky banner offers Sign In; signing out on purpose shows none", async ({ page }) => {
  await fresh(page);
  await openAssignments(page);
  await mock(page, (m) => m.expireSession());
  const banner = page.getByTestId("session-ended-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toHaveText(/Your NGA session ended\. Sign in to keep saving\./);
  await banner.getByRole("button", { name: "Sign In" }).click();
  await expect(banner).toHaveCount(0, { timeout: 10_000 });
  await expect(row(page, 51)).toBeVisible({ timeout: 10_000 });

  // Sign Out chosen here: just the sign-in screen.
  await page.locator(".tm-sidebar-title").getByRole("button", { name: "Views and More Actions..." }).click();
  await page.locator(".tm-menu-item", { hasText: "Show All My Projects" }).click();
  await page.locator(".tm-sidebar-title").getByRole("button", { name: "Views and More Actions..." }).click();
  await page.locator(".tm-menu-item", { hasText: "Sign Out of NGA" }).click();
  await page.locator(".tm-dialog").getByRole("button", { name: "Sign Out" }).click();
  await command(page, "View: Show Assignments");
  await expect(page.getByTestId("assignments-signin")).toBeVisible();
  await expect(banner).toHaveCount(0);
});
