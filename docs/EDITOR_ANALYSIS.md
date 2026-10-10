# TMCode vs. modern code editors: analysis and roadmap

_October 2026. Covers TMCode v0.3._

This compares TMCode with the editors developers actually use: VS Code, Cursor, Zed, JetBrains Fleet and IntelliJ, and Sublime Text. It records what we adopted in v0.3, what we left out on purpose, and the next steps. TMCode has two jobs:

1. **A Task Mentor exam and practice client.** Locked down, audited and offline-tolerant.
2. **A standalone editor.** A developer can use it instead of VS Code.

Every feature below is checked against both jobs. A feature that helps job 2 must not weaken job 1. Exam policy (`policy.terminal`, `internet_in_preview`, lockdown) always wins.

## 1. What each editor does best

| Editor | Signature strengths | Lesson for TMCode |
|---|---|---|
| **VS Code** | Extension ecosystem; Command Palette; integrated terminal with links, shell integration and recent commands; tasks; Simple Browser; Markdown preview; Source Control view; DAP debugging | Developers expect its look, keybindings and mental model. We copy its UI conventions exactly (Dark/Light Modern, codicons, quick input, panels). |
| **Cursor** | AI chat and inline edit (⌘K), codebase-aware completions, agent mode | AI is not allowed in exam mode. In practice mode it is a future opt-in, routed through Task Mentor's free-tier providers. |
| **Zed** | Native GPU UI at 120 fps, multiplayer editing, very fast startup, Tree-sitter everywhere | Speed is a feature. We lazy-load heavy parts (Prettier, esbuild-wasm, the debugger) and show skeletons rather than blank panes. |
| **Fleet / IntelliJ** | Deep language intelligence (refactorings, inspections), "smart mode" toggle, run configurations per project | Run configurations correspond to `launch.json` plus Tasks. Detecting the project type (Maven, Gradle, npm…) matters more than generic settings. |
| **Sublime Text** | Instant search, multi-cursor, Goto Anything | Monaco already provides multi-cursor and Goto Anything (Ctrl+P, `:` and `>` prefixes). |

## 2. What v0.3 adds

| Area | Feature | Where |
|---|---|---|
| Terminal | Bar cursor that blinks when focused and shows as an outline when not; restarts in the opened folder | `parts/panel/TerminalView.tsx` |
| Terminal | Ctrl/Cmd-click links. Localhost URLs open in the in-app browser, others in the system browser. `file:line:col` and Python tracebacks open the editor at that line. | `terminal/enhance.ts`, `terminal/links.ts` |
| Terminal | Find in Terminal (case, word, regex, match count) | `TerminalFind` |
| Terminal | Run Recent Command (Ctrl+Alt+R), with history kept across sessions | `terminal/history.ts` |
| Terminal | Dev-server detection: "Your application running on port 5173 is available" with Open in Browser Preview or External Browser. Works in both the Terminal and the Run output. | `enhance.ts` (`announceServer`) |
| Terminal | Unicode 11 widths (emoji and CJK line up) | `@xterm/addon-unicode11` |
| Previews | Simple Browser editor with back/forward/reload, an editable address bar, device sizes and open-externally | `parts/editor/BrowserEditor.tsx` |
| Previews | Live Markdown preview (Ctrl+K V): GFM, heading anchors, local images, highlighted code, links into the editor | `MarkdownEditor.tsx`, `widgets/docMarkdown.ts` |
| Previews | Image, audio and video viewer (checkerboard, fit/zoom, size), plus a live SVG preview beside the source | `MediaEditor.tsx`, Rust `ws_read_base64` |
| Projects | Run Task… detects npm/yarn/pnpm/bun scripts, Maven/Gradle (Spring Boot), Make, Cargo, Go, Django, pip and .NET, two folder levels deep (client/, server/, apps/web…) | `tasks/detect.ts`, `tasks/service.ts` |
| IntelliSense | Types from `node_modules` (package `types`/`typings` or `@types/*`, following the `.d.ts` graph). Reloaded after `npm install`. | `monaco/languageServices.ts` |
| Editing | Emmet (HTML, CSS, JSX/TSX) | `enableEmmet` |
| Editing | Prettier formatting for JS/TS/CSS/SCSS/LESS/HTML/Vue/Markdown/YAML/JSON/GraphQL, honouring `.prettierrc` or `package.json#prettier`; works with Format on Save | `enablePrettier` |
| UI | Skeleton loading everywhere something is awaited (explorer, search, quick open, editor, previews), with motion tokens and entrance animations that respect reduced motion | `widgets/Skeleton.tsx`, `workbench.css` |
| UI | Zen Mode (Ctrl+K Z; press Escape twice to leave) | `state/zen.ts` |
| Git | Clone, Source Control view, diff, stage/commit/push/pull, branches, gutter and explorer decorations, GitHub token in the OS keychain | `feat/git` |
| Extensions | Open VSX marketplace UI, VS Code themes, TextMate grammars, snippets, icon themes | `feat/extensions` |
| Debugging | Run and Debug view, breakpoints, variables, call stack, debug console, `launch.json` (Python, Node, C/C++) | `feat/run-debug` |

## 3. Frameworks and real projects

| Stack | Edit / IntelliSense | Run | Preview |
|---|---|---|---|
| Plain HTML/CSS/JS | Monaco + Emmet + Prettier | — | Built-in preview (F5) |
| React (single file / small app) | TSX + node_modules types | — | Built-in esbuild bundle preview |
| React / Vue / Svelte on Vite, Next.js, Angular CLI | node_modules types, Prettier, Emmet | Task `npm: dev` / `npm start` | Port detected → Simple Browser |
| Node / Express / NestJS | Types (`@types/node`, own types) | Run File (F5), task, debugger (`feat/run-debug`) | API URL in Simple Browser |
| Java (plain) | Monaco syntax; TextMate grammar | Run File (javac + java) | — |
| Spring Boot (Maven/Gradle) | Syntax + snippets | Task `maven: spring-boot:run` / `gradle: bootRun` | Port 8080 detected |
| Python / Django / Flask / FastAPI | Syntax; Python debugger | Run File; task `django: runserver` | Port 8000 detected |
| C / C++ | Syntax; lldb/gdb debugger | Run File (gcc/g++) | — |
| Go, Rust, .NET | Syntax | Tasks `go run .`, `cargo run`, `dotnet run` | Port detected |

**Known gap:** Monaco's built-in IntelliSense is deep only for TS/JS/CSS/HTML/JSON. Other languages get syntax, snippets and word completion, but no semantic completion. Closing the gap needs language servers (see 5.1).

## 4. What we deliberately left out

- **Running arbitrary VS Code extension code.** Code extensions (`main`/`browser` entry points) need the VS Code extension host API. Without isolation they would undermine exam integrity. v0.3 installs declarative contributions only (themes, grammars, snippets, icon themes, languages) and clearly marks code extensions as unsupported.
- **AI completion and chat.** Not allowed in exams. Any future version must be opt-in, off by default and disabled by policy.
- **Remote development (SSH/containers).** Out of scope for a student editor.

## 5. Roadmap

### 5.1 Language servers (high value)
Spawn LSP servers from Rust (pyright, jdtls, clangd, gopls, rust-analyzer), detected the same way as toolchains. Bridge them to Monaco with `monaco-languageclient` over a Tauri channel. Policy can switch them off in exams.

Started: Pyright is built in (downloaded on request, `src-tauri/src/lsp.rs` + `workbench/src/lsp/`), and the TypeScript service knows the whole project. JDT LS is planned. See [LANGUAGE_SERVERS.md](LANGUAGE_SERVERS.md).

### 5.2 Full extension host (large)
Move the workbench onto `@codingame/monaco-vscode-api`, the VS Code services running in the browser. Run extensions' `browser` entry points in a Web Worker extension host. That gives real VS Code extensions (ESLint, GitLens-lite, Live Share-style) without Node. Estimated 4–6 weeks. It requires reworking the editor parts we wrote by hand.

### 5.3 Smaller wins
- Shell integration (OSC 633) for exact command detection, exit-code decorations and sticky command headers.
- Outline view and breadcrumbs symbols (Monaco's document symbols).
- Notification centre (bell in the status bar, history of dismissed toasts).
- Inlay hints and sticky scroll on by default for TS.
- `tsconfig.json` `paths`/`baseUrl` mapped into the TS worker.
- Persistent terminals across reloads; split terminals.
- Settings sync through the Task Mentor account.

## 6. Quality bar
- Every feature has unit tests where logic is pure (`links`, `history`, `detect`) and e2e tests on Chromium (WebView2) and WebKit (WKWebView). See `apps/desktop/e2e/editor-features.spec.ts`.
- Native commands are added to `build.rs`, `capabilities/workbench.json` and `generate_handler!` together. `open_external` accepts http(s)/mailto only.
- The CSP allows framing only `tmpreview:` and `http://localhost:*` / `127.0.0.1:*`, plus `data:` media.
