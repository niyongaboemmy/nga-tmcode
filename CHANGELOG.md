# Changelog

## 1.3.0 — 2026-10-31

**TMCode 1.3: your Claude, ChatGPT and Gemini accounts answer right in the editor.** Sign in once to Claude Code, ChatGPT (Codex) or Gemini CLI with your own account, free or paid, and TMCode AI answers with it: in the chat, in the terminal's AI, and in agent modes. No more copying code into a browser tab and back. And `.sql` files now preview as an interactive database diagram, with every table, key and relationship, exportable as PNG, PDF or SVG. The terminal's AI box now sits under the terminal instead of covering it, and the model menu always shows every choice.

### Your AI accounts

- **Pick one in "Which AI answers"** (the model menu in the chat and in the terminal's AI box). The new **Your AI accounts** section lists:
  - **Claude Code** with your Claude account (Free, Pro, Max or an API key): its default model, Sonnet, Haiku or Opus;
  - **ChatGPT (Codex)** with your ChatGPT account (or an OpenAI API key);
  - **Gemini CLI** with your Google account (or a Gemini API key): Auto, Pro, Flash or Flash-Lite;
  - any other model name you type.
- **It answers with your account and your plan.** No TMCode AI allowance is used. When your plan's limit is reached, TMCode says so and offers **Your Plan** (to upgrade) or **Use Free AI and Retry**.
- **In the chat (Chat mode)** and **in the terminal** (⌘I, `# words`, Fix with AI) it answers read-only: it can't run commands or change files. Your question goes to it on its input, never on a command line.
- **In agent modes** (Manual, Edit automatically, Plan, Auto) it works on your project in a terminal, in its own matching permission mode, and asks there before it acts:
  - Claude Code: manual, acceptEdits, plan, auto;
  - Codex: read-only or workspace-write sandbox, asking on request;
  - Gemini CLI: default, auto_edit, plan.
- **Sign in, sign out, install, in one click.** The menu offers **Install…** when one isn't on your computer and **Sign In…** when it isn't signed in. Each runs in a terminal you can watch; signing in opens the company's own sign-in page in your browser.
- **Settings › TMCode AI › Your AI accounts** shows each one's state: signed in as whom and on which plan, the version. Buttons: Sign In, Sign Out (or Switch Account for Gemini), Use for TMCode AI, Your Plan, Check Again.
- **Your school stays in charge.** They are third-party AI tools: they work only where your school allows those (Task Mentor's AI settings, separately for students and staff), never in exams, and TMCode blocks the programs themselves when the school says no. Every question, agent task and command run is in the Activity log with the AI named (Claude Code, ChatGPT (Codex), Gemini CLI), where teachers see it.

### The terminal's AI box

- **It docks under the terminal.** The terminal shrinks above it instead of being covered, so the command you're asking about stays in view.
- **Short panels:** the examples fit on one row and the tips step aside, so nothing is cut off. In a very short panel the terminal keeps its last lines and the answer scrolls.

### The model menu

- **Every choice, every time.** The menu used to show only Free and Auto when it opened before Task Mentor had answered. It now waits for the answer (a moment, with a placeholder), shows the free models, premium models, your AI accounts and your keys, and offers **Try again** if Task Mentor can't be reached.
- **Add Your Own API Key…** is there whenever your school allows own keys, including when the list couldn't load.

### Database diagrams for .sql files

Open a schema or a database dump (mysqldump, phpMyAdmin, pg_dump, SQLite), click **Preview** above it, and TMCode draws every table, view and foreign key, like MySQL Workbench's EER diagram. Drag tables around, search, click one for all its details, and export the whole diagram as PNG, PDF or SVG.

- **Edit | Preview** above every `.sql` file, as Markdown and CSV files already have. Edit stays the default.
- **Each table is a card:** its name, how many columns, the table comment, and each column with its type.
  - a key for the primary key, an arrow for a foreign key, a filled diamond for NOT NULL and an empty one for nullable;
  - small badges: **UQ** unique · **IX** indexed · **AI** auto-increment · **DF** default · **GC** generated.
  - Hover a column for everything about it (default, ON UPDATE, comment…).
- **Views** are cards of their own (marked VIEW), with dotted lines to the tables they read.
- **Relationship lines** go from the foreign key column to the column it references, with crow's-foot ends:
  - a crow's foot means many, a bar means one, a ring means optional;
  - a dashed line is a nullable foreign key; a foreign key that is also unique (or the primary key) is one-to-one.
- **Automatic layout:** referenced tables sit left of the tables that reference them, crossings are kept low, and a table referenced by many (like `users`) doesn't make one endless column. Tables without relationships are grouped at the end.

### The diagram: moving around

- **Pan:** drag the background or scroll. **Zoom:** pinch, ⌘/Ctrl + scroll, the − / + buttons, or the − + 0 keys. **Fit to Screen** shows everything.
- **Zoomed far out**, columns become bars and table names grow so you can still read the map.
- **Drag tables** to arrange them. TMCode remembers where you put them for each file; **Reset Layout** goes back to the automatic one.
- **Find a table or column:** matching tables stand out; Enter goes to each in turn.
- **Keys Only** hides every column that isn't a key, for big schemas (on by default above 80 tables).
- **A minimap** in the corner shows where you are; click or drag it to move.

### The diagram: details

- **Click a table** to light it up with its neighbours and open its details beside the diagram: every column (type, NULL / NOT NULL, default, auto-increment, enum values, check, comment), keys and indexes, the foreign keys it has and the ones that point to it, with their ON DELETE / ON UPDATE rules. Click a linked table to go there.
- **Click a line** for that relationship: the columns on both sides, its cardinality in words and its rules.
- **Line N** links go to the CREATE statement in the editor.

### The diagram: export

- **PNG, PDF or SVG** of the whole diagram, not just what's on screen, in the current theme's colours.
- On the desktop app, a Save dialog asks where; in the browser the file downloads.

### The diagram: what it reads

- `CREATE TABLE` with backticked, double-quoted or [bracketed] names, schema-qualified names (`public.orders`), comments, inline and table-level `PRIMARY KEY` / `UNIQUE` / `FOREIGN KEY … REFERENCES … ON DELETE / ON UPDATE`, `CONSTRAINT` names, `CHECK`, `DEFAULT`, `NOT NULL`, `AUTO_INCREMENT` / `SERIAL` / `IDENTITY` / `GENERATED`, `KEY` / `INDEX` / `FULLTEXT` lines, `ENUM` and `SET`, column and table `COMMENT`s.
- `ALTER TABLE … ADD` (constraints, keys, columns), `MODIFY` / `CHANGE`, `ALTER COLUMN … SET NOT NULL / DEFAULT`, `DROP`; `CREATE INDEX`; `CREATE VIEW` (also mysqldump's views inside `/*!50001 … */`) and materialized views; PostgreSQL `CREATE TYPE … AS ENUM` and `COMMENT ON`.
- **Big dumps are fine:** `INSERT` and `COPY` data, triggers and functions are stepped over without being read, so a dump of tens of MB is drawn in about a second while the window stays responsive.
- **Nothing hidden:** what couldn't be read (a broken statement, a foreign key to a table that isn't in the file) is listed under **N skipped**, with a link to its line. A file without `CREATE TABLE` says so.

### All changes

- Release notes: the schema diagram goes in 1.3.0
- Merge main: keep the closing brace both sides shared
- Preview .sql files as an interactive database schema diagram
- Your Claude, ChatGPT and Gemini accounts answer TMCode AI; terminal AI box docks under the terminal (1.3.0)

## 1.2.0 — 2026-10-31

**TMCode 1.2: ask the terminal in your own words, easier own API keys, and colours for every kind of file.** Forgot a command? Press ⌘I (Ctrl+I) in the terminal, or type `#` and what you want at the prompt, and TMCode AI answers with the commands to run. When a command fails, Fix with AI explains why and gives the corrected one. Nothing runs until you click, and dangerous commands ask twice. Your own API keys are now tested when you add them, and `.env` files (and about 200 other file types) finally have colours.

### TMCode AI in the terminal

- **Ask in your own words.** Press **⌘I** (Ctrl+I) in the terminal, or click ✨ in the terminal's title bar, and say what you want: "find files bigger than 100 MB", "undo my last commit but keep the changes", "stop whatever is using port 3000".
- **Or type `#` at the prompt:** `# list the files changed today`, then Enter. TMCode AI answers; the words never reach the shell. (zsh, bash and fish with Shell Integration.)
- **Answers are commands you can use:**
  - **Run** (⌘↵ / Ctrl+Enter) runs it in the terminal;
  - **Insert** (⌥↵ / Alt+Enter) puts it at the prompt to edit first;
  - **Copy**.
  - Each command says what it does and names its important flags, so you learn the command, not just its result.
- **Fix with AI.** When a command fails, Fix with AI and Explain appear beside the terminal. TMCode AI reads the command and the end of its output, says why it failed, and gives the corrected command. Fix and Explain are also in the menu of the last command's dot, and in the Command Palette (Terminal: Fix the Last Command with TMCode AI · Explain the Last Command with TMCode AI).
- **Follow-ups** refine the answer: "only in the src folder", "for Windows".
- **It knows where you are:** your shell, operating system, folder, the project's files (package.json, Makefile…) and your last commands.
- **Safe by design:**
  - Nothing runs until you click Run.
  - TMCode checks every command itself. Commands that delete files, need administrator rights, force-push, rewrite git history, format a disk or run a script from the internet are marked **Dangerous** and ask "Run it anyway?". Installing packages or overwriting files is marked **Careful**.
  - If a command is still running in the terminal, Run starts a new terminal instead of typing into the running program.
- **Same rules as the rest of TMCode AI:** the model you pick (Free, Auto, Premium or your own key), today's allowance, and your school's and teacher's AI settings. It is off in exams, and the box says why when AI is off.
- **The Activity log** records each question and each command run from an answer, with TMCode AI named.
- **New settings (Terminal):**
  - TMCode AI in the Terminal;
  - Ask with # at the Prompt;
  - Offer a Fix When a Command Fails.

### Premium AI and your own API keys

- **Test Key.** A key is tested as soon as you save it (one tiny request), and with Test Key at any time. A wrong key, no credit or an unknown model shows now, not at your first question.
- **Wrong provider spotted.** Pasting an Anthropic key into OpenAI (or the other way round) shows a warning before you save.
- **Use a model in one click.** Under each saved key, click a model to make TMCode AI answer with it.
- **Removing a key** switches TMCode AI back to Free, so the next question doesn't fail.
- **Premium explained.** When your school hasn't turned premium AI on for you, Settings › TMCode AI says so and where it's turned on.
- **Current Claude models** suggested for Anthropic keys: claude-sonnet-5-5, claude-haiku-5-5, claude-opus-5-5.
- More refusals offer **Switch to Free** (premium allowance used up, own keys turned off by the school, no key for that model).

### Colours for every kind of file

- **`.env` files have colours:** comments, names, values, numbers, true/false and `${VARIABLES}`. This covers `.env.local`, `.env.production`, `.env.example` and `*.env` too.
- **About 200 more file types**, for example:
  - ignore files (`.gitignore`, `.dockerignore`…), `.gitattributes`, `.editorconfig`, `.npmrc`;
  - `requirements.txt`, `go.mod`, `Cargo.lock`, `Pipfile`, `tsconfig.json` (comments allowed);
  - Dockerfile variants, Makefiles, `CMakeLists.txt`, Jenkinsfile and Gradle;
  - nginx, Apache (`.htaccess`), SSH config, systemd, crontab, `.http` files, Terraform;
  - Vue, Svelte, Astro, MDX, Blade, Jinja, Sass, Stylus;
  - Haskell, Elixir, OCaml, Zig, Nim, LaTeX, Solidity, Nix, Fish and many more.
- A file is recognised by its whole name first (`.env.local`, `Dockerfile.dev`), as in VS Code, not only by its last extension.

### All changes

- TMCode AI in the terminal: plain words in, commands out; easier own API keys (1.2.0)
- textmate test: allow a minute to load every grammar (slow CI runners)
- Colour .env files and 150+ more file types out of the box
- First run: don't move the side bar once the student has clicked or typed

## 1.1.0 — 2026-10-31

**TMCode 1.1: you choose where projects are saved, any folder can become an assignment's work, "not submitted" is impossible to miss, and PDF, Word, CSV and Markdown files preview.**

### Where your projects are saved

- **Start asks where to save.** Starting an assignment or a new project asks where its folder goes:
  - **Where You Saved Last Time**;
  - the **Projects Folder** (~/TMCode Projects);
  - a **web server folder** (XAMPP, MAMP…) for PHP;
  - **Choose a Folder…**: anywhere on the computer, such as Documents, Desktop or a USB drive.
- **Use the Open Folder.** When the folder open now isn't connected to anything, Start can use it: your files there become the project, and your teacher's starter files are added beside them.
- **Not wanted?** Turn off Settings › Projects › **Ask Where to Save** to always use the Projects Folder.

### A folder you made yourself, connected to an assignment

- **TMCode notices the folder.** When you open a folder that isn't connected and you have assignments waiting, TMCode asks: *"Is this your work for an assignment?"* The Assignments view also shows a note with **Connect…**.
- **Projects: Connect This Folder to an Assignment…** (also in an assignment row's menu: **Use the Open Folder for This…**):
  - **Assignment not started yet:** it starts with your folder, automatically.
  - **You already have a project for it:** TMCode asks whether to **Replace with This Folder** (Task Mentor keeps the earlier versions in its history) or **Continue** with the project you have.
- **Not an Assignment** stops TMCode from asking again for that folder.

### Submitted or not: always clear

- **A banner over your code** says where the assignment stands, with the one thing to do:
  - **Not submitted yet** (orange), with **Go to Submit**, which brings up the brief with its Submit button;
  - **Returned by your teacher**, with the teacher's message and **Go to Submit**;
  - **Submitted** (green), with the date;
  - **Graded**, with **View Feedback**.
- **Rows in the Assignments view** show an orange **Not submitted** label until the work is handed in, and a tick once it is.
- **The status bar** reads "In progress: not submitted" or "✓ Submitted".
- **Before quitting:** if the open assignment isn't submitted and is due within two days (or is late), TMCode asks: **Submit Now**, **Quit Without Submitting** or **Cancel**.

### Several projects at once

- **File › New Window** (⇧⌘N / Ctrl+Shift+N) opens another TMCode window, each with its own folder, terminals and editors.
- **File › Open Folder in New Window…** picks a folder and opens it in a new window.
- **Open in New Window** is in the menu of a project in Projects, and of a started assignment in Assignments.
- **New Window** is also on the Welcome page.

### Previews

- **Markdown (.md):**
  - **Edit** (first) and **Preview** tabs above the file, as on GitHub;
  - Preview shows headings with # links, tables, code with colours and pictures from your folder;
  - **tick a task box** (`- [ ]`) in Preview to update the file; the change is unsaved and can be undone.
  - Ctrl+K V still opens a preview beside the file.
- **CSV and TSV:** Preview shows a table with a header row, row numbers and a **Filter rows** box.
- **PDF:** opens as pages, with zoom and "Page 1 of 9". Long PDFs open at once; pages are drawn as you scroll to them.
- **Word (.docx):** opens as a page with its headings, lists, tables and pictures. Fonts and page layout aren't shown.
- **Pictures, audio and video** preview as before.
- **Not previewed yet:** old .doc files, Excel and PowerPoint. They open as binary files; **File › Reveal in Finder** (Reveal in File Explorer on Windows) shows them so you can open them in their own app.

### Also in this release: everything since 0.23

TMCode 1.1 is the first release since 0.23, so it also brings the work below.

#### A terminal that shows what each command did, coloured folders, and files you can give TMCode AI

The terminal marks every command with a dot (blue: it worked, red: it failed), jumps between commands with ⌘↑/⌘↓, and keeps the running command pinned at the top while its output scrolls, as in VS Code. Folders in the Explorer now have colours. And you can attach files to a TMCode AI question: with the paperclip, by dropping them on the chat, or by pasting.

**Terminal**

- **A dot beside every command.** Blue when it worked, red when it failed, hollow while it runs. Click the dot to:
  - Copy Command;
  - Copy Output;
  - Re-run Command.
- **⌘↑ / ⌘↓ (Ctrl+↑ / Ctrl+↓)** jump to the previous or next command.
- **Sticky scroll:** while a long output scrolls, its command stays at the top. Click it to go back to the command.
- **New commands:** Terminal: Copy Last Command Output and Copy Last Command.
- **Run Recent Command** lists the exact commands the shell ran, not guesses.
- **A coloured prompt** when your shell's prompt has none (zsh and bash): your name, the folder, the git branch, and a red ✗ after a failed command. A prompt you set up yourself (oh-my-zsh, starship…) stays as it is.
- **Sharper, faster text:** the desktop app draws the terminal with the GPU, and text colours are adjusted to stay readable.
- **New settings (Terminal):**
  - Shell Integration;
  - Coloured Prompt (When the shell's prompt has no colours · Always · Never);
  - Sticky Scroll;
  - GPU Acceleration;
  - Font Family;
  - Line Height;
  - Minimum Contrast Ratio.
- Works in zsh, bash and fish. PowerShell and Command Prompt work as before, without the dots.

**Explorer**

- **Coloured folders.** Every folder has an icon coloured by what it usually holds, for example:
  - src: green;
  - tests: teal;
  - docs: blue;
  - build output: red;
  - .github and similar: grey.

  Files keep VS Code's Seti icons.
- **Your choice is kept.** The new default is "Seti with Coloured Folders (TMCode)". If you used plain Seti, you move to it once. To go back, pick "Seti (Visual Studio Code)" in Preferences › File Icon Theme.

**TMCode AI: attach files**

- **Three ways to attach:**
  - the paperclip next to Send;
  - drop files from Finder / File Explorer or the Explorer onto the chat;
  - paste files you copied.
- **Long pasted text** (an error log, a long output) becomes a "Pasted text" chip instead of filling the box.
- **Chips:** each attachment shows as a chip with its size, and ✕ removes it. Up to 5 files per question.
- **What is sent:** the text of each file goes with your question, like an @-mention. Very long files send their start, and the chip says so.
- **Not in exams:** you can't attach files during an exam.

#### Show TMCode AI a picture

Paste a screenshot (⌘⇧4, then ⌘V in the chat), drop an image on the chat, or attach one with the paperclip, and ask about it: an error on a web page, a design to build, a diagram. It goes to an AI that can read images.

**Images in TMCode AI**

- **Three ways to add an image:**
  - paste a screenshot or a copied image;
  - drop a PNG, JPEG, GIF or WebP on the chat;
  - pick one with the paperclip.
- **What you see:** each image shows as a thumbnail chip, and the sent question shows the images above its text.
- **Size:** large images are scaled down (longest side 1568 px) before they are sent, so they cost less and answer just as well. Up to 4 images per question.
- **Which AI answers:**
  - Free and Auto choose a model that can read images.
  - If the model you picked can't, TMCode says so and suggests Auto, so nothing is sent for nothing.
- **Needs Task Mentor from 2026-10-31.** With an older Task Mentor, images aren't offered, and code and text attachments work as in 0.24.

#### Never lose work

Unsaved files now survive quitting and crashes, as in VS Code. Large files open, and binary files can be opened anyway or viewed in a hex viewer.

**Unsaved files come back**

- **Quitting doesn't ask any more.** Quit with unsaved files and TMCode keeps them: when you open the folder again, they are there, still unsaved, exactly as you left them. New untitled files (⌘N) too.
- **After a crash:** if TMCode closes unexpectedly (or the computer turns off), your unsaved files come back the same way, and TMCode tells you.
- **How it works:** a copy of each unsaved file is kept a moment after you type, and removed when you save or revert.
- **To be asked again** before quitting, set Hot Exit to "off" (Settings › Files and Search).
- **Exams:** nothing changes. Exams keep their own journal and send every change to Task Mentor.

**Large and binary files**

- **Large files open** (up to 50 MB; the limit was 5 MB). Above 5 MB the minimap, folding and some highlighting turn off so typing stays fast, and a bar says so.
- **Binary files:** instead of an error, TMCode offers:
  - **Open Anyway** shows the file as text, read-only, so it can't be damaged by a save;
  - **Open in Hex Viewer** shows its bytes (offset, hex, characters), up to 16 MB.

**Auto Save**

- **New option "onWindowChange":** saves when you switch to another app.
- **"onFocusChange"** now also saves when the TMCode window loses focus.

#### More help from language servers

Python (Pyright) and every other built-in language server now bring quick fixes, formatting, inline type hints, code lenses, semantic colouring, smart folding and Expand Selection, as in VS Code.

**Language servers**

- **Quick fixes and refactorings:** the light bulb, or ⌘. / Ctrl+., offers the server's fixes for the problem under the cursor (remove an unused import, add a missing one…). The preferred fix is first.
- **Format Document and Format Selection** use the language server when it formats (Shift+Alt+F). Format Document With… lists it beside Prettier.
- **Inline hints:** types and parameter names show inline when the server sends them.
- **Code lenses:** reference counts, Run Test and similar links appear above code when the server offers them.
- **Semantic colouring:** variables, parameters and functions are coloured by what they are, not only by syntax.
- **Folding, Expand / Shrink Selection and links in code** follow the language's structure.
- **Go to Symbol in Workspace (⌘T, or # in Quick Open)** finds functions and classes across the project.

#### tasks.json the way VS Code runs it, problems from any tool, and attaching the debugger to a running program

**Tasks**

- **Run Task lists `.vscode/tasks.json` first,** then tasks from extensions, then the scripts TMCode finds (npm, Make, Maven, Gradle…).
- **Dependencies (`dependsOn`)** run first, all together or one after another (`"dependsOrder": "sequence"`). If one fails, the task that needs it doesn't run, and TMCode says which failed and with what exit code.
- **Questions before a task runs (`${input:…}`):** `promptString` asks you to type a value, `pickString` offers a list.
- **Variables:** `${file}`, `${fileBasename}`, `${fileDirname}`, `${workspaceFolder}`, `${env:…}` and the other usual ones work.
- **Watch tasks (`"isBackground": true`)** keep running and update Problems after each rebuild.
- **Tasks that start with the folder (`"runOptions": { "runOn": "folderOpen" }`)** run after you allow them once for that folder.
- **New commands:**
  - Run Test Task;
  - Configure Task, which creates a starter tasks.json.

  Both are in the Terminal menu.
- **Extensions' tasks** (an npm or Gradle extension, for example) appear in Run Task and run in TMCode's terminal.

**Problems from any tool**

- **Problem matchers:** a task's `problemMatcher` turns its output into Problems and squiggles. The built-in ones are:
  - `$tsc` and `$tsc-watch`;
  - `$gcc`;
  - `$eslint-stylish`;
  - `$msCompile`;
  - `$go`;
  - `$javac`;
  - `$python`.

  Your own `pattern` (one or several lines, `loop`) works too.

**Debugging**

- **Attach to a running program:**
  - Node.js started with `--inspect`;
  - Python started with `python -m debugpy --listen 5678`;
  - or pick the process from a list (`${command:pickProcess}`).

  New starting points for all of these are in Add Configuration….
- **Run menu:** Add Configuration…, Conditional Breakpoint…, Logpoint… and Remove All Breakpoints.

#### Find files in the Explorer, see who changed a line, a commit graph, a merge editor, and faster search

**Explorer**

- **Find in Explorer** (⌥⌘F / Ctrl+Alt+F with the Explorer focused, or the 🔍 button): type part of a name to see the matching files with their folders, even in folders you haven't opened. Enter opens the first match; Esc closes the box.
- **Open Editors:** a section at the top of the Explorer lists your open files by group. It shows the unsaved dot, closes files, and has Save All and Close All.
- **File nesting** (Settings › Explorer: File Nesting): related files sit under their file, for example:
  - package-lock.json under package.json;
  - app.js and app.d.ts under app.ts;
  - style.css under style.scss.
- **Drag files to TMCode AI:** drag files from the Explorer onto the chat to attach them to your question.

**Git**

- **Blame:** the status bar shows who last changed the current line, and when (hover for the commit). Turn on "Git: Blame After the Line" to see it, with the commit message, at the end of the line.
- **Graph:** Source Control shows every branch's commits with their lines, merges and branch names.
- **Merge editor:** "Resolve in Merge Editor" on a conflict shows each conflict's two changes side by side:
  - Accept Current, Accept Incoming or Accept Both, with the result shown below each conflict;
  - **Complete Merge** saves the file and stages it.

**Search**

- **Faster:** the desktop app finds which files match in parallel, so searching large projects is much quicker. Unsaved changes are still searched as you see them.
- **Open in editor:** the results open as a document you can keep, scroll and copy from. F12 or ⌘-click on a result takes you there.

#### More windows and more room

Open a second TMCode window, put the Panel beside the editor, centre the editor on wide screens, and open VS Code workspace files.

**Windows**

- **File › New Window (⇧⌘N / Ctrl+Shift+N)** opens another TMCode window: work on two projects side by side. **Open Recent in New Window…** opens a recent folder there.
- **Each window keeps its own layout,** open editors and unsaved-file backups. It starts with your settings, recent folders and sign-ins.
- **Not available during exams.**

**Layout**

- **Move Panel Left / Right / Bottom** (View commands, or Settings › Panel: Position): put the Terminal, Problems and Output beside the editor on wide screens. The position is remembered.
- **Centered Layout** (View › Centered Layout): the editor stays in the middle of a wide window, with space on both sides.

**Workspace files**

- **Opening a `.code-workspace` file** opens its first folder.
- **Several folders:** the status bar shows which one is open ("client (1 of 3)"). Click it to switch to another.
- TMCode still shows one folder at a time; the workspace file's own settings aren't applied.

#### Your setup, your way, everywhere

Keyboard shortcuts in keybindings.json, folder settings you can edit, profiles, and Settings Sync through your NGA account.

**Keyboard shortcuts as JSON**

- **Preferences: Open Keyboard Shortcuts (JSON)** opens keybindings.json in VS Code's format, for example `{ "key": "ctrl+alt+t", "command": "workbench.action.terminal.new" }`.
- **What you can write:**
  - `"when"` limits where a shortcut works (`editorTextFocus`, `terminalFocus`, `editorLangId == python`…);
  - a command written `"-command"` removes its key;
  - the last rule wins.
- Valid rules work as soon as you type them.

**Settings**

- **The Workspace tab of Settings can now be edited:** changes are saved in the folder's `.vscode/settings.json` (comments kept), and **Reset** removes them.
- **Only folder-level settings are listed:** tabs, formatting, wrapping and the like. Personal ones (font size, theme) stay yours.

**Profiles**

- **Separate setups:** keep one for Python, one for web projects, one for practice, each with its own settings and shortcuts.
- **Profiles commands:**
  - Create Profile… (from your current setup or TMCode's defaults);
  - Switch Profile…;
  - Delete Profile…;
  - Export Profile… (a `.tmcode-profile.json` file to share);
  - Import Profile from the Open File.
- The profile in use shows in the status bar.

**Settings Sync**

- **Settings Sync: Turn On Settings Sync…** (signed in to NGA): your settings, shortcuts and profiles follow your account to another computer.
- **First time on a computer whose account already has settings,** you choose which to keep. After that, changes go up a few seconds later, and come down when TMCode starts or when you choose Sync Now.
- **Not during exams.** Needs Task Mentor's Settings Sync (2026-10-31 and later).

#### More extensions work

Extensions that add a source control, tests or debug configurations now show them in TMCode. Extensions that use features TMCode doesn't show (notebooks, AI chat participants, language models) keep working instead of failing.

**Extensions**

- **Source control from extensions** (Mercurial, Perforce, Jujutsu…) shows in the Source Control view, beside git:
  - its changed files, by group (deleted ones struck through);
  - its message box and commit button;
  - clicking a file runs the extension's command.
- **Tests from extensions** (Jest, pytest, Go, Java test extensions…) show in Testing:
  - Run All, or run one test, from there;
  - passed and failed tests are marked;
  - a failure shows its message (expected and actual values when the extension gives them);
  - clicking a test opens it in its file.
- **Debug configurations from extensions** appear in Add Configuration…, and an extension can adjust a configuration (or stop it) before TMCode starts it. `debug.startDebugging` starts TMCode's debugger.
- **Notebooks, chat participants and language models:** an extension that uses them starts and runs without errors. TMCode doesn't show notebooks or other AI chat participants, and offers no language models to extensions (TMCode AI is built in).
- Extensions' own debug adapters (a debugger TMCode doesn't have) still don't run.

#### In French, easier with a screen reader, and quick to report a problem

**Display language**

- **Preferences: Configure Display Language** (or Settings › Display Language) switches TMCode's menus, views, panel tabs and Settings to **French**.
- **Not translated:** your code, Task Mentor's words and extensions stay as they are.
- **Kinyarwanda** comes once a translator has reviewed it.

**Accessibility**

- **Accessible View (Alt+F2 / ⌥F2):** shows the terminal's output, TMCode AI's last answer or a notification as plain text that a screen reader reads line by line, and that you can copy from. Esc goes back.
- **Accessibility Signals** (Settings › Accessibility), short sounds when:
  - the cursor reaches a line with an error or a warning;
  - a terminal command fails;
  - a task finishes or fails;
  - the debugger stops.

  They are on with the screen reader, and you can set them to always or never.

**Help**

- **Help › Report a Problem…** opens a report with TMCode's version, your system and recent errors. You fill in what happened and copy it to your teacher or the TMCode team. **TMCode sends nothing itself.**

**Quality**

- **Performance budget:** startup, opening a file and typing are checked by the test suite.
- **Screen comparisons** of the Explorer, editor and status bar in Dark and Light Modern are available (`npm run test:visual`).
- **Menu fix:** the File menu says "New Project from Starter…", the word the rest of TMCode uses.

### All changes

- CI: e2e in 8 parallel shards, time limits, one retry on CI
- explorer-search-git e2e: wait for the side bar to settle before dragging (slow CI)
- shell_integration tests: expect this OS's path separators (Windows CI)
- Fix the release gate: Explorer height, one Submit door, stale tests
- Release notes 1.1.0: everything since 0.23 in one place
- Assignments UX, several windows, document and Markdown previews
- Rebuild the extension host and Java DAP bundles
- Reach and quality: French display language, Accessible View, signals, Report a Problem, budgets
- scmTesting.test: type the run handler's request as the API does
- Extension API: source control, tests, debug configuration providers, safe notebooks / chat / lm
- Settings: keybindings.json, editable workspace settings, profiles, Settings Sync
- Layout and windows: New Window, Panel position, Centered Layout, workspace files
- Explorer find, file nesting, Open Editors, git blame and graph, merge editor, faster search
- tasks.spec: drop an unused helper
- Tasks, problem matchers and debugger attach
- Language servers: code actions, formatting, inlay hints, code lens, semantic tokens and more
- Never lose work: hot exit, crash recovery, large and binary files
- TMCode AI: images in questions (paste a screenshot, drop or attach one)
- Terminal shell integration, coloured folders, and file attachments in TMCode AI

## 0.23.0 — 2026-10-30

**TMCode 0.23: PHP runs without installing PHP, PHP files can start with HTML, and new PHP website and CMS starters.** Without PHP on the computer, Run now sends your PHP to the school's code runner, the same one the MIS Code Playground uses: a page opens in the preview with its links and forms working, and a script runs in the Run panel with keyboard input. With PHP installed, nothing changes.

### PHP without installing PHP

- **Run a PHP page or website on the school's runner.** It opens in the preview, rendered like the MIS Code Playground:
  - links and forms open the next page (`$_GET` and `$_POST` filled), with Back and Run Again;
  - the page re-runs when you save;
  - PHP warnings and errors show in the preview's console.
- **Run a PHP script on the school's runner.** Its output appears live in the Run panel, and you can type input while it waits.
- **PHP installed:** Run still uses `php -S` (or `php file.php`). Run ▾ also offers "… on the School Runner", and TMCode remembers your choice.
- **Still need PHP installed:** Composer, Laravel, PHPUnit and `php -a`. The install card says so.
- On the school's runner every page runs fresh, so files a page writes (a CMS's posts) aren't kept. Run PHP locally to keep them.

### PHP files can start with HTML

- `.php` files are coloured as HTML with PHP inside (VS Code's grammar). HTML before `<?php`, or a file with no `<?php` at all, now looks right instead of broken.

### New PHP starters

- **PHP website (HTML, CSS & JavaScript):** pages sharing a header and footer, a stylesheet, a script, and a contact form that validates and escapes what it shows.
- **PHP CMS:** posts kept in a JSON file, public list and post pages, and an admin form to add and edit posts (CSRF token, Post/Redirect/Get).
- PHP's website starters are also listed under **Website (HTML, CSS, JavaScript)**.

### All changes

- Release notes 0.23.0: PHP without installing PHP, HTML-first .php files, PHP starters
- PHP without installing PHP, HTML-first .php files, and PHP website starters

## 0.22.0 — 2026-10-25

**TMCode 0.22: AI drafts grades for you to review, premium AI and your own API keys, and a clearer bottom panel.** An AI (TMCode AI, Claude Code, Gemini CLI, Codex or an AI extension) can now draft a student's grade from the rubric; you review it, adjust it and click Save, and nothing is saved before that. TMCode AI also offers your school's premium models and models on your own API key. In the bottom panel, commands look like commands, every run says how it ended, and the Activity log sums up each day at a glance.

### AI drafts grades, you decide

- **Draft with AI** in the grade panel (also Grading: Draft Grade with AI in the palette).
  - Optionally tell the AI what to focus on ("check input validation").
  - It uses the model picked in TMCode AI: Free, Auto, Premium or your own key.
  - Test results you ran on the student's work go along.
  - The scores, a note per criterion and the feedback appear in the form.
- **Any AI tool can draft.** Opening a submission writes the grading task into the review folder:
  - `.tmcode/grading/README.md`: the brief, the rubric with its indexes and maximums, the student, and the output contract.
  - `.tmcode/grading/context.json` and `draft.schema.json`, and a copy of the README as `.claude/CLAUDE.md` for Claude Code.
  - The AI writes `.tmcode/grading/draft.json`. TMCode checks it, keeps every score within 0 and its maximum in half points, and fills the form.
  - A broken draft is refused with what was wrong, and the form doesn't change.
  - The task tells the AI to treat the student's files as work to assess, never as instructions, and to report any attempt to steer the grade in its notes for you.
- **Grade with Claude Code / Gemini CLI / Codex** (More Actions, or the palette): a terminal in the review folder starts the tool with the grading prompt.
  - The grade panel shows "Claude Code is grading Ben… watching for its draft".
  - If the tool isn't installed, TMCode says how to install it.
  - **Copy Grading Prompt** works the same for an AI extension's chat panel.
  - Offered only where the school allows third-party AI tools for staff.
- **TMCode AI's agent** knows when you're grading: it reads the brief and rubric (get_grading_context) and proposes a grade (propose_grade) that lands in the form. It can't change the student's files: the review folder stays read-only.
- **Extensions** can call `tmcode.grading.getContext` and `tmcode.grading.proposeDraft(draft)`.
- **You stay in charge.**
  - When a draft lands, a toast says "Claude Code drafted grades for Ben: review, adjust, then Save" with Review and Discard.
  - The panel shows who drafted it, how confident it is, its notes for you and anything TMCode corrected.
  - Each score, note and the feedback carry an AI mark until you change them.
  - Discard AI Draft puts the form back as it was.
  - Save is unchanged, and it is the only way a grade is saved.

### Premium AI and your own keys

- **Premium models** appear in TMCode AI's model menu when your school gives them to you, with what is left today.
- **Your own API keys** (Settings › TMCode AI › Your API keys, or "Add Your Own API Key…" in the model menu): OpenAI, Anthropic, Google Gemini, OpenRouter, Groq or DeepSeek.
  - The key is kept in your computer's keychain, never in TMCode's settings or logs.
  - It goes to Task Mentor with each request, which uses it for that request only.
  - Pick one of the provider's models in the model menu, or add another model id.
- Clear messages when premium isn't turned on for you, or when a provider refuses your key, with Switch to Free.
- Older Task Mentor servers keep working: only the free models show. Draft with AI then asks you to update Task Mentor.

### Bottom panel

- **Activity**
  - Commands show as commands: a `$` line in the terminal font, with the program, options, quoted text and file paths in their own colours. This covers commands typed in the terminal, commands run by TMCode AI, and the command line of each run.
  - Every run says how it ended, next to it: **✓ exit 0 · 1.2 s** in green, **✗ exit 1** in red, or **stopped**. A run still going shows **running**.
  - Each run is one entry. Before, one run could appear twice, and some read "Ran Run main.cpp".
  - Each kind of entry has its own colour: runs, terminal commands, git, extensions, AI, changes made outside the editor, and pastes from outside TMCode.
  - The filters show how many entries each one has, in one row. Empty filters are dimmed.
  - Each day's header sums up the day: actions, file changes, runs and how many failed, pastes and how many came from outside TMCode, time spent in other apps, and AI use. Plurals are right ("1 action").
  - Click an entry to see its details in plain words: the result, how long it took, the command, and where pasted text came from. Internal names like "kind: runFile" are no longer shown.
  - The search box says **Filter activity**.
  - The AI colour now also works in light themes. The Activity tab marks AI use today with a small ✦ and a count, instead of a badge that looked like unread items.
- **Run panel**
  - The command shows as a bold, coloured `$` line.
  - The program's end is its own line: **✓ Process exited with code 0 in 1.2 s** in green, **✗ Process exited with code 1** in red, or **■ Process stopped**.
  - The Run panel's first line no longer says "Running Run main.cpp".
- **Output**
  - With one channel picked, its name isn't repeated on every line.
  - Warnings and errors get an icon and a light tint.
  - Lines highlight under the mouse, and the spacing matches the other views.
- **Debug Console and JavaScript Console** rows highlight under the mouse, with the same spacing as Output. Warnings are easier to read in light themes.
- **Terminal and Run panel:** the space under the last line now matches the theme. Before, it was black in every theme.
- **Terminal find** uses the theme's colours for matches.
- **Panel tabs:** when the tabs don't fit, the hidden side fades out and the selected tab scrolls into view. Tabs show a focus ring when you use the keyboard.

### All changes

- Release notes 0.22.0: AI-assisted grading, premium AI, own keys
- AI-assisted grading: any AI drafts, the teacher reviews and saves
- TMCode AI: premium models and your own API keys
- Own AI provider keys in the OS keychain (ai_key_set/get/delete)
- Release notes 0.22.0: bottom panel
- Panel: tab strip, Output levels, quiet AI mark, consoles in line
- Activity: status and day summaries read as text; e2e for one run entry
- Run console: a coloured $ prompt and one clear status line
- Runs are logged once, with their exit code and duration
- Activity: commands as coloured chips, run status chips, day summaries

## 0.21.0 — 2026-10-25

**TMCode 0.21: AI settings take effect within seconds, and the Explorer manages files like VS Code.** When the school, a teacher or an administrator changes who may use AI, TMCode reacts at once. In the Explorer you can paste files copied in Finder, undo file operations, and more.

### Live AI settings

- TMCode keeps a line open to Task Mentor and hears when the AI settings change:
  - the school's AI policy, within about 5 seconds;
  - a teacher's AI setting for the quiz or assignment you're working on;
  - roles and permissions.
  - The AI panel, suggestions, AI extensions and AI terminal tools then follow the new decision straight away.
- TMCode also checks again every 15 seconds, and whenever it comes back to the front, in case the line drops.
- **During exams too:**
  - If the teacher turns AI on or off for the quiz while the exam runs, or the school turns AI off, TMCode follows it.
  - The exam package's setting applies only until Task Mentor's first answer during the exam.
  - AI extensions and AI terminal tools still never run in exams.
  - Only TMCode AI's own requests are allowed through during an exam; projects and assignments stay closed until it ends.
- Older Task Mentor servers without live updates keep working: TMCode falls back to checking every 15 seconds.

### Explorer: copy, paste and manage files like VS Code

- **Files copied in Finder now paste.**
  - Copy files or folders in Finder, then right-click the Explorer (or a folder) and choose **Paste**, or press ⌘V.
  - Before, Finder's clipboard was read wrongly on macOS and nothing happened.
  - Files copied in File Explorer on Windows paste the same way.
- **Paste in the empty space.** Right-clicking below your files now offers:
  - Paste;
  - Reveal in Finder / File Explorer;
  - Open in Integrated Terminal;
  - Find in Folder.
  - When there's nothing to paste, TMCode says so.
- **Undo file operations.** With the Explorer focused, ⌘Z (Ctrl+Z on Windows and Linux) undoes the last rename, move, paste, duplicate, new file or folder, or import from Finder. Edit › Undo does the same.
  - Deleted files are still restored from the toast's **Undo**, or from the Trash.
- **Cut files are dimmed** until you paste them.
- **Drag with Option** (Ctrl on Windows and Linux) to copy instead of move.
- New in the right-click menu:
  - **Open in Integrated Terminal**: a terminal in that folder.
  - **Find in Folder...**: Search limited to that folder.
  - **Select for Compare** / **Compare with Selected**: a diff of two files.
- On macOS, **⌘↓** opens the selected file.

### Activity: every copy and paste, for your teacher

- Every paste is now recorded, including pastes from the editor's right-click menu and Edit › Paste on macOS, which were missed before.
  - Each paste says where the text came from: copied inside TMCode, an AI's answer, or another app.
- Text you drag in from a browser or document is recorded too.
- Copying and cutting files in the Explorer are recorded.
- Time spent in other apps (30 seconds or more) is recorded as "Away from TMCode for 3 min". Clicking into TMCode's own preview panes doesn't count.
- In Task Mentor, a submission's **Activity** tab now counts the whole history:
  - copies, cuts and pastes, with how much was pasted from outside;
  - files brought in;
  - AI use by tool, and blocked attempts;
  - time in other apps.
  - Older entries load on demand.

### Terminal fits the panel again

- Long output no longer runs past the bottom of the panel and hides the prompt. The terminal fits the panel, scrolls, and keeps the newest line and the cursor in view, as in VS Code.
- Resizing the panel re-fits it.

### All changes

- Release notes 0.21.0: activity and terminal
- Activity: every paste, text dragged in, Explorer copy/cut and time in other apps
- Terminal fills the panel and scrolls: the prompt no longer hides below it
- Release notes 0.21.0: Explorer file management
- Explorer: VS Code file management -- Finder paste fixed, Paste in the empty space, undo, cut dimming, Option/Ctrl-drag copy, terminal, Find in Folder, compare
- TMCode AI reacts to changed AI settings within seconds

## 0.20.0 — 2026-10-25

**TMCode 0.20: your school and your teacher decide when AI can be used.** TMCode AI, AI extensions and AI command-line tools now follow Task Mentor's AI setting. That setting combines the school's AI switch, the teacher's choice for an assignment or quiz, and your role.

### TMCode AI follows the school's and the teacher's setting

- Every TMCode AI request says which **Task Mentor project** is open, so the teacher's setting for that assignment applies.
- When AI is off, the AI panel says why, in Task Mentor's words or TMCode's own:
  - "Your school has turned AI off."
  - "Your teacher turned AI off for this assignment."
  - "Hints only for this assignment."
  - "AI isn't turned on for your account."
- The decision is checked again whenever you open another project, and every minute after that. A change by the school reaches you without restarting TMCode.
- **Exams:** TMCode AI is off unless the teacher chose **Full assistant** for the quiz (the exam package's new `policy.ai`). AI extensions and AI command-line tools never run during exams.
- Older Task Mentor servers that don't send the new fields keep the old rule: AI is on outside exams and off during them.

### Third-party AI tools: extensions and terminal tools

- **AI extensions** (Claude Code, Copilot, Codex, Gemini, Cline…) run only when Task Mentor allows third-party AI tools. Until Task Mentor answers, they stay off in an assignment's project. Your other extensions keep working. The **Install** buttons are disabled and show the reason.
- **AI command-line tools** in the terminal (`claude`, `codex`, `gemini`, `copilot` / `gh copilot`, `aider`, `opencode`, `cursor-agent`, `qwen`, `amp`, `goose`, `ollama` and others) follow the same rule. While they are off:
  - New terminals reply "AI tools are turned off: …" when you run one.
  - AI provider keys are removed from the terminal's environment.
  - A tool that starts anyway, or an install of one (`npm i -g @anthropic-ai/claude-code`, `pip install aider-chat`, `brew install …`), is stopped within a few seconds.
- Every attempt is recorded in the **Activity log**, so your teacher sees it. AI tools that are allowed are recorded too.
- This control runs on your computer and is best-effort. A renamed program, your own code calling an AI service directly, or a container can get past it.

### All changes

- Revert manual 0.20.0 bump; scripts/release.mjs does it
- Version 0.20.0: AI usage control (changelog)
- e2e: TMCode AI shows Task Mentor's reason when AI is off
- AI CLIs in terminals follow Task Mentor's AI status too
- Third-party AI extensions follow Task Mentor's AI status
- TMCode AI follows Task Mentor's AI status for the open project
- protocol: exam policy gains ai (off | hints | full), default off
- install-languages: keep arduino-cli's staging folder (it is created on every start)
- Runner: Arduino (Uno) — compile sketches to firmware
- judge: live runs show only the program's own stderr

## 0.19.0 — 2026-10-14

**TMCode 0.19: TMCode AI works on your project, and Claude Code installs.** Choose how TMCode AI works, the way Claude Code does, and install Claude Code, Codex (ChatGPT) or Gemini from the AI panel.

### TMCode AI works on your project

- **Modes**, as in Claude Code (switch with **⇧Tab** in the prompt box):
  - **Chat:** answers and explains; nothing in your project changes.
  - **Manual:** works on your project and asks before each change, showing you the change first.
  - **Edit automatically:** makes the file changes directly; commands still ask.
  - **Plan:** explores your code and presents a plan. Then **Start building**.
  - **Auto:** changes and safe commands (tests, builds, running your program) go ahead; anything risky waits for your OK.
- **See every step:** reading, searching, editing and running, each as a card you can open to see the change or the output.
- **Approve, Approve all or Reject.** A rejected change is never made.
- **Undo all** puts back every file a request changed.
- Everything the AI does is in your **Activity log**.

### Prompts

- **Copy** any question or answer: answers can now be selected too.
- **Edit and send again**, **Send again**, and **Ask about this answer** (it goes along with your next question).
- **↑ / ↓** bring back earlier prompts.
- **@** adds a file to your question (type `@` and pick one).

### AI extensions install

- **Claude Code installs and runs.** TMCode now downloads the build made for your computer (it used to pick another system's), allows the size AI extensions need (Claude Code is over 100 MB), shows the download's progress, and keeps their bundled program runnable.
- **Use other AI assistants** in the TMCode AI panel: Claude Code, Codex (ChatGPT), Gemini Code Assist, Cline and Continue, each with **Install** and then **Open**.

### All changes

- TMCode AI works on the project (Claude Code's modes); AI extensions install (0.19.0)
- judge: live sessions feed SQL its script on stdin

## 0.18.1 — 2026-10-14

**TMCode 0.18.1: TMCode AI answers.** In 0.18.0 the AI chat showed an empty warning instead of an answer. It answers now.

### TMCode AI

- **Answers arrive.** TMCode wasn't allowed to receive Task Mentor's streamed answers, so every question failed. They now stream in as they're written.
- **Errors say what happened** ("sign in", "update TMCode", "try again") instead of showing an empty box.

### Code runner

- **Live runs on Task Mentor** work in the desktop app too. They had the same problem.

### All changes

- Allow streamed Task Mentor answers (tm_stream): TMCode AI and live runs (0.18.1)
- judge: live Node runs end when the program stops reading stdin
- Interactive runs show prompts as soon as they are printed (stdbuf -o0 in sessions)

## 0.18.0 — 2026-10-14

**TMCode 0.18: AI the way VS Code has it, and an activity log of your work.** TMCode has its own free AI, AI extensions such as Claude Code and Gemini work in your projects, and everything you do (except typing) is recorded, with AI use named.

### TMCode AI (free)

- **Ask about your code** in the new chat on the right (**⌘I**, or the AI button in the title bar). It sees the open file, your selection and the file's problems.
- **Answers stream in**, with code you can **Copy**, **Insert** at the cursor, or **Apply**. Apply shows the change as a diff first, and you **Accept** or **Reject** it. Undo takes an accepted change back.
- **Explain, Fix, Write Tests** are in the editor's right-click menu.
- **Suggestions while typing** (ghost text, Tab to accept): turn them on with the lightbulb in the chat.
- **Free by default**: OpenRouter's free models. Choose **Auto** and TMCode picks a free AI that still has requests left today, or choose one model. The chat shows how many questions you have left today.
- Sign in to NGA to use it. TMCode AI is always off during exams.

### AI extensions work as in VS Code

- **Claude Code, Gemini Code Assist, Blackbox, Windsurf, Continue and Cline** install from the Extensions view and run.
  - Their chats open, in the new **secondary side bar** on the right where they ask for it.
  - Their suggestions appear as ghost text.
  - Their proposed edits open as diffs you can accept.
- **What extensions can do now**:
  - inline suggestions;
  - documents that live in the extension (shown as diffs);
  - editor tabs (`tabGroups`);
  - terminals that run commands and read their output;
  - sign-in links (`tmcode://`);
  - extension accounts (Accounts: Manage Extension Accounts).

### Activity log

- **Everything except typing is recorded:**
  - files created, renamed, moved, copied and deleted;
  - copy, cut and paste, with where pasted text came from (inside TMCode, an AI's answer, or outside);
  - runs, tests, debugging and terminal commands;
  - git, extension installs, and saves and submits to Task Mentor;
  - changes made outside the editor.
- **Every use of AI is named** on its event: questions, answers, applied code, accepted suggestions, and edits or commands by AI extensions.
- See it in the **Activity** tab of the panel: today's summary, filters (AI, files, copy & paste, runs…), search, and details per event.
- For work linked to Task Mentor (assignments, practicals), the log goes to Task Mentor. **Teachers see it in grading** under a new **Activity** tab, with a summary of AI use and pastes.

### All changes

- TMCode AI (free), secondary side bar layout fix, docs and 0.18.0 notes
- AI extensions work as in VS Code; activity log of every action
- Multi-file programs: go/single and swift/single compile every source; tests link files in all languages

## 0.17.3 — 2026-10-13

**TMCode 0.17.3: the JavaScript Console works in the app.** Programs run, typed expressions are answered, and output arrives the way Node shows it.

### JavaScript Console

- **It runs again in the desktop app.** Running a file showed "NetworkError" and typing an expression showed "EvalError": the app's security rules blocked them. The console now runs in its own sealed sandbox, so both work while the rest of TMCode stays protected.
- **Finished means finished.** A program counts as done only when nothing is left to run: timers, intervals, `await` and `fetch` all complete before "Finished in … ms", as in Node. An interval keeps it running until it is cleared (or you press Stop).
- **`process.exit(code)` ends the program**, including from a timer, and nothing after it runs.
- **An error in a callback fails the run**, after the rest of the program has finished.
- **`console.table` draws a real table**, with an (index) column and a column per key, like Node.
- **`alert()` shows its message in the console.** `prompt()` and `confirm()` explain where input works instead (Run with Node.js, or an HTML page in Live Preview).

### Exams

- **No network for the console during an exam.** Programs can't reach the internet while an exam is open.

### All changes

- Run the JavaScript Console in its own sandbox origin (0.17.3)
- go/single needs file locks in isolate (go build locks its cache); tests use /opt/rust when installed; clearer broken-program and wrapper checks
- Catalog 2026.10.4: offer PHP, Ruby, Bash, Kotlin, C# and Swift (single-file kinds enabled)
- install-languages: swift.org's key file is gzip-compressed without saying so; show gpg/apt errors
- Runner languages: PHP, Ruby, Bash, C#, Kotlin, Swift, Go and Rust on the isolate host

## 0.17.2 — 2026-10-13

**TMCode 0.17.2: release notes that fit.** The update window keeps its buttons on screen and shows the notes properly formatted.

### Update window

- **Install and Restart and Later are always on screen.** Long release notes scroll inside the window instead of pushing the buttons out of view, on any screen size.
- **Release notes read properly:** headings, bold text and lists are shown formatted, not as raw `**` and `###` marks.

### All changes

- Update window: long notes scroll, buttons stay on screen; notes shown as Markdown

## 0.17.1 — 2026-10-13

**TMCode 0.17.1: every view in reach.** The activity bar shows all its views while they fit, and the More menu lists each one once.

### Activity bar

- **Every view stays in the bar while there's room.** Students still see Assignments, Files, Search and Run first, in plain words, then Testing, Source Control, Extensions and any extension's views. A handful of icons is never tucked away.
- **More (…) appears only when the window is too short** for all the icons, and holds just the ones that didn't fit. The view you have open is never moved under More.
- **No more doubles:** "Extensions" appeared twice in the More menu. Each view is listed once.

### All changes

- Activity bar: every view while it fits, More only when short, each view once
- CI: list each judge test in the isolate job (which real-box cases ran or were skipped)
- tm-judge: fix the starter sweep findings (SQLite locks, non-source entries, objc probe, Python data without uv)

## 0.17.0 — 2026-10-13

**TMCode 0.17: runs everywhere.** When your computer can't run a program or its tests, Task Mentor runs them for you, with input you can type. New projects start from the same starters Task Mentor uses. The workspace is easier to use: files move by dragging, pasting shows its result, and PHP websites can live in XAMPP's folder.

### When your computer can't run it, Task Mentor can

- **Run on Task Mentor.** If the language isn't installed (or you're in the browser), the message that says so has **Run on Task Mentor**. Your program runs there and its output appears in the Run panel as it comes.
- **Type your program's input** in the line under the Run panel and press Enter. **Ctrl+C** stops the program, **End of Input** tells it there's nothing more to read, and **Stop** ends the run.
- **This works in exams too**, so a program that reads input can be tried even on a computer without the language.
- **Example tests run on Task Mentor** when your computer can't run them, for any language Task Mentor knows. The Testing view says "run on Task Mentor", and each result says why it failed in plain words.
- **Unit tests on Task Mentor.** pytest, JUnit, node:test, go test and others run there when they can't run here. The results are in the Testing view, failures first, each with its message and a link to the file and line.
- **Colours you can read at a glance:** green passed; red wrong answer, crash or didn't compile; orange a limit (too slow, too much memory or output, a missing package); blue information.
- All of this appears only when your Task Mentor offers it. With an older Task Mentor, TMCode works as before.

### Coding questions checked by unit tests

- A coding question that your teacher checks with unit tests says so: "Your teacher's tests check this when you submit. You can run your own tests here." There's no empty "Run them" button.
- **Open Testing** runs your own tests on Task Mentor (never your teacher's tests).

### New projects from starters

- **New Project from Starter…** asks for a language, then a starter: a first program, an exercise with input and output, a project with tests, a website or an API. The starters are the same as Task Mentor's, so a project starts the same way everywhere.
- An assignment with no starter files offers starters for its language only.
- Run and Test know many more languages (Haskell, Zig, Ada, Lua, R and others) from the same list Task Mentor uses. Example tests can live in `.nga/tests.json` (the starters' file) or `.tmcode/tests.json`.

### The workspace

- **The brief's bottom bar** sits on the tab's bottom edge, full width.
- **Drag a file or folder onto a folder to move it.** Editor tabs drag to another group or an edge again.
- **Paste shows what it did:** it opens the folder, selects what arrived, and says "Copied main.py to py". Files copied in Finder or File Explorer paste in too, and Edit › Cut, Copy and Paste work on the Explorer.
- **Clicking a file that is already open brings its tab forward**, wherever it is.
- **Sync Now** on the brief sends your work and gets anything newer. When the network comes back, TMCode sends what you saved while offline.
- **Pictures in the brief keep their shape**; click one to see it full size.
- **Live Preview:** phone, tablet and laptop frames in their real shape, turned sideways, zoomed, **Full Screen**, and **Open in Browser**.

### PHP websites and where projects live

- **Projects Folder** (Settings) chooses where new projects go.
- **XAMPP, MAMP, WAMP and Laragon are found.** Starting a PHP assignment asks once whether it goes in the web server's folder (served at `http://localhost/…`) or your Projects Folder.
- A PHP project in a web server's folder gets **Open in XAMPP** first. Elsewhere it runs with PHP's own server on a free port, and opens the page you're editing.
- **Projects: Move This Project…** moves a project (into htdocs, another drive…) and reopens it there.

### Running languages

- PHP, Ruby, Kotlin, Dart and Swift run in the Run panel with keyboard input and example tests.
- Go and Rust on Windows find the program they built; Kotlin on Windows runs both steps.
- A script beside a Node.js package runs the script you're editing. A web page in a subfolder finds `../style.css`.
- Single-file C# says it needs .NET 10 (or a project), with How to Install.

### Teachers

- **Run the Student's Unit Tests** (More Actions in the grade panel, or the palette): the graded version's unit tests run on this computer when it has the tools, else on Task Mentor. Failures come first, each with its message and file:line.
- **Open in Task Mentor** goes to Task Mentor's new pages: To grade, a student's work in Grading, Projects, Starters and the Playground.
- Words are the same as Task Mentor's: Project, Starter, Code assignment, Coding question, Grading, To grade.

### Needs a Task Mentor update

Running on Task Mentor needs the Task Mentor version with TMCode's code runner routes and its runner (tm-judge) for live runs and unit tests. Until then these buttons don't appear.

### All changes

- e2e: Split Down test waits until both groups are laid out before comparing their positions (null box on CI WebKit)
- e2e: the crash-relaunch test waits until the newer run is in the local journal ("Offline: 1 change saved"), not just "Offline", which a missed heartbeat also shows (flaky on CI WebKit, main too)
- install.sh: /opt/junit is set up after the toolchain step now; don't chmod it there
- JUnit console jar installed executable: tm-judge counts (and mounts) only executable tools
- Java unit tests without Maven: JUnit console always installed, on javac's classpath, mounted in the box
- install.sh: python3-pytest from the distro, so Python unit tests work without the toolchain step
- Rust test: on Windows the build output is main.exe (the 0.17 Go/Rust fix)
- tm-judge build: bundle @nga/runtimes' dependencies (zod) on a judge-only install
- Starters: an assignment with no language offers the most-used languages' first programs first (Python was cut off); e2e Java pick
- Brief: the hidden footer is gone once it slides away (visibility), so one Submit is on screen
- Code runner: e2e journeys (practice live run, tests and unit tests on Task Mentor, exam unit question and live run, no code runner, grading), the missing-tool card offers Task Mentor, unit-test language from the test suites; e2e updated for starters and the new words; protocol §3.1 and 0.17 release notes
- Task Mentor's code runner: live runs, example tests and unit tests on Task Mentor when this computer can't
- Testing: example tests are read from .nga/tests.json (the starters' file) as well as .tmcode/tests.json; new tests go to whichever the project has
- Task Mentor links: the new routes (/code/projects/:id, /grading/:type/:id?question=&student=, /grading, /assignments/:id/work, /code/playground, /code/starters), one address builder (grading's and the exam's copies removed)
- Vocabulary: Starter, Code assignment, Coding question, Project, Grading (no more template, practical, workspace in what the user reads); the glossary test bans the retired words in user-facing text
- runtimes: ctest writes its JUnit report where the judge reads it
- tm-judge: go/module may take file locks inside isolate
- Starters and run detection from the Runtime Catalog: New Project from Starter (language, then starter), an empty assignment's starters, the Run hub's kinds (catalog decides, TMCode's local layer runs), any catalog language's single file runs in a terminal from the catalog's steps; old templates and the terminal-runner list removed
- tm-judge: mount a symlinked tool's real folder; CI installs GoogleTest
- Testing: one copy of the test frameworks and report parsers, in @nga/runtimes (the workbench imports @nga/runtimes/testing; TMCode's 0.17 fixes moved there: unittest fallback, selected Python, node:test without package.json, one suite per tests/ folder)
- tm-judge tests: show the build output when a catalog build fails
- tm-judge install: work on Ubuntu 26.04 (no python3.12 package)
- Review: workspace, files and project locations (gap analysis and fixes)
- e2e: workspace fixes (pinned brief footer + Sync Now, drag to move, paste opens its folder, open file comes to the front, preview device/landscape/full screen)
- PHP's built-in server uses a free port (8000, else the next free one); location chooser skips a one-option list
- Run panel profiles for PHP, Ruby, Kotlin, Dart and Swift (keyboard input, example tests, install check; terminal still one choice away); tab dragging between groups uses pointer events (desktop drops)
- Live Preview and the built-in browser: device frames in their own shape, landscape, zoom (fit/50/75/100%), size label, remembered choice, Full Screen (Escape closes), Open in Browser
- Explorer: move by dragging (pointer drag; the desktop's native file-drop handler swallowed HTML5 drops), paste opens the folder and says what it did, paste files copied in Finder/File Explorer, Edit menu Cut/Copy/Paste act on the Explorer, macOS drop position; a file already open comes to the front (never opens in the brief's place); run fixes: Windows .exe for Go/Rust, Ruby exercises, Kotlin on PowerShell, .cts, a script beside a Node package, subfolder HTML pages, PHP server opens the edited page, single-file C# needs .NET 10
- Project location: Projects Folder setting, PHP websites offered the computer's web server folder (XAMPP/MAMP/WAMP/Laragon/Apache, detected with its port), Choose a Folder for templates, Move This Project, Open in XAMPP run action; brief footer pinned to the tab's edge; brief images keep their shape and open full size; Sync Now and resync when back online
- runtimes: wave B starters — hello + io for PHP, Ruby, Lua, Bash, R, plus unit-test projects
- runner host: previews on a separate site (sslip.io / DuckDNS), not a subdomain of amashuri.com
- docs: PROTOCOL §5.6–5.9 — PTY sessions, container tier, previews, per-run databases
- tm-judge: runner host bootstrap (Oracle Always Free A1 + WireGuard), shared-host fallback
- tm-judge: runner images for the container kinds (amd64 + arm64) and build-images.sh
- tm-judge: tier 3 — Docker + gVisor containers, PTY sessions, server previews, per-run databases
- runtimes: per-run database services; sql/postgres and sql/mysql move to tier 3
- runtimes: wave C/D catalog — 28 long-tail languages, hello + io starters for 36
- tm-judge: interactive Sessions API (live pipes over server-sent events)
- tm-judge: run projects from the Runtime Catalog (build, unit tests, caches, checkers)
- @nga/runtimes: runtime catalog, detection and starter projects (wave A)
- tm-judge: compile-error verdict, fresh box per test, Java packages, output caps

## 0.16.0 — 2026-10-12

**TMCode 0.16: calm and guided.** Run, Test and Stop each have one button that says what it will do and why. Your work saves itself, the brief keeps its one main button on screen, and fewer messages ask for your attention. Students get a simpler screen; teachers get one set of numbers and a Grade button.

### Run, Test and Stop

#### One Run
- **Run runs what you're working on, and says why.** Hover over Run in the status bar: "Run main.py, because it's the file you're editing", or "react-app is a React project". The Run panel's first line says the same for programs that run in the Terminal.
- **F5 runs your program.** It starts the debugger only when you've set breakpoints (or chose Debug in the Run menu), so there's no "install the debugger" question unless you want one.
- **Shift+F5 stops anything:** a program, the debugger, a dev server or the JavaScript Console.
- **Change Run Target… is remembered for the folder you chose it in.**
- A web page previews the page you're editing, not the site's index. A `.js` file previews its page only when that page loads it.
- Programs that read input with `prompt-sync` run where you can type.

#### Every language, checked first
- **Before a run, TMCode checks that the language is installed.** If it isn't, one card says so, with **How to Install** and **Check Again**, instead of an error in a terminal.
- TMCode now finds PHP, Ruby, Kotlin, .NET, Dart and Swift, and **Check My Computer** lists them.
- **C and C++** build only the program you run (a folder of exercises, each with its own `main`, now works). **Go** builds the program's own files. **Java** runs classes inside packages. **Kotlin** keeps its build file out of your project.

#### One Test
- **A Test button beside Run**, with a passed/total count. It tests the file's tests, its project's tests, or your example tests, and says which and why.
- **Add a Test:** give an example input and the output you expect; TMCode writes the test for you.
- Python tests run with the built-in `unittest` when pytest isn't installed, use the same Python as Run, and a `tests/` folder is one suite, not two. Plain Node.js test files run without a `package.json`.

### Working on an assignment

- **Your work saves itself:** a few seconds after you save a file, it's in Task Mentor. The brief says "Saving…", then "Saved online". The Save button only shows when automatic saving is off; if saving fails, **Try Again** appears on the brief.
- **The brief keeps its main button on screen:** scroll the brief and Start, Continue or Submit stays at the bottom.
- **One brief at a time:** opening another assignment's brief replaces the first, and says which assignment you're working on before you switch.
- Previews and results open under the brief, never in its place. On a small screen the side bar folds away when the brief opens beside your code.
- **An empty project offers "Create main.py"** (named for the assignment's language), and Submit says "Nothing to hand in yet" until there's a file. Starter templates are only for the assignment's language.
- **Next up on Home says why:** Returned to you, Late, Due soonest or Open now.

### A simpler screen for students

- **Four icons:** Assignments, Files, Search and Run. Source Control, Testing and Extensions are under **More** (Settings › Simple Layout shows them all).
- **A shorter status bar** with what you act on.
- **Your own projects are in Assignments › Other projects:** one place for all your work.
- **Quiz practicals count as tasks** in the badge and on Home.
- Rows show the title, then the status and due date. The course is hidden when you have only one.
- **Fewer messages:** at most two at once, over your code. A message about an assignment you have on screen (submitted, returned, graded) goes straight to the bell, because the brief already shows it.

### Teachers

- **The assignment page's main button is Grade (n),** and its numbers (Students, In progress, To grade, Graded) come from the same list as Grading. "Use Open Project as Starter…" moved to the "…" menu.
- **Grading goes oldest hand-in first,** and says "1 of 2 to grade".
- **No criteria? One final grade.** An assignment or quiz question without grading criteria shows a **Final grade** box, with Full marks and quick scores.
- After Save & Next, the next student's footer says what you saved ("Saved Ben: 18/20"), instead of a message over the Feedback box.
- The student list opens over the grade form instead of pushing it down, and keeps your filter when you change student.
- **Close Review** also closes the grading tab. Reviews open the code first, not the README.
- Home says "No submissions yet" instead of "Done", and due dates are plain facts for teachers, not red warnings.
- New palette commands: **Start Grading**, **Return for Changes…**, **Show Brief**, **Start or Continue an Assignment…**.

### All changes

- Release notes for 0.16.0
- Grading: no criteria means one final grade (normalised criteria and maximum, Final grade box with Full marks, no '/ 0'), e2e + unit tests
- Guided workflow: fixes from the full e2e run (Run menu lists the target once, pins belong to where they were chosen, remembered file choice and the edited page win, exam task actions know their source, pretend pytest probe, two-line rows without wrapping)
- Guided workflow: e2e for the new behaviour (guided.spec.ts), specs updated to the intended changes; fixes found by them (Saving… only when queued, why-line only for terminal runs, Save & Next footer text survives remounts, dropdown closes on any choice, grading filter kept per practical)
- Guided workflow Phase J: simple student screen (student layout: Assignments/Files/Search/Run + More, simple status bar, two-line rows, one-course rows, coach mark beside its icon over the editor, no Source Control while reviewing)
- Guided workflow Phase I: one number + teacher flow (studentTasks with quiz practicals, graded is graded, gradingQueue/progressOf drafts rule, teacher brief Grade (n) with roster numbers and starter under …, grading order + 1 of n to grade, Close Review closes the tab, no student quiz list for teachers, reviews open code first, No submissions yet, neutral teacher due dates)
- Guided workflow Phase H: one home per action (Other projects inside Assignments, one submit(), one openInTaskMentor(), Start/Continue/Sign in wording, one row behaviour, palette Show Brief/Start or Continue/Start Grading/Return for Changes, real shortcuts, dead code removed)
- Guided workflow Phase G: the first minute (language-only starters, Create your first file, nothing to hand in until a file exists, Next up says why)
- Guided workflow Phase F: one Test (resolveTest, Test button + passed/total badge, Add a Test, unittest fallback, one suite per folder, selected Python, node:test without package.json)
- Guided workflow Phase E: build fixes + preflight (entry-folder C/C++/Go programs, Java package class, Kotlin jar in .tmcode, PHP/Ruby/Kotlin/.NET/Dart/Swift detection, install card before a run, Check My Computer lists every language)
- Guided workflow Phase D: work mode (one brief slot, sticky main button, previews under the brief, side bar folds <1200px, Home in first group, grading list dropdown)
- Guided workflow Phase C: one saving story (3 s after save, Saving… at once, Save button only when not automatic)
- Guided workflow Phase B: one Run (resolveRun with a reason, F5 = Run, one Stop, why-line, page-loaded JS rule)
- Guided workflow Phase A: calm messages (owners, silent when on screen, max 2, over the code)
- Reviews: end-user walkthrough and simplify-and-centralize (post-0.15)

## 0.15.0 — 2026-10-12

**TMCode 0.15: start here, one way to do it.** TMCode now opens on Home: your next assignment, or what you have to grade, one click away. Every screen shows one status and has one main button, grading opens the first student by itself, and messages say what happened in plain words and stay until you've read them.

### Start here

#### Home
- **TMCode opens on Home** every time, in front of the files you had open (they're still there, one tab away). Students see **Next up**: the assignment to work on now (work your teacher returned comes first), with one button: Start or Continue. Below it: Returned, To do and Graded, each one click from the list.
- **Teachers see what's waiting:** "3 submissions to grade in 2 practicals · 1 draft not released", with **Start Grading**, and each practical's count.
- Signed out, Home has one thing to do: **Sign in**.
- Don't want it? **Settings › Startup Editor: none** (or "Home, only when no folder is open").
- The Explorer with no folder now says where your assignments are, with a button.

#### The right layout from the start
- **TMCode remembers whether you teach.** Teachers get Grading on the first frame instead of the student layout, and a teacher's first sign-in opens Grading (students still get Assignments). The account menu has **Grading**.
- On a first run, the side bar starts on Assignments (or Grading) instead of the Explorer; after that it comes back where you left it.

#### One status everywhere
- The brief, the side bar, the Assignments list and the status bar always show **the same status**: Not started, In progress, Submitted, Returned, Graded or Closed. When the two are catching up you see "Updating…", never two answers.
- **Returned work** shows your teacher's message right where you continue, with **Submit Again**. The steps gain a Returned step.
- **Graded work** shows the score, feedback and criteria at the top of the brief.

#### Messages that stay
- **"Submitted…", "Returned to…" and "Released…" stay until you close them.** Other messages wait while your pointer is over them.
- **New work, grades and returned work** stay until you've seen them, and the bell counts what you haven't read.
- **Do Not Disturb never hides exam warnings, teacher messages or returned work.** During an exam it hides nothing.
- Exam time warnings replace each other (10, then 5, then 1 minute left) instead of piling up.
- The update download shows its progress until it's done.
- Things that used to happen silently now say so: work returned for changes, the first automatic save that fails (in the brief, at once), **Moved to the Trash** (with **Undo**), files dragged in, Git commit, push and pull, a deleted line comment (with **Undo**), and an exam save to Task Mentor that fails (once, not on every retry).

#### Fixes
- Renaming a file to a name that's taken now shows the error under the name and keeps the box open (it used to do nothing).
- A folder that opened while a check was still running could lose its project card in the side bar.

### One way to do it

#### Students
- **Save and Submit live on the brief only.** The side bar's This Folder is now one line, "● In progress · Saved online 2 min ago · Open Brief", so your assignment list has room again. The steps (In progress → Submitted → Graded) moved to the brief.
- **Live status** (what teachers see while you work) is in the line's "…" menu. It stays on while an assignment is open.
- **Quiz practicals have a brief too**, with the same Start, Submit and Withdraw to Edit. Until your quiz attempt is open, the first step is **Open Quiz**. You no longer go through All My Projects to hand one in.
- **Signing in carries on with what you started:** "Signed in. Starting your new project…".
- Files that changed both here and in Task Mentor are listed on the brief, with Compare, Keep Mine and Take Task Mentor's.

#### Teachers
- **Opening a practical opens its first waiting submission** (the oldest hand-in). Home's **Start Grading** goes straight there: one click from launch.
- **The code gets the width:** while a submission is open, the side bar and the student list fold away; a switcher (‹ Ben Learner 1 of 2 ›) stays above the grade. Settings › Grading › Focus While Reviewing turns this off.
- **The grade panel reads top to bottom:** criteria, feedback, line comments, then files and changes (folded). Return for Changes, Preview, Compare with Version and Shortcuts are under **More Actions**.
- **One main button: Save & Next ▾.** Its menu has Save Draft and Save & Release; your last choice becomes the main button. ⌘Enter / Ctrl+Enter is still Save & Next.
- "Score every criterion" now shows on the first criterion without a score, outlined.
- **Progress shows once**, in one line at the top of the grading tab: "2 to grade · 0 graded · 1 in progress".
- Saving a grade says so in the panel's footer (no extra message); Save & Next also shows a short message, since the panel moves on.

#### Words
- Task Mentor failures are in plain words, "Task Mentor had a problem. Try again in a minute.", with the technical part behind **Details**.
- Messages name what you see and put the next step in a button, not a menu path: "Connect to Task Mentor", "Show Conflicts" (opens the brief), "Restore".
- One word for each thing: Start, Continue, Save to Task Mentor, Submit, Withdraw to Edit, In progress, Returned, Graded, Closed, Sign in.
- Reasons a draft wasn't released are in words ("not handed in yet"), never server codes.

### Polish

#### Always a way on
- Empty screens have one action: Grading with no practicals offers **Create in Task Mentor**; "Nothing waiting to be graded" offers **Show All Practicals** or **Show All Students**.
- A student still working shows **See Their Live Status** (assignments) or **Open in Task Mentor**, not just "you can grade once the work is submitted".
- **Close Review** is a button at the top of the grading tab (the side bar can be folded while you review). "Back to My Folder" is now called Close Review everywhere.

#### Teachers' Assignments
- **Your classes come first**, and each assignment has **Grade (2)**: one click to the first waiting submission.

#### Notifications
- The notification centre **keeps 30 days** of messages (up to 200), across restarts.
- **View Feedback, Open and Show Brief stay** in the centre after their message closes.
- **Mark All as Read** clears the bell's count.
- Sign Out, Disconnect and Sign out of GitHub ask as warnings: they affect more than this window.

#### Fits the window
- Grading's filter chips wrap instead of clipping ("Not sta…").
- The side bar's sync words fold into the icon (with the words as its tooltip) when the side bar is narrow; course names show in full on hover.
- **Menus that don't fit go under "…"** in the title bar, so Help and Check My Computer are always reachable.

#### Less noise for students
- **Source Control is hidden in assignment workspaces** (your work saves to Task Mentor). Settings › Source Control in Assignments brings it back.
- No "↑" badge on All My Projects (the brief and the side-bar line show sync; conflicts still show).
- The status bar's Run item names Live Preview only beside web files.

#### Newcomers
- **Where the work is comes first in the activity bar:** Assignments for students; Grading, then Assignments, for teachers.
- A one-time pointer says "Your assignments live here" (or "Grading lives here"). It goes at your first click and never shows again.

### All changes

- Final polish before 0.15.0: icon alignment, gentler first hint, returned note, guides
- Workflow plan Phases 3–4 (polish, validation clean-up)
- Fix brace lost when merging the toast offset rule
- Toasts sit above the grading footer while a grading tab is in front
- Toasts sit above the grading footer while a grading tab is in front
- Workflow plan Phase 2 (0.16 "One way to do it")
- Workflow plan Phase 1 (0.15 "Start here"): Home, role, one status, notification policy
- Workflow plan Phase 0: golden journeys, journey counter, WebKit UA off macOS

## 0.14.0 — 2026-10-10

**TMCode 0.14: the VS Code you know.** The everyday commands VS Code users reach for, a reload that never loses work, VS Code's own file icons and a smarter editor.

### Reload, safely
- **Developer: Reload Window: ⌘R (macOS) / Ctrl+R (Windows, Linux).** TMCode asks about unsaved files first, saves the layout, stops terminals, runs, debuggers and language servers, then reloads. During an exam it waits until all your work has reached Task Mentor.
- **No more accidental reloads:** F5, Ctrl+R and the other browser keys can no longer reload or navigate the app behind your back (on Windows the webview's own browser shortcuts are off).

### Window
- **Open Recent:** ⌃R (macOS) / Ctrl+Alt+O (Windows, Linux): recent folders, this folder's recent files, and Clear Recently Opened.
- **Toggle Full Screen:** ⌃⌘F / F11 (F11 stays Step Into while debugging).
- **Close Window:** ⇧⌘W / Alt+F4, with the same unsaved-work check as Quit.

### Editors
- **Next / Previous Editor:** ⌥⌘→ / ⌥⌘← (Ctrl+PageDown / Ctrl+PageUp).
- **Move Editor** left, right, or into the next or previous group.
- **Close Others, Close to the Right, Close Saved (⌘K U), Close Group (⌘K W)**, and **Keep Editor (⌘K Enter)**.
- **Toggle Maximize Editor Group (⌘K ⌘M).**
- **Open to the Side:** ⌘/Ctrl+Enter in Quick Open and the Explorer.
- **Compare with Saved (⌘K D)** and **Compare Active File With…**
- **Copy Path (⌘K P)**, Copy Relative Path, Reveal Active File in Explorer.
- **Breadcrumbs you can use from the keyboard:** ⇧⌘. opens them with a list of sibling files and symbols.
- **Go to Next / Previous Change:** ⌥F5 / ⇧⌥F5 jumps between your edits.

### View › Appearance
- **Show or hide** the Activity Bar, the Status Bar and Breadcrumbs, move the Side Bar left or right, and toggle whitespace and sticky scroll.

### Terminal and tasks
- **Run Build Task: ⇧⌘B** (the default build task in tasks.json, else Run Project).
- **Terminal: Clear** (⌘K in the terminal), **Focus Terminal**, **Run Selected Text in Active Terminal**.

### Notifications
- **The bell opens a notification centre** with earlier messages, Clear All and Do Not Disturb.

### Files
- **Toggle Auto Save** from the File menu.
- **User snippets:** Configure User Snippets per language and Insert Snippet; your snippets also appear in suggestions.

### File icons from VS Code
- **Seti, VS Code's own file icons, is now the default** everywhere a file appears: Explorer, tabs, Quick Open, Search, Source Control, Problems, the Timeline, Projects, Assignments and grading. It knows 238 file types and 101 special file names (package.json, Dockerfile, .gitignore…). TMCode Glyphs, Minimal and None are still in File › Preferences › File Icon Theme.

### A smarter editor
- **Renaming an HTML or JSX tag renames its pair.**
- **Bracket pair guides and colours, sticky scroll and inlay hints** (with Toggle Inlay Hints).
- **Format on paste and format on type**, **organize imports or fix all on save**, and **trim trailing whitespace / add a final newline on save** (all optional, in Settings).
- **New files guess their language** from what you type ("Python (auto detected)").
- **The command palette understands you:** "reload" finds Reload Window, "close all" finds Close All Editors, and if nothing matches it suggests similar commands.
- **Shift-drag a file into a Markdown file** to insert a link (or an image).

During exams the teacher's settings always win: editor help, terminal and snippets stay as the exam allows.

### All changes

- data-safety e2e: seed storage before the app starts (Linux CI flake)
- Keep the last tabs on reload; seed run-hub e2e settings before the app starts
- Build on Windows and Linux: menu_update is a no-op where the menu bar isn't native
- 0.14 release notes
- VS Code's missing default commands: Reload Window, browser-key guard, Open Recent, editor/group commands, layout toggles, breadcrumbs, build task, notification centre, snippets
- Seti file icons by default; VS Code's editor smarts
- 0.13 release notes; scope a line-number selector to the gutter (WebKit)
- Terminal profiles/split/rename, settings.json + [language] scopes + .vscode overlay, editor grid with pins and saved layout, merge-conflict CodeLens, hunk staging, git Timeline, trust prompt
- One Go Back history; .git can't be renamed; window zoom in the shared menu
- Built-in Python IntelliSense: Pyright on demand, behind the exam policy
- Palette, menus and keybindings (V5-V9)
- Files and search: Replace in Files, Explorer multi-select, encodings, window zoom
- Go to Definition across files, Go Back/Forward, whole TypeScript project for IntelliSense

## 0.12.0 — 2026-10-10

**TMCode 0.12: grade like a code reviewer.** Teachers comment on lines, see what changed and decide when grades go out. Exams check the computer first.

### Grading
- **Line comments:** click the "+" in the gutter, or right-click › Add Comment, in the student's code. Comments are listed in the grade panel and saved with the grade. Students see them once the grade is released.
- **See what changed:** "Changes vs Starter" and "Compare with Version…" open a diff of the current file. The panel lists every file the student added, changed or deleted.
- **Save Draft or Save & Release:** drafts stay with you; students see nothing until you release. "Release N Drafts" sends them all at once. A draft never locks the student's project.
- **Return for changes** from TMCode, with a message. Graded work can be reopened with Allow Resubmission. (Quiz practicals can't be returned.)
- **Your unsaved grading is kept,** even if TMCode closes. A save that fails shows Retry, and the student's row is marked "Not saved".
- **Two teachers, one student:** if someone else graded while you were working, TMCode shows their grade and asks: Use Theirs, or Keep Mine and Save. Every grade shows who graded it and when.
- **Keyboard:** ⌘/Ctrl+Enter Save & Next, Alt+↓/↑ next or previous student, ⌘/Ctrl+Alt+G focus the grade panel. Arrow keys move through the students; Enter opens one.
- **Quick scores like the web,** a warning when a typed score is out of range, and a warning when the rubric doesn't add up to the activity's points.
- **Links from Task Mentor's grading page open the same student in TMCode,** and back.
- Screen readers: the student list, score chips, note boxes and save status are labelled and announced.

### Exams
- **Check your computer before you start:** TMCode checks the language tools each task needs, the connection to Task Mentor, the clock and the disk. If something is missing, you get a plain fix with install links for your system.
- **Check My Computer** does the same any time: from the Help menu, the command palette or the Welcome page.
- **No Python or Java on this computer?** The example tests run on Task Mentor instead ("Running on Task Mentor… (queued)"), with a wait time if you run them too often.
- **Exam folders stay out of Recent.** If an exam is still in progress when TMCode starts, it says so. A submitted exam's folder is read-only.
- **Launch problems say what to do:** Try Again, Open Task Mentor, or Update TMCode when the exam needs a newer version.
- **Work is always saved during an exam,** and the status bar counts unsaved changes.
- **Results name each example test** with its verdict (wrong answer, time limit, compile error…).

### Signing in
- **While you sign in in the browser:** Open the Browser Again, Copy Sign-in Link, or Cancel.
- **If TMCode can't save your sign-in** to the Keychain or Credential Manager, it tells you, instead of signing you out silently next time.

Grading drafts, line comments, versions, return and the live exam data need Task Mentor PR #61. With an older Task Mentor, grading works as before.

### All changes

- 0.12 release notes
- Grading review: line comments, diffs, draft/release, return, drafts, two teachers, keys
- Exam readiness: system check lobby, server-run fallback, launch errors, sign-in wait

## 0.11.0 — 2026-10-10

**TMCode 0.11: one place for my work.** The student's Assignments view is now home, and every hand-in says exactly what it contains.

### Assignments is your home
- **The open assignment's card sits at the top of Assignments:** where you are, what's saved online, Submit. For students, Task Mentor Projects becomes **All My Projects**, one step further down.
- **The Welcome page shows your assignments:** Sign in with NGA, or "2 to do · next due Fri" with Open Assignments. After your first sign-in, Assignments opens by itself.
- **Quieter rows:** Start and Open appear when you point at or select a row. Only your most urgent assignment keeps a solid Start button.
- **Quiz practicals show their state and grade,** and "Open here" when their workspace is open.
- **You're told about new and graded work:** "New assignment: …" and "… was graded: 17/20", with a button to the brief or the feedback.
- **Closed and completed work is clear:** a Closed or Read-only chip with a lock, and the grade.
- **Arrow keys, Home and End** move through the Assignments and Projects lists.
- **When your NGA session ends,** an orange banner says so and offers Sign In.

### Submitting
- **The submit dialog says what is handed in:** "23 files, 1.2 MB". It also lists what isn't included (build folders, ignored files, files over 10 MB) and why.
- **A file that grew too big is no longer recorded as deleted.** It keeps its saved copy online.
- **Closed assignments can't be submitted,** and late work is explained: accepted until your teacher closes the assignment, marked late.

### Grades you can read
- **"How it's graded"** in the brief lists the criteria and points.
- **After grading,** a table shows your score and your teacher's note for each criterion.

### Saving to Task Mentor
- **Assignments save to Task Mentor automatically:** 30 seconds after you save a file, and when you switch away from TMCode. Personal projects are unchanged. You can turn it off in Settings.
- **The brief shows where your work is:** "Saved online · 2 min ago" or "Not saved yet · 3 changes". After two failed automatic saves, TMCode tells you why.
- **The status bar uses the same words as the Projects view:** Saved online, Not saved yet, Conflicts…
- **"version N" everywhere.**
- **Changes coming from Task Mentor are announced** ("Got 3 changes from Task Mentor: a.js, b.css (deleted)"), and your files are kept in Local History first.
- **Opening another assignment** offers to save this one to Task Mentor first.
- **Conflicts have a Compare view:** Task Mentor's copy beside yours, with Keep Mine and Take Task Mentor's.

Works with any Task Mentor. Per-criterion scores, Closed and the late-work rule need Task Mentor PR #60.

### All changes

- 0.11 release notes
- Restore a closing brace lost in the 0.11 stylesheet merge; keep the compare bar above the diff
- Wire 0.11 tracks together: shared sync labels, conflict Compare, Closed status
- Student home: Assignments becomes the one place for my work (0.11)
- Submit clarity, sync honesty, one vocabulary (0.11)

## 0.10.6 — 2026-10-10

**TMCode 0.10.6: trust.** The P0 fixes from the [10 October gap review](../reviews/2026-10-10-ux-gap-review/README.md): what TMCode says is now what happens.

### Your work is safe
- **Switching folders asks about unsaved files** (Save / Don't Save / Cancel) and never mixes files between projects. Before, folder B's `main.py` could show folder A's content.
- **Closing TMCode asks first:** about unsaved files, and in an exam about changes that haven't reached Task Mentor yet.
- **Delete moves files to the Trash,** after a Local History snapshot. If the Trash isn't available, you're asked before anything is deleted for good.
- **Notifications with buttons stay until you answer them.**

### Exams do what the teacher chose
- **"Block paste" and "editor help" settings are applied in the editor.** Copying and pasting inside TMCode still works when only outside paste is blocked.
- **"Restricted console" turns the terminal off,** and a "Secure" exam is labelled as monitored, because lab lockdown isn't available yet.
- **After a crash, your newest work wins.** TMCode compares the copies by content; the other copy is set aside in `.recovered/`, never lost, and the message says what happened.
- **Offline when time runs out:** one "Time is up" card says your work is saved on this computer and will be sent when you're back online. Submit doesn't come back.
- **Sessions that ended** (taken over on another computer, revoked, closed) show a card with the reason instead of a Submit button that can't work. Slow grading says so instead of spinning forever.

### Assignments tell the truth
- **A quiz practical can't be "submitted" while the quiz is closed.** TMCode says "The quiz isn't open in Task Mentor" and offers to open it.
- **Returned work is shown:** "Returned by your teacher" with the teacher's message, in the brief and on the row.
- **"Late" means handed in late,** not "the due date has passed". The countdown disappears once you've handed in.
- **When Task Mentor can't check your subjects,** you see "Couldn't check your subjects" with Retry and Sign in again, not "Nothing to do".
- **Submit errors say why:** offline, project too large, locked, or conflicts.
- **One submit message and one "Withdraw to Edit"** everywhere, with a confirmation before withdrawing.
- **"Use Open Project as Starter…"** is shown to teachers only.

### Grading
- **Per-criterion notes are kept when you save a grade again.**

Needs Task Mentor PR #59 (and #55) for the returned, late and quiz-not-open information. Older servers keep working.

### All changes

- Add the 2026-10-10 UX gap review
- Hide Use as Starter from students in the Assignments menu; 0.10.6 notes
- Task Mentor trust fixes (client): quiz not open, returned, late, scope errors, notes
- Data safety: folder switch prompt, close/quit guard, Move to Trash, sticky action toasts
- Exam trust fixes: paste/help policy, terminal, crash recovery, offline time-up

## 0.10.5 — 2026-10-09

**TMCode 0.10.5: safer by default.** The quick fixes from the [UX review](../reviews/2026-10-09-ux-review/README.md).

### No more accidental sign-outs
- **The command palette opens on common commands** (Go to File, Show Assignments, Terminal, Search, Settings, Color Theme). It used to open with **Sign Out of NGA** selected, so two Enter presses signed you out everywhere.
- **The palette remembers what you ran,** also after a restart, as VS Code does.
- **Hard-to-undo confirmations focus Cancel:** Sign Out (NGA and GitHub), Disconnect and Remove. Enter no longer confirms them by accident.
- **Dialogs keep the focus:** Tab stays inside the dialog, and closing it puts the focus back where you were.

### Smaller fixes
- **Quiz practicals:** clicking the row (or pressing Enter) opens its workspace, as a project row does. It used to do nothing.
- **Exam results** are listed by task ("1. Sum of two numbers") instead of an internal question number, and "1 hidden test" is singular.
- **Shortcuts in tooltips** show your system's keys (Ctrl+Alt+U, Ctrl+Enter on Windows and Linux).
- **Text that pointed nowhere** now points to the right place: Recent on the Welcome page, the Conflicts list, and Restore in the Projects view.
- **Run and Debug:** no more stray full stop under "Show all automatic debug configurations".

### All changes

- UX quick wins from the review (0.10.5)
- Add the 2026-10-09 UX review (VS Code as the reference)

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

