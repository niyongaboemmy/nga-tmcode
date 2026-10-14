# AI in TMCode, and the activity log (0.18)

Three goals:

1. AI extensions (Claude Code, Gemini Code Assist, Blackbox, and also Cline, Continue and Windsurf) install from Open VSX and work in a project as they do in VS Code.
2. TMCode has its own AI, free by default (OpenRouter's free models through Task Mentor), with Auto quota control.
3. Every action except typing is recorded, and AI involvement is named in each event.

## What the research found (2026-10-14)

Each AI extension was run in TMCode's Node extension host (`packages/exthost/test`) against a real folder, and its views were opened.

| Extension (Open VSX) | Before | Why |
|---|---|---|
| Anthropic.claude-code 2.1.296 | activates, chat renders | missing `registerFileSystemProvider` (`_claude_fs_left/right`) and `registerTextDocumentContentProvider`, which it uses to show proposed edits as diffs; `window.tabGroups` is empty; no secondary side bar |
| Google.geminicodeassist 2.104.0 | **fails to activate** | "Could not load node-pty": VS Code ships `node-pty` under `env.appRoot`, and the extension `require`s it from there |
| Blackboxapp.blackboxagent 3.3.33 | activates, chat renders | `registerTextDocumentContentProvider (blackbox-diff)`; inline completions are a no-op |
| Codeium.codeium | fails | `workspace.getConfiguration().http.proxy`: the root configuration object has no section properties |
| Continue.continue | activates, then errors | `mkdir globalStorage/<id>`: the parent folder doesn't exist |
| saoudrizwan.claude-dev (Cline) | activates | content providers, terminals |

None of them use VS Code's built-in Chat API. Their chat is a **webview**, and their editor integration is:

- inline completions (ghost text);
- virtual documents plus `vscode.diff` for proposed edits;
- `tabGroups`, to find and close diff tabs;
- terminals and shell integration;
- `registerUriHandler` and `authentication`, for sign-in;
- file events.

## A. Extension compatibility (packages/exthost and workbench/exthost)

1. **`env.appRoot` and `node-pty`.**
   - A `node-pty`-compatible module under `appRoot/node_modules/node-pty`.
   - `spawn()` returns an IPty backed by TMCode's own PTY (Rust portable-pty) over RPC, so no native addon or Node ABI match is needed.
2. **Configuration.** The root `getConfiguration()` exposes sections as properties, plus VS Code's built-in defaults (`http.proxy`, `http.proxyStrictSSL`, …).
3. **Storage.** `globalStorage` and `workspaceStorage` parents exist before activation.
4. **Virtual documents.**
   - `registerTextDocumentContentProvider` and `registerFileSystemProvider` (stat, readFile, writeFile, watch).
   - Editors and diff editors open `scheme:` URIs through the host.
5. **Commands.** `vscode.diff`, `vscode.open` with virtual URIs, `workbench.action.closeActiveEditor`, `workbench.action.focusAuxiliaryBar` / `toggleAuxiliaryBar`, `editor.action.inlineSuggest.*`, and `workbench.view.extension.*` in the secondary side bar.
6. **`window.tabGroups`.**
   - Real groups and tabs: `TabInputText`, `TabInputTextDiff`, `TabInputWebview`, `TabInputCustom`.
   - `close()`, `onDidChangeTabs` and `onDidChangeTabGroups`.
7. **Inline completions.** `languages.registerInlineCompletionItemProvider` maps to Monaco's inline completions:
   - ghost text; Tab accepts, Esc dismisses, ⌘→ accepts a word, ⌥] / ⌥[ cycle;
   - `editor.inlineSuggest.enabled`;
   - the item's `command` runs after accept;
   - shown and accepted items are reported to the activity log.
8. **`registerUriHandler`.** `tmcode://<publisher.name>/path?query` deep links are routed to the extension. `env.uriScheme` is `tmcode`, and `asExternalUri` keeps http(s) and maps the app scheme.
9. **`authentication`.** `registerAuthenticationProvider`, `getSession` (createIfNone, silent) and `onDidChangeSessions`, with an Accounts entry for the providers and their sessions.
10. **Secondary side bar.**
    - A right-hand (or opposite) pane, VS Code's auxiliary bar.
    - It hosts `viewsContainers.secondarySidebar` contributions and TMCode's own Chat.
    - `vscode.version` is bumped to a version that has it.
11. **Events.** `onWillSaveTextDocument` (waitUntil edits), `onDid/WillCreate/Delete/RenameFiles`, and terminal shell-execution events where the terminal can report them.
12. **Install.** Platform-specific `.vsix` files (Claude Code ships one per OS and architecture) are picked for the running platform.

Verification:
- `ai-probe` (in the Node host) shows every one of the six activating, with no unsupported API on its main path.
- Webview rigs render their chats.
- e2e with a fixture AI extension (inline completion, diff via content provider, URI handler, tab close).

## B. TMCode AI (built in)

**Server: Task Mentor `/api/tmcode/ai/*`.** The key never leaves the server; TMCode's repository is public. The server holds `OPENROUTER_API_KEY` and the other free providers.

- `GET /ai/status`: the modes, the free models and the user's budget left today.
- `POST /ai/chat` returns a job id, and `GET /ai/chat/:id/events` streams the answer over SSE (TMCode's existing `account.stream`).
- `POST /ai/complete` returns one inline completion.

**Modes:**
- **Free (default):** OpenRouter `:free` models only, with the free-only guard.
- **Auto:** the server picks the model and provider for each request from the quota left. Chat and explain go to stronger models; inline completions go to fast ones (Groq, then Gemini Flash, then OpenRouter code models). It falls back across every free provider and turns inline completions down before chat runs out.
- **A chosen model:** any free model from the list.

**Quota manager:**
- The OpenRouter account allows **50 free requests a day for all NGA apps**.
- Per-user daily budgets, a shared pool, and cooldowns on 429.
- Inline completions are debounced, cached and only sent after a pause, and stop first when the pool runs low.

**The client:**
- A Chat view in the secondary side bar: streaming Markdown, code blocks with Apply (as a diff), Insert and Copy.
- Context chips (file, selection, problems) and a model / mode picker with a quota meter.
- Inline chat (⌘I) and Explain / Fix / Write tests on a selection.
- Ghost-text completions.
- **Never during exams.**

## C. Activity log (everything except typing)

Events are recorded with time, file and details, plus `ai: { by, how }` when AI was involved:

- **Files:** create, rename, move, delete, duplicate, import, save. These come from the explorer, from extensions (named), and from outside TMCode, which the watcher picks up and attributes to an AI agent while one is working.
- **Clipboard:** copy, cut and paste (length, lines, and source: inside TMCode or outside), in the editor, the terminal and inputs.
- **AI:**
  - a chat question;
  - an answer applied, inserted or copied;
  - an inline suggestion accepted (characters and lines);
  - an extension's edit or diff accepted;
  - an AI extension's view opened;
  - a command an AI extension ran in a terminal.
- **Run, test, debug, terminal command, git, extension installs, project sync and submit.**

**Where it shows:**
- **TMCode:** an **Activity** view (timeline, AI badges, filters, search, jump to file). It is kept per folder in app data.
- **Task Mentor:**
  - linked projects (assignments, practicals) upload the events in batches;
  - the grading workspace gets an **Activity** tab with an AI-usage summary for the teacher;
  - during exams the same events go to the existing `/sessions/:sid/telemetry`.

## Order

1. C: the recorder, the Activity view, and the local file and clipboard sources.
2. A1–A12.
3. B: the TM endpoints and quota, then the Chat UI and inline completions.
4. C: the Task Mentor upload and the grading tab.
5. Tests: unit, exthost rigs, e2e on Chromium and WebKit, TM integration. Then release.

## Research details (bundle strings and VS Code typings)

**Claude Code (2.1.296)**
- It spawns the bundled `resources/native-binary/claude`, a 240 MB file, through the Agent SDK: `--output-format stream-json --input-format stream-json`. It sets `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, and the CLI handles OAuth itself (loopback `/callback` or a pasted code).
- The manifest has `untrustedWorkspaces.supported:false`, so the workspace must be trusted.
- Proposed edits:
  - The right side uses the `_claude_vscode_fs_right` / `_claude_fs_right` FileSystemProviders, and `vscode.diff(left, right, "✻ [Claude Code] name", {preview:false, preserveFocus:true})`.
  - Within 1 s it polls `tabGroups.all` for a `TabInputTextDiff` whose `modified` is that URI, and throws if none appears.
  - Accept: the `claude-vscode.acceptProposedDiff` command (reads `activeTabGroup.activeTab`), or saving the right side (`onWillSaveTextDocument`, autoSave off). Reject: closing the tab.
  - For 1 s it registers its own `type` command, forwarding to `default:type`.
- IDE integration (CLI in a terminal):
  - A WebSocket MCP server on 127.0.0.1:<random>.
  - A lock file `~/.claude/ide/<port>.lock` `{pid, workspaceFolders, ideName, transport:"ws", authToken}`.
  - `environmentVariableCollection.replace("CLAUDE_CODE_SSE_PORT", port)`.
  - Tools: `openDiff`, `getDiagnostics`, `close_tab`, `closeAllDiffTabs`, `openFile`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `checkDocumentDirty`, `saveDocument`.
- Secondary side bar: used when `vscode.version >= 1.106`, otherwise it calls `setContext("claude-code:doesNotSupportSecondarySidebar", true)`. Group identity in `tabGroups` must be stable.
- `registerWebviewPanelSerializer("claudeVSCodePanel")` restores its chat tabs.

**Gemini Code Assist (2.104.0)**
- `node-pty` is loaded eagerly from `${env.appRoot}/node_modules/node-pty`, so without it the extension doesn't activate. It uses `spawn`, `onData`, `onExit`, `write`, `resize` and a real `pid` (it kills by tree-kill).
- Its engine is `cloudcode_cli duet` (a Go language server over stdio). The agent runs as `spawn(process.execPath, ["agent/a2a-server.mjs"], {env: ELECTRON_RUN_AS_NODE=1…})`.
- Sign-in:
  - Google PKCE with a loopback redirect `http://localhost:<port>/oauth2redirect`, which needs `env.appHost === "desktop"` (otherwise it switches to out-of-band paste into a pseudoterminal).
  - `openExternal` must resolve `true`; it also uses `asExternalUri` and `clipboard.readText`.
- Inline completions: two providers, no proposed API, its own 500 ms debounce. It returns `[]` on Automatic while a diff tab is active. It uses `editor.action.inlineSuggest.trigger/hide` and the context key `inlineSuggestionVisible`.
- Diffs: `gca-virtual-doc` content provider plus `vscode.diff`, with CodeLens accept/reject.

**Blackbox (3.3.33)**
- It has no inline completion provider.
- Diffs: `blackbox-diff:` content provider (base64 in the query) on the left and the real file on the right. It streams `applyEdit` into the file, then closes the tabs through `tabGroups`.
- Terminals: `shellIntegration.executeCommand(cmd).read()`, with OSC 633 C…D markers.
- Paid sign-in and GitHub connect return through `vscode://Blackboxapp.blackboxagent/...` deep links, so TMCode must also accept `vscode://` links. It uses secrets.

**Monaco:** `InlineCompletionTriggerKind` is reversed relative to vscode (Monaco Automatic=0/Explicit=1, vscode Invoke=0/Automatic=1).
