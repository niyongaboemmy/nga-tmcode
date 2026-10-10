# Extension host

TMCode runs the code of VS Code extensions from Open VSX. This document covers four things:

- the architecture;
- the part of the `vscode` API TMCode implements;
- the security model;
- what works today and what does not.

Declarative contributions (themes, icon themes, grammars, languages, snippets) are covered by the extensions feature itself (`packages/workbench/src/extensions/*`). They have always worked without running any code.

## How VS Code does it (and what TMCode copies)

VS Code never runs extension code in the renderer. Each window has one or more **extension hosts**:

- a Node.js process for desktop extensions (the `main` entry point);
- a Web Worker for web extensions (the `browser` entry point);
- a remote host, for Remote-SSH and Codespaces.

The host loads extensions with `require()`. A hook on Node's `Module._load` answers `require('vscode')` with an API object built for the calling extension: VS Code finds the extension by the path of the requiring module.

The host and the renderer talk over an RPC protocol split into **MainThread\*** and **ExtHost\*** "shapes".

- *ExtHost* objects live in the host and hold the extension-facing state: documents, editors, commands and providers.
- *MainThread* objects live in the renderer and do the real work: they edit Monaco models, show messages and register providers with the editor.

Providers are proxies. When an extension registers a completion provider, the host keeps the provider object and tells the renderer "handle 7 provides completions for this selector". The renderer registers a Monaco provider that calls back `$provideCompletionItems(7, …)`. Results travel as plain DTOs.

Extensions activate lazily, on **activation events**:

- `*`;
- `onStartupFinished`;
- `onLanguage:<id>`;
- `onCommand:<id>`;
- `workspaceContains:<glob>`;
- `onView:…` and others.

Since VS Code 1.74, contributions also imply events. Every contributed command adds an implicit `onCommand`, and every contributed language an implicit `onLanguage`.

VS Code for the Web and the Open VSX "web extensions" use the same API in a Web Worker host. That host has no Node.js built-ins, and its files come from the workbench.

TMCode follows the same design, at a smaller scale.

## Architecture in TMCode

```
 Workbench (WKWebView / WebView2 / browser)            Extension host
 ──────────────────────────────────────────            ──────────────
 exthost/hostService.ts  start/stop/restart  ─────►  Node.js: `node resources/exthost.cjs`
 exthost/mainThread.ts   $main.* handlers   ◄─RPC─►      (spawned by src-tauri/src/exthost.rs,
 exthost/documentSync.ts models → host                   stdio relayed over a Tauri Channel)
 exthost/languageBridge.ts host providers → Monaco   Web Worker: packages/exthost/src/worker/main.ts
 exthost/contributions.ts commands/menus/keys          (browser-entry extensions; the browser build)
 exthost/ui.tsx           Extensions UI, status bar
 exthost/views/*          view containers, tree views,  host/views.ts (tree views, webviews)
                          webviews (sandboxed iframes)
 src-tauri/src/webview.rs tmwebview:// pages + files
                                                     packages/exthost/src/host/extHost.ts (state,
                                                     activation), host/api.ts (the `vscode` module)
```

### `packages/exthost`

A workspace package, shared by both hosts and the workbench.

- **`rpc.ts`**: JSON-RPC between two peers, with requests, responses, notifications and `$cancel`.
  - Over stdio, messages are framed like LSP and DAP: `Content-Length: N\r\n\r\n<json>`.
  - The Rust side reuses its DAP framer (`debug.rs::DapReader`).
  - Stray output cannot corrupt the stream, because the decoder skips anything that is not a frame.
- **`protocol.ts`**: the DTOs.
  - Documents and resources are **workspace-relative paths**, as everywhere else in the workbench. Ranges are 0-based `[sl, sc, el, ec]`.
  - The host turns paths into `file:` URIs under the workspace folder.
  - In the browser build the folder is `file:///<name>`.
- **`api/uri.ts`, `api/types.ts`, `api/moreTypes.ts`, `api/events.ts`**: the `vscode` classes, with VS Code's semantics.
  - `Uri` is a trimmed port of `vs/base/common/uri.ts`. It has the same encoding, and an `fsPath` that follows the host OS.
  - `Range`/`Position` normalise and validate as VS Code does.
  - Enum values match VS Code's.
- **`host/extHost.ts`**: the host.
  - It holds documents (`host/document.ts`, incremental sync), editors, commands, providers, diagnostics, output channels, status bar items, configuration, mementos and file watchers.
  - It handles activation (with `extensionDependencies` first) and the `$…` handlers the workbench calls.
- **`host/api.ts`**: builds the `vscode` module, one object per extension.
- **`host/views.ts`**: tree views and webviews (see "Views and webviews" below).
- **`node/main.ts`**: the Node entry point.
  - It hooks `Module._load` for `require('vscode')`.
  - It registers Node's synchronous module hooks (`module.registerHooks`), so ES-module extensions can `import … from "vscode"`. Prettier 12 is one.
  - It redirects `console.*` and stray `process.stdout.write` to the "Extension Host" Output channel.
  - It refuses `process.exit()` from extensions.
  - It exits when stdin closes, so a dead app never leaves hosts behind.
  - `node/nodeFs.ts` implements `workspace.fs` on disk.
- **`worker/main.ts`**: the Web Worker entry point.
  - A small CommonJS loader reads extension files from the workbench over RPC (`$main.readExtensionFile`).
  - `workspace.fs` goes through the workbench's platform fs.
- **`build.mjs`**: esbuild bundles the Node host into `apps/desktop/src-tauri/resources/exthost.cjs`. It is listed in `tauri.conf.json` `bundle.resources`.
  - The bundle is committed so that `cargo build` works without npm.
  - The desktop `build` script and the Node test rebuild it.
  - `node packages/exthost/build.mjs --check` fails when it is stale.

### Rust: `src-tauri/src/exthost.rs`

| Command | What it does |
|---|---|
| `exthost_start(on_event)` | Finds `node` through the existing toolchain detection and spawns `node --max-old-space-size=3072 <resources>/exthost.cjs`. Relays framed stdout as `{type:"message"}`, stderr as `{type:"stderr"}` and the exit as `{type:"exit", code}`. Returns the extensions and storage folders. |
| `exthost_send(id, message)` | Frames one message onto the host's stdin. |
| `exthost_stop(id)` | Kills the host's process tree. |
| `exthost_policy(allowed)` | Called during exams. While it is off nothing starts, and running hosts are killed. |
| `exthost_secret(op, extension, key, value)` | Backs `ExtensionContext.secrets` with the OS keychain: service "TMCode Extensions", account `<ext>/<key>`, plus a per-extension key index. |
| `webview_publish(handle, html, roots)` | (`webview.rs`) Publishes one webview's page at `tmwebview://localhost/<handle>/index.html` (`http://tmwebview.localhost/…` on Windows) and the folders its `file/` URLs may read. Refused while extensions are blocked or in an exam folder. |
| `webview_dispose(handle)` | Forgets a webview's page. |

Further behaviour:

- There is at most one Node host per window. A host left over by a reloaded webview is killed when a new one starts.
- `exthost_start` also refuses to start while the open folder is an exam folder.
- Every command is listed in `build.rs`, in `capabilities/workbench.json` and in `lib.rs` `generate_handler!`.
- `lib.rs` kills all hosts on exit.

### Workbench: `packages/workbench/src/exthost`

- **`hostService.ts`** decides which host runs each extension:
  - `main`, when the platform offers a Node host (desktop) → Node.js;
  - otherwise `browser` → a Web Worker;
  - otherwise → "cannot run here", with the reason shown in the UI.

  It starts the hosts at startup and sends `$init`: extension descriptions, configuration, mementos, open documents and editors. Then it sends `$startup`, which fires `*`, then `workspaceContains:`, then `onLanguage:` for open documents, then `onStartupFinished`.

  Hosts restart when:
  - an extension with code is installed, enabled, disabled or removed;
  - the folder changes;
  - the user runs "Restart Extension Host".

  A host that crashes is restarted up to 3 times in 5 minutes. After that a notification offers "Restart Extension Host", as in VS Code.
- **`mainThread.ts`** implements the `$main.*` requests:
  - commands, messages, quick pick and input box, Output channels, status bar and progress;
  - document open, save and show, editor edits, snippets, selections, reveal and decorations;
  - workspace edits, provider registration, diagnostics, configuration updates, mementos, secrets, clipboard and `openExternal`;
  - the Web Worker's file system.
- **`documentSync.ts`** forwards Monaco model events incrementally, using Monaco's own change events, plus saves, dirty state, language changes, visible and active editors, selections and visible ranges.
- **`languageBridge.ts`** turns host providers into `monaco.languages.register*Provider` registrations. They are disposed with the extension's Disposable, or when the host stops.

  The editor opener (so "Go to Definition" into another workspace file opens it) and the link opener are registered at startup by `monaco/navigation.ts`, with or without extensions (see LANGUAGE_SERVERS.md).

  Commands attached to completions, code actions and code lenses run through a command cache: the host keeps the live arguments and the workbench gets a reference.
- **`contributions.ts`** applies `contributes.commands`, `keybindings` and `menus`. See "UI" below.
- **`decorations.ts`** implements `TextEditorDecorationType` as CSS classes on Monaco decorations.
- **`config.ts`** handles configuration.
  - TMCode's settings already use VS Code's names (`editor.tabSize`, …), so they form the built-in layer.
  - Extension settings are stored under `extensions.settings` in the settings store.
  - The host merges these with every extension's `contributes.configuration` defaults and `configurationDefaults`.
- **`ui.tsx`** contains the Extensions UI pieces described below.
- **`views/*`** renders extension UI contributions: `model.ts` (contributions, menus, icon fonts), `trees.ts` + `TreeView.tsx` (tree views), `webviews.ts` + `WebviewSlot.tsx` + `prelude.ts` + `themeVars.ts` (webviews), `ViewPanes.tsx` (side bar panes) and `mainThread.ts` (the `$main.treeView` / `$main.webview*` handlers).

## The `vscode` API subset

Anything not in this list behaves in one of three ways.

- **Event subscriptions** (`onDid…` / `onWill…`) and **registrations** of an unsupported kind (`register…`) log `'X' is not supported in TMCode yet (ignored).` to the extension's Output channel. They return a no-op `Disposable`, so activation succeeds, as most extensions expect.
- **Any other unknown member** throws `'X' is not supported in TMCode yet.` It is also logged, and listed on the extension's Runtime Status tab.
- **A throwing extension** is marked *Failed*. The host and the other extensions keep running.

### `commands`

- `registerCommand`, `registerTextEditorCommand`, `executeCommand` and `getCommands`.
- `setContext` feeds `when` clauses.
- Built-ins extensions call: `vscode.open`, `workbench.action.openSettings`, `editor.action.*` (run on the active editor), and any TMCode command.

### `window`

- **Messages:** `showInformationMessage`, `showWarningMessage` and `showErrorMessage`, with string or `MessageItem` items and `{ modal, detail }`. A non-modal message resolves `undefined` when it is closed.
- **Quick pick and input box:**
  - `showQuickPick` supports `canPickMany` (checkboxes), separators and `$(icon)` labels.
  - `showInputBox` supports `validateInput`, which is asynchronous and checked while typing and before accepting.
  - `createQuickPick` and `createInputBox` are a basic object API over the same widget.
- **Output and status bar:**
  - `createOutputChannel`, including `{ log: true }` LogOutputChannels, appears in the Output panel with a channel picker.
  - `createStatusBarItem` supports text with `$(icon)`, tooltip, command, colour, alignment and priority.
  - `setStatusBarMessage`.
- **Progress:** `withProgress` shows Notification progress as a progress notification with Cancel. Window and SourceControl progress appears as a spinner in the status bar.
- **Editors:**
  - `activeTextEditor`, `visibleTextEditors` and `showTextDocument`.
  - `onDidChangeActiveTextEditor`, `onDidChangeVisibleTextEditors`, `onDidChangeTextEditorSelection`, `onDidChangeTextEditorVisibleRanges` and `onDidChangeWindowState`.
  - On a `TextEditor`: `document`, `selection(s)` (settable), `visibleRanges`, `options`, `edit()` (one undo step), `insertSnippet()`, `setDecorations()` and `revealRange()`.
- **Decorations:** `createTextEditorDecorationType` supports colours, borders, font style, whole line, the overview ruler, before/after text and light/dark variants.
- **Tree views:** `createTreeView` and `registerTreeDataProvider`. See "Views and webviews".
- **Webviews:** `createWebviewPanel` and `registerWebviewViewProvider`. See "Views and webviews".
- **Stubs:** `registerUriHandler`, `registerFileDecorationProvider`, `registerWebviewPanelSerializer`, `tabGroups` (empty), `terminals` (empty) and `activeColorTheme`.

### `workspace`

- **Folders:** `workspaceFolders`, `rootPath`, `name`, `getWorkspaceFolder` and `asRelativePath`.
- **Documents:**
  - `textDocuments` and `openTextDocument`, which accepts a Uri, a path or `{ content, language }`.
  - Files outside the folder open as read-only snapshots.
- **Document events:** `onDidOpen`, `onDidChange` (incremental `contentChanges`), `onDidSave` and `onDidClose` TextDocument.
- **Configuration:** `getConfiguration(section, scope)` provides `get`, `has`, `inspect`, `update` and language overrides. `onDidChangeConfiguration` supports `affectsConfiguration`.
- **Edits:** `applyEdit` supports text edits (files no editor shows are saved), create, delete and rename. Edits outside the folder are skipped and logged.
- **Files:**
  - `findFiles` supports globs and `RelativePattern`, and uses the `files.exclude` and `search.exclude` defaults.
  - `createFileSystemWatcher` is fed by TMCode's file watcher.
  - `fs` provides `stat`, `readDirectory`, `createDirectory`, `readFile`, `writeFile`, `delete`, `rename` and `copy`, limited to the folder, the extension's own files (read-only) and its storage.
- **Other:** `saveAll` and `save`. `isTrusted` is `true`.

### `languages`

**Providers:**
- Completion, including resolve, item commands, snippets and insert/replace ranges.
- Hover.
- Definition, declaration, type definition, implementation and references.
- Document symbols.
- Code actions; their edits and commands go through TMCode.
- Document formatting, range formatting and on-type formatting.
- Colour.
- Document highlight.
- Document links.
- Folding ranges.
- Signature help.
- Rename, with `prepareRename`.
- Inlay hints.
- Code lenses, including resolve.
- Linked editing.
- Selection ranges.

**Other:**
- `createDiagnosticCollection` feeds the Problems panel, including for files that are not open. `getDiagnostics` and `onDidChangeDiagnostics` work too.
- `getLanguages`, `setTextDocumentLanguage`, `match` and `createLanguageStatusItem` (shown as a status bar item).
- `setLanguageConfiguration` applies to extension languages only. Monaco would replace, not merge, a built-in language's configuration.
- Semantic tokens, call hierarchy and type hierarchy, workspace symbols, inline completions and inline values register as no-ops.

### `env`

- **Identity:** `appName` ("TMCode"), `appHost`, `language`, `machineId` (persisted, random), `sessionId`, `uriScheme`, `uiKind` and `shell`.
- **Actions:** `clipboard.readText` / `writeText`, and `openExternal` through the platform (http, https and mailto only).
- **Other:** `asExternalUri`. `createTelemetryLogger` is a no-op, and telemetry is off.

### `extensions` and `l10n`

- `extensions`: `getExtension`, `all` and `onDidChange`. Each extension's `exports` are its `activate()` result.
- `l10n.t`, with `{0}` and `{name}` placeholders.

### `ExtensionContext`

- `subscriptions`, `extensionPath`, `extensionUri`, `asAbsolutePath` and `extensionMode` (Production).
- `globalState` and `workspaceState`, persisted in TMCode's store per folder.
- `secrets`: the OS keychain on the desktop, the tab's memory in the browser.
- `globalStorageUri` and `storageUri` (`<app data>/extension-storage/…`), plus `logUri`.
- `environmentVariableCollection` (no-op) and `extension`.

### Classes and enums

The classes include:

- `Uri`, `Position`, `Range`, `Selection` and `Location`;
- `TextEdit`, `SnippetTextEdit`, `WorkspaceEdit`, `SnippetString` and `MarkdownString`;
- `Diagnostic` with its `Severity`, `Tag` and `RelatedInformation`;
- `CompletionItem`/`List`/`Kind`/`Tag`/`TriggerKind`, `Hover`, `CodeAction`, `CodeActionKind` and `CodeLens`;
- `DocumentSymbol`, `SymbolInformation`, `Color*`, `DocumentLink`, `DocumentHighlight` and `FoldingRange`;
- the `SignatureHelp` family, `InlayHint`, `SelectionRange` and `LinkedEditingRanges`;
- `EventEmitter`, `Disposable`, `CancellationTokenSource` and `CancellationError`;
- `ThemeColor`, `ThemeIcon`, `RelativePattern`, `FileSystemError`, `TreeItem` and the semantic-token classes;
- the classes libraries subclass while loading. These include `CallHierarchyItem`, `TypeHierarchyItem`, `InlayHintLabelPart`, the notebook data classes, tasks, breakpoints and the debug adapter descriptors.

The enums include `StatusBarAlignment`, `ProgressLocation`, `EndOfLine`, `ViewColumn`, `TextEditorRevealType`, `ConfigurationTarget`, `FileType`, `ExtensionMode`, `UIKind`, `LogLevel` and `QuickPickItemKind`.

`vscode.version` is `1.96.0`.

## Contribution points

- **`contributes.commands`**: the Command Palette, with category, `enablement`, and the `commandPalette` menu's `when`. Running a command activates its extension (`onCommand`).
- **`contributes.keybindings`**:
  - `key`, `mac`, `win` and `linux`, with `when`, and `args`.
  - Chords are converted to TMCode's notation (`ctrl` becomes `mod` on Windows and Linux).
  - `cmd` bindings without a Windows or Linux key are skipped there.
- **`contributes.menus`**:
  - `editor/context` items join Monaco's context menu, shown while their `when` holds. They receive the file's Uri, as in VS Code.
  - `editor/title` `navigation` items become buttons in the editor title.
  - `commandPalette` hides commands.
- **`contributes.viewsContainers`** (`activitybar`, `panel`), **`contributes.views`**, **`contributes.viewsWelcome`**, **`contributes.icons`** and the **`view/title`** / **`view/item/context`** menus: see "Views and webviews".
- **`contributes.configuration`** and **`configurationDefaults`**: defaults for `getConfiguration`, plus an **Extensions › <name>** section in the Settings editor.
  - Booleans, enums, numbers and strings get controls.
  - Objects and arrays are edited as JSON.
  - A **Reset** link appears on modified settings.

`when` clauses (`exthost/when.ts`) support:

- the operators `!`, `&&`, `||`, parentheses, `==`/`!=` (including `===`/`!==`), `<`, `<=`, `>`, `>=`, `=~ /re/flags`, `in` and `not in`;
- quoted strings;
- context keys: `editorLangId`/`resourceLangId`, `resourceExtname`/`Filename`/`Path`/`Scheme`/`Dirname`, `editorTextFocus`/`editorFocus`, `editorHasSelection`, `editorReadonly`, `isMac`/`isWindows`/`isLinux`/`isWeb`, `workspaceFolderCount`, `config.*`, and the keys extensions set with `setContext`;
- in view menus, `view`, `viewItem` and `listMultiSelection`.

Not applied:

- `explorer/context`, `editor/title/context` and `scm/*` menus;
- submenus;
- `walkthroughs`, `debuggers`, `taskDefinitions`, `jsonValidation`, `terminal`, `icons` and the like.

## Views and webviews

### View containers and views

- **`contributes.viewsContainers.activitybar`** adds an activity bar icon after TMCode's own views. Its icon is a codicon (`$(name)`) or an image inside the extension, loaded through the extension file reader as a data URL and painted in the activity bar's colour (a CSS mask), as VS Code does. The icon's badge is the sum of its views' `badge`s.
- **`contributes.viewsContainers.panel`** adds a tab to the panel.
- **`contributes.views`** puts views into an extension container, or into TMCode's Explorer (`explorer`, below Outline and Timeline), Source Control (`scm`), Run and Debug (`debug`) or Testing (`test`). Each view is a collapsible section, as TMCode's own panes, with:
  - its `when` clause (re-evaluated when `setContext` or settings change);
  - `visibility: "collapsed"` starting closed, `"hidden"` not shown;
  - its title, description, message and badge from `TreeView` / `WebviewView`;
  - the **`view/title`** menu: `navigation` items as icon buttons, the rest under "…"; plus Collapse All for `showCollapseAll`;
  - **`viewsWelcome`** content while the view is empty or has no provider: paragraphs, inline links and `[Label](command:…)` buttons.
- **`onView:<id>`** fires when a view is shown, and is implicit for contributed views (VS Code 1.74+).
- Commands: `workbench.view.extension.<container>` ("View: Show …"), `<view>.focus` and `<view>.open`.
- **`contributes.icons`** with an icon font (`fontPath`, `fontCharacter`) makes `$(name)` work everywhere codicons do (GitLens' `$(gitlens-*)`).

### Tree views

`window.createTreeView` and `registerTreeDataProvider` (`host/views.ts`, workbench `views/trees.ts` and `TreeView.tsx`):

- **Handles.** The host keeps the extension's elements and gives the workbench handles: `1/<id>` for items with an `id`, `0/<parent>/<index>:<label>` otherwise, as VS Code does. Fetching a parent's children again releases the handles of its previous children and their subtrees.
- **Lazy children.** The workbench asks for children (`$treeChildren`) when the view is visible and when an item is expanded. Items that are `Expanded` load their children at once.
- **`onDidChangeTreeData`** is batched per tick. Firing for the whole tree reloads the roots and every expanded node. Firing for elements refreshes their `TreeItem`s and reloads them if expanded.
- **`TreeItem`:** `label` (with `highlights`), `description` (and `true` with a `resourceUri`), `tooltip` (string or MarkdownString, shown as text; `resolveTreeItem` on hover), `iconPath` (ThemeIcon with its ThemeColor, Uri, `{ light, dark }`), `resourceUri` (the file icon theme's icon when there is no icon or it is `ThemeIcon.File`/`Folder`), `collapsibleState`, `command` (run on click), `contextValue` (for `viewItem`), and `checkboxState`.
- **Menus.** `view/item/context` items with group `inline` are buttons on the hovered or selected row; the others form the context menu. Commands receive the element, then the selection when `canSelectMany` and several are selected.
- **`TreeView`:** `visible` / `onDidChangeVisibility`, `selection` / `onDidChangeSelection` (multi-select with ⌘/Ctrl and Shift), `onDidExpandElement` / `onDidCollapseElement`, `onDidChangeCheckboxState`, `title`, `description`, `message`, `badge`, and `reveal(element, { select, focus, expand })`, which uses `getParent` to load and expand the ancestors.
- Keyboard: arrows move, expand and collapse; Enter runs the item.

### Webviews

`window.createWebviewPanel` opens an editor tab; `registerWebviewViewProvider` fills a side bar view (`type: "webview"`), resolved the first time it is shown.

- **Isolation.** Each webview is an `<iframe sandbox>` without `allow-same-origin`, so its page has an opaque origin: it cannot reach the workbench's DOM (`window.parent.document` throws) or storage. `allow-scripts` and `allow-forms` follow `enableScripts` / `enableForms`. Tauri's IPC is out of reach: its initialisation scripts (with the invoke key every IPC call must carry) run in the main frame only, and the page's CSP has no `ipc:` in `connect-src`.
- **Pages.** On the desktop the page comes from `tmwebview://localhost/<handle>/index.html` (`webview.rs`), served with its own CSP: TMCode's prelude is inline, and the extension's `<meta>` CSP (nonces included) applies to its own page on top. The browser build has no such origin, so pages go into `srcdoc` with their `asWebviewUri` resources inlined as data URLs.
- **`asWebviewUri`** gives `tmwebview://localhost/<handle>/file/<absolute path>`; the app serves it only from that webview's `localResourceRoots` (default: the extension's folder and the workspace), after resolving symlinks and `..`. **`cspSource`** is `tmwebview://localhost tmwebview:`.
- **The prelude** (first in `<head>`, before the extension's CSP):
  - `acquireVsCodeApi()` with `postMessage`, `getState` and `setState` (kept across reloads);
  - messages from the extension arrive as plain `message` events; ArrayBuffers and typed arrays survive the JSON link to the host (GitLens sends Uint8Array RPC);
  - the theme as `--vscode-*` variables (every colour of the active theme, VS Code's registry defaults for the common keys, the font variables), `vscode-dark` / `vscode-light` / `vscode-high-contrast` on `<body>`, VS Code's default webview styles in a low-priority cascade layer; theme changes are pushed live;
  - links: `http(s):` and `mailto:` open in the browser, `command:` runs when `enableCommandUris` allows it;
  - ⌘/Ctrl shortcuts are forwarded to the workbench (copy, paste, cut, undo and select all stay in the page);
  - an in-memory `localStorage`/`sessionStorage`, since an opaque origin has none.
- **Lifecycle.** Iframes live in one layer over the workbench and follow the slot that shows them (moving an iframe would reload it). A hidden webview is destroyed and re-created from its HTML when shown again (its `setState` kept), unless `retainContextWhenHidden`. Messages posted while it loads are queued; to a hidden, not retained webview `postMessage` returns `false`. Panels report `active` / `visible` / `viewColumn` (`onDidChangeViewState`); closing the tab fires `onDidDispose`; `reveal` focuses the tab; `title` and `iconPath` update the tab.
- **Never in exams.** Webviews come only from running extensions: when extensions are blocked the hosts stop and every view and webview goes with them, the activity bar hides extension containers, and `exthost_policy(false)` makes `webview.rs` forget every page and refuse to serve.

Two scripts check real extensions without the app:

- `node packages/exthost/test/views-real.mjs <extension> <folder> [command] [view ids…]` activates an extension in the Node host and prints its tree views (two levels) and webviews.
- `node packages/exthost/test/webview-rig.mjs <extension> <folder> <command[@file] | view:<id>> <out.png> [chromium|webkit]` renders its webviews in Chromium or WebKit with TMCode's prelude, the same CSP and the same `localResourceRoots` rule, relays messages to the Node host and takes a screenshot.

## UI

- **Extensions view:** each installed extension with code shows its runtime state: *Activating…*, *Activated · 12ms* or *Failed* (with the error in its tooltip). It shows a warning instead when its code cannot run here, for example a Node-only extension in the browser build. The old "contains code that TMCode cannot run" warning is gone for extensions that run.
- **Extension details:** a **Runtime Status** tab shows:
  - the state, the activation event and the host (with the Node.js version and path);
  - the error, if any;
  - the activation events, marking those TMCode never fires;
  - the APIs the extension used that are not supported yet;
  - a Restart button.
- **Commands:** "Developer: Restart Extension Host" and "Developer: Show Running Extensions". The latter is a picker with the state, the activation time and the reason.
- **Trust notice:** the first install of any extension with code shows a one-time dialog: "<name> runs code on your computer… Only install extensions from publishers you trust. Extensions never run during exams."
  - **Trust and Enable** records the choice.
  - **Keep Disabled** installs the extension disabled.
- **Output panel:** a channel picker. The "Extension Host" channel shows host diagnostics and extensions' console output.

## Security model

- **Extension code runs as the user, as in VS Code.** A Node.js extension can use any Node API: `fs`, `child_process` and the network. `workspace.fs` is limited to the folder, the extension's own files and its storage. That limit is an API boundary for correctness, not a sandbox.
- **The user is told once.** The trust notice appears on the first install of an extension with code, and declining keeps it disabled.
- **Only Open VSX**, as before. The download and the `.vsix` unpacking are unchanged (`extensions.rs`): they reject zip bombs, path escapes and id mismatches.
- **Never during exams.** Whenever extensions are blocked, the workbench stops every host at once and removes contributed commands, keybindings, menus and status items. "Blocked" means the exam phase is `active`, `locked` or `submitting`, or the policy mode is not `practice`.

  Rust also refuses `exthost_start` while `exthost_policy(false)` is in force or the open folder is an exam folder, and `exthost_policy(false)` kills running hosts. Policy-driven disablement of extensions is unchanged.
- **Isolation from the workbench.** The host is a separate process (Node) or a Worker, and only speaks the RPC protocol. All editor changes go through `$main.*` handlers. Those handlers:
  - respect read-only editors (exam time-out);
  - open only workspace paths;
  - open external URLs only for http, https and mailto.
- **Webviews are sandboxed.** Extension pages run in `<iframe sandbox>` without `allow-same-origin` (an opaque origin), so they cannot touch the workbench's DOM or storage, and they never get Tauri's invoke key, so they cannot call app commands. They talk to their extension only through `postMessage`, which the workbench checks against the iframe's window. `webview.rs` serves files only from each webview's `localResourceRoots`, and serves nothing while extensions are blocked.
- **Secrets** live in the OS keychain, never in the settings store.
- **Hosts never outlive the app.** A host exits when its stdin closes, the app kills hosts on exit, and a new host replaces a reloaded window's old one.

## Verified with real extensions

`node packages/exthost/test/real-extensions.mjs <dir>` runs these through the bundled Node host, against a fake workbench (`test/harness.mjs`). `<dir>` holds the unpacked `.vsix` files.

| Extension | Result |
|---|---|
| **lyuwenhan.code-formatter-and-minifier** 1.1.35 | ✅ It activates on `onLanguage:javascript` and registers formatters for 8 languages. *Beautify* and *Minify* rewrite the file. These commands act on the file passed to them, which is how the editor context menu and editor title call them; from the Command Palette they report "No file selected", as in VS Code. |
| **esbenp.prettier-vscode** 12.4.0 | ✅ It is an ES module and activates on `onStartupFinished`. Its formatting provider formats JavaScript with its bundled Prettier. |
| **formulahendry.auto-rename-tag** 0.1.10 | ✅ It is a `vscode-languageclient` client with its own language server. Renaming `<span>` to `<spam>` renames `</span>` too, through `TextEditor.edit`. |
| **christian-kohler.path-intellisense** 2.8.0 | ✅ It provides completions of `./` from the real folder (`lib`, `main.js`). |
| **streetsidesoftware.code-spell-checker** 4.9.6 | ✅ It is a `vscode-languageclient` client with a language server over Node IPC. It reports "sentense: Misspelled word" and "mispeled: Unknown word" as diagnostics. |

Views and webviews, checked with `views-real.mjs` and `webview-rig.mjs` against a small git repository (three commits, a branch and a tag):

| Extension | Result |
|---|---|
| **eamodio.gitlens** | ✅ It activates (`onStartupFinished`), registers its tree views and five webview views. Its Source Control views are grouped by default: until its welcome is dismissed (the `viewsWelcome` "Continue" button) the grouped view shows that welcome, then `gitlens.views.scm.grouped` lists the real data: "COMMITS — main", "❰ v1.0 ❱➤ Second change — You, 2 minutes ago", "Initial commit", each expanding to its files. Its `$(gitlens-*)` icons come from its icon font. The Inspect (commit details) and Welcome webviews render and talk to the extension (binary RPC); the Commit Graph view shows GitLens' own "Sign In to GitLens" gate. Commit avatars (gravatar `https:` images) show an account codicon. |
| **mhutchie.git-graph** | ✅ "View Git Graph" (`git-graph.view`) opens its webview panel, which loads its scripts and styles through `asWebviewUri` and draws the graph of the repository: `feature`, `main`, `v1.0`, the three commits with authors, dates and hashes. Chromium and WebKit. |
| **rangav.vscode-thunder-client** | ✅ Its activity bar container (SVG icon) holds the `thunder-client-sidebar` webview view: New Request, Activity, Collections, Env, as in VS Code. It also opens its Release Notes panel on first run. |
| **ms-vscode.live-server** (Live Preview) | ✅ "Show Preview" (`livePreview.start.preview.atFile` on `index.html`) starts its server on port 3000 and opens its preview panel, whose page frames `http://127.0.0.1:3000/index.html` (allowed by the webview CSP's `frame-src`). In the rig its live-reload WebSocket (port 3001) answered the handshake with HTTP 400, so live reload was not verified. |

The native self-test runs inside the real app, against Open VSX:

```
cd apps/desktop
TMCODE_DEV_PORT=1481 TMCODE_DEV_SELFTEST=exthost TMCODE_DEV_WORKSPACE=<folder with app.js> npx tauri dev
```

It works through these steps:

1. It installs Code Formatter & Minifier and Path Intellisense.
2. It runs Beautify, then Minify, and checks the edited model.
3. It triggers Monaco's suggest at `import x from './'` and reads the suggest widget.
4. It removes what it installed.

The results go to `~/Library/Logs/com.amashuri.tmcode/TMCode.log`.

Language-server-based extensions work when they use `vscode-languageclient` over Node IPC or stdio, as Auto Rename Tag and Code Spell Checker do. The client mostly needs `workspace`, `languages`, `window` and child processes, which Node provides. ESLint and the Python extension were not verified:

- **ESLint** (dbaeumer.vscode-eslint) uses the same client and should load. It needs `eslint` installed in the project.
- **The Python extension** depends on Pylance and the Python environment APIs. It also uses webviews and views, which TMCode does not have.

## Limits and what is next

- **Views and webviews** (see above) work, with these gaps:
  - **Not supported:** custom editors (`registerCustomEditorProvider`), `WebviewPanelSerializer` (panels are not restored after a restart), walkthroughs, notebooks, the `explorer/context`, `scm/*` and `editor/title/context` menus, submenus, view drag and drop (`dragAndDropController`), moving views between containers, and `TreeView.activeItem` beyond the first selected item.
  - **Webview pages** cannot use `localStorage` persistently (an in-memory one stands in) and do not get VS Code's find widget (`enableFindWidget`). Images from the web (`https:`) are allowed inside webviews but not in tree items, where avatars show a codicon. Port mapping (`portMapping`) and `asExternalUri` return the URI unchanged; `localhost` servers are framed directly.
  - **The browser build** has no webview origin: pages use `srcdoc` and their `asWebviewUri` resources are inlined as data URLs (fine for the fixture and small pages; resources a page loads at run time are not served).
  - **Live Preview's live reload** was not verified (its WebSocket handshake failed in the test rig).
  - The native self-test does not cover views yet; they were verified with the Node harness, `webview-rig.mjs` and the Playwright fixture (`e2e/ext-views.spec.ts`).
- **No terminals** (`window.createTerminal` throws). No tasks, no debuggers from extensions, no SCM providers, no authentication providers, no comments.
- **Extensions with only a `browser` entry** run in a Web Worker. On the desktop that Worker evaluates code with `new Function`. If the webview's CSP refuses it, the extension shows as *Failed*.
- **ES-module extensions** need Node.js 22.15 or 23.5 or newer, for `module.registerHooks`. On older Node they fail to activate with "Cannot find package 'vscode'".
- **Multi-select quick picks** are supported. The extension-driven `QuickPick` object API is basic (show, accept, hide); buttons and dynamic items are not supported.
- **`onWillSaveTextDocument`** never fires, so `waitUntil` edits are not applied. Format on Save still uses extension formatters, because it runs Monaco's Format Document.
- **`setLanguageConfiguration`** is ignored for languages with a built-in configuration.
- **Unopened files:** `workspace.applyEdit` saves files that no editor shows instead of keeping them dirty in the background.
- **One workspace folder.** Multi-root workspaces are not supported.
- **Next:**
  - `createTerminal` over TMCode's terminal;
  - `onWillSaveTextDocument`;
  - custom editors and webview panel serializers;
  - verified ESLint support.
