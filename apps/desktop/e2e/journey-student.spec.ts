import { expect, test } from "@playwright/test";
import { command, finish, launch, mock, shot, toast, visibleDoors } from "./journeys";

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
  // The overdue case study is out of the way (completed), so practical 51 is next up.
  await mock(page, `m.setAssignmentStatus(52, "completed")`);
  await command(page, "Assignments: Refresh Assignments");
  // 0.15: Home in front, with the next assignment and its one button.
  await expect(page.getByTestId("home-next-title")).toHaveText("Build a to-do list", { timeout: 10_000 });
  await shot(page, info, J, "launch");

  // Start the next assignment from Home: one click.
  await page.getByTestId("home-next-action").click();
  await expect(page.getByTestId("assignment-page")).toBeVisible({ timeout: 15_000 });
  await expect(row(page, 51)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("assignment-submit")).toBeVisible({ timeout: 15_000 });
  await shot(page, info, J, "started");
  // 0.16 (W3, L1) + guided plan C: one Submit on the brief; saving is automatic (no Save button).
  expect(await visibleDoors(page)).toEqual({ submit: 1, save: 0 });
  await expect(page.getByTestId("this-folder-line")).toBeVisible();

  // Saved to Task Mentor by itself: the brief's line says so.
  await expect(page.getByTestId("assignment-sync")).toHaveAttribute("data-state", "synced", { timeout: 15_000 });
  // Calm (guided plan A): never more than two messages on screen.
  expect(await page.locator(".tm-toast:visible").count()).toBeLessThanOrEqual(2);

  // Submit (confirm dialog).
  await page.getByTestId("assignment-submit").click();
  await page.locator("[data-dialog-button=submit]").click();
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
  await shot(page, info, J, "submitted");

  // Returned for changes by the teacher.
  await mock(page, `m.returnForChanges(51, "Add a delete button to each item.")`);
  await page.getByTestId("assignments-refresh").click();
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "returned", { timeout: 15_000 });
  await expect(page.getByTestId("assignment-returned")).toContainText("Add a delete button");
  // N2: a notice that stays until read.
  // Calm (guided plan A): the brief in front shows Returned, so no toast repeats it; the bell keeps it.
  await expect(toast(page, /Your teacher returned "Build a to-do list"/)).toHaveCount(0);
  // W4: one status on the whole screen, and the way back in is Submit Again.
  await expect(page.getByTestId("assignment-next-step")).toHaveAttribute("data-status", "returned", { timeout: 15_000 });
  await expect(row(page, 51)).toHaveAttribute("data-status", "returned");
  await expect(page.getByTestId("project-student-status")).toHaveAttribute("data-status", "returned");
  await expect(page.getByTestId("this-folder-line")).toHaveAttribute("data-status", "returned");
  await expect(page.getByTestId("assignment-submit")).toHaveText(/Submit Again/);
  await shot(page, info, J, "returned");
  expect(await visibleDoors(page)).toEqual({ submit: 1, save: 0 });

  // Submit again, then graded.
  await page.getByTestId("assignment-submit").click();
  await page.locator("[data-dialog-button=submit]").click();
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "submitted", { timeout: 15_000 });
  await mock(page, `m.grade(51, 17, "Good work: the list adds and deletes.")`);
  await page.getByTestId("assignments-refresh").click();
  await expect(page.getByTestId("assignment-state")).toHaveAttribute("data-status", "graded", { timeout: 15_000 });
  // The brief in front shows the grade (guided plan A): no toast repeats it.
  await expect(toast(page, /Build a to-do list was graded: 17\/20/)).toHaveCount(0);
  // L8: the result is the next-step card, at the top; one status everywhere.
  await expect(page.getByTestId("assignment-next-step")).toHaveAttribute("data-status", "graded", { timeout: 15_000 });
  await expect(page.getByTestId("assignment-next-step").getByTestId("assignment-result")).toContainText("17");
  await expect(row(page, 51)).toHaveAttribute("data-status", "graded");
  await shot(page, info, J, "graded");
  expect(await visibleDoors(page)).toEqual({ submit: 0, save: 0 });

  const r = await finish(page, info, J);
  expect(r.marks.map((m) => m.name)).toEqual(expect.arrayContaining(["home-shown", "first-start", "submitted"]));
  // §10: launch → working on the next assignment in 1 click.
  expect(r.marks.find((m) => m.name === "first-start")?.clicks).toBe(1);
});
