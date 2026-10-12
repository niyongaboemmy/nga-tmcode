# Baseline (TMCode 0.14.0), before the workflow plan

Plan: [2026-10-12 workflow UX implementation plan](../../plans/2026-10-12-workflow-ux-implementation-plan.md), Phase 0.

## 1. Automated baseline (golden journeys, 0.1 + 0.3)

Measured by `e2e/journey-student.spec.ts` and `e2e/journey-teacher.spec.ts` with the dev-only counter
(`__TMCODE_DEBUG__.journey`), 12 October 2026, on the memory account's mock Task Mentor.
The tests know where to click, so these are **the minimum clicks**, not what a first-time user needs:
discovery (finding the mortar-board or Grading icon) isn't counted.

| Journey | Milestone | Clicks | Notes |
|---|---|---|---|
| Student | launch → `first-start` | 2 | Assignments icon, then Start on the row. The Explorer opens first; nothing on screen points to Assignments. |
| Student | launch → `submitted` | 5 | Save to Task Mentor, Submit, confirm. |
| Student | returned | — | **No notice.** The header says Returned while the card says "Submitted · Withdraw to Edit" (W4, asserted). |
| Student | graded | — | Header Graded, card still "Submitted", grade below it (W4, L8, asserted). |
| Teacher | launch → `first-student-open` | 3 | Grading icon (appears after a background check), practical, Start Grading. |
| Teacher | whole journey (draft, release, return) | 11 | Includes opening the student switcher in a narrow grading tab. |

Screens with two different statuses in the student journey: **2** (returned, graded).
Screenshots: `apps/desktop/test-results/journeys/` (not committed).

## 2. Usability session (0.4): to run with the school

**Status: not run yet.** It needs 3 students and 1 teacher for an hour. Use this table, and the same
tasks again in Phase 4.

| Task | Who | Success (y/n) | Time | Clicks | Quote |
|---|---|---|---|---|---|
| Open TMCode and start your next assignment | Student 1–3 | | | | |
| Save your work and hand it in | Student 1–3 | | | | |
| Your teacher returned your work: find out what to change | Student 1–3 | | | | |
| Find your grade and the feedback | Student 1–3 | | | | |
| Open TMCode and grade the first waiting submission | Teacher | | | | |
| Save a draft grade, then release it | Teacher | | | | |
| Send one submission back for changes | Teacher | | | | |
| "I knew what to do next" (1–5), after each task | All | | | | |

Run the dev build with `window.__TMCODE_JOURNEY__ = true` set before load to get the click counts,
or count by hand from the screen recording.
