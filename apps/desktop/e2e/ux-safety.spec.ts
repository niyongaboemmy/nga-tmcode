import { expect, test, type Page } from "@playwright/test";

/** 0.10.5: the findings of docs/reviews/2026-10-09-ux-review that could lose access or confuse. */

async function fresh(page: Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("tmcode:mock-account", "signed-in");
  });
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
}

const items = (page: Page) => page.locator(".tm-qi-item");

test("a fresh command palette opens on common commands, then on what you ran (kept across restarts)", async ({ page }) => {
  await fresh(page);
  await page.keyboard.press("F1");
  await expect(items(page).first()).toContainText("commonly used");
  await expect(items(page).first()).toContainText("Go to File");
  await expect(items(page).filter({ hasText: "Sign Out" }).first()).not.toHaveClass(/is-focused/);
  await page.keyboard.press("Escape");

  await page.keyboard.press("F1");
  await page.keyboard.type("View: Show Search");
  await page.keyboard.press("Enter");
  await page.reload();
  await expect(page.locator(".tm-statusbar")).toBeVisible();
  await page.keyboard.press("F1");
  await expect(items(page).first()).toContainText("recently used");
  await expect(items(page).first()).toContainText("View: Show Search");
});

test("Sign Out asks with Cancel focused: Enter keeps you signed in, and focus stays in the dialog", async ({ page }) => {
  await fresh(page);
  await page.keyboard.press("F1");
  await page.keyboard.type("Accounts: Sign Out of NGA");
  await page.keyboard.press("Enter");
  const dialog = page.locator(".tm-dialog");
  await expect(dialog).toContainText("Sign out of NGA?");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  // Tab cycles inside the dialog.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Sign Out" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("tmcode:mock-account"))).toBe("signed-in");
});

test("non-destructive dialogs still focus their primary button", async ({ page }) => {
  await fresh(page);
  await page.keyboard.press("F1");
  await page.keyboard.type("View: Show Assignments");
  await page.keyboard.press("Enter");
  await page.locator('[data-testid="assignment-row"][data-assignment-id="51"]').getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("assignment-submit").click();
  await expect(page.locator(".tm-dialog").getByRole("button", { name: "Save and Submit" })).toBeFocused();
  await page.keyboard.press("Escape");
});

test("clicking a quiz practical row opens its workspace", async ({ page }) => {
  await fresh(page);
  await page.keyboard.press("F1");
  await page.keyboard.type("View: Show Assignments");
  await page.keyboard.press("Enter");
  await page.getByTestId("quiz-practical-row").locator(".tm-project-name").click();
  await expect(page.locator(".tm-toast", { hasText: 'Your workspace for "Build a navbar" is ready' })).toBeVisible({ timeout: 15_000 });
});
