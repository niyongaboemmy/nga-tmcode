import { expect, test } from "@playwright/test";
import { finish, launch, mock, shot } from "./journeys";

/**
 * Golden journey, student (workflow plan 0.1): launch → start → save →
 * submit → returned → graded, against the memory account's mock Task Mentor
 * (practical 51 "Build a to-do list", 20 points, starter files).
 */

const J = "student";
const row = (page: import("@playwright/test").Page, id: number) => page.locator(`[data-testid="assignment-row"][data-assignment-id="${id}"]`);

test("student journey: launch → start → save → submit → returned → graded", async ({ page }, info) => {
  test.setTimeout(120_000);
  await launch(page);
  await shot(page, info, J, "launch");

  // Find and start the next assignment.
  await page.locator('.tm-activity[aria-label^="Assignments"]').click();
  await expect(row(page, 51)).toBeVisible({ timeout: 10_000 });
  await row(page, 51).getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-save")).toBeVisible({ timeout: 15_000 });
  await shot(page, info, J, "started");

  // Save to Task Mentor.
  await page.getByTestId("assignment-save").click();
  await expect(page.getByTestId("assignment-sync")).toHaveAttribute("data-state", "synced", { timeout: 15_000 });

  // Submit (confirm dialog).
  await page.getByTestId("assignment-submit").click();
  await page.locator("[data-dialog-button=submit]").click();
  await expect(page.locator(".tm-toast", { hasText: /Submitted "Build a to-do list"/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
  await shot(page, info, J, "submitted");

  // Returned for changes by the teacher.
  await mock(page, `m.returnForChanges(51, "Add a delete button to each item.")`);
  await page.getByTestId("assignments-refresh").click();
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "returned", { timeout: 15_000 });
  await expect(page.getByTestId("assignment-returned")).toContainText("Add a delete button");
  await shot(page, info, J, "returned");

  // BASELINE (0.14, W4): the card below still follows the stale project status.
  await expect(page.getByTestId("assignment-next-step")).toContainText("Withdraw to Edit");

  // Graded.
  await mock(page, `m.grade(51, 17, "Good work: the list adds and deletes.")`);
  await page.getByTestId("assignments-refresh").click();
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "graded", { timeout: 15_000 });
  await expect(page.getByTestId("assignment-result")).toContainText("17");
  // BASELINE (W4, L8): "Graded" above a "Submitted" card, the grade below it.
  await expect(page.getByTestId("assignment-next-step")).toContainText("Submitted");
  await shot(page, info, J, "graded");

  const r = await finish(page, info, J);
  expect(r.marks.map((m) => m.name)).toEqual(expect.arrayContaining(["first-start", "submitted"]));
});
