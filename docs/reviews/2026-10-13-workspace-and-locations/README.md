# Workspace, files and project locations: gap analysis and fixes

**Date:** 13 October 2026. **Starts from:** TMCode 0.16.0. **Branch:** `feat/workspace-fixes`.

This review covers the problems reported after 0.16 (brief footer, Explorer moves and copies, files from outside, already-open files, saving, brief images, Live Preview, running languages) and the question of **where projects live on disk**. Each item gives the root cause found in the code, what was changed, and how it is tested.

## 1. What was reported, why it happened, what changed

| # | Problem | Root cause | Fix | Tested by |
|---|---|---|---|---|
| 1 | The brief's "In progress · Submit" bar floated above the bottom, with the brief showing under it | It was `position: sticky` inside the scrolling page, whose bottom padding (48 px) kept it off the edge | The brief is a shell: the page scrolls, the footer is pinned to the tab's bottom edge, full width, sliding in when the main card scrolls away; the page keeps room so the footer never covers the last lines | `workspace.spec`: footer bottom = tab bottom, full width |
| 2 | Files and folders can't be moved to another folder | The desktop's native file-drop handler (Tauri `drag_drop_handler`, on by default, needed for files dragged in from Finder with their paths) **consumes every drop**: inside the page `dragover`/`drop` never fire on macOS or Windows. The Explorer used HTML5 drag and drop | Moves use **pointer events** (a ghost label follows the pointer, the target folder is highlighted, Escape cancels). Editor tabs (to another group, or an edge to split) were broken for the same reason and use pointer drag too | `workspace.spec`: drag `web/style.css` onto `js` |
| 3 | Copy and paste into another folder "does nothing" | The paste happened, but into a **closed** folder, with no message (and a cut file just vanished from its place). Edit › Cut/Copy/Paste in the macOS menu bar send DOM clipboard events the Explorer ignored | Paste opens the folder, selects what arrived and says "Copied/Moved … to …"; Duplicate opens its folder; the menu bar's Cut/Copy/Paste act on the Explorer when it has focus | `workspace.spec`: paste into a closed folder |
| 4 | Files and folders from outside can't be copied in | (a) **Paste:** files copied in Finder / File Explorer were never read; the clipboard API only had text. (b) **Drag in:** on macOS the drop position was divided by the screen scale twice (WKWebView already reports points), so on a Retina screen the drop landed on the wrong row or outside the Explorer and was ignored | (a) `ws_clipboard_files`: Finder (`public.file-url` via the system's own JavaScript bridge), Windows (`Get-Clipboard -Format FileDropList`), Linux (`wl-paste`/`xclip`); Paste imports them (with the usual "Replace?" question) when they are newer than TMCode's own Copy. (b) macOS divides by the window zoom only | macOS reader checked with a real pasteboard; drop position by code review (desktop only) |
| 5 | Clicking a file that is already open (but not in front) does nothing | `openFile` looked only in the **active** group: with the brief focused, the file's tab in the code group was never brought forward (a duplicate could open in the brief's column instead) | The existing tab comes to the front wherever it is; a new file never opens in the brief's place | `workspace.spec`: brief focused, click an open file |
| 6 | No Save/Sync button: working offline, then online | Saving is automatic, but nothing to press and nothing when the network came back | **Sync Now** on the brief (sends the work and gets anything newer); when the computer comes back online TMCode checks and sends what was saved meanwhile | `workspace.spec`: Sync Now visible |
| 7 | Images in the brief lose their shape | Task Mentor images keep `width`/`height` attributes; `max-width: 100%` shrank the width only | `height: auto; object-fit: contain`; a click opens the picture full size (Escape closes) | CSS + manual |
| 8 | Live Preview: screen ratios, modern, full screen | One scale-to-fit, top-aligned, portrait only, no frame; no full screen; the built-in browser had its own copy | Shared `deviceView`: phone/tablet/laptop frames in their real shape, **landscape**, **zoom** (fit, 50, 75, 100 %), size label (`375 × 667 · 70 %`), centred, remembered for every preview; **Full Screen** over the whole window (Escape), **Open in Browser** | `workspace.spec`: device, landscape, full screen |

## 2. Where projects live (the XAMPP question)

### Findings
- Every Task Mentor project, assignment, quiz practical, template project and teacher review was created by one Rust command under a hard-coded `~/TMCode Projects`. No setting, no question. The code already accepted another base folder; nothing passed one.
- Most kinds of project **run anywhere**: TMCode starts their own server or runner (Node/Vite/Next, Python/Django/Flask, Java/Spring, Go, .NET, Ruby, Dart/Flutter, C/C++, and PHP through `php -S` / `artisan serve`).
- **PHP is different for many students.** Classes teach XAMPP / MAMP / WAMP / Laragon: Apache serves `htdocs` (or `www`) at `http://localhost/<folder>`, with MySQL beside it. A PHP site outside that folder can't be opened the way the course expects.

### Design (implemented)
1. **Projects Folder** setting (`projects.folder`): where new projects go (default `~/TMCode Projects`).
2. **Web server folders are found**: XAMPP (macOS/Windows/Linux `lampp`), MAMP (port from its `httpd.conf`, 8888 by default), WAMP, Laragon, Apache `/var/www/html`, `~/Sites`. Each with its address (`http://localhost[:port]`).
3. **PHP work offers them**: starting a PHP assignment, or a PHP/Laravel template, asks once where it goes: *XAMPP web folder (served at http://localhost/…)*, *Projects Folder (runs with PHP's built-in server)*, or *Choose a Folder…*. The setting **Projects: PHP Websites** (`ask` / `webServer` / `projectsFolder`) makes it automatic. Other languages are never asked (except New Project from Template, which always offers *Choose a Folder…*).
4. **Run knows**: a project inside a web server's folder gets **Open in XAMPP (localhost/shop/)** first (Laravel: `/public/`); outside it, `php -S` on a **free port** (8000, else the next free one) and the page you're editing opens, not only the front page.
5. **Projects: Move This Project…** moves an existing project (into htdocs, another drive…), reopens it there and remembers it; Task Mentor is unchanged. Across drives it copies, and removes the original only once the copy is complete.
6. **Find This Computer's Web Server** (palette) says what was found.

Unit tests: `projects/location.test.ts` (which work wants a web server; which server serves a folder and at which address, Windows paths included; a PHP site in htdocs runs as Apache serves it, loose PHP exercises still run one by one). Rust tests: Apache port parsing, moving a folder (name taken, into itself refused).

## 3. Running and testing languages

| Language | Before | Now |
|---|---|---|
| PHP, Ruby, Kotlin, Dart, Swift | Terminal only: no example tests, no install check in the Run panel | **Run panel profiles**: keyboard input, example tests (Add a Test), the install check; the terminal stays one choice away. Starter programs checked with the real tools (PHP 8.4, Ruby 2.6, Kotlin, Dart, Swift) |
| Go, Rust on Windows | `go build -o …/main` / `rustc -o …/main` made `main`, the runner started `main.exe`: not found | Windows builds `main.exe` |
| Kotlin on Windows | `kotlinc … && java -jar …`: PowerShell 5.1 has no `&&` | Two steps joined the shell's way |
| Ruby exercises | Any folder of `.rb` files ran `app.rb`/`main.rb` whatever was open | A folder of exercises runs the file being edited |
| A script beside a Node package | Run ran the package's `index.js` | Runs the script being edited (the package's own scripts still win for real projects) |
| HTML page in a subfolder | Served from its own folder: `../style.css` missing | Served from the site's folder |
| TypeScript `.cts` | "can't run" | Runs |
| Single-file C# | `dotnet run file.cs` failed on .NET 8/9 | Run explains that .NET 10 is needed (or a project), with How to Install |
| PHP built-in server | Always port 8000; opened the front page | Free port; opens the page being edited |

## 4. Other gaps found (not changed in this round)

- **Desktop-only behaviour is not covered by the browser e2e suite:** native drops from Finder, the OS clipboard, the folder picker, web-server detection, Move This Project. They need a short manual pass on macOS and Windows before release (checklist below).
- **Linux clipboard files** need `wl-paste` or `xclip` installed.
- **Windows terminal syntax**: TMCode writes PowerShell syntax for terminal runs; a student who switched the default terminal to `cmd` gets errors on chained commands.
- **WordPress** has no template (it needs Apache + MySQL: the htdocs flow above is the way to add one).
- **Laravel under Apache** opens `/public/`; Apache's own virtual hosts or `.htaccess` are not set up by TMCode.
- **Teacher review folders** stay in the default Projects Folder (they are TMCode's own copies).

### Manual checklist (desktop build)
1. macOS: drag a file from Finder onto a folder in the Explorer → copied there. Copy two files in Finder, ⌘V on a folder → both arrive.
2. Windows: same with File Explorer, Ctrl+V.
3. Edit › Copy / Paste (menu bar) with the Explorer focused → files copied.
4. With XAMPP installed: start a PHP assignment → the location question lists XAMPP; Run opens `http://localhost/<folder>/`.
5. Projects: Move This Project… into htdocs → reopens there; Continue from Assignments opens the moved folder.
6. Settings › Projects Folder set → a new template project goes there.
