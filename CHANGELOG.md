# Changelog

## 0.10.4 — 2026-10-09

**TMCode 0.10.4: colours that mean something, and a tidier layout.**

### The selected assignment looks like VS Code
- **The selected row uses your theme's list selection**, like the Explorer: grey when the side bar isn't focused, the theme's selection colour when it is. Light, dark and high-contrast themes each get their own; the old navy tint and side bar are gone.
- **"Open here" is a badge** in your theme's badge colour, so it reads as a label, not a second highlight.

### One meaning per colour
- **Red** is only for errors: failed saves, sync errors, test errors, grading errors.
- **Orange** is for things that need your attention: unsaved local changes, conflicts, late work, due soon.
- **Blue** is for information: changes waiting on Task Mentor, submitted work, "starting…/building…", read-only banners, reviewing a student's work.
- **Green** is for success: graded work and tests that passed.
- **Grey** is neutral: in progress, completed or read-only.

### Alignment and grouping
- **Brief header:** the assignment's state comes first in the facts row (state, due, points, language), with even spacing around the next-step card.
- **Grading:** criterion scores line up in one column whatever the maximum (`/ 8` or `/ 12`). The "Reviewing …" card shows the icon and the student on one line, with **Back to my folder** under them.
- **Projects:** status filters wrap onto a second line, so no chip is cut off.

### All changes

- Status colours by meaning, VS Code list selection, alignment fixes

## 0.10.3 — 2026-10-09

**TMCode 0.10.3: from an assignment straight into its project.**

### Opening an assignment offers its project
- **Every brief starts with the next step:**
  - **Not started:** **Start this assignment** explains that TMCode creates your own project (with your teacher's starter files) and opens it here, with the brief beside your code. Press Enter, or click **Start Assignment**.
  - **Started, but not open:** **Continue your work** offers **Open My Project**.
  - **Open here:** **You're working on it in this window**, with **Save** and **Submit**.
- **Each row in Assignments shows its action:** **Start** for a new one, **Open** for one you started, **Open here** for the one in this window. Double-click a row to go straight in.
- **Opening an assignment's project from anywhere** (Assignments, Projects, Start) shows its brief beside the code, in a single tab.

### No more empty folders
- **Starters for empty projects:** when a teacher gave no starter files, TMCode asks how you want to begin. Pick starter files for the assignment's language, or start with an empty project. Your choice is saved to Task Mentor straight away.
- **The first file opens beside the brief:** after Start, the starter file (`index.html`, `main.py` …) opens for coding, with the brief to the right.

### All changes

- From an assignment straight into its project

## 0.10.2 — 2026-10-09

**TMCode 0.10.2: everything follows your colour theme, assignment images show, and loading shows at once.**

### Fixed
- **The editor's right-click menu** had no background, so its items were drawn over your code. It now uses your theme's menu colours, with a border, rounded corners and a shadow, in light, dark and high-contrast themes.
- **Assignment briefs** written in Task Mentor kept the rich editor's own look: black text, white backgrounds and Times New Roman, which made them unreadable in dark themes. Briefs now use your theme's colours and fonts and keep their structure (headings, lists, bold, alignment).
- **Images in briefs** showed as empty boxes. Images uploaded in Task Mentor now display. An image from another website shows as an **Open image** link.
- **Suggestions, hovers and find in the editor** get proper borders, rounded corners and shadows.

### Loading shows at once
- **Instant feedback:** as soon as TMCode starts talking to Task Mentor, a thin line runs under the title bar and the status bar says what's happening ("Saving to Task Mentor…", "Opening the student's project…"). This covers saving, getting the latest, starting and submitting work, opening a project or a student's submission, and saving a grade.
- **Save reacts on click:** **Save** now shows "Saving…" the moment you click it. Before, nothing showed until TMCode had compared every file with Task Mentor.

### Clearer assignment lists
- **The assignment you're working on stands out:** its row has an accent bar and an **Open here** label.
- **The assignment whose brief is on screen is selected,** like the open file in the Explorer.
- **Status on its own line:** "In progress" moved to the row's second line, so titles aren't cut off.
- **Projects and Grading** highlight the open project and the practical being graded the same way.
- **High-contrast themes** outline badges, labels and highlighted rows.

### All changes

- Fix hook order: useActivity before the early returns in ThisFolder and the assignment page
- Loading shows the instant work starts
- Theme harmony: themed editor menus, Task Mentor briefs in the theme with their images, clear assignment highlight

## 0.10.1 — 2026-10-09

**TMCode 0.10.1: assignments from Task Mentor show up in TMCode.**

### Fixed
- **Assignments you're enrolled in now appear.** TMCode didn't pass your Central MIS sign-in to most Task Mentor requests. Without it, Task Mentor couldn't tell which subjects you study or teach, so:
  - the Assignments view stayed empty;
  - opening an assignment said "You aren't enrolled in this assignment's course", even though Task Mentor's website showed it;
  - teachers' grading lists were limited to assignments they created themselves.

  TMCode now sends it with every Task Mentor request.
- **Errors aren't hidden any more:** if Task Mentor can't be reached or refuses a request, the Assignments view says so, instead of looking empty.

Also needed: Task Mentor treats an assignment whose submission type is **TMCode** as a TMCode practical, even when its "TMCode practical" section was left off (a Task Mentor update, deployed with this release).

### Assignments view
- **It explains an empty list:**
  - Students learn what will appear (with a Start button and the teacher's starter files) and get **Refresh** and **Open Task Mentor**.
  - Teachers are told to choose **TMCode** as the way students hand it in, with a **Create in Task Mentor** button.
  - It shows who is signed in, so using the wrong account is easy to spot.
- **Always current:** the list refreshes when you open the view and when you come back to TMCode (for example from Task Mentor, where you just published an assignment). It shows when it last checked.
- **Draft assignments are flagged:** a teacher's unpublished assignment says "Draft · students can't see it".
- **Grade from the list:** right-click a teaching assignment for **Grade Submissions**.

### All changes

- Assignments appear: send the MIS token on every Task Mentor request; clearer Assignments view

## 0.10.0 — 2026-10-09

**TMCode 0.10: assessments are simpler to manage, for students handing work in and for teachers grading it.**

### For students: what your project is for, and what to do next
- **One card for your assessment:** Projects › This Folder now shows a single card with:
  - the assignment or quiz the project is for, and when it's due;
  - a progress line, **In progress → Submitted → Graded**;
  - the one thing to do next: **Match**, **Submit**, **Withdraw to make changes**, or your grade.
- **Your grade in TMCode:** a graded assignment shows its score and your teacher's feedback right in the card.
- **Connecting is faster:** **Connect to Task Mentor** asks for the project's name, then which assessment it's for. The old one-choice step and the template list are gone.
- **One list of assessments:** search by title or subject.
  - Assessments are grouped by subject, soonest due first.
  - A quiz's TMCode practicals are listed directly; there's no more subject → kind → item → question.
  - "No assessment (a personal project)" always stays last, so Enter never picks it by accident.
  - Your current assessment is marked when you change it.
- **The same words everywhere:** Projects and Assignments both say *In progress / Submitted / Graded*, with the same colours.
- **Tidier panel:**
  - Saving is one row ("Saved online", Save, Get Latest).
  - Project names have their own line in the list.
  - Filter chips no longer wrap.
- **Fewer pop-up messages:** connecting and matching show one message, and opening a project no longer reports "Updated N files".

### For teachers: grading without scrolling
- **The form fits beside the code:** with a student's project open, the student list folds into a bar: *‹ Ben Learner · 1 of 2 · 2 to grade ›*. The scores, feedback and Save & Next fit on screen. Click the bar for the whole list.
- **Their files, one click away:** "Their project is open in the editor (read-only)", with the submitted files listed to open.
- **Full marks:** fills every criterion at once; lower what was missed. **Clear** empties the scores.
- **Save says what's missing:** "Score 1 more criterion to save", instead of a greyed-out button.
- **A finish line:** after the last submission, "All handed-in work is graded", with **Back to My Folder**.
- **Each practical says what's waiting:** "2 to grade", "All 3 graded", "No submissions yet".
- **Grade from the assignment page:** an assignment's page has **Grade Submissions**, which opens TMCode's grading tab.

### All changes

- Simpler assessments for students and teachers

## 0.9.0 — 2026-10-09

**TMCode 0.9: your project's own tests in the Testing view, and debugging for Java, Kotlin, C#, PHP, Ruby and Swift.**

### Project tests in the Testing view
- **Found automatically:** TMCode finds the test framework of the folder and its sub-folders (client/, server/, …):

  | Language | Frameworks |
  |---|---|
  | Python | pytest, Django tests |
  | JavaScript / TypeScript | Vitest, Jest, `node --test` |
  | Java, Kotlin | JUnit through Maven or Gradle |
  | Others | `go test`, `cargo test`, `dart test`, `flutter test`, PHPUnit, Laravel, RSpec, Rails (minitest), `dotnet test` (xUnit, NUnit, MSTest), `swift test` |

- **Real runs:** tests run with the project's own tools, in your login shell, so they behave as they do in your terminal. A Python project's `.venv` is used when there is one.
- **Results tree:** results are grouped by suite and by file or class, with failures first. Each test shows how long it took.
- **Failures:** click a failure to see its message and stack and to jump to its line. Failing lines are marked in the editor and listed in Problems.
- **Run one test:** use ▶ on its row, ▶ Run Test above it in the editor, or **Test: Run Test at Cursor** (⌘/Ctrl+; C).
- **More commands:** **Run Tests in Current File** (⌘/Ctrl+; F) and **Rerun Failed Tests** (⌘/Ctrl+; E).
- **Filter:** filter by name or show only failed tests. The full output is in the Output panel (Tests).
- **Missing tools:** if a framework isn't installed, the suite says so and shows the install command.
- **Practice tests:** the input/output tests in `.tmcode/tests.json` still appear below the project tests. A new project's tests now appear without reopening the folder.

### Debugging for more languages
- **Java:** F5 compiles the open file with `javac -g` and debugs it with TMCode's own Java debugger, which is built in and needs only a JDK.
  - Classes in packages work.
  - Supported: conditional breakpoints, hit counts, logpoints, exception breakpoints, variables (also editable), watches, and stepping.
  - **Java: Attach to JVM (port 5005)** debugs Spring Boot or Maven apps you start with `-agentlib:jdwp=…`.
- **Kotlin:** F5 compiles the open `.kt` file with `kotlinc` and uses the same Java debugger.
- **C# / .NET:** F5 builds the project (`dotnet build -c Debug`) and debugs it with netcoredbg. TMCode downloads netcoredbg once, after you agree, and checks it against a pinned SHA-256. There is no build for Intel Macs.
- **PHP:** F5 debugs the open file with Xdebug.
  - **PHP: Listen for Xdebug** debugs web requests (Laravel).
  - The PHP Debug adapter is downloaded once and checked the same way. PHP needs the Xdebug extension; the install card shows how to add it.
- **Ruby:** F5 debugs the open `.rb` file with rdbg, which comes with Ruby 3.1+. The program's output shows in the Debug Console.
- **Swift:** F5 in a Swift package runs `swift build`, then debugs the executable with lldb-dap.
- **launch.json:** **Add Configuration…** now lists 17 configurations.

### Fixes
- New projects from a template now show their `.tmcode/tests.json` practice tests right away.

### All changes

- Rails tests in the Testing view (minitest -v parser, -n for one test)
- Debug Kotlin, C#, PHP, Ruby and Swift; docs for 0.9
- Testing view runs project test frameworks; Java debugging

## 0.8.0 — 2026-10-08

**TMCode 0.8: many more technologies to create, run, debug, preview and test, plus built-in SQL, truth tables and an API Tester.**

### 49 project templates
**File › New Project from Template…**, also on the Welcome page, needs no Task Mentor account. Task Mentor's **New Project** uses the same catalog. Templates are grouped by category:

| Category | Templates |
|---|---|
| Websites | HTML/CSS/JS, **jQuery**, **Bootstrap 5**, **Tailwind CSS**, a canvas game |
| Frontend frameworks | **React** (TypeScript or JavaScript), **Vue 3**, **Svelte 5**, **Angular**, **Next.js** |
| Backend & APIs | **Express**, Node.js with TypeScript, **NestJS**, **Flask**, **FastAPI**, **Django**, **Spring Boot**, **PHP**, **Laravel**, **Sinatra**, **Ruby on Rails**, **Go**, **ASP.NET Core** |
| Mobile & desktop | **Flutter**, **Dart**, Java Swing, **Swift** |
| Languages | Python, **C**, C data structures, C++, C++ with CMake, Java (single file and Maven), **Kotlin**, **C#**, Go, **Rust**, Ruby, TypeScript, Lua |
| Data & SQL | **SQL (SQLite)**, Python data analysis (pandas) |
| Learning | **Algorithms** in Python, C, C++ and Java with input/output tests, **Logic & Truth Tables**, Problem Solving |

Templates that need it (npm install, flutter create, composer, rails new) offer to **run their setup** in a terminal.

### Run more kinds of projects
- **New project types:**
  - **Flutter**: the web app opens in the built-in browser, with hot reload.
  - **Dart**, **Laravel**, **PHP**, **Rails**, **Sinatra**, **Ruby** and **Swift** projects.
  - **NestJS** now starts in watch mode.
- **Single files in a terminal:** ▶ also runs PHP, Ruby, Dart, Swift, Kotlin, Scala, C#, Lua, R, Perl, Shell, PowerShell, Julia, Haskell and Elixir files.

### SQL, built in
- **Run:** ▶ on a `.sql` file, or ⌘/Ctrl+Shift+Enter. ⌘/Ctrl+Enter runs only the statement under the cursor.
- **How it runs:** SQLite runs inside TMCode, offline and in exams too.
- **Results:** every statement shows its result as a table, or how many rows it changed. An error shows on its statement and as a Problem at its line.
- **Schema:** a panel shows your tables, their columns and row counts.
- **💡 Explain:** shows how SQLite runs a query (EXPLAIN QUERY PLAN).
- **Copy:** copy rows as CSV.
- **Fresh each run:** `schema.sql` and `seed.sql` run first, so every run starts the same. Choose **Keep data** to keep tables between runs.

### Logic and truth tables
- **`.logic` files:** write logical expressions (and/or/not, & | !, ∧ ∨ ¬, →, ↔, xor, nand, nor).
- **Truth tables:** ▶ shows each expression's truth table, with a column for every step.
- **Analysis:** whether it is a tautology or a contradiction, its minterms, and its sum-of-products and product-of-sums forms.
- **Equivalence:** expressions with the same table are listed as equivalent (De Morgan, for example).

### API Tester
- **Requests:** send GET, POST, PUT, PATCH and DELETE requests to your running server or to any API. You see the status, time and size, pretty JSON, the headers, and HTML pages.
- **Routes from your code:** they're found automatically in Express, NestJS, Flask, FastAPI, Django, Spring Boot, Laravel, Go and Rails projects. Click one to fill the request.
- **No CORS errors:** requests are sent by the app, not the page.
- **History:** the requests you sent are kept per folder.
- **Where to find it:** the Run menu, or the status bar while a server runs.

### Debugging
- **Go** debugs with Delve.
- **Dart** and **Flutter** debug with their own debuggers.
- **New Run and Debug configurations:** Go, Dart and Flutter.
- **Install guides:** new for Dart, Flutter, PHP, Ruby, Swift and Kotlin. The Go, Rust and C# guides now say what TMCode can do.

The full table is in [docs/LANGUAGES.md](https://github.com/niyongaboemmy/nga-tmcode/blob/main/docs/LANGUAGES.md).

### All changes

- Tech coverage: real-toolchain fixes, template integrity tests, tech e2e, docs/LANGUAGES.md, 0.8.0 notes
- Tech coverage: 45 templates, more project kinds, built-in SQL and truth tables, API Tester, Go/Dart/Flutter debugging

## 0.7.0 — 2026-10-07

**TMCode 0.7: grade TMCode practicals without leaving the editor.**

### Grading for teachers
- **Grading view** (new activity-bar icon, shown to teachers): the TMCode practicals of your subjects, grouped by subject. It lists both assignments and quiz practical questions.
  - Each shows a progress bar (graded, to grade, still working) and a count of what waits.
  - The icon's badge shows the total left to grade.
  - The filter button shows only practicals with work to grade.
- **The grading tab:**
  - **Progress:** for the whole practical, with the share of submissions already graded.
  - **Students:** filter them by To grade, Graded, Working, Not started or All, or find one by name.
  - **Each student's project loads automatically when you select them.** Their submitted version opens in this window, read-only, with the grading tab beside it. **Back to my folder** returns to your own work.
  - **Criteria:** score each one with quick buttons (not met, partly met, fully met) or an exact score, and add a note per criterion. The total adds up as you go. Overall feedback goes alongside.
  - **Save & Next** (⌘/Ctrl+Enter) saves to Task Mentor and moves to the next student waiting.
  - **Preview** runs a submitted website in the built-in browser.
  - **Unsaved grades** are kept as a draft while you switch students.
  - **Sync:** the tab refreshes from Task Mentor every 30 seconds, so other teachers' grades and new submissions appear on their own.
- **Quiz practicals:** grade them the same way. Switch between a quiz's practical questions from the tab's header.

### Tooltips
- Icons, buttons, menus, tabs and the status bar now show styled tooltips, as in VS Code, with the keyboard shortcut as a key chip.

### All changes

- Grading for teachers: Grading view, grading tab with progress, auto-loaded read-only submissions, criteria grades synced to Task Mentor; workbench tooltips

## 0.6.2 — 2026-10-07

**TMCode 0.6.2: TMCode practicals in quizzes.**

- **Quiz practicals in the Assignments view.** A teacher can add a TMCode practical question to a quiz. It is listed under **Quiz Practicals**, with its quiz, points and due date. **Start** creates your workspace from the question's starter files; starting it again reopens the same workspace.
- **Choosing an assessment** now has a 4th step for quizzes that have practical questions: pick the question, or link the whole quiz.
- **Submitting a quiz practical:** **Submit Project** hands in that exact version as your answer to the question, and your teacher grades it with the rubric. Keep the quiz open in Task Mentor while you submit, so your project is recorded as your answer.
- **Picker:** in each step of the assessment picker, **Back** is now at the bottom of the list, so pressing Enter picks the first choice instead of going back.

### All changes

- Quiz practicals: Quiz Practicals in the Assignments view, a 4th picker step, Start via /quizzes/:id/questions/:qid/start

## 0.6.1 — 2026-10-07

**TMCode 0.6.1: match each project with an assessment, and follow it from Draft to Submitted to Graded.**

### Match a project with an assessment
- **When you create a project,** TMCode asks which assessment it is for, in three short steps: choose a subject, then the kind of assessment (assignment, quiz or recorded assessment), then the assessment itself.
  - **Back** returns to the previous step.
  - **No assessment** keeps it as a personal project.
  - If you pick a TMCode practical, TMCode offers to start it instead, so you get your teacher's starter files.
- **Change Assessment…** matches the project with a different assessment, or removes the match, while the project is still a draft.
- **Fixed:** linking a project to an activity failed against Task Mentor because the two disagreed on the activity format. Matching now works.

### Project status
- **The Projects view shows each project's status:** Draft → Submitted → Graded, or Removed.
- **Submit Project** saves your work and hands in that exact version. If the project isn't matched yet, TMCode asks which assessment first.
- **A submitted project is locked.** Use **Withdraw** to keep editing before it is graded.
- **Remove Project…** moves a draft to **Removed**, from where you can **Restore** it. Your saved versions are kept.
- **Status filters** in My Projects: All, Draft, Submitted and Graded, with counts.

### All changes

- 0.6.1 release notes: assessment matching and project status
- Projects: match with an assessment (subject → kind → assessment), change it, and the project status lifecycle

## 0.6.0 — 2026-10-07

**TMCode 0.6 brings Task Mentor practicals into the editor: teachers publish coding assignments and case studies with starter files, and students start, save and submit them without leaving TMCode. Extensions also get their own views, panels and terminals.**

### Assignments and case studies from Task Mentor
- **New Assignments view** (mortar-board icon). It lists the TMCode practicals and case studies of your subjects:
  - grouped into **To do**, **Submitted**, **Graded** and **Completed**;
  - each shows a due countdown, red when it is late;
  - a badge counts what is left to do.
- **One click to Start.**
  - TMCode copies your teacher's starter files into your own Task Mentor project and opens it in a new folder.
  - The brief opens beside the code.
  - **Continue** brings you back to the same workspace on any computer.
- **The assignment page:**
  - the brief, instructions, attachments, points and due date;
  - **Save** and **Submit**. Submit saves first, so your teacher grades exactly what you see;
  - your grade and feedback once marked.
- **Completed means read-only.** When your teacher completes an assignment, its workspace can no longer be edited, saved or submitted. TMCode shows why.
- **For teachers:**
  - a Teaching section with submission counts;
  - each student's state and live status;
  - **Use as Starter for an Assignment…** publishes the open project as an assignment's starter files.
- **Open in TMCode:** Task Mentor's button opens the assignment straight in TMCode (`tmcode://assignment`).

### Projects view
- **Disconnect This Folder:** stops syncing a folder with Task Mentor. Your files stay.
- **Share live status with teachers:** a switch for each project. It stays on for open assignments.
- **Submitted projects are locked:** once Task Mentor locks submitted work, TMCode shows why and offers **Withdraw Submission** so you can keep editing.
- **Tidier layout:**
  - the This Folder panel no longer overlaps My Projects;
  - buttons fit narrow side bars;
  - the folder's assignment shows as a badge.

### Extensions
- Extension **views, tree views, webview panels and webview views** appear in their own activity bar containers and in the built-in views, as in VS Code (Git Graph, GitLens panels, Todo Tree…).
- Extensions can open **terminals**, change a document **before it is saved**, and see the editor's own **Problems** (for example, Error Lens shows TypeScript errors inline).
- **Format Document With…** and a default formatter per language.
- **Install from VSIX…**
- Browser-only extensions run on the desktop too.
- **Fixed:** extensions that follow the active editor now see you switch files. Before this, Auto Rename Tag stopped renaming closing tags and Better Comments stopped colouring after you opened a second file.
- **Fixed:** Better Comments, Todo Tree and similar extensions now find each language's comment syntax. A built-in "Language Basics" extension provides it, as VS Code's built-in language extensions do.
- README links open in your browser.

### All changes

- 0.6.0 notes: Withdraw Submission
- Projects: Task Mentor project lifecycle support (submitted/graded/removed lock, Withdraw Submission)
- Extension host: onDidChangeActiveTextEditor when a group switches files; built-in Language Basics (comment syntax for extensions.all)
- Assignments: workspaces rows for students not yet in Task Mentor, PRESENCE_LOCKED in the mock; 0.6.0 notes; e2e: allow esbuild-wasm cold start in WebKit
- TMCode practicals: assignments and case studies from Task Mentor
- Extensions self-test: check a webview panel round-trips messages
- TreeView.reveal and WebviewView.show bring their view forward, as in VS Code
- Docs: views and webviews in EXTENSION_HOST.md (API, contributions, security, real extensions, limits)
- Webview messages carry ArrayBuffers/typed arrays (GitLens RPC); real-extension rigs
- exthost e2e test: wait for UI notifications before asserting
- Workbench: extension view containers, tree views, webview views and webview panels
- Extension host: tree views, webview panels and webview views (host side)
- Extensions: browser-only extensions run in the Node host on the desktop, Install from VSIX…, README links open in the browser and #anchors scroll
- tmwebview:// origin for extension webviews: published pages + localResourceRoots files
- Extensions: window.createTerminal over TMCode terminals, onWillSaveTextDocument edits before save; Format Document With… and per-language default formatter
- Extensions see the workbench's own diagnostics (Error Lens etc.); end-to-end extensions self-test

## 0.5.0 — 2026-10-06

**TMCode 0.5 runs real VS Code extensions, adds a one-click Run for every kind of project, and fixes editing in the desktop app.**

### VS Code extensions that actually run
- **New extension host.** It follows VS Code's own design: a separate Node.js process with the `vscode` API, plus a Web Worker host for browser extensions. Extensions start only when they're needed. If one crashes, the host restarts on its own, and other extensions keep working.
- **Tested with popular extensions from Open VSX:** Prettier, ESLint, Error Lens, Code Spell Checker, Path Intellisense, Auto Rename Tag, Tailwind CSS IntelliSense, ES7 React snippets, Live Server, REST Client, Code Runner, GitLens, Better Comments, TODO Highlight, indent-rainbow, Color Highlight, and Code Formatter & Minifier (use its commands from the editor's right-click menu).
- **What extensions can add in TMCode:**
  - commands (Command Palette, keyboard shortcuts, right-click and title-bar menus);
  - formatters, completion, hover, go to definition, code actions and code lens;
  - Problems diagnostics, status bar items and Output channels;
  - settings (under Settings › Extensions).
- **In the Extensions view:**
  - Each extension shows its running state: Activating, Activated with its start time, or Failed with the reason.
  - A Recommended list of extensions verified to work in TMCode.
  - **Restart Extension Host** and **Show Running Extensions** commands.
- **Safety:** extensions never run during exams.

### One-click Run for files and projects
- **Run controls:**
  - **▶ Run** in the status bar, plus a split Run button on each editor. The button's menu lists every way to run the current file or the whole project.
  - **Run Project** is Ctrl/Cmd+Shift+F10.
  - TMCode remembers your choice for each folder; **Change Run Target…** picks another.
- **Project detection:** websites, React/Vite/Next/Vue/Svelte/Angular, Node.js apps, Python/Flask/Django/FastAPI, Java Maven/Gradle (Spring Boot), C/C++, Go, Rust and .NET.
- **Websites:**
  - Live Preview beside the code. It reloads as you type or on save (your choice), and keeps your scroll position.
  - Objects in the preview console can be expanded.
- **JavaScript Console (new panel):**
  - runs JS and TypeScript, including imports;
  - shows expandable objects and clickable error lines;
  - has a REPL that keeps your program's variables;
  - has a Stop button that ends even endless loops.
- **Dev servers** (Vite, React, Next, Express, Spring, Django…):
  - start in a named terminal and open in the built-in browser beside your code;
  - show elapsed time, with Stop and Restart.
- **Go and Rust** compile and run like C, C++, Java and Python. Build errors go to Problems.
- **REPLs:** Node.js and Python, each in a terminal.

### Editing fixes in the desktop app
- **Select All** (⌘A / Ctrl+A) now works in the editor, the terminal and every text field.
- **Terminal copy and paste** work. ⌘C/⌘V on macOS. On Windows and Linux, Ctrl+C copies when text is selected and otherwise still interrupts the program; Ctrl+V pastes.
- **Explorer clipboard:** cut, copy and paste files and folders (⌘X/⌘C/⌘V) and **Duplicate**. Copies are named like VS Code's ("main copy.py") and work for any file, including images. Plus **Copy Path** and **Copy Relative Path**.
- **No more false "changed on disk" warnings.** TMCode no longer mistakes its own auto-save for a change made outside the editor.
- **Sign in with NGA** completes again. The browser step worked, but TMCode didn't read Central MIS's reply correctly. After you sign in, the Projects view lists your synced projects.
- **Save to Task Mentor** is now Ctrl/Cmd+Alt+U, because Ctrl/Cmd+Alt+S is Save All.

### All changes

- Docs: recommended extensions (compatibility survey), 0.5.0 release notes, plan status
- Sign in with NGA: read MIS's { data: { token } } redeem reply; Edit › Select All selects in whatever has focus; recommended extensions
- Extension host: Uri accepts the components object (GitLens), Node 25's removed buffer.SlowBuffer restored (REST Client); compatibility survey script
- docs/EXTENSION_HOST.md: architecture, API subset, contribution points, security model, verified extensions, limits; typecheck covers packages/exthost
- Extension host: one Node host per window (a reloaded webview's host is killed); the desktop build and the Node test rebuild the bundled host
- Native self-test TMCODE_DEV_SELFTEST=exthost: installs Code Formatter & Minifier and Path Intellisense from Open VSX, runs Beautify/Minify and checks Monaco's suggestions, then removes what it added
- UI probe: terminal ⌘C/Ctrl+C reaches the system clipboard (restores the user's clipboard)
- Explorer: Copy/Cut/Paste (⌘C/⌘X/⌘V) and Duplicate for files and folders, Copy Path; native ws_copy
- Terminal copy/paste on macOS WebKit through the system clipboard; UI probe measures the live editor; debug self-tests keep their window in front
- Panel tabs stay on one line (scroll) now that there are six
- Extension host e2e (Web Worker host, chromium + webkit): palette command, diagnostics, status bar, Output channel, formatter, completion, runtime status, settings, restart, exam lockdown; exams stop hosts that were still starting
- e2e: the Run menu in an exam offers running code but no REPLs or tasks
- Workbench extension host tests: when clauses, keybinding conversion, selectors, completion kinds, edits, manifest code contributions
- Workbench extension host tests: when clauses, keybinding conversion, selectors, completion kinds, edits, manifest code contributions
- Extension host tests: RPC framing, vscode classes (Range/Position/Uri semantics), activation events, configuration layering, documents, globs, and the Node host end to end with fixture extensions
- Extension host UI: runtime state in the Extensions view and details (Runtime Status tab), status bar items, editor title buttons, Output channel picker, extension settings, trust notice, Restart/Show Running commands
- Go and Rust compile and run in the Run panel, with build errors in Problems
- Extension host: ES module extensions (Node module hooks), the rest of the vscode classes and enums
- Live preview: reload on save (setting), keep the scroll position, structured console
- Extension host: Node harness (fake workbench) and a real Open VSX extension check
- Run hub: status bar ▶ target, editor-title split button, Run Project, dev servers
- Extension host (workbench): host lifecycle, main-thread handlers, Monaco language bridge, decorations, contributed commands/menus/keybindings
- JavaScript Console panel: structured console output and a REPL
- Run hub: project detection (projectKind) and structured console values (jsInspect)
- Extension host (workbench): manifest code contributions, platform API, when clauses, config, output, document sync
- Extension host: the vscode API shim (Node + Web Worker) and the Rust stdio bridge
- UI probe: selection highlight, copy, paste, delete and terminal selection checks (browser + native)
- No false 'changed on disk' warning for TMCode's own saves; Save to Task Mentor moves to Ctrl/Cmd+Alt+U (clashed with Save All)

## 0.4.1 — 2026-10-06

**TMCode 0.4.1 fixes how the editor and terminal look in the installed app.** In 0.3.0 and 0.4.0 the desktop app blocked the styles that the editor and terminal create while they run. As a result:
- you could not see the cursor;
- the current line and its line number were not highlighted;
- code had no syntax colours;
- the terminal cursor and colours were missing.

### Editor
- The cursor shows again: a smooth, blinking caret, the same as in VS Code.
- The current line is highlighted, and so is its line number in the gutter.
- Syntax colours, bracket pair colours, indent guides and link underlines are back.

### Terminal
- The terminal cursor shows again (a bar while focused, an outline when not), and the terminal uses the theme's colours.
- If the terminal panel was open when you reopened a project, it could stay blank. It now always starts a working shell.
- A loading placeholder shows while a slow shell is starting.

### Quality
- A new UI self-test runs inside the real desktop window. It checks:
  - cursor, line highlight and syntax colours;
  - text alignment;
  - typing, scrolling and large-file stalls;
  - the terminal prompt, fit and cursor;
  - blocked styles.
- Any style the app's security policy refuses is now written to the app log.

### All changes

- e2e: wait for lazy syntax colouring in the UI probe; wait for the final TypeScript problem, not mid-typing ones
- Editor and terminal: visible cursor, line highlight and colours in the desktop app

## 0.4.0 — 2026-10-06

**TMCode 0.4 brings Task Mentor projects, Local History and the Outline view.**

### Task Mentor projects
- **Sign in with NGA:** one sign-in for Central MIS and Task Mentor, in your browser (Google works). The tokens are kept in your system keychain. Use the account button at the bottom of the activity bar.
- **Projects view** (Ctrl/Cmd+Shift+J): your projects and the ones shared with you, synced as soon as you sign in.
- **Task Mentor projects** (C++, Python, anything without GitHub):
  - **Save to Task Mentor** (Ctrl/Cmd+Alt+S) uploads only the files that changed. You can also turn on automatic saving.
  - **Get Latest** brings in work saved on another computer.
  - Files changed both here and in Task Mentor are listed so you can choose which version to keep.
  - A status bar badge shows whether everything is saved.
- **GitHub projects** use git push as usual; Task Mentor shows your branch and your pushes.
- **Open in TMCode** from Task Mentor (`tmcode://project` links) clones or downloads the project the first time, then opens it.
- **Activities:** link a project to a quiz, an assignment or a recorded assessment. Submitting sends your teacher that exact version.
- **Live status:** Task Mentor can show that the project is open and which file you're editing. Turn this off in Settings › Projects.
- **New Project templates:** React (Vite), Node.js/Express, Python, C++ (CMake), Java (Maven) and a website. Each is ready to run, debug and save.

> Projects become available once your Task Mentor is updated to support them; until then TMCode tells you they are coming soon.

### Editor
- **Timeline / Local History** (under the Explorer):
  - Every save keeps a copy.
  - Compare any copy with the current file, or restore it; Undo works.
  - The copies stay on your computer.
- **Outline** (under the Explorer): the active file's classes, functions and variables. Filter them, and click one to jump to it.
- TMCode's own `.tmcode` folder is hidden from the Explorer and kept out of git.
- New folders created outside TMCode (a pull or checkout, for example) appear in the Explorer straight away.

### All changes

- e2e: exam time-up test gets a 15 s deadline (slow CI WebKit booted past 6 s)
- e2e: Timeline test edits with select-all (Linux WebKit Home key)
- 0.4.0 notes; friendly message while Task Mentor lacks the projects API; plan + README
- Projects: native self-test (TMCODE_DEV_SELFTEST=projects, debug-only TMCODE_DEV_MIS_TOKEN), device name in presence, Task Mentor contract script
- Local History (Timeline) with compare/restore, Outline view, .tmcode hidden from the explorer
- Projects (TMCode side): NGA sign-in (MIS + Task Mentor), Projects view, sync with Task Mentor, templates, deep links

## 0.3.0 — 2026-10-06

**TMCode 0.3 makes it a full developer editor.** You can clone a real project, run and debug it, preview it, and theme it like VS Code. Exam mode is as locked down as before.

### Source Control and GitHub
- Clone from a URL or from your GitHub repositories, with progress and Cancel.
- Source Control view (Ctrl+Shift+G):
  - stage, unstage and discard changes;
  - commit with Ctrl/Cmd+Enter, including amend, commit-and-push and sync;
  - see recent commits.
- Diff editor for every change: index vs working tree (editable) and HEAD vs index.
- Added, modified and deleted marks in the editor gutter. M/U/A/D letters and colours in the explorer.
- In the status bar: a branch picker (create, switch, check out remote branches), ahead/behind counts, and pull, push, fetch and publish.
- GitHub sign-in with a personal access token, stored only in your OS keychain.

### Run and Debug
- Run and Debug view (Ctrl+Shift+D):
  - Variables (expandable, editable), Watch, Call Stack and Breakpoints;
  - exception breakpoints.
- Breakpoints in the gutter, including conditional breakpoints, logpoints and hit counts. F9 toggles a breakpoint.
- A floating debug toolbar (continue, step over/into/out, restart, stop), a Debug Console with expression evaluation, and values on hover.
- Debugging works for Python (debugpy), Node.js (js-debug) and C/C++ (lldb-dap / gdb).
- `launch.json` support, with templates. F5 runs or debugs; Ctrl+F5 runs without debugging.
- "How to install" guides for Python, Node, Java, C/C++, Go, Rust and C# when a toolchain is missing.

### Extensions
- An Extensions view (Ctrl+Shift+X) backed by the Open VSX marketplace. It lists search results, installed and recommended extensions, and shows each extension's details with its README.
- Installs VS Code color themes, file icon themes, TextMate grammars, languages and snippets.
  - Extensions that contain code can be installed for these parts; their code does not run yet.
- More accurate syntax colouring from VS Code's TextMate grammars.

### Real projects
- **Run Task…** detects npm, yarn, pnpm and bun scripts, Maven and Gradle (including Spring Boot), Make, Cargo, Go, Django, pip and .NET. It also looks in subfolders such as `client/` and `server/`.
- **IntelliSense from `node_modules`:** completions and type checks for the packages a project has installed (React, Express and others). It refreshes after `npm install`.
- **Prettier** formatting that follows the project's `.prettierrc`, and **Emmet** for HTML, CSS and JSX.

### Terminal
- Ctrl/Cmd-click a link to open it. Localhost URLs open in the built-in browser, and `file:line:col` references jump into the editor.
- Find in Terminal, Run Recent Command (Ctrl+Alt+R), and a cursor that stays visible.
- When a dev server starts, TMCode notices its port (Vite, Next, Angular, Spring, Django, and so on) and offers to open it in the browser.

### Previews
- A **built-in browser** for your dev server, with back, forward, reload, an address bar and device sizes.
- Live **Markdown preview** (Ctrl+K V), an **image, audio and video viewer**, and a live **SVG preview**.

### Design
- Loading skeletons wherever content is being loaded, plus smooth transitions and animations.
- **Zen Mode** (Ctrl+K Z; press Escape twice to leave).

### All changes

- CI fixes: portable literal-pathspec git test (Windows forbids '*'); wait for boot before keyboard shortcuts in the narrow-window e2e
- Release notes: hand-written highlights for 0.3.0 ahead of the commit list
- Run and Debug tests: DAP framing, launch.json (JSONC), simulated sessions, e2e on Chromium and WebKit
- Run and Debug view: launch.json, gutter breakpoints, debug toolbar, Debug Console, hover evaluation, F5/Ctrl+F5, install guides, simulated browser debugger
- Debugger host: exam policy switch (policy.debugger, debug_policy), real debugpy session test
- Desktop extensions host: download .vsix from Open VSX and unpack into app data (Rust)
- Source Control: VS Code-style SCM view, diff editor, gutter, explorer decorations, status bar
- Workbench: showQuickPick/showInputBox, progress notifications with Cancel, gitDiff editor input
- Git host interface: GitHost on Platform, Tauri bindings, in-memory git for the browser build
- Extensions view over Open VSX: search, details editor, install/uninstall/disable, declarative contributions
- VS Code colouring: TextMate grammars (vscode-textmate + local Oniguruma wasm), VS Code's theme files, theme/icon-theme services
- git: open allow-listed help/token pages; real-repo test for upstream, ahead/behind, detached HEAD
- v0.3 developer experience: terminal links/find/recent commands, Simple Browser, Markdown/media previews, tasks, Prettier, Emmet, node_modules types, skeletons, Zen Mode
- Git & GitHub (native): git.rs over the system git, PAT in the OS keychain, TMCode as GIT_ASKPASS
- Debugger host: DAP bridge (stdio/TCP), debugpy/js-debug/lldb-dap/gdb adapters, pinned js-debug download, runInTerminal, toolchain selection
- Terminal: always-visible cursor (bar/outline), new shell in the new folder after a workspace switch, colour output; configurable dev/mock ports for parallel e2e

## 0.2.2 — 2026-10-05

- Open the folder macOS hands over at cold start (open -a TMCode <folder>, Open With, Dock drops)

## 0.2.1 — 2026-10-05

- Release script: bump only workspace entries in package-lock; refuse a lock npm ci would reject

## 0.2.0 — 2026-10-05

- CI: pin Linux jobs to ubuntu-24.04 (ubuntu-latest jobs were left without runners)
- Test: build the path-argument cases with this OS's own path form (Windows CI)
- README: downloads, install notes, command line, updates, releasing
- TMCode for everyday development: watch, open paths, updates, responsive, releases
- tm-judge: dedicated process entry (pm2 wraps scripts, so the main-module check never fired)
- tm-judge deploy: re-exec after updating, clean pm2 restart, real health wait
- tm-judge: run as bundled JavaScript; transpile student TypeScript with esbuild
- tm-judge: mount toolchains installed outside /usr read-only; ignore EPIPE on isolate stdin
- tm-judge: create the isolate user with subordinate uid/gid ranges (CI + deploy)
- tm-judge: production deploy script (isolate + slice limits + pm2); strip-types-safe code; CI diagnostics
- Desktop exam host: tmcode:// deep links, on-disk journal, exam folders, scoped HTTP
- Phase 3 client: exam sessions, tamper-evident journal, sync, submit
- tm-judge service (isolate sandbox) with CI; Windows path fix
- CI: typecheck, unit and Playwright tests; Rust tests on macOS and Windows
- TMCode Phase 2: language profiles, native runner, tests and web preview
- TMCode Phase 0/1: VS Code-style workbench and Tauri shell

