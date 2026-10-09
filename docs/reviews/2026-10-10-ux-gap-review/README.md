# TMCode UX gap review: VS Code parity and the Task Mentor link

**Version reviewed:** 0.10.4, with the uncommitted `fix/ux-quick-wins` work noted where it changes a finding.
**Date:** 10 October 2026.
**Reviewer role:** senior desktop UI/UX.
**Scope:**
- the core editor compared with VS Code;
- the student journey for assignments, projects and quiz practicals;
- teacher grading;
- exam mode;
- first run, sign-in and updates;
- the TMCode ↔ Task Mentor connection on both sides: `nga-tmcode` and `nga-task-mentor` (server and web).

**Method:** a code-level review of both repositories, split into four tracks (editor, student and Task Mentor link, grading, exams and onboarding). Every P0 finding was then re-read in the source by hand. This review follows the [2026-10-09 review](../2026-10-09-ux-review/README.md), which looked mainly at **screens**; this one looks at **behaviour behind the screens**. Findings already listed on 9 October are not repeated, except in the status table below.

**Paths:** `TMC` = `nga-tmcode/packages/workbench/src`, `APP` = `nga-tmcode/apps/desktop`, `TMS` = `nga-task-mentor/server/src`, `TMW` = `nga-task-mentor/client/src`.

**Verification:**
- **✔** = I re-read the code and the behaviour is certain.
- **C** = from reading the code, not yet reproduced at runtime.

---

## Overall rating: **63 %**

That is functional, but not yet trustworthy for high-stakes assessment.

| Area | Weight | Score | Verdict |
|---|---:|---:|---|
| Core editor parity with VS Code | 20 % | **72** | Looks and feels like VS Code; the depth below the surface is thinner (language intelligence, Search/Replace, menus, settings) |
| Data safety and reliability | 10 % | **50** | Folder switching can mix files across projects; no quit guard; Delete is permanent |
| Student assessment workflow | 15 % | **66** | The happy path is good; the edges (late, returned, quiz not open, what gets submitted) mislead |
| TMCode ↔ Task Mentor connection | 15 % | **55** | Same API on both sides, but the states don't agree and several messages never cross the bridge |
| Teacher grading | 15 % | **60** | Fast rubric scoring, but no line comments, no diffs, no tests and no draft/release, and it loses notes on re-save |
| Exam mode | 15 % | **62** | The best screens in the app, but some teacher policies aren't applied and crash and offline recovery are fragile |
| First run, install, sign-in | 5 % | **60** | Unsigned builds, a 5-minute sign-in wait with no way out, toolchains never explained |
| Accessibility and keyboard | 5 % | **55** | Many mouse-only lists, no UI zoom, the exam timer floods screen readers |
| **Weighted total** | 100 % | **63** | |

**Why this score is lower than the 78 % of 9 October:** that review scored what the screens show, and they are good. This one scores whether what they say is *true*:
- an exam setting that is never applied;
- a "Submitted" that recorded nothing;
- a "Late" on work handed in on time.

Each of these costs more trust than a misaligned button. Fixing the **12 P0 items below would lift the score to about 76 %**, and the 0.11–0.13 roadmap at the end to about **85 %**.

### Simplicity and trust, by user

| User | Rating | Why |
|---|---:|---|
| Student, practice | **7 / 10** | Feels like VS Code; frustrations show up later (no Python IntelliSense, F12 into another file may do nothing, no Replace in Files) |
| Student, assignments | **6 / 10** | Easy to start and submit; hard to know *what* was submitted, whether it's late, or why it unlocked again |
| Student, exam | **7 / 10** | Calm, focused screens; but a crash, an offline time-up or closing the window can cost work |
| Teacher, grading | **6 / 10** | Quick scoring; but the teacher can't comment on a line, see what changed, run the tests, or hold grades back |
| Teacher, exam setup | **4 / 10** | Paste, Editor help and Restricted console look like controls but do nothing; there's no live view of who is in the exam |

### VS Code parity, by feature family

| Family | Parity | Main gap |
|---|---:|---|
| Look, layout, theming | 92 % | Only the whole-window zoom is missing |
| Command palette and Quick Open | 70 % | `file:line` broken; no `@`/`#`/`?`; history not saved |
| Menus and keybindings | 55 % | No Selection or Run menu; no rebinding; macOS menu ≠ in-app menu |
| Tabs and editor groups | 70 % | Max 3 groups, no Split Down, no Pin, layout not restored |
| Explorer | 65 % | Single selection, no drag-in from the OS, Delete is permanent |
| Search | 50 % | No Replace in Files, no include/exclude |
| Language intelligence | 45 % | TS knows only open files; no Python/Java/C language servers |
| Source control | 70 % | No hunk staging, no merge-conflict UI |
| Terminal | 60 % | One shell, no split, rename or profiles |
| Run, debug, test | 85 % | Strong: 15+ debuggers, framework tests |
| Settings | 45 % | About 22 settings; no JSON, no workspace scope, `.vscode/settings.json` ignored |
| **Average** | **≈ 64 %** | |

---

## Status of the 2026-10-09 findings

| # | Finding | Now |
|---|---|---|
| 1 | The palette pre-selects Sign Out; destructive dialogs focus the destructive button | **Being fixed.** `fix/ux-quick-wins` (uncommitted): common commands first, persisted recent commands, Cancel focused for destructive buttons, a focus trap. Explorer **Delete** is not yet marked destructive (`TMC/state/store.ts:503`). |
| 2 | Two submit flows that contradict each other | Open (`projects/matching.ts:235` vs `projects/assignments.ts:278`) |
| 3 | Conflicts have no diff | Open |
| 4–8 | Projects/Assignments overlap; four "Save"s; status labels; Withdraw naming and no confirmation; version wording | Open. The web adds a fifth wording, "Revision #N" (`TMW/…/TmcodeStudentPanel.tsx:245`) |
| 9 | Broken references in the copy | Mostly fixed in `fix/ux-quick-wins` |
| 10 | The Welcome page ignores sign-in and assignments | Open |
| 11 | A primary Start button on every row | Open |
| 12 | The quiz practical row opens nothing | Changed in `fix/ux-quick-wins`: the row now opens the workspace. See S8 for what is still missing. |
| 15 | "Use as Starter" shown to students | Open (`ProjectsView.tsx:179`) |
| 17 | No arrow keys in the lists | Open |
| 19 | ⌘ glyphs hard-coded | Being fixed. One more found: the Markdown preview button says "(Ctrl+K V)" on macOS (`parts/editor/EditorGroupView.tsx:386`) |
| 21 | "Question {id}" in exam results | Fixed (results name the tasks) |

---

## P0: fix before the next assessment window

These 12 items can lose work, produce wrong grades or records, or make a setting say something false.

| # | Gap | Evidence | ✔/C | Fix |
|---|---|---|---|---|
| **P0-1** | **Switching folders can show, and then save, another project's file.** `setWorkspace` resets the editor groups without firing `onEditorsClosed`, so Monaco models stay alive. They are keyed by the *relative* path (`tmcode:/main.py`), so opening folder B's `main.py` can reuse folder A's model. Unsaved edits in A are also dropped without a prompt. Students switch between assignments with the same file names every day. | `TMC/state/store.ts:282-296`; `TMC/monaco/documents.ts:35-37, 77-80, 226-228` | ✔ (code) · C (runtime) | `setWorkspace` → `closeAllEditors()` with the dirty prompt (stop if cancelled), then dispose every model; or key the URIs by root. Add an e2e test: open A, open B, check `main.py`. |
| **P0-2** | **A quiz practical "submitted" without the quiz open records nothing**, yet TMCode says "Your teacher sees exactly this version" and the web shows "Submitted". The answer is written only if an `in_progress` quiz submission exists; the request still returns 200 and marks the link submitted. The teacher's grade save then fails with `409 NOT_ANSWERED`. | `TMS/controllers/projects.controller.ts:1412-1454`; `TMC/projects/matching.ts:247`; `TMW/…/TmcodePracticalQuestion.tsx:270` | ✔ | Server: return `409 QUIZ_NOT_OPEN` (or attach to the next attempt). TMCode: check before the dialog, and offer "Open the quiz in Task Mentor". |
| **P0-3** | **Re-saving an assignment grade deletes the per-criterion notes the student saw.** Notes are stored only inside the feedback text; the roster sends the scores back without comments; the editor removes the "Criteria notes" block. So Save writes the feedback with no notes. TM web has the same bug. | `TMS/controllers/tmcodePracticals.controller.ts:305-311, 346-349`; `TMC/grading/GradingEditor.tsx:42-49`; `TMW/pages/PracticalGradingPage.tsx:151-161` | ✔ | Store `{index, score, comment}` (JSON). Until then, parse the notes block back into the comments. |
| **P0-4** | **Exam "Paste" and "Editor help" policies are not applied in the editor.** `policy.paste` is checked only in the terminal; `policy.intelligence` is read nowhere. Teachers choose "Block paste / No editor help" in Task Mentor and get neither. | `TMC/terminal/enhance.ts:80` (the only check); grep for `intelligence` in TMC finds nothing; `TMW/components/Proctoring/ProctoringSettings.tsx:668-678` | ✔ | Enforce in Monaco: block the paste command and `onDidPaste` (allow internal copies), and set `quickSuggestions`, `suggest` and `hover` from the level. Until then, hide the options in Task Mentor. |
| **P0-5** | **"Restricted console" gives a full shell, and "Secure (lab lockdown)" only changes a label.** Every terminal gate tests only `!== "off"`. | `TMC/parts/panel/Panel.tsx:112`, `commands/builtin.ts:49`, `commands/developer.ts:15`, `run/runHub.ts:80`; `parts/StatusBar.tsx:20` | ✔ | Treat `restricted` as `off` until a real restricted console exists. Mark "Secure" as not available. Explain each choice in one line in the Task Mentor form. |
| **P0-6** | **After a crash, the server's older copy overwrites newer local exam work, and the message says the opposite.** A relaunch gets a new session, so the journal is empty and `localSeq = 0`. Then `serverNewer` is always true. Unsent offline work stays in the old session's journal; the local files go to `.recovered/`, which is never graded. The toast says "Your newer work from Task Mentor was loaded". | `TMC/exam/session.ts:95-101, 136-142, 174-189` | ✔ | On launch, find unsent journals for the same submission and upload or replay them. Compare by timestamp or hash, not by sequence numbers from different sessions. When the copies differ, ask the student which to keep. |
| **P0-7** | **Being offline at time-up gives contradictory screens and can drop the last minutes.** The final snapshot is taken *after* the deadline, so the server rejects it. `lockExam("Time is up.")` then hides the "Submitting…" overlay while the retry loop keeps running, and the title bar shows Submit again. | `TMC/exam/session.ts:285, 330, 381-385`; `TMS/controllers/tmcode.controller.ts:376-385` | C | Stamp the final snapshot at the deadline (`offline_final`). Show one full-screen card: "Time is up. Saved on this computer, sending when online (grace ends 14:32)". |
| **P0-8** | **No close or quit guard: not during an exam, not with unsaved files.** There is no `onCloseRequested` handler anywhere; ⌘Q and the close button just quit. The exam overlay says "Do not close TMCode", but nothing enforces it. | grep for `onCloseRequested` in `APP/src`, `APP/src-tauri/src` and TMC finds nothing; `TMC/exam/session.ts:383` | ✔ | Intercept the close request: in exams, "N changes haven't reached Task Mentor yet. Keep TMCode open / Quit anyway"; otherwise reuse `confirmCloseDirty`. |
| **P0-9** | **"Return for changes" is invisible to the student.** The teacher's message is saved only as a project event that neither app shows. The work silently goes back to "In progress" and the workspace unlocks. | `TMS/controllers/projects.controller.ts:1657-1663`; there is no `returned` entry in `TMW/components/Projects/HistoryTabs.tsx` or in `TMC/projects` | ✔ | Add a `returned` state and `returned_message` to the `/assignments` payload, with a "Returned by your teacher: …" banner in the TMCode brief and the web panel. |
| **P0-10** | **"Late" is shown on work handed in on time.** `late` means `due < now` (a property of the assignment), not the submission's `is_late`. Both the TMCode receipt and the web panel show it after the due date. | `TMS/controllers/tmcodeAssignments.controller.ts:141`; `TMC/projects/AssignmentEditor.tsx:264-269`; `TMW/…/TmcodeStudentPanel.tsx:123` | C | Send `my.is_late` from `submissions.is_late` and use it for receipts. Hide the countdown once the work is submitted. |
| **P0-11** | **When Central MIS is down or the token has expired, the student sees "nothing to do".** `getScopedSubjects` returns `[]` on any MIS failure, and deep links answer `NOT_ENROLLED`. The fix (`409 MIS_SCOPE_UNAVAILABLE`) exists only in **TM PR #55, which is not merged**. | `TMS/utils/scopedSubjects.ts:120-124`; `nga-task-mentor-tmcode-project-assignments/…/tmcodeAssignments.controller.ts:83` | ✔ | Merge PR #55. In TMCode, show "Couldn't check your subjects. Retry / Sign in again" rather than an empty list, and stop swallowing the quiz-practicals error (`assignments.ts:88`). |
| **P0-12** | **Explorer Delete is permanent, and the dialog focuses Delete.** "TMCode does not use the Trash." There is no undo for rename or move. One Delete then Enter loses an assignment file. | `TMC/state/store.ts:497-508` | ✔ | Move to the OS trash (Rust `trash` crate), mark the button `destructive`, and take a Local History snapshot before deleting. |

---

## P1: student journey and the Task Mentor connection

| # | Gap | Evidence | Impact | Fix |
|---|---|---|---|---|
| S1 | **Submit doesn't say what is handed in.** `dist`, `build`, `out`, `target`, `node_modules` and `.venv` are always skipped, plus `.gitignore`. Files over 10 MB, or beyond 5,000 files / 100 MB in total, are cut off. A file that grows past the limit is recorded as *deleted*. | `APP/src-tauri/src/projects.rs:22-24, 62-90`; `TMC/projects/plan.ts:44,58` | High | Show a manifest in the submit dialog ("23 files, 1.2 MB · 2 not included: Show"). Never treat a skipped file as a deletion. |
| S2 | **The rubric is never shown in the TMCode brief, and nobody sees per-criterion scores.** The API returns `rubric` but TMCode types it `unknown`. Graded work shows only the total and the feedback text. | `TMS/…/tmcodeAssignments.controller.ts:182-192, 405`; `TMC/projects/assignments.ts:46` | High | "How it's graded" in the brief; after grading, a table of scores and comments per criterion (in both apps). |
| S3 | **Submit errors hide the real cause.** Offline, quota (413) and locked all become "Save your work to Task Mentor first (unsaved changes or conflicts)". | `TMC/projects/service.ts:328, 680-685` | Med-high | Pass the cause through: "You're offline. Your work is safe here; submit when you're back online." |
| S4 | **When the session ends mid-work, the open brief becomes an endless skeleton.** It doesn't recover after signing in again; the only signal is a "!" badge. | `TMC/projects/service.ts:107-116`; `assignments.ts:91-131`; `AssignmentEditor.tsx:108-125` | Med-high | Sticky banner "Your NGA session ended. Sign in to keep saving", a signed-out state in the brief, and reload open briefs after sign-in. |
| S5 | **Withdrawing after the due date quietly makes on-time work late,** and removes it from the teacher's to-grade list. | `TMS/controllers/projects.controller.ts:1372-1395, 1617-1636` | Med-high | Say so in the (new) Withdraw confirmation, or keep the on-time flag when the content hasn't changed. |
| S6 | **Deadline rules differ by path.** The web card closes at the due date; the server and TMCode accept late work until the teacher closes the assignment. No one tells the student the real cutoff. | `TMW/…/AssignmentDetails.tsx:641`; `TMS/…/projects.controller.ts:1347-1350` | Med | One policy per assignment ("Late accepted until …"), shown in both apps. |
| S7 | **"Open in TMCode" on the web sends students to the download page while Chrome's "Open TMCode?" prompt is still showing** (the "no blur in 2 s" heuristic). The exam button has no fallback, and its hint links to `/apps`, a route that doesn't exist. | `TMW/components/Projects/OpenProjectInTmcode.tsx:55-77`; `TMW/components/Quizzes/OpenInTmcode.tsx:23-24, 55` | Med-high | Hint only, never auto-navigate; link to `/tmcode`; detect unsupported devices (Chromebook, phone). |
| S8 | **Quiz-practical rows have no state, grade, rubric or open/close information,** and they disappear once the quiz ends, so their grades never appear in TMCode. They can also be started **before** the quiz's `start_date`. | `TMC/projects/AssignmentsView.tsx:130-181`; `TMS/tmcode/projects/access.ts:71`; `projects.controller.ts:1210-1212` | Med-high | The same row and brief model as assignments, plus "Quiz open / not open in Task Mentor"; respect `start_date` ("Opens Fri 9:00"). |
| S9 | **TMCode never announces new or graded work.** The list is polled every 5 minutes, but changes are not compared, so there's no "New: X" or "X was graded 17/20" notice. | `TMC/projects/assignments.ts:73-122` | Med | Compare between refreshes and show a toast with "View feedback". Add TMCode deep links to the MIS reminders. |
| S10 | **A grade can lock a student who is still working.** Saving a grade on unsubmitted work creates a graded submission and locks the project. | `TMS/…/tmcodePracticals.controller.ts:494-539` | Med | Warn the teacher; tell the student "Your teacher graded this; the workspace is now read-only". (See G4 for draft/release.) |
| S11 | **Save quietly pulls in and deletes files from Task Mentor** when the online copy is newer, with no summary and no undo. | `TMC/projects/service.ts:362-365, 437-445` | Med | "Getting 3 changes from your other computer: a.js, b.css (deleted)…", with a Local History backup first. |
| S12 | **Unsaved work on another device, or in the folder being left, gets no warning.** Opening an assignment pulls the online version even if the laptop has unsaved changes; switching assignments leaves unsynced work behind. | `TMC/projects/service.ts:482-535, 714-726` | Med | Use the student's own presence data: "Your Mac has 4 changes not saved online". "Save 'A' before opening 'B'?" |
| S13 | **Auto-save failures are silent** (the quiet save only sets `sync='error'`), and the brief shows no sync state. | `TMC/projects/service.ts:404-407, 782` | Med | Show the sync line in the brief; toast after 2 failures. |
| S14 | **Signing out on a lab PC signs out everywhere and leaves the student's folders behind** for the next user. | `TMC/projects/service.ts:155`; `APP/src-tauri/src/account.rs:481-498` | Med | "Sign out of this computer only" plus "Also remove my assignment folders". |
| S15 | **The web can submit while TMCode has unsaved changes,** and doesn't say which version it submits. | `TMW/components/Projects/ProjectLifecycle.tsx:24-28` | Med | "Submitting version 4, saved 14:02". Warn when presence reports unsaved changes. |
| S16 | The grade is hidden behind "Read-only" in the completed list; past-term work disappears; attachments can't be saved into the workspace; the starter-files line shows only to teachers (the student branch is dead code). | `AssignmentsView.tsx:34, 303`; `tmcodeAssignments.controller.ts:325`; `AssignmentEditor.tsx:302-307` | Low-med | Grade chip plus lock; a "Past terms" section; "Save to workspace"; show the starter line to students. |
| S17 | **The two apps use different words.** The web shows markdown instructions as raw text; the web says "Revision #N" and "Work and save"; the "Late" and "Read-only" chips follow different rules. | `TMW/…/TmcodeStudentPanel.tsx:160, 245` | Low | One shared vocabulary: *Not started · In progress · Submitted · Returned · Graded · Closed*; render markdown on the web. |

---

## P1: teacher grading

| # | Gap | Evidence | Impact | Fix |
|---|---|---|---|---|
| G1 | **No inline line comments.** Feedback is per criterion plus one text box. GitHub PR review, CodeGrade and Gradescope all centre on line comments. | grep `TMC/grading/*` and the grade schema (`tmcodePracticals.controller.ts:443-451`) | High | `annotations: [{path, line, text}]` on the grade; Monaco comment widgets in the review folder; shown to students in both apps. |
| G2 | **No diff against the starter files or between versions.** The starter revision is recorded, but only the frozen revision is loaded. TMCode already has two diff editors. | `TMS/tmcode/practical/question.ts:26-33`; `TMC/grading/service.ts:313-347`; `TMC/history/HistoryDiffEditor.tsx` | High | "Changes vs starter" and "Compare with version N", plus a version picker (the web already has one). |
| G3 | **No autograder or test results for practicals.** Running the work means opening a terminal by hand in a read-only folder. | `TMS/tmcode/practical/question.ts:4-5`; `GradingEditor.tsx:149-174` | Med-high | Teacher-attached tests with pass/fail in the grade panel; at least a "Run" button in the review folder. |
| G4 | **Grades are live the moment they are saved:** no draft and no "Release grades". The toast "The student sees it in Task Mentor" is wrong for quizzes, where the score is held while any answer is pending. | `tmcodePracticals.controller.ts:500, 555-562`; `TMC/grading/service.ts:251` | Med-high | A "Save draft / Save & release" pair (or a release toggle per activity); an accurate toast for each activity type. |
| G5 | **"Return for changes" exists only on the web,** fails for quiz practicals there, and graded work can never be reopened. | `TMW/pages/PracticalGradingPage.tsx:824-830, 1429`; `TMS/tmcode/projects/status.ts:120-122` | Med-high | "Return for changes…" in TMCode; hide it for quizzes or support it; "Allow resubmission" after grading. |
| G6 | **The AI marking draft is not available for practicals** in either app (the endpoint reads only uploaded files and the text answer). | `TMS/controllers/submissionAi.controller.ts:84`; `TMW/…/AssignmentDetails.tsx:345-352` | Med | A project-aware draft at the frozen revision: "Draft marks & feedback", filling in unsaved scores. |
| G7 | **Drafts live only in memory** (lost on quit, although the dialog says they stay); a failed save is only a toast. The web keeps its drafts in localStorage. | `GradingEditor.tsx:40, 341`; `service.ts:253-255` | Med | Persist drafts per activity and student; an inline error with Retry; "unsynced" marks in the roster. |
| G8 | **With two teachers, the last write wins silently.** There's no version check, `graded_by` isn't shown, and a dirty draft hides newer server data. | `tmcodePracticals.controller.ts:339-375, 494-513`; `GradingEditor.tsx:84-87` | Med | Return 409 on stale writes; show "Graded by X at T" and a "changed by someone else" banner. |
| G9 | **Deep links don't land in grading.** The web's "Open in TMCode" opens an editable working copy of the head version; TMCode → web drops `?question=` and `?student=`. | `TMS/…/projects.controller.ts:1189-1194`; `GradingEditor.tsx:417-421` | Med | `tmcode://grading?type&id&question&student`; pass question and student to the web. |
| G10 | **The keyboard flow is weaker than TM web's.** ⌘Enter works only while focus is inside the panel; there are no palette commands, no next/previous student, no shortcut help; arrow keys in the roster load a whole folder per step. | `GradingEditor.tsx:116-124, 476-482`; `TMC/projects/commands.ts:338-340` | Med | `grading.saveAndNext/next/prev/focusPanel` with global keys; arrows move focus and Enter loads (or a debounce). |
| G11 | **Rubric scoring is thinner than TM web's.** Quick scores are only 0/½/full, typed values are silently clamped, there are no comment snippets, and nothing warns when the rubric total ≠ the activity's points. | `GradingEditor.tsx:204-236` vs `PracticalGradingPage.tsx:132-176, 1220, 1285` | Low-med | Match the web's chips, snippets and validation; warn on a points mismatch. |
| G12 | **Integrity aids are missing:** late shows as a chip only (no "2 days late", no penalty); no similarity hints; no bulk release, return or CSV export. | `tmcodePracticals.controller.ts:373, 412` | Low-med | "N days late" plus an optional penalty; a file-hash similarity flag; multi-select actions. |
| G13 | Quiz practicals are graded with no context from the rest of the student's quiz; the progress % is graded÷submitted in TMCode but graded÷total on the web; `graded_at` is really `updated_at`; review folders pile up on staff disks (privacy); Preview is enabled even for projects without HTML. | `GradingEditor.tsx:400-407`; `service.ts:222, 340, 386`; `tmcodePracticals.controller.ts:351` | Low | Quiz total in the header; one % definition; a real `graded_at`/`graded_by`; prune review copies; hide Preview for non-web projects. |
| G14 | **Accessibility of the roster and panel:** options aren't focusable, chips have no `aria-pressed`, textareas aren't labelled, and save status isn't announced. | `GradingEditor.tsx:204-273, 470-511` | Med | A listbox pattern, labels, and an `aria-live` save status. |

---

## P1: exam mode (beyond P0-4 to P0-8)

| # | Gap | Evidence | Impact | Fix |
|---|---|---|---|---|
| E1 | **No system check before the exam.** A missing Python or JDK is found when the student clicks Run, and the message mentions "toolchain packs" that don't exist. Installs are blocked in exams. | `TMC/exam/session.ts:94`; `APP/src-tauri/src/runner.rs:248`; `IMPLEMENTATION_PLAN.md:288` | High | A lobby checklist before the timer starts, and "Check my computer" in Task Mentor ahead of exam day. |
| E2 | **The server-run fallback is built but never called,** so a student without the local tool can't run the visible tests at all. | `TMC/exam/api.ts:141` (no callers); `testService.ts:55-58` | Med-high | Run on Task Mentor when there's no local tool: "Running on Task Mentor… (queued)" and "Run again in 40 s". |
| E3 | **After a restart, the exam folder reopens in practice mode** (full terminal, no timer) from Recent, and after "Close exam" it stays editable. | `TMC/state/store.ts:265, 283`; `exam/session.ts:456` | Med | Keep exam folders out of Recent; show "You have an exam in progress" at startup; make the folder read-only after submitting. |
| E4 | **No teacher live view of TMCode exam sessions.** Heartbeat, focus, current task and flags (`journal_tampered`, `offline_final_late`) are stored but shown nowhere. The client never sends telemetry. | `TMS/controllers/tmcode.controller.ts:204-307, 518-531` | Med-high (teachers) | A "TMCode sessions" panel per quiz: status, last sync, task, app version, flags with explanations. |
| E5 | **Launch failures are dead ends:** only "Close", raw server text, a ZodError dump for an outdated client. There is no minimum-version check, although the updater is (rightly) blocked in exams. | `TMC/exam/ExamViews.tsx:155-167`; `session.ts:116-123`; `api.ts:126` | Med | Map each error code to a plain title and an action (Try again / Open Task Mentor / Update TMCode); `min_app_version`. |
| E6 | **The 120 s launch ticket meets macOS Gatekeeper** on an unsigned first run: the deep link is lost or the ticket expires. | `TMS/controllers/tmcode.controller.ts:52`; `APP/src-tauri/tauri.conf.json:56` | Med | "Install and open TMCode once before the exam" with a test link; Developer ID signing. |
| E7 | **Locked, superseded and revoked sessions keep a Submit button that can't work;** "Paused by your teacher" is never shown; there is no per-student extra time. | `ExamViews.tsx:46, 100`; `session.ts:282, 312, 393` | Med | A full-window card per reason ("Continued on another computer: Take over here"); a paused overlay; time multipliers in Task Mentor. |
| E8 | **No submission receipt:** no time, no per-task "last saved", no code for the proctor. "Grading your code…" spins forever after polling stops. | `ExamViews.tsx:180-222`; `session.ts:400` | Med | A receipt block, and "Grading takes longer than usual; results will appear in Task Mentor". |
| E9 | **"All work saved" can be wrong:** auto-save isn't forced in exams, unsaved buffers are ignored, and only 100 files per task are read (the server allows 300). | `session.ts:211, 422`; `ExamViews.tsx:59-65` | Low-med | Force `afterDelay` in exams; "2 unsaved changes"; warn at the file cap. |
| E10 | **The web quiz page doesn't know about the TMCode session.** Submitting on the web closes the attempt, and TMCode then says "Time is up". | `TMW/pages/QuizTakingPage.tsx:1899-1901` | Low-med | "Coding questions in TMCode: last saved 10:41"; warn before a web submit; a clear "Submitted from Task Mentor" message. |
| E11 | **Results are thin:** "x/y tests passed" with no verdict (time limit, wrong answer, compile error). Task titles are question text cut at 80 characters mid-word. | `TMS/…/tmcode.controller.ts:687-692`; `TMS/tmcode/exam.ts:122` | Low-med | Visible tests named, with verdicts; cut titles at a word boundary with "…". |
| E12 | **Teachers can't preview their exam in TMCode,** and the policy form has no help text. The debugger setting can't be configured: Task Mentor drops it. | `tmcode.controller.ts:88-90`; `TMS/tmcode/policy.ts:12-60` | Med (teachers) | "Preview in TMCode" (a sandbox attempt); a "What students will see" summary; the debugger toggle wired through. |

---

## P1: core editor compared with VS Code

| # | Gap | Evidence | Impact | Fix |
|---|---|---|---|---|
| V1 | **No hot exit and no unsaved-files prompt on quit** (see P0-8). | `APP/src-tauri/src/lib.rs:348` | High | Back up dirty models and restore them on launch. |
| V2 | **Cross-file Go to Definition can do nothing.** The editor opener is registered only once an extension registers a provider. | `TMC/exthost/languageBridge.ts:62-69, 389-390` | High | Register the opener at startup (`monaco/setup.ts`). |
| V3 | **The TypeScript service only knows the open files:** "Cannot find module './utils'", and Rename and References miss unopened files. `tsconfig` paths are ignored. | `TMC/monaco/documents.ts:77-91`; `languageServices.ts:151-236` | High | Load workspace sources (bounded) as extra libs; read `tsconfig`. |
| V4 | **No semantic intelligence for Python, Java or C/C++** without a system Node and extensions. | `docs/EDITOR_ANALYSIS.md` §3, §5.1 | High (Python/Java courses) | Bundle pyright and jdtls behind the exam policy. |
| V5 | **Quick Open promises `file:line` but it doesn't work;** there are no `@` symbol, `#`, `?` or `%` modes; history isn't saved; matching is on file names only. | `TMC/widgets/QuickInput.tsx:86-92, 164-170, 268-276` | Med | Parse a trailing `:line`; add `@` (OutlinePane has the data) and `?`; persist history. |
| V6 | **Editor actions are hidden:** about 11 Monaco actions are wrapped; F1 (Monaco's palette) is captured by the workbench; the in-app menus show no shortcuts for Find, Comment or Undo. | `TMC/commands/builtin.ts:205-217`; `Workbench.tsx:176-192`; `parts/TitleBar.tsx:34` | Med | List `editor.getSupportedActions()` in the palette, with their keybindings. |
| V7 | **Menus:** no Selection or Run menu; Go has 3 items; the macOS native menu is a separate, static list (Terminal has only "New Terminal") and its items are never disabled. ⌘Z and ⌘F always target the editor. | `parts/TitleBar.tsx:12-86`; `APP/src-tauri/src/menus.rs:20-121` | Med | Build both menus from one spec; add Selection and Run; route ⌘Z and ⌘F by focus. |
| V8 | **Missing everyday shortcuts:** Ctrl+Tab, Reopen Closed Editor (⇧⌘T), Go Back after F12, focus group (⌘1/2/3), untitled file (⌘N), Save As, Revert. | grep of the `registerCommand` ids | Med | Add the commands; untitled buffers via a `tmcode-untitled:` scheme. |
| V9 | **Keybindings are read-only,** the reference omits Monaco's own bindings (⌘D, ⌥↑/↓), and double-clicking a row *runs* the command. | `TMC/parts/editor/ShortcutsEditor.tsx:6-34` | Med | User overrides (locked in exams); merge Monaco's bindings into the reference; make double-click edit, or do nothing. |
| V10 | **Search has no Replace in Files and no include/exclude;** `.gitignore` isn't honoured; results are mouse-only. | `TMC/parts/search/SearchView.tsx:88-133`; `search.ts:26-28` | Med | A Replace field with preview, glob inputs, and a tree keyboard model. |
| V11 | **Explorer:** single selection only; files can't be dragged in from Finder or File Explorer; `.git` is visible and deletable; no compact folders (Java's `src/main/java/com/x` = 4 clicks); no auto-reveal; no type-ahead. | `TMC/state/store.ts:404-408`; `parts/explorer/ExplorerView.tsx:137, 221-293` | Med | Multi-select, OS drops through Rust, `files.exclude` (default `.git`), compact folders on by default. |
| V12 | **No merge-conflict UI** (no Accept Current/Incoming CodeLens, no merge editor); no hunk staging; no diff navigation toolbar; Timeline is local history only. | `TMC/scm/ScmView.tsx:236, 313`; `scm/GitDiffEditor.tsx:105-117` | Med | A conflict CodeLens (same pattern as `testing/editor.ts`), diff title actions, git entries in Timeline. |
| V13 | **Status bar items:** Indentation shows the *global* setting, not the file's, and opens Settings; EOL and Encoding are static. Non-UTF-8 files are decoded lossily and the loss is **saved back** (accents in French Windows files). | `TMC/parts/StatusBar.tsx:160-205`; `APP/src-tauri/src/workspace.rs:245-246` | Med | `model.getOptions()` with VS Code's indentation picker; an EOL picker; detect the encoding (or open read-only with a warning) and keep the BOM. |
| V14 | **Notifications:** only the last 5 are kept, so an action toast ("changed on disk… Discard my changes") can be pushed out. | `TMC/state/store.ts:873-886` | Med | A notification centre; never evict notifications that have actions. |
| V15 | **Terminal:** one shell per OS (Windows always PowerShell); the label is hard-coded ("zsh" for a bash user); no split, rename or profiles; terminals are killed on a folder change. | `APP/src-tauri/src/pty.rs:45-51`; `TMC/parts/panel/TerminalView.tsx:293-368` | Med (Windows) | A profile picker (pwsh, cmd, Git Bash, WSL), the real shell name, split and rename. |
| V16 | **Settings:** about 22 fixed settings, a static "User" tab, no settings JSON, and **`.vscode/settings.json` from teachers' starter code is ignored.** No per-language indentation. | `TMC/state/settings.ts:13-46`; `parts/editor/SettingsEditor.tsx:116-121` | Med | A read-only overlay of `.vscode/settings.json`; `[python]` scopes; "Open Settings (JSON)". |
| V17 | **Editor groups and tabs:** max 3 groups, no Split Down, no drop-to-split; no pinned tabs; ←/→ don't move between tabs (an ARIA tablist violation); the restored layout loses splits, cursors and pane sizes. | `TMC/state/store.ts:303-326, 739-746`; `EditorGroupView.tsx:188-304` | Low-med | A grid with Split Down, Pin, a roving tabindex, persisted layout and view state. |
| V18 | **Accessibility:** ⌘= and ⌘- zoom only the editor font, though the macOS menu says "Zoom"; there's no screen-reader mode; the Problems and Search rows are mouse-only. | `TMC/commands/builtin.ts:176-189`; `parts/panel/Panel.tsx:70` | Med | Whole-window zoom (Tauri `set_zoom`); an `accessibilitySupport` toggle; keyboard trees. |
| V19 | Single window, single folder: no "New Window", no multi-root, and no trust prompt before running tasks or `launch.json` from a cloned repository. Extensions are only partly supported (`createTerminal` throws; no tasks, debuggers or SCM providers), and the Extensions view doesn't say which parts work. | `docs/EXTENSION_HOST.md:265-293, 418-438` | Low-med | "Open in New Window"; a light trust banner for cloned folders; a support badge per extension. |

---

## P1: first run, sign-in, install

| # | Gap | Evidence | Fix |
|---|---|---|---|
| F1 | Sign-in waits up to **5 minutes** with a disabled button. Cancel is only in the Accounts menu; there's no "Open the browser again" and no copyable link. | `APP/src-tauri/src/account.rs:27`; `TMC/projects/ProjectsView.tsx:424` | Cancel, Open again and Copy link next to the spinner. |
| F2 | A failed keychain save is only logged, so the student is silently signed out at the next start. Ad-hoc signing likely re-triggers macOS keychain prompts after each update, with no explanation in the app. | `account.rs:381-383`; `tauri.conf.json:56` | Tell the student; explain "Always Allow"; prioritise Developer ID signing. |
| F3 | Nowhere says that Python, a JDK or a C compiler must be installed separately. "No compilers or interpreters were found" offers no links. | `TMW/pages/TmcodeDownloadPage.tsx:62`; `TMC/run/runService.ts:295` | A "Check my setup" card on Welcome with install links for each OS. |
| F4 | The tips for unsigned installers (macOS Open Anyway, Windows SmartScreen) appear only on the download page, not where students start (the quiz page, the Open in TMCode hint). | `TmcodeDownloadPage.tsx:43-52` | Repeat the one-line tip; treat signing and notarisation as an exam blocker. |

---

## What already works well (keep it)

- **VS Code fidelity on the surface:**
  - theme-true colours (including high contrast);
  - preview tabs, dirty dots and close variants;
  - VS Code arrow keys in the Explorer;
  - a palette with recent and common commands, plus chords;
  - Zen mode, Outline, sticky scroll, Local History.
- **Run, debug and test breadth:** 15+ debuggers, framework test discovery, 49 templates, a built-in SQL engine, truth tables and an API tester. This is better than stock VS Code for a beginner.
- **The exam engine's foundations:** an fsync'd, HMAC-chained journal; a server-anchored clock; updates deferred during exams; idempotent submit; 10/5/1-minute warnings; most blocked features explain themselves.
- **One grading API for both apps.** The review folder is truly read-only and opens on the right file. Save & Next goes to the next ungraded student, and there's a finish screen.
- **The assignment brief's "next step" card and the status stepper** (from the 9 October review) are still the best student pattern in the app.

---

## Recommended roadmap

| Release | Content | Expected score |
|---|---|---:|
| **0.10.5 "Trust" (now)** | The 12 P0 items. Most are small: P0-1 one function; P0-4 and P0-5 enforce or hide; P0-8 a close handler; P0-12 the `trash` crate. P0-2, P0-3, P0-9, P0-10 and P0-11 are Task Mentor server changes, with PR #55 to merge. | **≈ 76 %** |
| **0.11 "One place for my work"** | The 9 October roadmap (merge This Folder into Assignments, one submit, one vocabulary) plus S1–S4, S8, S9 and the shared status vocabulary across both apps (S17). | ≈ 80 % |
| **0.12 "Grade like a code reviewer"** | G1 line comments, G2 diffs, G4 draft/release, G5 return in TMCode, G7–G10. Exams: E1 system check, E2 server run, E4 teacher live view. | ≈ 84 % |
| **0.13 "Feels like VS Code underneath"** | V2–V4 language intelligence (pyright, jdtls), V5 Quick Open, V7 menus, V10 Replace in Files, V11 Explorer, V13 status bar and encoding, V18 zoom and screen-reader mode. | ≈ 87 % |

**Suggested e2e tests to add with the P0 fixes:**
- open folder A, then B, and check that `main.py` shows B's content;
- submit a quiz practical without the quiz open: expect `QUIZ_NOT_OPEN`;
- grade with notes, then re-save: the notes are still there;
- an exam with `paste: block`: Monaco paste is refused;
- kill the app while offline in an exam, relaunch: the local work wins.
