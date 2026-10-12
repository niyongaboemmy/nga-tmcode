import { expect, test } from "@playwright/test";
import { finish, launch, mock, shot, toast } from "./journeys";

/**
 * Golden journey, teacher (workflow plan 0.1): launch → grade → draft →
 * release → return, against the mock Task Mentor: assignment 51 has Ben's
 * and Chloe's submissions waiting.
 */

const J = "teacher";

test("teacher journey: launch → grade → draft → release → return", async ({ page }, info) => {
  test.setTimeout(120_000);
  await launch(page, { teacher: true });
  await shot(page, info, J, "launch");

  // 0.15: Home says what waits, with Start Grading.
  await expect(page.getByTestId("home-to-grade-summary")).toContainText(/submissions? to grade/, { timeout: 15_000 });
  await page.getByTestId("home-start-grading").click();
  await page.locator('[data-testid="grading-activity"][data-key="assignment:51:"]').click();
  await page.getByTestId("grade-start").click();
  const panel = page.getByTestId("grade-panel");
  await expect(panel).toContainText("Ben Learner");
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
  await shot(page, info, J, "first-student");

  // A draft grade.
  await page.getByTestId("grade-full-marks").click();
  await page.getByTestId("grade-save-draft").click();
  await expect(page.getByTestId("grade-status")).toContainText("Draft saved: 20/20", { timeout: 10_000 });
  await expect(page.getByTestId("grade-draft-chip")).toBeVisible();
  await shot(page, info, J, "draft");

  // Release the drafts.
  await page.getByTestId("grade-release-drafts").click();
  await page.locator("[data-dialog-button=release]").click();
  await expect(toast(page, /Released 1 grade/)).toBeVisible({ timeout: 10_000 });
  const ben = (await mock(page, `m.gradeOf("assignment", 51, null, 21)`)) as { released: boolean } | null;
  expect(ben?.released).toBe(true);
  await shot(page, info, J, "released");

  // Return Chloe's work for changes.
  // A narrow grading tab keeps the roster behind the student switcher.
  if (await page.getByTestId("grade-switcher-toggle").isVisible()) await page.getByTestId("grade-switcher-toggle").click();
  await page.getByTestId("grade-row").filter({ hasText: "Chloe" }).click();
  await expect(panel).toContainText("Chloe");
  await page.getByTestId("grade-return").click();
  await page.getByTestId("grade-return-message").fill("Add a delete button to each item.");
  await page.getByTestId("grade-return-form").getByRole("button", { name: /Return/ }).click();
  await expect(toast(page, /Returned to Chloe/)).toBeVisible({ timeout: 10_000 });
  const returned = (await mock(page, "m.returnedProjects()")) as { owner: string; message: string }[];
  expect(returned.some((r) => /Chloe/.test(r.owner) && /delete button/.test(r.message))).toBe(true);
  await shot(page, info, J, "returned");

  const r = await finish(page, info, J);
  expect(r.marks.map((m) => m.name)).toContain("first-student-open");
});
