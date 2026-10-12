import { expect, test } from "@playwright/test";
import { clicksTo, finish, gradeMoreAction, launch, mock, saveGradeAs, shot, toast } from "./journeys";

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

  // Home says what waits; Start Grading opens the oldest submission straight away (0.16, W8: one click).
  await expect(page.getByTestId("home-to-grade-summary")).toContainText(/submissions? to grade/, { timeout: 15_000 });
  await page.getByTestId("home-start-grading").click();
  const panel = page.getByTestId("grade-panel");
  await expect(panel).toContainText("Chloe Coder", { timeout: 15_000 });
  await expect(page.getByTestId("load-project")).toHaveText(/open in the editor/, { timeout: 15_000 });
  expect(await clicksTo(page, "first-student-open")).toBe(1);
  // Review focus: the side bar folds away; one primary button.
  await expect(page.locator(".tm-sidebar")).toBeHidden();
  await expect(page.locator(".tm-grade-footer .tm-button:not(.tm-button--secondary):not(.tm-split-button-menu)")).toHaveCount(1);
  await shot(page, info, J, "first-student");

  // A draft grade, from the split button's menu.
  await page.getByTestId("grade-full-marks").click();
  await saveGradeAs(page, "draft");
  await expect(page.getByTestId("grade-status")).toContainText("Draft saved: 20/20", { timeout: 10_000 });
  await expect(page.getByTestId("grade-draft-chip")).toBeVisible();
  await shot(page, info, J, "draft");

  // Release the drafts.
  await page.getByTestId("grade-release-drafts").click();
  await page.locator("[data-dialog-button=release]").click();
  await expect(toast(page, /Released 1 grade/)).toBeVisible({ timeout: 10_000 });
  const chloe = (await mock(page, `m.gradeOf("assignment", 51, null, 22)`)) as { released: boolean } | null;
  expect(chloe?.released).toBe(true);
  await shot(page, info, J, "released");

  // Return Ben's work for changes (More Actions › Return for Changes…).
  await page.getByTestId("grade-switcher-toggle").click();
  await page.getByTestId("grade-row").filter({ hasText: "Ben" }).click();
  await expect(panel).toContainText("Ben Learner");
  await gradeMoreAction(page, "Return for Changes…");
  await page.getByTestId("grade-return-message").fill("Add a delete button to each item.");
  await page.getByTestId("grade-return-form").getByRole("button", { name: /Return/ }).click();
  await expect(toast(page, /Returned to Ben/)).toBeVisible({ timeout: 10_000 });
  const returned = (await mock(page, "m.returnedProjects()")) as { owner: string; message: string }[];
  expect(returned.some((r) => /Ben/.test(r.owner) && /delete button/.test(r.message))).toBe(true);
  await shot(page, info, J, "returned");

  const r = await finish(page, info, J);
  expect(r.marks.map((m) => m.name)).toContain("first-student-open");
});
