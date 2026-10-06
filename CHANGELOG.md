# Changelog

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

