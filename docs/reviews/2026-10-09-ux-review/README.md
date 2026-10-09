# TMCode UX review: VS Code as the reference

**Version reviewed:** 0.10.4 · **Date:** 9 October 2026 · **Reviewer role:** senior desktop UI/UX
**Method:** an automated crawl of 30 screens (student, teacher, exam and signed-out; dark and light themes) on the mock Task Mentor, plus a code inventory of every view, command, dialog and Task Mentor touchpoint. Screens in [img/](img/).

---

## Overall grade: **78 %** (good; ready for students, with clear room to simplify)

| Area | Weight | Score | One-line verdict |
|---|---:|---:|---|
| Student assignment workflow | 20 % | **80** | Start → code → Submit is short and well guided; let down by duplicated paths and wording |
| Task Mentor management (sync, submit, projects) | 15 % | **68** | Powerful but spread over two views and four "Save" meanings; conflicts have no diff |
| Core editor (edit, search, git, run, debug, tests) | 15 % | **85** | Feels like VS Code; a few static status bar items |
| Visual design and VS Code fidelity | 10 % | **88** | Theme-true colours, VS Code list selection, clean cards |
| Teacher grading | 10 % | **82** | Fast rubric scoring and Save & Next; dense header |
| Exam mode | 10 % | **90** | Focused, calm, clear timer and save state; best screen in the app |
| First run and onboarding | 8 % | **60** | The Welcome page never mentions sign-in or assignments |
| Consistency and terminology | 6 % | **62** | project / workspace / folder, three labels for Withdraw |
| Accessibility and keyboard | 6 % | **70** | Good ARIA basics; no arrow keys in the Task Mentor lists; destructive buttons autofocused |
| **Weighted total** | 100 % | **78** | |

### Simplicity for the end user

| User | Rating | Why |
|---|---:|---|
| Student (practice and assignments) | **7.5 / 10** | Six actions from a new assignment to a submission, and the brief always says what to do next. Confusing parts: Projects *and* Assignments, and which "Save" means what. |
| Student (exam) | **9 / 10** | Only the task, the code, a timer and Submit. Nothing to learn. |
| Teacher (grading) | **7 / 10** | Quick once inside; getting there takes several hops (Grading view → activity → Start Grading → student), and the header shows 3 progress summaries. |

---

## What already works well (keep it)

1. **The VS Code look and shortcuts.** Activity bar, side bar, tabs, command palette, settings editor, Ctrl/⌘+P, F5 and F9 all match. A student who later moves to VS Code loses nothing.
2. **The brief as a "next step" card** ([16](img/16-brief-not-started.png), [18](img/18-working-on-it.png), [21](img/21-after-submit.png)). Every state has exactly one primary action: Start Assignment, then Submit, then Withdraw. This is the best pattern in the app.
3. **The status stepper** In progress → Submitted → Graded, with "Locked until graded" and a way back.
4. **Exam mode** ([28](img/28-exam.png)): the timer and Submit in the title bar, numbered tasks with points, "All work saved" in the status bar, and an orange mode badge. It hides everything an exam doesn't need.
5. **Grading** ([26](img/26-grading-student.png)): 0 / half / full quick-score chips, a total score, Save & Next, and the student's project opened read-only beside it.
6. **Colour semantics** (since 0.10.4): red for errors, orange for attention, blue for information, green for success.
7. **Signed-out empty states** ([03](img/03-signed-out-assignments.png)): they explain the value and offer one Sign in button.

---

## Findings, by priority

**P0** = could lose work or access, or blocks understanding · **P1** = friction most users will hit · **P2** = polish

### P0

| # | Finding | Evidence | Recommendation |
|---|---|---|---|
| 1 | **Two Enters sign you out everywhere.** The command palette opens with **Accounts: Sign Out of NGA** pre-selected (alphabetical, no recently used commands on a fresh start). The confirm dialog autofocuses **Sign Out**. So ⌘⇧P, Enter, Enter signs the student out of MIS and Task Mentor on every device. | [06](img/06-command-palette.png); `projects/service.ts:152`, `widgets/Overlays.tsx:98` | Like VS Code, show "recently used" and then the most common commands first. Autofocus **Cancel** in every destructive dialog (Sign Out, Disconnect, Remove). |
| 2 | **Two submit flows that contradict each other.** From Projects, "Submit Project" says the project is then *locked*. From the brief and Assignments, "Submit" says *you can submit again*. Students see different rules for the same action. | `projects/matching.ts:235` vs `projects/assignments.ts:278` | One `submit()` with one dialog and one message. Keep the "Match with an assessment first" step as a pre-step only. |
| 3 | **Sync conflicts have no diff.** The only choices are "Keep Mine" or "Take Task Mentor's", file by file, without seeing either version. One wrong click overwrites a student's work. | `ProjectsView.tsx` conflicts list; `docs/PROJECTS_PLAN.md:111` promises a 2-way diff | Open the conflict in the diff editor (TMCode already has one for git), with Keep Mine / Take Theirs in its title bar. |

### P1: Task Mentor management

| # | Finding | Recommendation |
|---|---|---|
| 4 | **Two views for one mental model.** Students must learn *Task Mentor Projects* (folders, sync, submit) and *Assignments* (work, brief, submit). Both can submit, both show status, and both say "Open here". There are three Task Mentor icons in the activity bar, and the same `mortar-board` icon is used for Assignments and for the exam Task view. | Make **Assignments** the student's home. Move the "This Folder" card (sync line, Save, live status) to the top of Assignments, and keep Projects as a secondary "All my projects" list (or put it under the "…" menu). Teachers keep Grading. Result: 1 view to learn instead of 2. |
| 5 | **"Save" means four things:** save the file (⌘S), save to Task Mentor (the button, ⌘⌥U, the status bar), save a grade, and exam auto-save. There are also two "Auto Save" settings (`files.autoSave` on, `projects.autoSave` off). The status bar "Auto Save" means files only, which reads as if Task Mentor is auto-saved too. | Rename the cloud action **"Upload"** or **"Sync to Task Mentor"**, with a cloud icon everywhere. Or better: turn `projects.autoSave` on by default for assignments so students never think about it, and keep a single "Saved online · 2 min ago" indicator. |
| 6 | **The status bar disagrees with the view.** The view says "Saved online", "Sync problem", "Newer version online"; the status bar says "Task Mentor" for three different states. | Use the same short label in both places ("Saved online", "Sync problem", "Update available"). |
| 7 | **Withdraw has three names:** "Withdraw to make changes", "Withdraw Submission to Edit" and "Projects: Withdraw Submission". There's no confirmation, although it takes the work back from the teacher. | One label, **"Withdraw to Edit"**, plus a light confirmation ("Your teacher will no longer see version 1"). |
| 8 | **Version wording:** "revision N" (save toast), "version N" (submitted), "rN" (teacher table). | Use "version N" everywhere. |
| 9 | **Broken references in the text:** "reopen it from File › Open Recent" (that menu item doesn't exist), "Projects › Resolve Conflicts" (no such command), "restore it in Task Mentor" (TMCode has its own Restore). | Fix the copy, or add File › Open Recent (VS Code users expect it). |

### P1: Workflow and onboarding

| # | Finding | Recommendation |
|---|---|---|
| 10 | **The Welcome page ignores the main job.** A new student sees New File, Open Folder and Template, plus two info cards that can't be clicked. There's no "Sign in", no "Your assignments", and nothing changes after sign-in ([01](img/01-welcome-empty.png)). | Add a first card, **"Your assignments"**: Sign in with NGA when signed out, then "2 to do · next due Fri" with Open Assignments. Make the "Taking an exam" and "Practising" cards clickable. After the first sign-in, open the Assignments view automatically. |
| 11 | **Every row has a primary "Start" button** ([15](img/15-assignments-list.png)). Three solid blue buttons compete, and VS Code never puts a filled primary button in list rows. | Make the row action a secondary or ghost button, and show it on hover or selection only. Keep it solid for the single most urgent item (the next due), or move "Start" into the brief, which already has a large Start button. |
| 12 | **Clicking a quiz-practical row** didn't visibly open anything in the crawl: the previous brief stayed in front ([22](img/22-quiz-practical.png); reproduce by clicking "Build a navbar"). | Verify. Every row click should show its brief, as assignment rows do. |
| 13 | **A teacher's Assignments view** showed the student "To do" list with Start buttons ([27](img/27-teacher-assignments.png)). This may be the mock account being both teacher and student. | Verify with a real teacher account. If a teacher sees "Start", hide the student sections for teaching subjects. |
| 14 | **Getting to grading takes 4 hops:** the Grading view, then an activity, then **Start Grading** ([25](img/25-grading-overview.png)), then the student. The grading header repeats progress three times: the side bar totals, the header bar, and "0 graded · 2 to grade · 1 working · 0 %". | Clicking an activity with work to grade should open the first student straight away (the empty right pane is wasted). Keep one progress summary in the header. |
| 15 | **"Use Open Project as Starter…"** (a teacher action) is in the This Folder "…" menu for students too. | Show it to teachers only. |
| 16 | **The live-status setting contradicts the switch.** With `projects.presence` off, the per-project switch still says teachers can see the project. | Disable the switch and explain why when the global setting is off. |

### P1: Keyboard and accessibility

| # | Finding | Recommendation |
|---|---|---|
| 17 | **No ↑/↓ in the Projects, Assignments and Grading rows.** They're `role="button"` divs: Tab only, Enter only, Space ignored. Explorer, SCM and the grading student list do support arrows. | Use the same listbox/tree keyboard model as the Explorer: arrows, Home/End, Space, and type-to-find. |
| 18 | **Destructive dialogs autofocus the destructive button** (Sign Out, Disconnect, Remove). | Autofocus Cancel (see #1). Also add a focus trap and restore focus on close (neither exists in `Overlays.tsx`). |
| 19 | **⌘ glyphs are hard-coded** in tooltips ("⌘⌥U", "⌘Enter"). Windows students see the wrong keys. | Use the keybinding formatter the command palette already uses. |

### P2: Polish

| # | Finding |
|---|---|
| 20 | Run and Debug view: a stray "." under "Show all automatic debug configurations" ([09](img/09-run-debug.png)). |
| 21 | Exam: "1 hidden tests" (plural) (`exam/ExamViews.tsx:126`). The exam results label rows "Question {id}" instead of "Task 1, 2…". |
| 22 | Toasts stack: after Submit, the earlier "workspace is ready" toast is still showing ([21](img/21-after-submit.png)). Dismiss related info toasts when the state moves on. |
| 23 | Status bar: the Language item can't be clicked (in VS Code it changes the language mode), and the bell can't be clicked (there's no notification centre to see dismissed messages). |
| 24 | Live Preview status item says "React - react-app" while `main.py` is open: it describes the project, not the file in front. |
| 25 | Mixed ellipses ("…" and "..."); the Settings editor uses native `<select>`s (VS Code draws its own); there are two "New Project" commands (Projects: New Project… vs File: New Project from Template…). |
| 26 | The Grading view's sign-in empty state can never show (Grading appears only after sign-in), and `submitFromView` is dead code. |

---

## Workflow walkthroughs (as measured)

| Workflow | Steps today | Target | Notes |
|---|---:|---:|---|
| New student: sign in → see work | 3 (Assignments icon → Sign in → browser) | 2 | Add sign-in to the Welcome page and auto-open Assignments (#10) |
| Start an assignment | 2 (row → Start) | 2 | Starter files open beside the brief: good |
| Save to Task Mentor | 1 (Save) | 0 | Auto-save assignments (#5) |
| Submit | 2 (Submit → Save and Submit) | 2 | One flow and one message (#2) |
| Change after submitting | 1 (Withdraw) | 2 | Add a confirmation (#7) |
| Teacher: grade the next student | 4 to open, then 1 per student (Save & Next) | 2, then 1 | Open the first student directly (#14) |
| Exam | 0 (opens from Task Mentor) → Submit → confirm | same | Exemplary |

---

## Management between TMCode and Task Mentor

**What's right:** one NGA sign-in (browser, PKCE, keychain), deep links from Task Mentor straight into the right assignment or exam, "Open in Task Mentor" everywhere it's useful, live status for teachers, offline-safe exam saving, and grades visible in TMCode.

**Where it leaks complexity to the user:**
- **The data model shows through.** "Project", "assessment", "activity" and "binding" are Task Mentor's internal concepts. A student only needs *assignment → my work → submit → grade*. "Match with an Assessment…" and "Connect to Task Mentor" are needed only for personal projects, so put them behind the "…" menu.
- **Sync is manual by default.** Students have to remember to Save to Task Mentor, while files auto-save locally. The safe default for assignments is to save online automatically (debounced), and show the state, not a button.
- **Two sources of truth for status.** Projects has 4 status words, Assignments 5, Grading 4, teacher stats 4. Use one vocabulary across both apps: *Not started · In progress · Submitted · Graded · Closed*.

**Integration rating: 7 / 10.** Technically complete; simplify the model it shows to students.

---

## Recommended roadmap

1. **0.10.5 (quick, low risk):** fixes #1, #18 and #19 (dialog focus, palette defaults, keybinding glyphs), #20–#22 (copy and polish), #9, and verifying #12 and #13.
2. **0.11 "One place for my work":** merge This Folder into Assignments (#4), one submit flow (#2), unified status and save wording (#5–#8), Welcome "Your assignments" card (#10), quieter row buttons (#11).
3. **0.12 "Safe sync":** conflict diff (#3), auto-save for assignments by default (#5), list keyboard model (#17), direct-to-student grading (#14).

If 0.11 lands, the expected grade rises from **78 %** to about **86 %**, and student simplicity from 7.5 to about **8.5 / 10**.
