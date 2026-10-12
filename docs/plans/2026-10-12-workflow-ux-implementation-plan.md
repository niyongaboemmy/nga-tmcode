# Implementation plan: clear starting points, one way to do each thing, honest feedback

**Based on:** [2026-10-12 workflow, notification and layout gap analysis](../reviews/2026-10-12-workflow-gap-analysis/README.md) (W1–W10, N1–N10, L1–L10)
**Starting version:** TMCode 0.14.0
**Plan date:** 12 October 2026
**Delivers:** 0.15 "Start here" → 0.16 "One way to do it" → 0.17 "Polish", plus a validation phase
**Team assumed:** 1 full-stack developer full time, plus a teacher and 3–5 students for 2 short test sessions. The estimates below are working days for one developer; with two, the phases shorten by about 40% (the 0.16 tracks run in parallel).

---

## 1. What we are building, in one picture

Today a student opens TMCode and sees a file tree. After this plan, every user sees **one obvious next step**:

```
Student opens TMCode                         Teacher opens TMCode
        │                                            │
        ▼                                            ▼
 Home: "Next up: Build a to-do list"         Home: "3 submissions to grade"
        [Continue working →]                        [Start grading →]
        │                                            │
        ▼                                            ▼
 Code + brief side by side                   First student's code + grade panel
 One status line · one Submit                Criteria → Feedback → [Save & Next ▾]
        │                                            │
        ▼                                            ▼
 "Submitted ✓" (stays until dismissed)       Next student opens by itself
        │                                            │
        ▼                                            ▼
 "Returned: add a delete button [Open]"      "All graded. 1 draft not released [Release]"
 "Graded 17/20 [View feedback]"
```

### Principles every change is checked against

1. **One door per step.** Each screen has exactly one primary button. Alternatives live in menus and the palette, never as a second button on the same screen.
2. **One answer to "where am I?".** All status on screen comes from one derived value. If the data is momentarily inconsistent, show "Updating…", never two statuses.
3. **Every action answers back, in the right place.** Use one channel per event, following the rules in §3.3. Important results stay until dismissed. Background failures are never silent.
4. **Words users see.** Messages name things exactly as the user sees them and put the next action in a button, not a menu path.
5. **Nothing breaks for existing users.** New behaviour ships behind settings with sensible defaults, existing settings migrate, and older Task Mentor servers keep working.

### Not in scope

- AI features (separate report).
- Exam engine changes, except the notification rules in N3/N7.
- Task Mentor server changes. **None are required**: everything uses fields the server already sends (`my.state`, `my.returned_at`, the grading roster counts, `activity.can_return`).

---

## 2. Phase overview

| Phase | Version | Goal | Gap items | Effort (1 dev) | Ship when |
|---|---|---|---|---|---|
| **0** | — | Baseline and safety net | measurement, test journeys, test-server fixes | 3 days | before any UI change |
| **1** | **0.15 "Start here"** | Users know where to start; screens never contradict; important events are never missed | W1, W2, W4, N1, N2, N3, N9 | 11–13 days | after the Phase 0 baseline |
| **2** | **0.16 "One way to do it"** | One primary action per screen; grading takes 1 click per student; messages in plain words | W3, W5, W7, W8, L1, L2, L3, L4, N4–N7 | 13–16 days | after 0.15 has been in use for a week |
| **3** | **0.17 "Polish"** | No dead ends; consistent words; narrow windows work | W6, W9, W10, N8, N10, L5–L10 | 7–9 days | — |
| **4** | — | Validate with real users, then clean up | retest, metrics, remove flags | 3 days, plus the sessions | after 0.17 |

**Total: about 37–44 developer days, or 8–9 weeks with one developer.** Each phase is independently releasable and valuable on its own. If time runs out after Phase 1, most of the confusion is already gone.

---

## 3. Shared foundations (built in Phase 1, used by everything after)

These five small modules carry most of the plan, so they come first, with unit tests.

### 3.1 Role store: `state/role.ts` (new)

**Problem it solves (W2):** today a teacher sees the student layout until two network checks finish, and the role is never remembered.

```ts
export type Role = "unknown" | "student" | "teacher" | "both";
export const useRole = create<{ role: Role; resolved: boolean }>(…);
```

- **Inputs:** the existing `useAssignments.staff` (teaching scope 200/403) and the grading `grader` flag. `both` means a teacher who also has student assignments (common for the test account, rare in reality).
- **Cache:** the last resolved role is saved in the platform store under `role.<accountId>`, so the **next launch starts in the right layout instantly** and re-checks in the background.
- **While unknown on a first sign-in:** Home and the activity bar show a neutral "Checking your classes…" skeleton, never the student layout.
- **Consumers:** `ActivityBar.tsx` (view order and labels), `WelcomePage`/Home, `studentHome.ts` (the first-sign-in reveal), the account menu, side-bar titles, empty states.
- **Tests:** a table of (staff, grader, cached) → role; the cached role is used at startup and corrected when the network answers.

### 3.2 One student status: `projects/status.ts` (new)

**Problem it solves (W4):** the brief header follows `my.state` while the next-step card and the side-bar stepper follow `project.status`, so they can disagree.

```ts
export type StudentStatus =
  | "not_started" | "in_progress" | "submitted" | "returned" | "graded" | "closed";
export interface StatusView {
  status: StudentStatus;
  syncing: boolean;          // the two sources disagree for a moment → show "Updating…"
  primary: Action | null;    // the ONE button for this state
  secondary: Action[];       // shown in the "…" menu only
  headline: string;          // "You're working on it", "Returned by your teacher", …
}
export function deriveStatus(a: AssignmentSummary, p: Project | null, sync: SyncState): StatusView;
```

- **Precedence:** `closed` > `graded` > `returned` > `submitted` > `in_progress` > `not_started`. The assignment payload (`my.*`) is authoritative for grading and return. The project is authoritative for local work.
- **Conflicts:** if `my.state === "graded"` but the project still says submitted (the refresh hasn't caught up), return `graded` with `syncing: true`, and quietly refresh the project.
- **Moves into it:** the existing `studentStatus()` (`assignments.ts:472`), `returnedForChanges`, `acceptsSubmissions`, and the next-step logic now inside `AssignmentEditor.tsx:263-353`.
- **Consumers:** the brief header and next-step card, the side-bar This Folder line, the row chip, the stepper (which gains a **Returned** step), the status bar item, and Home.
- **Tests:** a full table over every combination of `my.state` × project status × `returned_at` × `accepts_submissions` × sync state. This is the single most valuable test in the plan.

### 3.3 Notification policy: extend `notify()` in `state/store.ts`

**Problem it solves (N1, N3, N4, N7):** today every info toast dies after 6 s, the timer doesn't pause on hover, Do Not Disturb hides exam warnings, and repeated warnings stack.

The API stays **backwards compatible**. Today's `notify(severity, message, actions)` keeps working, with an optional 4th argument:

```ts
notify("info", "Submitted "Build a to-do list". Your teacher sees exactly this version.", actions, {
  kind: "result",            // "result" | "external" | "progress" | "failure" | "hint"
  important: true,           // stays until dismissed
  replaceKey: "exam-time",   // a new toast with the same key replaces the old one
  undo: () => restore(),     // adds an Undo button, lasting 10 s
  details: rawError,         // shown behind a "Details" link, never in the main text
  bypassDnd: true,           // exams, teacher messages, returned work
});
```

**Rules, enforced in one place:**

| Kind | Default lifetime | DND | Goes to the centre | Example |
|---|---|---|---|---|
| `hint` | 6 s, paused on hover | hidden | no | "Copied path" |
| `result` | 8 s, paused on hover; **until dismissed if `important`** | hidden unless important | yes | "Submitted…", "Returned to Chloe" |
| `external` | until read | shown in the centre with an unread badge; the toast is hidden in DND unless `bypassDnd` | yes, unread | "New assignment", "Graded 17/20", "Returned for changes" |
| `failure` | until dismissed | shown | yes | "Saving to Task Mentor failed" |
| `progress` | until it finishes | shown | no | "Downloading the update 42%" |

- **Hover pause:** add `onMouseEnter`/`onMouseLeave` to `Overlays.tsx` toasts. Timers live in a small `toastTimers` map, not in bare `setTimeout`.
- **DND exceptions:** `bypassDnd` is **forced on** for anything raised by `exam/*` and for teacher messages, whatever the caller passes.
- **Migration:** all ~250 existing calls keep working. Phase 1 updates only the ~25 calls listed in the Phase 1 tasks. The rest stay plain `hint`/`result` and are revisited in Phase 2 (N4).
- **Tests:** unit tests for lifetimes, `replaceKey`, DND filtering and the exam override; e2e for hover pause and an important toast surviving 10 s.

### 3.4 Message catalogue: `messages/catalog.ts` (Phase 2)

**Problem it solves (N5, N6, L9):** technical text, wrong view names, and seven names for "sign in".

- Every user-facing string the plan touches moves to `catalog.ts` with an id, the text, and an optional `details` slot for technical information: `msg("submit.done", { title })`.
- **Glossary** (enforced by a unit test that scans `catalog.ts` and the workbench `.tsx` files for banned words):

| Use | Never |
|---|---|
| Start, Continue | Open My Project, Continue in TMCode, (Continue) |
| Save to Task Mentor | Save online, upload, sync |
| Submit | Hand in (as a button), Submit Project |
| Withdraw to Edit | Withdraw Submission |
| In progress | Working |
| Returned, Graded, Closed | Locked until graded, Completed (read-only) |
| All My Projects (students) | Task Mentor Projects view (in student-facing text) |
| Sign in | Sign in with NGA (Central MIS + Task Mentor), Sign in again |

- **Bonus:** the catalogue is what later Kinyarwanda and French translations need, so the cost is paid once.

### 3.5 Home editor: evolve `parts/editor/WelcomePage.tsx` into Home

**Problem it solves (W1, W2):** there is no starting point.

- Same editor kind (`welcome`), renamed **Home** in the UI. VS Code calls it Welcome; TMCode users need "Home". Keep the id so existing tabs and commands work.
- **New setting `workbench.startupEditor`** (VS Code's own key):
  - `"home"`: the default for practice mode.
  - `"none"`: today's behaviour.
  - `"homeIfNoFolder"`
  - Exams never show Home.
- Home is **role-aware** (§3.1) and reads only data TMCode already loads: the assignments list, quiz practicals, the grading roster counts and Recent.

---

## 4. Phase 0: baseline and safety net (3 days)

Nothing user-visible ships here, but without it we can't prove the later phases worked or avoid breaking things.

| # | Task | Details | Done when |
|---|---|---|---|
| 0.1 | **Golden journey tests** | Turn this review's walk-throughs into permanent e2e specs: `e2e/journey-student.spec.ts` (launch → start → save → submit → returned → graded) and `e2e/journey-teacher.spec.ts` (launch → grade → draft → release → return). Assert today's behaviour, then update the assertions in each phase. They save screenshots to `test-results/journeys/` for visual review. | Both pass on Chromium and WebKit |
| 0.2 | **Fix the test server's state model** | `platform/memoryProjects.ts`: `returnForChanges()` sets the project to draft or in progress, and `grade()` sets the project to graded, as the real server does. Today the test server keeps "submitted", which hid the real W4 bug behind a fake one. | The journey shows the real states |
| 0.3 | **Click and time counter (dev only)** | A dev-only `__TMCODE_DEBUG__.journey` that counts clicks and elapsed time between named milestones (`home-shown`, `first-start`, `submitted`, `first-student-open`). It's used by e2e and in usability sessions. Nothing is sent anywhere. | The numbers print at the end of each journey test |
| 0.4 | **Baseline usability session** | 3 students and 1 teacher, with tasks from the gap analysis. Record success, time, clicks and quotes. Takes 1 hour with the school. | A baseline table in `docs/reviews/…/baseline.md` |
| 0.5 | **CI WebKit consistency** (left over from 0.14) | In `playwright.config.ts`, give the WebKit project a user agent that matches the host OS when running on Linux CI. This removes the 6 false WebKit failures, so CI can gate releases. | CI green on a PR |

---

## 5. Phase 1 = 0.15 "Start here" (11–13 days)

### 5.1 Role store and instant role layout (W2): 1.5 days
- Build `state/role.ts` (§3.1) and wire it into `ActivityBar.tsx:64-67`, `SideBar.tsx` titles, and the account menu (add a **Grading** item for teachers).
- `studentHome.ts:58-65`: the first-sign-in reveal opens **Grading** for teachers and **Assignments** for students, and waits for the role, with a timeout of 4 s before falling back to Home.
- **Acceptance:**
  - A teacher who signed in before sees Grading in the activity bar on the first frame (cached role).
  - A first-time teacher sees "Checking your classes…", then the teacher layout, and never the student "All My Projects" title.
  - A student sees the same as today.

### 5.2 Home on every start (W1, W2): 4 days

**Startup** (`state/store.ts:307-312`, `initWorkbench`):
- In practice mode with `workbench.startupEditor === "home"`, open Home **as the active tab**, even when the last folder reopens. The folder still opens in the Explorer, and its restored tabs sit behind Home.
- Restore `activeView` from the saved layout. On a first run, start the side bar on Assignments (student) or Grading (teacher), not the Explorer.

**Student Home sections, in order:**
1. **Signed out:** one card, "Sign in to see your assignments" [Sign in].
2. **Next up:** one assignment chosen by `nextUp()`: returned first, then the open folder's assignment if in progress, then the soonest-due to-do. It shows the title, course, due date, `StatusView.headline` and the **one** primary button: Continue / Start / Open feedback.
3. A row of small counters, each opening Assignments filtered to that group: **Returned (n) · To do (n) · Graded recently (n)**.
4. **Practise on your own:** Open Folder · New Project from Template · Recent (up to 5).
5. Footer links: Check my computer · Keyboard shortcuts. The exam card turns into a one-line link, "Taking an exam? Open it from Task Mentor."

**Teacher Home:**
1. **To grade:** "3 submissions in 2 practicals · 1 draft not released" with [Start grading →], which opens the **first** waiting submission across all practicals (implemented in 6.4; until then it opens the Grading view).
2. A short practicals list with counts, each clickable.
3. Links: Your classes' assignments · Create in Task Mentor.

**Explorer empty state:** replace "Exams and assigned tasks open here…" with "Your assignments are in **Assignments** [Open Assignments]".

**`nextUp()`** lives in `projects/studentHome.ts`, as a pure function with table tests.

**Acceptance:**
- A returning student launches TMCode, sees Home, and starts or continues their next assignment in **1 click**.
- A teacher reaches grading in 1 click.
- `workbench.startupEditor: "none"` restores today's behaviour.
- Exams never show Home.

### 5.3 One status everywhere (W4): 3 days
- Build `projects/status.ts` (§3.2), then refactor the consumers:
  - `AssignmentEditor.tsx`: the next-step card renders only `StatusView`. For **graded**, the result card becomes the next-step card at the top (score, feedback, rubric, line comments), which also fixes L8. For **returned**, the card shows the teacher's message plus [Continue working].
  - `ProjectsView.tsx` AssessmentCard, `AssignmentsView.tsx` row chip, `StatusBar.tsx` project item: all read `StatusView`.
  - The stepper gains **Returned**: In progress → Submitted → (Returned →) Graded.
- When `syncing` is true, show a subtle "Updating…" line instead of two statuses, and trigger `refreshProjects({ quiet: true })` once.
- **Acceptance:** the journey test's returned and graded screens show one consistent status in the header, card, side bar, row and status bar (asserted in e2e). The table tests cover every combination.

### 5.4 Notification policy (N1, N3, N7): 2 days
- Implement §3.3 in `state/store.ts`, `widgets/Overlays.tsx` (hover pause, Details link, Undo button) and `state/notificationCenter.ts` (DND exceptions, unread count of `external` items).
- Update these calls in Phase 1:

| Call | Change |
|---|---|
| Submit done (`submitFlow.ts:121`, `assignments.ts:367`, `matching.ts:248`) | `result`, important |
| Return done (`grading/service.ts:404`) | `result`, important |
| Release done (`service.ts:359-391`) | `result`, important |
| Workspace ready (`assignments.ts:264`) | `result` (8 s, hover pause) |
| Exam time extended (`exam/session.ts:589`) | `external`, important, bypassDnd |
| Exam 10/5/1 min left (`session.ts:604-609`) | `replaceKey: "exam-time"`, bypassDnd |
| Exam recovery notes (`session.ts:384-409`) | `result`, important, bypassDnd |
| Teacher message (`session.ts:592`) | `external`, bypassDnd |
| Update downloading (`update/updateService.ts:95`) | real `notifyProgress` with % |
| New assignment / graded (`assignments.ts:161,167`) | `external` |

- **Acceptance:**
  - The submit confirmation is still visible after 10 s.
  - Hovering pauses any toast.
  - With DND on during an exam, "5 minutes left" still appears.
  - Only one time warning is visible at a time.

### 5.5 Notices for silent events (N2): 1.5 days

| Event | New feedback |
|---|---|
| **Returned for changes** (refresh diff in `assignments.ts`, next to the graded notice) | `external`, bypassDnd: "Your teacher returned *Build a to-do list*: 'Add a delete button…'" [Open] |
| **First auto-save failure** (`projects/service.ts:1024-1038`) | Sync line in warning colour at once. A `failure` toast only if the brief isn't visible; otherwise the inline line is enough. |
| **Move to Trash** (`state/store.ts:784`) | `hint`: "Moved main.py to the Trash" [Undo]. Undo restores from the Local History snapshot that already exists (`snapshotBeforeDelete`). |
| **File import** (`importFiles.ts:40`) | `hint`: "Copied 3 files into web/" |
| **Git push/pull/commit success** (`gitService.ts`) | `hint`: "Pushed to origin/main" / "Committed 2 files" |
| **Line comment deleted** (`grading/comments.ts:61-80`) | `hint` [Undo] |
| **Exam sync failure** (`exam/session.ts:569`) | One `failure`: "Saving to Task Mentor failed. Your work is safe on this computer." Repeats are suppressed with a `replaceKey`. |

**Acceptance:** each row has an e2e or unit test, and the student journey test asserts the returned notice.

### 5.6 Rename bug (N9): 0.5 day
- `state/store.ts:639`: clear `explorerEdit` **after** a successful `moveEntry`, so failures reach `setExplorerEditError`.
- **Test:** renaming to an existing name shows the inline error and keeps the input open.

### 5.7 Release 0.15 (1 day)
- Run the journeys on Chromium and WebKit, the full suites and CI (with the Windows check).
- Release notes in plain words ("TMCode now opens on Home: your next assignment or what to grade, one click away").
- A short **"What's new" card on Home** for one week (dismissable), linking to the notes.

---

## 6. Phase 2 = 0.16 "One way to do it" (13–16 days)

Two tracks that touch different files, so two developers can run them in parallel.

### Track A: students (7–8 days)

#### 6.1 One primary action per screen (W3, L1, L2): 3 days
- **Side-bar "This Folder" card** (`ProjectsView.tsx` `ThisFolder`, reused in `AssignmentsView.tsx:370`): collapses to **one line** for students, `● In progress · Saved online 2 min ago · Open brief`. No Save or Submit buttons. The stepper moves into the brief.
- **Live-status switch:** moves to the card's "…" menu and Settings. Assignment workspaces keep it locked on, as today, with the explanation in the tooltip.
- **Brief** keeps the only Save to Task Mentor and Submit buttons, driven by `StatusView.primary`.
- **Row buttons in Assignments:** unchanged from 0.11 (quiet, shown on hover).
- **Acceptance:** at every journey step, at most one visible Submit and one visible Save button (an e2e counts them). On a 680 px tall window, 6 or more assignment rows are visible.

#### 6.2 Resume the action after sign-in (W5): 1 day
- `projects/service.ts:183-197` `requireSignIn(pending)` stores the pending action and runs it once `account.signed_in` becomes true, with a `result` toast: "Signed in. Opening Build a to-do list…". It's dropped after 5 minutes.

#### 6.3 Quiz practicals get the same brief (W7): 3 days
- Extend the brief editor input with `{ kind: "assignment", source: "quiz", quizId, questionId }`. It renders the question text (from the payload already loaded), the quiz state chip and the same `StatusView` card.
- The **first step** in the card is "Open the quiz in Task Mentor" [Open Quiz], until `attempt_open` is true.
- Submit uses the shared `submitFlow`; the user no longer goes through All My Projects.
- **Acceptance:** a quiz practical goes from row → brief → start → submit without leaving Assignments.

#### 6.4 Copy pass for students (N5, N6): 1 day (with Track C)

### Track B: teachers and grading (6–8 days)

#### 6.5 Grading opens the first student (W8): 1 day
- `grading/service.ts` `openGrading(key)`: if there's waiting work, open the first "to grade" student directly. Otherwise show the roster with an empty-state action (6.9).
- Home's [Start grading] opens the first waiting submission across all practicals (oldest submission first).
- **Acceptance:** Home → first student's code and grade panel in 1 click.

#### 6.6 Grading layout (L3, L4): 4 days
- **Review focus:** while a review folder is open, the grading side bar collapses automatically (the setting `grading.focusWhileReviewing`, default true). A slim student switcher stays in the panel header (‹ Ben Learner 1 of 2 ›), so the code gets the width.
- **Panel order:**
  1. header (student, status chip, version, submitted at)
  2. score summary
  3. **Criteria**
  4. **Feedback**
  5. **Line comments**
  6. Files and changes (collapsed)
  7. Return for changes, moved into "More actions ▾" with Preview, Open on GitHub and Compare
- **Sticky footer:** one primary split button, **Save & Next ▾**, with Save Draft / Save & Release / Save (stay) in its menu. The last choice is remembered per teacher. The "score every criterion" hint moves to the first unscored criterion (inline red outline plus text). The keyboard icon becomes "Shortcuts" in the "…" menu.
- **Progress shown once:** remove the second and third progress displays in `GradingEditor.tsx` (header bar and stats line) and keep one compact header line, "2 to grade · 0 graded · 1 in progress". The side bar keeps its summary only when the panel isn't open.
- **Acceptance:**
  - At 1360×820 the Feedback box is visible without scrolling, for a rubric of 3 or fewer criteria.
  - There is one primary button.
  - The keyboard flow (⌘Enter Save & Next) is unchanged.

#### 6.7 Teacher notification tidy-up (N4): 1 day
- Grade save: keep the inline footer status and **remove the toast** when the panel is visible. Keep the toast only for release, release-all and return.

### Track C: shared (2–3 days, alongside A and B)

#### 6.8 Message catalogue and glossary (N5, N6, L9): 2 days
- Create `messages/catalog.ts` (§3.4). Move the ~60 most-seen messages:
  - submit, save, sync, start, return, release, sign-in, errors from `api()`;
  - Projects view names, replaced by "All My Projects" for students;
  - the menu paths, replaced by action buttons (e.g. "Show Conflicts" opens the brief's conflicts section for assignment workspaces).
- `api()` errors (`projects/service.ts:96`): "Task Mentor answered 500." becomes "Task Mentor had a problem. Try again in a minute." with [Details], which shows the status code and request id.
- Release-drafts skip reasons become catalogue entries, not server codes with underscores removed.
- Glossary unit test (§3.4).

#### 6.9 Release 0.16 (1 day), then the second usability session (½ day plus the session).

---

## 7. Phase 3 = 0.17 "Polish" (7–9 days)

| # | Item (gap) | Implementation | Days |
|---|---|---|---|
| 7.1 | **Dead ends** (W6) | Give every empty state one action. Grading "no practicals" gets [Create in Task Mentor]. "Nothing to grade" gets [Show All Students]. Grade panel "Still working" gets [See their live status] (opens the presence detail) or [Open in Task Mentor]. The Explorer empty state is done in 5.2. | 1 |
| 7.2 | **Recognition over recall** (W9) | Remove menu paths from messages (covered by the catalogue). Recent is on Home. Close Review becomes a visible button in the review banner. | 0.5 |
| 7.3 | **Teacher Assignments** (W10) | For staff, Teaching comes first, and each teaching row gets an inline "Grade (2)" button that opens 6.5. | 1 |
| 7.4 | **Notification centre** (N8) | 30 days of history in the platform store (capped at 200 entries). An unread count on the bell. Actions kept while valid (each action gets a `validUntil` check, e.g. "View Feedback" stays). "Mark all as read". | 2 |
| 7.5 | **Severity fixes** (N10) | Sign Out dialog → warning severity. Audit the remaining dialogs for severity. | 0.25 |
| 7.6 | **Clipped labels** (L5) | Grading filter chips wrap. The sync label becomes icon-only below 260 px with a tooltip. Course names get a tooltip. | 0.5 |
| 7.7 | **Title bar overflow** (L6) | When the menus don't fit, collapse them into a "…" menu (VS Code's behaviour), so Help and Check My Computer stay reachable at 1100 px. | 1 |
| 7.8 | **Student noise** (L7) | Hide the Source Control view and badge in **assignment workspaces** unless the teacher's starter has a `.git` folder (setting `scm.showInAssignments`). Remove the Projects "↑" badge for students (the brief shows sync). Show the Live Preview status item only for HTML files or web projects. | 1 |
| 7.9 | **Activity bar for newcomers** (L10) | Order for students: Assignments, Explorer, Search, Run, Testing, …; for teachers: Grading, Assignments, Explorer, …. A one-time coach mark on the Assignments or Grading icon ("Your assignments live here"), dismissable and never shown again. | 1 |
| 7.10 | **Release 0.17** | Full suites, journeys, CI, notes. | 0.5 |

---

## 8. Phase 4: validation and clean-up (3 days plus the sessions)

1. **Usability retest:** the same 3–5 students and 1–3 teachers and the same tasks as the baseline (0.4). Compare with §10.
2. **Fix round:** budget 2 days for what the retest finds. There will be something.
3. **Remove temporary flags:** keep `workbench.startupEditor` and `grading.focusWhileReviewing` as real settings. Delete any rollout-only flags.
4. **Update the docs:** release notes, a one-page "Getting started with TMCode" for students and one for teachers (screenshots from the journey tests), and the memory/plan notes.

---

## 9. Testing strategy

| Layer | What | Where |
|---|---|---|
| **Unit (pure logic)** | `deriveStatus` (all combinations), `nextUp`, role resolution, notification lifetimes/DND/replaceKey, glossary scan, catalogue completeness | `projects/status.test.ts`, `projects/studentHome.test.ts`, `state/role.test.ts`, `state/notifications.test.ts`, `messages/catalog.test.ts` |
| **Golden journeys (e2e)** | Student and teacher end to end, with click and time counters and screenshots; the main regression guard for this plan | `e2e/journey-student.spec.ts`, `e2e/journey-teacher.spec.ts` |
| **Feature e2e** | One spec per phase: `e2e/start-here.spec.ts` (0.15), `e2e/one-way.spec.ts` (0.16), `e2e/polish.spec.ts` (0.17) | Chromium + WebKit |
| **Visual check** | Journey screenshots reviewed by a person at each release; no pixel diffing (too brittle with fonts) | `test-results/journeys/` |
| **Existing suites** | All current e2e, vitest and Rust tests must stay green; update assertions only where the plan intentionally changes behaviour, and say so in the commit | — |
| **Real app** | Before each release, a 15-minute manual run of both journeys in the installed desktop app against the real Task Mentor (staging account) | checklist in each release's notes |

**Test-writing rule learned in 0.14:** seed browser storage with `addInitScript` (with a once-per-test flag), never "load the page, write storage, reload", because startup saves can overwrite the seed.

---

## 10. Success measures

| Measure | Baseline (0.4) | Target after 0.15 | Target after 0.17 |
|---|---|---|---|
| Students who start their next assignment without help | to measure | 5 / 5 | 5 / 5 |
| Clicks from launch to working on the next assignment | 3–5, with discovery | **1** | 1 |
| Teachers who reach the first submission without help | to measure | 3 / 3 | 3 / 3 |
| Clicks from launch to grading the first student | 4+ | 2 | **1** |
| Screens with two different statuses (journey test) | 2 of 8 | **0** | 0 |
| Important events with no notice or a disappearing one | 9 | **0** | 0 |
| Visible duplicate primary buttons (journey test) | 2 per screen | 2 | **0** |
| Technical messages shown to users | 6+ kinds | 6 | **0** (Details only) |
| Time to grade 5 submissions (teacher task) | to measure | — | −30% |
| "I knew what to do next" (1–5, after the task) | to measure | ≥ 4 | ≥ 4.5 |

---

## 11. Risks and how we handle them

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Home annoys experienced users** who just want their folder | Medium | Home opens as a tab, so the restored editors are one click away. The setting `workbench.startupEditor: "none"` turns it off. "Continue working" opens the last folder's files directly. |
| **The role is cached wrongly** (a teacher who is also a student, or a role change) | Low | `both` role supported. The cache is only a first-frame hint; the network result always wins within seconds. A role change shows a one-time toast: "Your layout changed to teacher." |
| **`deriveStatus` precedence wrong** in a real server state we didn't foresee | Medium | Exhaustive table tests. `syncing` → "Updating…" rather than guessing. The real-app checklist before each release uses a staging account in each state. |
| **The notification change makes toasts pile up** (important ones stay) | Medium | Important toasts are few by design (submit, return, release, exam). `replaceKey` collapses repeats. The centre holds the rest. Cap visible toasts at 3, with a "+2 more" link to the centre. |
| **Grading layout change slows expert teachers** | Low–medium | The keyboard flow is unchanged. The split button remembers the last choice. The focus mode is a setting. Test with the 3 teachers before release. |
| **Scope creep** (each screen invites redesign) | High | Only the listed gap items, each with an acceptance line. Anything else goes to a "later" list in this file. |
| **WebKit/Linux CI noise** hides real failures | Medium | Fixed in Phase 0 (0.5) before any UI work. |
| **Older Task Mentor servers** lack fields (`returned_at`, drafts) | Low | `deriveStatus` and Home degrade: no Returned without `returned_at`; no draft counts without drafts. Covered by existing "older server" mock modes. |

---

## 12. Files touched, by phase (for code review planning)

| Phase | New files | Main edits |
|---|---|---|
| 0 | `e2e/journey-student.spec.ts`, `e2e/journey-teacher.spec.ts` | `platform/memoryProjects.ts`, `apps/desktop/playwright.config.ts` |
| 1 | `state/role.ts`, `projects/status.ts`, tests | `state/store.ts` (notify, startup, activeView restore), `widgets/Overlays.tsx`, `state/notificationCenter.ts`, `parts/editor/WelcomePage.tsx` (→ Home), `parts/ActivityBar.tsx`, `parts/SideBar.tsx`, `projects/studentHome.ts`, `projects/AssignmentEditor.tsx`, `projects/AssignmentsView.tsx`, `projects/ProjectsView.tsx`, `parts/StatusBar.tsx`, `projects/assignments.ts`, `projects/service.ts`, `exam/session.ts`, `update/updateService.ts`, `grading/comments.ts`, `scm/gitService.ts`, `parts/explorer/importFiles.ts`, `parts/explorer/ExplorerView.tsx` |
| 2 | `messages/catalog.ts`, `messages/glossary.test.ts` | `projects/ProjectsView.tsx` (ThisFolder), `projects/AssignmentEditor.tsx` (quiz brief), `projects/matching.ts`, `projects/submitFlow.ts`, `grading/GradingEditor.tsx`, `grading/GradingView.tsx`, `grading/service.ts`, `projects/service.ts` (`api()` errors, `requireSignIn`) |
| 3 | — | `widgets/NotificationCenter.tsx`, `parts/TitleBar.tsx`, `parts/ActivityBar.tsx`, `scm/*` (visibility), `parts/StatusBar.tsx`, empty states in Assignments/Grading/Projects |

---

## 13. Definition of done (every item)

- [ ] The acceptance line in this plan is met and covered by a test.
- [ ] Works on Chromium and WebKit e2e and in the installed desktop app (manual checklist).
- [ ] Copy follows the glossary; there is no technical text in the main message.
- [ ] Keyboard reachable, labelled for screen readers (`aria-label`, `role=status`/`alert` as appropriate), visible focus.
- [ ] Theme-correct in dark, light and high contrast (CSS variables only; braces balanced in `workbench.css`).
- [ ] No behaviour change in exam mode unless the item says so.
- [ ] Release notes line written in user words.
