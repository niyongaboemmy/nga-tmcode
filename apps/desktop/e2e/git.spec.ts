import { expect, test, type Page } from "@playwright/test";

/**
 * Source Control against the in-memory git (platform/memoryGit.ts): the demo
 * project starts on `main`, one commit ahead of origin/main, with README.md
 * staged, main.py modified, src/utils.ts untracked and notes/todo.txt deleted.
 */

const TM = `http://localhost:${process.env.MOCK_TM_PORT ?? 5099}`;

async function boot(page: Page, query = "") {
  await page.goto(`/${query}`);
  await expect(page.locator(".tm-titlebar")).toBeVisible();
}

async function openScm(page: Page) {
  await page.getByRole("tab", { name: /^Source Control/ }).click();
  await expect(page.locator(".tm-scm-input")).toBeVisible();
}

const section = (page: Page, id: "staged" | "changes" | "merge") => page.locator(`.tm-scm-section[data-section="${id}"]`);
const scmRow = (page: Page, id: "staged" | "changes", path: string) => section(page, id).locator(`.tm-scm-row[data-path="${path}"]`);
const explorerRow = (page: Page, path: string) => page.locator(`.tm-explorer [data-path="${path}"]`);

async function palette(page: Page, command: string) {
  await page.keyboard.press("F1");
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test("Source Control lists staged changes and changes with VS Code's letters", async ({ page }) => {
  await boot(page);
  // Activity bar badge: README.md, main.py, notes/todo.txt, src/utils.ts.
  await expect(page.getByRole("tab", { name: /^Source Control/ }).locator(".tm-activity-badge")).toHaveText("4");
  await openScm(page);
  await expect(page.locator(".tm-sidebar-title h2")).toHaveText("Source Control");
  await expect(scmRow(page, "staged", "README.md").locator(".tm-scm-letter")).toHaveText("M");
  await expect(scmRow(page, "changes", "main.py").locator(".tm-scm-letter")).toHaveText("M");
  await expect(scmRow(page, "changes", "src/utils.ts").locator(".tm-scm-letter")).toHaveText("U");
  await expect(scmRow(page, "changes", "notes/todo.txt").locator(".tm-scm-letter")).toHaveText("D");
  await expect(scmRow(page, "changes", "notes/todo.txt")).toHaveClass(/is-deleted/);
  await expect(section(page, "changes").locator(".tm-scm-count")).toHaveText("3");
  // Status bar: branch with dirty/staged markers, and 0 to pull / 1 to push.
  await expect(page.getByTestId("git-branch")).toHaveText("main*+");
  await expect(page.getByTestId("git-ahead-behind")).toHaveText("0↓ 1↑");
  await expect(page.locator(".tm-scm-commit-row").first()).toContainText("Add letter grades");
});

test("explorer colours and letter badges", async ({ page }) => {
  await boot(page);
  await expect(explorerRow(page, "main.py")).toHaveClass(/git-modified/);
  await expect(explorerRow(page, "main.py").locator(".tm-git-letter")).toHaveText("M");
  await expect(explorerRow(page, "README.md").locator(".tm-git-letter")).toHaveText("M");
  // A folder above a change takes its colour, without a letter.
  await expect(explorerRow(page, "src")).toHaveClass(/git-untracked/);
  await expect(explorerRow(page, "src").locator(".tm-git-letter")).toHaveCount(0);
  await explorerRow(page, "src").click();
  await expect(explorerRow(page, "src/utils.ts").locator(".tm-git-letter")).toHaveText("U");
  // The gutter marks the lines added since the index version.
  await explorerRow(page, "main.py").dblclick();
  await expect(page.locator(".monaco-editor .tm-dirty-diff-added").first()).toBeVisible();
});

test("diff editor: index vs working tree, and HEAD vs index for staged files", async ({ page }) => {
  await boot(page);
  await openScm(page);
  await scmRow(page, "changes", "main.py").locator(".tm-scm-name").click();
  const tab = page.locator(".tm-tab", { hasText: "main.py (Working Tree)" });
  await expect(tab).toBeVisible();
  await expect(tab).toHaveClass(/is-preview/);
  const diff = page.getByTestId("git-diff");
  await expect(diff.locator(".monaco-diff-editor")).toBeVisible();
  await expect(diff.locator(".editor.modified .view-lines")).toContainText('return "C"');
  await expect(diff.locator(".editor.original .view-lines")).not.toContainText('return "C"');
  // Staged: HEAD on the left, the index on the right (read-only); replaces the preview tab.
  await scmRow(page, "staged", "README.md").locator(".tm-scm-name").click();
  await expect(page.locator(".tm-tab", { hasText: "README.md (Index)" })).toBeVisible();
  await expect(page.locator(".tm-tab")).toHaveCount(1);
  await expect(diff.locator(".editor.modified .view-lines")).toContainText("Read `count`");
});

test("stage, unstage, commit with Ctrl+Enter", async ({ page }) => {
  await boot(page);
  await openScm(page);
  await scmRow(page, "changes", "main.py").hover();
  await scmRow(page, "changes", "main.py").getByRole("button", { name: "Stage Changes" }).click();
  await expect(scmRow(page, "staged", "main.py")).toBeVisible();
  await expect(scmRow(page, "changes", "main.py")).toHaveCount(0);
  await scmRow(page, "staged", "README.md").hover();
  await scmRow(page, "staged", "README.md").getByRole("button", { name: "Unstage Changes" }).click();
  await expect(scmRow(page, "changes", "README.md")).toBeVisible();
  await page.locator(".tm-scm-input").fill("Add the C grade");
  await page.locator(".tm-scm-input").press("ControlOrMeta+Enter");
  await expect(section(page, "staged")).toHaveCount(0);
  await expect(page.locator(".tm-scm-input")).toHaveValue("");
  await expect(page.locator(".tm-scm-commit-row").first()).toContainText("Add the C grade");
  await expect(page.getByTestId("git-ahead-behind")).toHaveText("0↓ 2↑");
  await expect(scmRow(page, "changes", "README.md")).toBeVisible();
});

test("commit without staged changes offers to stage everything", async ({ page }) => {
  await boot(page);
  await openScm(page);
  await page.locator(".tm-scm-input").fill("Everything");
  await section(page, "staged").locator(".tm-scm-section-header").hover();
  await section(page, "staged").getByRole("button", { name: "Unstage All Changes", exact: true }).click();
  await expect(section(page, "staged")).toHaveCount(0);
  await page.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("There are no staged changes to commit.");
  await page.getByRole("button", { name: "Yes" }).click();
  await expect(section(page, "changes").locator(".tm-scm-row")).toHaveCount(0);
  await expect(page.getByTestId("git-branch")).toHaveText("main");
  // Nothing left: the primary button becomes Sync Changes.
  await expect(page.getByRole("button", { name: /Sync Changes/ })).toBeVisible();
});

test("discard an untracked file asks before deleting it", async ({ page }) => {
  await boot(page);
  await openScm(page);
  const r = scmRow(page, "changes", "src/utils.ts");
  await r.hover();
  await r.getByRole("button", { name: "Delete File" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("Are you sure you want to DELETE 'utils.ts'?");
  await page.getByRole("button", { name: "Delete File" }).last().click();
  await expect(r).toHaveCount(0);
  // Discarding a deleted tracked file brings it back.
  const gone = scmRow(page, "changes", "notes/todo.txt");
  await gone.hover();
  await gone.getByRole("button", { name: "Discard Changes" }).click();
  await page.getByRole("button", { name: "Discard File" }).click();
  await expect(gone).toHaveCount(0);
  await page.getByRole("tab", { name: /^Explorer/ }).click();
  await expect(explorerRow(page, "notes")).toBeVisible();
});

test("branch picker: create a branch, publish it, switch back", async ({ page }) => {
  await boot(page);
  await page.getByTestId("git-branch").click();
  const picker = page.locator(".tm-quick-pick");
  await expect(picker.getByRole("option", { name: /^feature\/login/ })).toBeVisible();
  await picker.getByRole("option", { name: /Create new branch\.\.\.$/ }).click();
  await page.keyboard.type("bad name~");
  await expect(page.locator(".tm-qp-prompt.is-error")).toBeVisible();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("feature/grades");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("git-branch")).toHaveText("feature/grades*+");
  // No upstream: the sync item publishes.
  await expect(page.locator(".tm-status-git .codicon-cloud-upload")).toBeVisible();
  await page.locator(".tm-status-git", { has: page.locator(".codicon-cloud-upload") }).click();
  await expect(page.locator(".tm-toast", { hasText: "Published branch 'feature/grades' to origin." })).toBeVisible();
  await expect(page.locator(".tm-status-git .codicon-sync")).toBeVisible();
  // Switch back to main through the picker (typing filters).
  await page.getByTestId("git-branch").click();
  await page.keyboard.type("main");
  // "Create new branch..." always stays on top, as in VS Code.
  await expect(picker.getByRole("option").first()).toContainText("Create new branch...");
  await picker.getByRole("option", { name: /^main/ }).click();
  await expect(page.getByTestId("git-branch")).toHaveText("main*+");
});

test("sync pushes with a progress notification", async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId("git-ahead-behind")).toHaveText("0↓ 1↑");
  await page.locator(".tm-status-git", { has: page.locator(".codicon-sync") }).click();
  await expect(page.locator(".tm-toast [role=progressbar]")).toBeVisible();
  await expect(page.getByTestId("git-ahead-behind")).toHaveCount(0);
  await expect(page.locator(".tm-toast [role=progressbar]")).toHaveCount(0);
  // Every git command goes to the Git output channel.
  await palette(page, "Git: Show Git Output");
  await expect(page.locator(".tm-panel")).toContainText("[Git] > git sync --progress");
});

test("clone a repository from a URL", async ({ page }) => {
  await boot(page);
  await palette(page, "Git: Clone");
  await page.keyboard.type("https://github.com/octocat/Hello-World.git");
  const option = page.locator(".tm-quick-pick").getByRole("option", { name: /Clone from URL https:\/\/github.com\/octocat\/Hello-World.git/ });
  await expect(option).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast", { hasText: "Cloning git repository" })).toBeVisible();
  await expect(page.locator(".tm-toast", { hasText: "Cloned into memory://clones/Hello-World." })).toBeVisible();
});

test("GitHub: sign in with a personal access token, then clone from GitHub", async ({ page }) => {
  await boot(page);
  await palette(page, "GitHub: Sign in with a Personal Access Token");
  const input = page.locator(".tm-quick-pick input");
  await expect(input).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Create a token on GitHub…" })).toBeVisible();
  await page.keyboard.type("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast", { hasText: "Signed in to GitHub as octocat." })).toBeVisible();
  await palette(page, "Git: Clone");
  await page.locator(".tm-quick-pick").getByRole("option", { name: "Clone from GitHub" }).click();
  await expect(page.locator(".tm-quick-pick").getByRole("option", { name: /octocat\/Spoon-Knife/ })).toBeVisible();
  await page.keyboard.type("spoon");
  await page.keyboard.press("Enter");
  await expect(page.locator(".tm-toast", { hasText: "Cloned into memory://clones/Spoon-Knife." })).toBeVisible();
});

test("a folder without a repository offers Initialize Repository", async ({ page }) => {
  await boot(page, "?git=none");
  await page.getByRole("tab", { name: /^Source Control/ }).click();
  await expect(page.getByRole("button", { name: "Initialize Repository" })).toBeVisible();
  await page.getByRole("button", { name: "Initialize Repository" }).click();
  await expect(page.locator(".tm-scm-input")).toBeVisible();
  await expect(section(page, "changes").locator(".tm-scm-row").first()).toBeVisible();
  await expect(page.getByTestId("git-branch")).toHaveText("main*");
});

test("Source Control fits a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 700 });
  await boot(page);
  await page.keyboard.press("Control+Shift+g");
  await expect(page.locator(".tm-scm-input")).toBeVisible();
  const overflow = await page.locator(".tm-sidebar").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("git is off in exam mode", async ({ page }) => {
  await page.request.post(`${TM}/__test/reset`);
  const { deeplink } = await (await page.request.post(`${TM}/__test/launch`)).json();
  await page.goto(`/?launch=${encodeURIComponent(deeplink)}`);
  await expect(page.locator(".tm-taskview-quiz")).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("tab", { name: /^Source Control/ })).toHaveCount(0);
  await expect(page.getByTestId("git-branch")).toHaveCount(0);
  await expect(page.locator(".tm-tree-row .tm-git-letter")).toHaveCount(0);
  await page.keyboard.press("Control+Shift+g");
  await expect(page.locator(".tm-sidebar-title h2")).not.toHaveText("Source Control");
  await page.keyboard.press("F1");
  await page.keyboard.type("Git: ");
  await expect(page.locator(".tm-qi-item", { hasText: "Git: Clone" })).toHaveCount(0);
  await page.keyboard.press("Escape");
});
