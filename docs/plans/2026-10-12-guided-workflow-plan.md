# Implementation plan: a calm, guided TMCode

**Merges:** the plan in [end-user walkthrough](../reviews/2026-10-12-end-user-walkthrough/README.md) (U1–U13, T1–T10) and the plan in [simplify and centralize](../reviews/2026-10-12-simplify-and-centralize/README.md).
**Starts from:** TMCode 0.15.0. **Delivers:** one release after every phase is done and tested.

## Rules every change follows

1. **One home per action, one label, one function.** Other doors are palette commands with the same words, never a second button.
2. **The screen guides:** the main button for the current step is always visible, and Run says what it will run and why.
3. **Calm:** at most two messages on screen; a message goes once the screen shows the same thing.
4. **One saving story; one Run; one Test; one number for each question.**

## Phases

| # | Phase | Gaps | Main changes |
|---|---|---|---|
| A | **Calm messages** | U1, U11, U13, T9 | Messages have an owner (`assignment:<id>`, `account`, `grading:<key>`); a new one from the same owner replaces the old. When the owner's state is on screen (brief or grade panel visible), the message goes to the centre instead of a toast. At most 2 toasts, over the code column. Sign-in messages replace each other. The centre groups by owner: newest state wins, stale buttons drop. |
| B | **One Run** | simplify §2.3 | `resolveRun()` (pin per project folder → exam/assignment task → the file's own project, run-like tasks included → the file → the only project) with a reason. Status bar, editor ▶, F5, Ctrl+F5, Run File, Run Again, Run with Arguments all use it. F5 = Run (Debug is a menu choice, or F5 with breakpoints). One Stop. A first line in the Run panel says what runs and why. `.js` previews a page only if that page loads it; `prompt-sync` = input; PHP/Ruby/Kotlin/C#/Dart/SQL/logic known to every door. |
| C | **One saving story** | U2 | In assignment workspaces, saving a file saves to Task Mentor a few seconds later (not 30 s). The brief's line counts unsaved editors at once ("Saving…"). The status bar's disk "Auto Save" item is hidden there. "Save to Task Mentor" becomes **Try Again**, shown only after a failure. |
| D | **Work mode** | U3, U4, U5, U8, T4 | Opening a brief beside code folds the side bar below 1200 px. The brief has a sticky footer with the status and the one main button. One brief slot (the brief tab is reused). Home always opens full width in the first group. A brief for another assignment says "You're working on X" with Continue. Previews and Run output never take the brief's place. The student list in grading opens as a dropdown over the panel. |
| E | **Build fixes + preflight** | simplify §2.2 | C/C++ compile the entry's folder only, and only the entry when several files define `main`. Java compiles the entry's folder and runs `package.Class`. Go builds the entry's package. Kotlin's jar goes to the build folder. Tool detection for every language TMCode runs; `preflight()` before any run shows one install card (How to install, Check again, Run on Task Mentor in exams). Check My Computer lists every language. |
| F | **One Test** | simplify §2.3 | `resolveTest()` (exam/sample tests → test file → project framework → sample tests of the Run target, or **Add an example**). A Test button beside Run with a passed/total badge. Real `unittest`, one suite per folder, the selected interpreter, `node --test` without package.json. |
| G | **The first minute** | U6, U7 | Starter templates only for the assignment's language. An empty assignment workspace shows "Create your first file". Submit stays disabled ("Nothing to hand in yet") until the project has a file. Next up says why ("Late", "Returned", "Due soonest"). |
| H | **One home per action** | simplify Part 1 | Students: All My Projects becomes "Other projects" inside Assignments. One `submit()`, one `openInTaskMentor()`. Start/Continue/Sign in/Open everywhere. Same row behaviour (click/Space = brief, double-click/Enter = start). Palette commands Show Brief, Start/Continue, Start Grading, Return for Changes. Dead code removed. |
| I | **One number + teacher flow** | simplify §1.2, T1–T3, T5–T8 | `studentTasks()` (quiz practicals included) feeds the badge, Home, Assignments. `gradingQueue()` feeds every teacher count. Teacher brief's main button is **Grade (n)**; starter files in "…". Grading order = oldest hand-in, counter "1 of n to grade". Close Review also closes the grading tab. Teachers don't see the student quiz list. Reviews open the code file, not README. "No submissions yet" instead of "Done"; neutral due dates for teachers. |
| J | **Simple student screen** | U9, U10, U12, T10 | A student layout by default: Assignments, Files, Search, Run (Testing, Source Control, Extensions, Projects under a "More" setting). A simple status bar for students. Two-line rows. The coach mark sits beside the icon, over the editor. |

## Testing (after all phases)

- Unit tables: `resolveRun`, `resolveTest`, message owners/retire rules, `studentTasks`/`gradingQueue` counts, runner source selection (Rust).
- e2e: `e2e/guided.spec.ts` for the new behaviour, the golden journeys extended (at each step: ≤ 2 toasts, one main button visible at 1280×720 **and** 900×640, Run label = the file's target), then the full Chromium and WebKit suites.
