# TMCode workflow, notification and layout gap analysis

**Version reviewed:** 0.14.0 (released 10 October 2026)
**Date:** 12 October 2026
**Reviewer role:** senior UI/UX designer
**Scope:** TMCode for students (practice, assignments, quiz practicals) and for teachers (grading). Exams are covered only where their notifications differ.

**Method:**
1. Two end-to-end journeys run in the app with the test version of Task Mentor, with a screenshot at every step ([img/](img/)):
   - a student: first launch → sign in → start → work → save → submit → returned → graded;
   - a teacher: first launch → grading → grade → draft → release → return.
2. A code inventory of every feedback call: about 250 toasts, dialogs and inline messages, plus every action that gives no feedback at all.
3. A check against established usability heuristics:
   - visibility of system status;
   - match with the user's words;
   - consistency;
   - error prevention and recovery;
   - recognition rather than recall;
   - a minimal design.

**About the test server.** Two of the screens below show the test version of Task Mentor, which keeps a project marked "submitted" after a return or a grade. That makes the contradictions in W4 look worse than they will with the real server. The underlying cause, two sources of state on one screen, is real and is in the code.

---

## Summary

Users are confused about where to start for three reasons:

1. **TMCode never shows a starting point.** It opens on the Explorer and the last folder, which is a developer's starting point, not a student's or a teacher's.
2. **The same action has up to six doors, sometimes on the same screen.**
3. **The screen sometimes gives two answers to "where am I?".** For example, "Returned by your teacher" sits right above a "Submitted · Withdraw to Edit" card.

Notifications are plentiful, but important confirmations disappear after 6 seconds. Some key events give no notice at all (work returned for changes, the first auto-save failure, Trash, extension install). Some messages show technical text.

| Area | Score | Main gap |
|---|---:|---|
| Student: "where do I start?" | **4 / 10** | No home; the Explorer opens first; sign-in and Assignments are hidden behind icons |
| Teacher: "where do I start?" | **3 / 10** | No teacher entry point; Grading appears later; the teacher first sees the student layout |
| Student workflow, once started | 7 / 10 | The brief's next-step card is good; duplicate controls and contradictory states hurt it |
| Teacher grading workflow | 6.5 / 10 | Powerful, but 4 steps to the first student, 3 save buttons, Feedback below the fold |
| Notifications and feedback | 6 / 10 | Disappearing confirmations, silent events, technical text, no rules for which channel to use |
| Layout and arrangement | 6.5 / 10 | Duplicate controls, a crowded side bar, a squeezed grading layout, clipped labels |

**The highest-value fix is a role-aware Home that opens on every start.**
- A student sees "your next assignment", with one button.
- A teacher sees "N submissions to grade", with one button.

That plus one source of truth for status (W4) and a notification policy (N1) would remove most of the confusion reported.

---

## Part 1: Workflow, from start to finish

### Student journey today

| # | Step | What the student sees | Problem |
|---|---|---|---|
| 1 | Launch TMCode (first time) | Welcome page; the "Your assignments" card has **Sign in with NGA** ([s01](img/s01-first-launch-empty.png)) | Good, but only shown when no folder is open |
| 1b | Launch TMCode (any later time) | **Explorer with the last folder**; the editor area shows only keyboard shortcuts ([s03](img/s03-signed-in-first-view.png)) | No sign-in prompt, no Assignments, no "continue where you left off". The only clue is a small "2" badge on an unlabelled icon |
| 2 | Find assignments | 8th icon in the activity bar (mortar board) | It has to be discovered; there's no label |
| 3 | Open an assignment | Click a row → the brief opens | Good |
| 4 | Start | **Start Assignment** in the brief, or Start in the row | Good; the brief opens beside the starter file ([s06b](img/s06b-started.png)) |
| 5 | Work and save | Auto-save to Task Mentor; **two Save buttons and three "Saved online" indicators** on one screen | Duplication (L1) |
| 6 | Submit | **Two Submit buttons** (side bar "Submit Project" and brief "Submit") ([s08](img/s08-submit-dialog.png)) | Which one? (W3) |
| 7 | Returned for changes | **No notice at all.** The brief shows "Returned by your teacher", but the card below still says "Submitted · Withdraw to Edit" ([s10](img/s10-returned.png)) | Silent (N3) and contradictory (W4) |
| 8 | Graded | A notice: "…was graded: 17/20 [View Feedback]". The header says Graded, but the card still says "Submitted · Withdraw to Edit", and the grade sits below it ([s11](img/s11-graded.png)) | Contradiction (W4); the result is buried (L8) |

### Teacher journey today

| # | Step | What the teacher sees | Problem |
|---|---|---|---|
| 1 | Launch, signed in | **Explorer with a practice folder**; no grading anywhere ([t01](img/t01-teacher-first-view.png)) | No teacher entry point. The Grading icon appears only after a background check, and the first sign-in opens the *student* Assignments view |
| 2 | Find grading | Grading icon (if it has appeared) → list of practicals with to-grade counts | Good list, but it has to be discovered |
| 3 | Open a practical | A grading tab opens with an empty right pane: "Select a student to grade. 2 submissions are waiting. [Start Grading]" ([t05](img/t05-activity-opened.png)) | An extra step: why not open the first student? |
| 4 | Grade a student | Code in the middle, grade panel on the right ([t06](img/t06-student-loaded.png)) | Three save buttons, Feedback below the fold, a narrow code column (L3) |
| 5 | Save Draft / Release | The toast and the inline status both confirm it | Good, but duplicated (N4) |
| 6 | Return for changes | "Return for Changes…" sits above the work and the criteria | Too prominent for a rare action (L3) |
| 7 | Finish | "All handed-in work is graded" [Back to My Folder] | Good; there's no "next practical with work" |

### Workflow gaps

| # | Priority | Gap | Evidence | Recommendation |
|---|---|---|---|---|
| **W1** | **P0** | **No home or starting point.** Startup always opens the Explorer (`activeView` defaults to "explorer" and isn't restored) and reopens the last folder. The Welcome page, the only screen that explains what to do, appears only when no folder is open. The Explorer's empty state says exams "open here automatically" and doesn't mention Assignments. | [s03](img/s03-signed-in-first-view.png); `state/store.ts:229`; `ExplorerView.tsx:279-288` | **A Home page that opens on every start in practice mode**, as VS Code's Welcome does by default. It shows a role-aware "What's next" block (below). The activity bar starts on **Assignments** for students and **Grading** for graders. The Explorer's empty state says "Your assignments are in Assignments [Open Assignments]". |
| **W2** | **P0** | **No teacher entry point.** Until the role checks finish (two network calls after sign-in), a teacher sees the student layout ("All My Projects", student empty states). The Welcome page has no grading card. The first-sign-in reveal opens Assignments for every role. The account menu has no Grading item. | [t01](img/t01-teacher-first-view.png); `ActivityBar.tsx:64-67`; `studentHome.ts:58-65`; `WelcomePage.tsx` | A role-aware Home: "**N submissions to grade** in 3 practicals [Start Grading]" for graders. Show "Checking your classes…" instead of the student layout while the role loads. Reveal Grading, not Assignments, on a grader's first sign-in. Add Grading to the account menu. |
| **W3** | P1 | **Too many doors for one step.** Start or open: 6 ways. Submit: 4. Save: 5. Grade: 4. Sign in: 7. Some appear **on the same screen**: the side-bar card and the brief both show Save and Submit. | Inventory §4; [s06b](img/s06b-started.png) | **One primary action per screen.** The brief's next-step card is the home of Start, Save, Submit and Withdraw. The side-bar "This Folder" card shows status only, with no buttons. Keep alternatives in menus and the palette only. |
| **W4** | **P0** | **Two sources of truth.** The brief header and chips follow the assignment state (`my.state`, Returned, Graded), while the next-step card and the side-bar stepper follow the project status. They can disagree: "Returned" above "Submitted · Withdraw to Edit", and "Graded" above "Submitted". The stepper has no "Returned" step. | [s10](img/s10-returned.png), [s11](img/s11-graded.png); `AssignmentEditor.tsx:253-353`; `ProjectsView.tsx:231-346` | Derive **one** status with `studentStatus()` (Not started · In progress · Submitted · Returned · Graded · Closed) and drive every element on the screen from it: header, next-step card, side-bar stepper and row chip. Add a Returned step to the stepper. If the two sources disagree for a moment, show "Updating…" rather than two answers. |
| **W5** | P1 | **Sign-in interrupts and forgets.** A Projects action while signed out asks the student to sign in, then doesn't resume the action they started. | `projects/service.ts:183-197` | Resume the pending action after sign-in ("Signed in. Opening Build a to-do list…"). |
| **W6** | P1 | **Dead ends** (screens with no next action): the Explorer empty state; the Grading "no practicals" message; the grading tab with nothing to grade; the grade panel's "Still working: you can grade once the work is submitted."; the exam card outside practice mode. | Inventory §4 | Give every empty state one action. For example, "Nothing to grade yet [Open Task Mentor] [Show All Students]", and "Still working: [Message the student]" (or link to Task Mentor). |
| **W7** | P1 | **Quiz practicals follow a different path.** No brief, no Submit on the row; submitting goes through All My Projects › Submit Project. | `AssignmentsView.tsx:195-269` | The same brief and next-step card as assignments, with "Keep the quiz open in Task Mentor" as the first step. |
| **W8** | P1 | **Teacher: four steps to the first student** (find Grading → practical → Start Grading → student). The empty right pane adds a click. | [t05](img/t05-activity-opened.png) | Opening a practical with work waiting **opens the first student straight away**. "Start Grading" on Home goes directly to the first submission across all practicals. |
| **W9** | P2 | **Recall instead of recognition.** "Reopen it any time from Recent on the Welcome page (Help › Welcome)"; "Use Projects › Connect This Folder first"; Close Review exists only in a menu. | Inventory §1 | Put the action in the message as a button. Show Recent on Home. |
| **W10** | P2 | **Teacher's Assignments view:** teaching rows have no inline button, and the Teaching section comes after the student sections. | `AssignmentsView.tsx:113, 486-490` | Teaching first for staff, with an inline "Grade (2)" button on each row. |

### Target flows

**Student Home (every start):**
```
Good morning, Ada                               [Sign in] (if signed out)
┌ Next up ───────────────────────────────────────────────┐
│ Build a to-do list · Web Development · due Fri 23:59    │
│ In progress · saved online 2 min ago                    │
│                                   [Continue working →]  │
└────────────────────────────────────────────────────────┘
Returned to you (1) · To do (2) · Graded recently (1: 17/20 View feedback)
Practise on your own: Open Folder · New Project from Template · Recent
```

**Teacher Home (graders):**
```
┌ To grade ──────────────────────────────────────────────┐
│ 3 submissions in 2 practicals · 1 draft not released    │
│                                      [Start grading →]  │
└────────────────────────────────────────────────────────┘
Practicals: Build a to-do list (2) · Build a navbar (1)
Your classes' assignments · Create in Task Mentor
```

---

## Part 2: Notifications and feedback

**Rule to adopt.** Each kind of event gets one channel:

| Event | Channel | Persistence |
|---|---|---|
| State visible in the current view (Saving…, Saved online) | **Inline** in that view, plus the status bar | Live |
| Result of a user action the user can't see completing (submitted, returned, released, imported) | **Toast** | Stays until dismissed if irreversible or important, else 8–10 s, **paused while the pointer is over it** |
| Something the user must decide | **Dialog** | Modal |
| Something that arrived from outside (new assignment, graded, returned, teacher message) | **Toast with an action**, plus an entry in the notification centre with an **unread count** | Until read |
| A failure | **Inline at the place of failure**, plus a toast only if the place isn't on screen | Until resolved |

### Notification gaps

| # | Priority | Gap | Evidence | Recommendation |
|---|---|---|---|---|
| **N1** | **P0** | **Important confirmations vanish after 6 s**, and the timer doesn't pause on hover. Examples: "Submitted … Your teacher sees exactly this version."; "Returned to Chloe for changes."; "Your workspace … is ready"; exam "Your teacher extended the time. New end: …"; exam recovery notes that name a folder; "Downloading the update…" (closes while the download continues). | Inventory §3 ("vanish"); `store.ts:1279` | Use the persistence column above: submit, return, release, time extended and recovery notes stay until dismissed. Pause the timer on hover. Make the update download a progress notification. |
| **N2** | **P0** | **Silent events:** | | |
| | | Work **returned for changes**: no notice, only inline | `assignments.ts`; [s10](img/s10-returned.png) | Toast "Your teacher returned *Build a to-do list*: 'Add a delete button…' [Open]", and an unread entry |
| | | First **auto-save failure**: silent; the toast comes only after the 2nd | `service.ts:1024-1038` | Show the sync line in warning colour at once, and a toast on the first failure if the brief isn't visible |
| | | **Refresh** of Assignments, Projects or Grading fails: inline only, sometimes only a tooltip | Inventory §2 | An inline error card with Retry in every list |
| | | **Move to Trash**, **file import**, **extension install/uninstall**, **git commit/push/pull**, **Copy Path**: success is only logged | Inventory §2 | A short toast for actions with no visible result ("Moved main.py to the Trash [Undo]", "Copied path", "Pushed to origin") |
| | | **Line comment delete**: no confirmation, no undo | `grading/comments.ts:61-80` | An Undo toast |
| | | **Exam sync failures** (other than journal rejection): logged only | `exam/session.ts:569` | The status bar is already red. Add a single toast "Saving to Task Mentor failed. Your work is safe here; tell your teacher if this stays." |
| **N3** | **P0** | **Do Not Disturb hides things that must never be hidden:** exam time warnings, teacher messages, "time extended", and "returned for changes". | `notificationCenter.ts:92-95` | DND never applies during an exam, or to teacher messages and returned work. |
| **N4** | P1 | **Duplicate channels:** grade saved = toast + footer status; Save to Task Mentor = toast + sync line + status bar + brief line; submit = toast + card change. This is noise and trains users to ignore toasts. | Inventory §3 | Follow the rule table: when the change is visible inline, don't add a toast (grade save, Save to Task Mentor while the brief is open). |
| **N5** | P1 | **Technical text:** "Task Mentor answered 500."; release skip reasons made from server codes ("activity closed"); raw `Git: …` lines; "stopped with exit code 1"; raw `e.message` in many places, including grading "Not saved: {error}". | Inventory §3 | One message catalogue: what happened, what to do, and a Details link for the technical part. |
| **N6** | P1 | **Messages name views that don't exist for students:** "Task Mentor Projects view", "(Projects view)", "Task Mentor Projects › Removed", "Projects › Connect This Folder", when students see "All My Projects". "Show Conflicts" and the status-bar click open Projects, not the student's Assignments home. | Inventory §3 | Name things by what the user sees, and put the action in a button instead of a path. |
| **N7** | P1 | **Exam warnings stack:** the 10, 5 and 1 minute warnings all stay and pile up. | `exam/session.ts:604-609` | Replace the previous time warning instead of adding a new one. |
| **N8** | P2 | **Notification centre:** history is in memory only (lost on restart), the bell has no unread count, and a closed toast loses its buttons (for example "View Feedback"). | `notificationCenter.ts:18-26`; `NotificationCenter.tsx:56` | Keep 30 days of history, show an unread count on the bell, and keep the actions in the centre while they're still valid. |
| **N9** | P2 | **Bug found: a failed rename says nothing.** `renameEntry` clears the inline edit before moving the file, so when the move fails (name taken, permissions), the error has no input to appear under and the rename simply doesn't happen. | `store.ts:639`; `setExplorerEditError` `607-610`; `ExplorerView.tsx:158-161` | Clear the edit only after a successful move (small). |
| **N10** | P2 | **Severity:** the Sign Out dialog is styled as info although it signs the student out everywhere. | `projects/service.ts:168` | Warning severity. |

---

## Part 3: Layout and arrangement

| # | Priority | Gap | Evidence | Recommendation |
|---|---|---|---|---|
| **L1** | P1 | **Duplicate controls on the working screen:** Submit ×2, Save ×2, and "Saved online" ×3 (side-bar card, brief, status bar), plus a stepper in the side bar and a status chip in the brief. | [s06b](img/s06b-started.png), [s08](img/s08-submit-dialog.png) | The side-bar "This Folder" card shrinks to one status line with a link to the brief. Keep the status bar item. |
| **L2** | P1 | **Crowded Assignments side bar:** the This Folder card (with the stepper and the live-status switch) pushes the assignment list below the fold, so on a 680 px tall window only two rows show ([s14](img/s14-narrow.png)). | [s14](img/s14-narrow.png) | Make the card a collapsible one-line summary (collapsed by default once started), and move the live-status switch to Settings or the "…" menu. |
| **L3** | P1 | **Grading layout:** three columns (grading side bar, code, grade panel) squeeze the code. The grade panel needs scrolling, and **Feedback is below the fold**. The footer has **three buttons** (Save Draft · Save & Release · Save & Next) plus a keyboard icon next to a warning, "Score every criterion to save". "Return for Changes…" is placed above the files and criteria. | [t06](img/t06-student-loaded.png) | Hide the grading side bar while reviewing (as in Zen mode), with the student switcher in the panel header. The panel order becomes Score summary → Criteria → Feedback → Line comments → Files/changes. Use a sticky footer with **one** primary button, **Save & Next ▾**, whose menu holds Save Draft and Save & Release. Show the "score every criterion" hint inline on the empty criterion. Move Return for Changes into a "More actions" menu. |
| **L4** | P2 | **Progress shown three times** in the grading tab: the side-bar summary, the header bar, and the "0 graded · 2 to grade · 1 working · 0%" line. | [t05](img/t05-activity-opened.png) | Show it once, in the header. |
| **L5** | P2 | **Clipped labels:** the grading filter chip "Not sta…"; the sync line "Not save…" ([s08](img/s08-submit-dialog.png)); course names ("Web Developme…"). | Screens | Let chips wrap, and shorten the sync label to an icon plus a tooltip when narrow. |
| **L6** | P1 | **Narrow window:** the title bar drops the **Help** menu at 1100 px ([s14](img/s14-narrow.png)), so Check My Computer and Welcome become unreachable from menus. | [s14](img/s14-narrow.png) | A "…" overflow menu, as VS Code has. |
| **L7** | P2 | **Developer noise for students:** a source control badge (15–20 changes) in assignment folders; a "↑" badge on All My Projects; "React - react-app (Live Preview)" in the status bar while an unrelated file is open. | [s06b](img/s06b-started.png) | Hide Source Control in assignment workspaces unless the teacher uses git. Remove the Projects badge for students, since the brief shows sync. Show Live Preview only for HTML or project files. |
| **L8** | P2 | **Graded result buried:** on a graded brief the score card sits under the "Submitted" card. | [s11](img/s11-graded.png) | When graded, the result card is the next-step card, at the top: score, feedback, rubric, line comments. |
| **L9** | P2 | **Vocabulary drift:** "In progress" vs "Working"; "Handed in" vs "Submitted"; "Back to My Folder" vs "Back to my folder"; "Open" / "Open My Project" / "Continue in TMCode" / "(Continue)"; seven sign-in labels. | Inventory §3 | A shared glossary: Start · Continue · Save to Task Mentor · Submit · Withdraw to Edit · Returned · Graded. |
| **L10** | P2 | **Unlabelled activity bar** for first-time users: 8–9 icons, and the important ones (Assignments, Grading) sit in the middle. | [s01](img/s01-first-launch-empty.png) | For students and teachers, put Assignments or Grading **first**, and show labels on hover with a one-time "Here are your assignments" coach mark. |

---

## Prioritised fix plan

| Release | Items | Effort | Expected effect |
|---|---|---|---|
| **0.15 "Start here"** | W1, W2 (role-aware Home on every start; Assignments/Grading first), W4 (one status source), N1 (persistence and hover pause), N2 (returned notice, first auto-save failure, Trash/import/push toasts with Undo), N3 (DND exceptions), N9 (rename bug) | ~2 weeks | Removes the "where do I start" confusion and the contradictory screens |
| **0.16 "One way to do it"** | W3 + L1 + L2 (one primary per screen, slim side-bar card), W8 + L3 + L4 (grading opens the first student, panel reorder, one split Save button), N4–N7 (channel rules, message catalogue, view names, warning replacement), W5, W7 | ~2–3 weeks | Faster grading; quieter, clearer notifications |
| **0.17 "Polish"** | W6, W9, W10, N8, N10, L5–L10 | ~1–2 weeks | Fewer dead ends; consistent words; narrow-window fixes |

### How to know it worked

Run a **5-student and 3-teacher usability test** before and after 0.15, using the same tasks:
- Student: "Start the to-do assignment, save, submit; then find your grade."
- Teacher: "Grade the next submission and release it."

| Measure | Today (estimated from the journeys) | Target |
|---|---|---|
| Time from launch to the first useful action | 3–5 clicks, with discovery | 1 click from Home |
| Students who find Assignments without help | not measured | ≥ 5 of 5 |
| Teachers who reach the first submission | 4 steps | 1–2 steps |
| Screens showing two different statuses | 2 of 8 journey steps | 0 |
| Important events with no or disappearing notice | 9 found | 0 |
| Technical messages users see | 6+ kinds | 0 (Details link only) |

---

## Appendix: notification inventory, at a glance

The full inventory, about 250 messages with file and line references, was produced for this review. The highlights:

- **Info toasts with no actions close after 6 s** (`store.ts:1279`). At most 5 toasts show at once, but toasts with actions are never removed, so they can pile up beyond 5.
- **Grading** reports well: an inline footer status, and an inline error with Retry on a failed save. A two-teacher conflict shows a banner with Use Theirs / Keep Mine and Save.
- **Projects** reports every save, conflict and submit, but in Projects words ("Task Mentor Projects view") that students don't see.
- **Assignments** announces new and graded work as persistent notices with actions. Returned work, refresh errors and Continue / Open My Project are silent.
- **Exams** use full-window cards for lobby, submitting, submitted and lock states (good). Time warnings stack, and the time-extension notice vanishes.
- **Silent successes:** local save (dirty dot only), auto-save to Task Mentor, Trash, import, Copy Path, extension install and uninstall, git commit, push and pull, sign-out, settings and theme changes.
