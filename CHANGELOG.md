# Changelog

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

