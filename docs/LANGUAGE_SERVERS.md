# Language intelligence

How TMCode gives students real IntelliSense across a project without installing extensions (UX gap review, items V2–V4).

## Go to Definition and Go Back (V2)

- `monaco/navigation.ts` registers Monaco's editor opener and link opener when Monaco starts (`setupMonaco`). Go to Definition, Peek and a reference into another workspace file open it in TMCode's editor. Before, the opener was registered only when an extension registered a provider.
- **Go Back / Go Forward** (`workbench.action.navigateBack` / `navigateForward`, editor actions): ⌃- / ⌃⇧- on macOS, Alt+← / Alt+→ on Windows and Linux, as in VS Code. The history (`monaco/navHistory.ts`) records where Go to Definition started and in-file moves of 10 lines or more (not typing). It follows renames and drops deleted files.
- Not done here: Go Back / Go Forward in the command palette and the Go menu (the palette/menus work owns those; they can call `goBack()` / `goForward()` from `monaco/navigation.ts`).

## The whole TypeScript/JavaScript project (V3)

Monaco's TypeScript worker only knows models. `monaco/workspaceSources.ts` gives it the project's other files as *extra libs*, keyed by the files' own `tmcode:/` URIs, so relative imports resolve, and Find References and Rename cover unopened files. Open files' models always win over these copies.

- **Which files** (`monaco/tsProject.ts`):
  - With a `tsconfig.json` (else `jsconfig.json`) at the root: its `files`, `include` and `exclude`, `outDir` excluded, JavaScript only with `allowJs`/`checkJs` (always for jsconfig), JSON with `resolveJsonModule`. `extends` (relative or a package in `node_modules`) and solution configs (`"files": []` + `references`, Vite's template) are followed.
  - Without a config: every `.ts/.tsx/.js/.jsx/.mjs/.cjs` file that is a module (imports or exports). Loose scripts are left out: their globals would clash, as they would not in VS Code's inferred projects.
  - Never `node_modules` (its types come from `acquireTypes` in `languageServices.ts`), `.git` or `.tmcode`; without a config also build output (`dist`, `build`, `out`, …).
- **Budget:** 2,000 files and 20 MB; one file over 1 MB is skipped. Open files and their folders come first. The rest is logged in Output › IntelliSense.
- **Compiler options:** the config's options, mapped as `tsc` reads them: enum names (`target`, `module`, `moduleResolution`, `jsx`), `lib` file names, and `baseUrl`, `paths` (relative to the config without `baseUrl`), `rootDirs` and `typeRoots` as `tmcode:/` URIs. Without a config TMCode's defaults stay.
- **Sync:** saves, outside changes (watcher), renames and deletes update the copies; a changed `tsconfig*.json`/`jsconfig.json` reloads everything. Progress shows in the status bar ("Loading the project for IntelliSense…").
- **Unopened files:** Monaco creates a model when Go to Definition, Peek or Rename needs one. `monaco/documents.ts` adopts it as a *background* document: an editor opening the file reuses it, a refactoring's edits to it are saved at once (VS Code's `files.refactoring.autoSave`), and its diagnostics stay out of Problems until it is opened.

## Built-in language servers (V4)

### Python: Pyright

| | |
|---|---|
| Server | Pyright 1.1.414 (MIT), the npm package's `langserver.index.js --stdio` |
| Runtime | The Node.js TMCode already detects (Toolchains); the same Node runs the extension host |
| Download | Once, on request, from `registry.npmjs.org`, about 6 MB, pinned by the registry's SHA-512 (`lsp.rs` `PYRIGHT_SHA512`), unpacked to `<app data>/language-servers/pyright/<version>` |
| Start | When the first Python file opens; stops when the folder changes |
| Settings | Like Pylance's defaults: `typeCheckingMode: off` (syntax errors, undefined names and missing imports are still reported), open files only; the project's `pyrightconfig.json` or `[tool.pyright]` overrides them. `python.pythonPath` is the Python TMCode runs |
| Features | Diagnostics, completion (with resolve), hover, signature help, Go to Definition / Declaration / Type Definition, Find References, highlights, outline symbols, Rename (with prepare) |

- **Offer:** without Pyright, opening a Python file shows "Python IntelliSense (errors, Go to Definition, completions) needs Pyright, about 6 MB. Download it?" with *Download*, *Not now* (this session) and *Don't ask again*. Without Node.js nothing is offered; the reason is logged in Output › Pyright.
- **Exams:** servers are never downloaded in an exam folder (`lsp_install` refuses). They start in an exam only when the policy's `intelligence` is `diagnostics` or `full` (`lsp/manifest.ts` `serverAllowed`); the workbench tells Rust (`lsp_policy`), which refuses `lsp_start` in exam folders otherwise and kills running servers when the policy turns them off.
- **Files outside the folder** (typeshed stubs, site-packages): definitions there are not opened (TMCode only opens workspace files).
- **Crashes:** restarted up to 3 times in 5 minutes, then a notification.

Code: `src-tauri/src/lsp.rs` (download, spawn, framing, policy), `platform/types.ts` `LanguageServerHost`, `lsp/jsonrpc.ts`, `lsp/client.ts` (LSP ↔ Monaco), `lsp/servers.ts` (lifecycle, offer, policy), `lsp/manifest.ts` (servers and rules). The browser build has a Pyright stand-in for e2e (`platform/memoryLanguageServer.ts`, enabled by `window.__TMCODE_FAKE_LSP__`).

### Java: Eclipse JDT LS (planned)

Not built in yet. `lsp/manifest.ts` lists it with `builtIn: false`; `lsp_probe("jdtls")` reports that it is not available. The plan, reusing everything above:

1. **Runtime:** JDK 17 or newer. Toolchains already detects `java`; parse its version and refuse below 17 with a plain message ("Java IntelliSense needs Java 17 or newer").
2. **Download:** the JDT LS milestone archive from `download.eclipse.org/jdtls/milestones/<version>/` (about 50 MB), pinned by the SHA-256 Eclipse publishes next to it, unpacked to `<app data>/language-servers/jdtls/<version>` with `unpack_npm_tarball`'s temp-then-rename pattern (the validity check: `plugins/org.eclipse.equinox.launcher_*.jar` and `config_<os>` exist).
3. **Start** (`server_command("jdtls")`): `java -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product -Xmx1G --add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED -jar plugins/org.eclipse.equinox.launcher_<v>.jar -configuration config_<mac|win|linux> -data <app data>/jdtls-data/<hash of the folder>`. The `-data` folder is per project and outside it, so nothing is written into the student's folder.
4. **Client:** the same `LanguageClient`; settings under `java.*` (`java.import.gradle.enabled`, `java.configuration.runtimes` from the detected JDK). Handle `language/status` (show "Java: Starting…" through the activity system) and ignore `jdt://` locations (JDK classes) like Python stubs, until a read-only virtual document exists.
5. **Cost:** 300–600 MB of memory and 5–20 s to start on a student laptop: start it only when a `.java` file opens, and keep it off in exams unless the policy allows intelligence (as for Pyright).
6. **Tests:** pinning and command building in Rust like `lsp::tests`; a Java stand-in in `memoryLanguageServer.ts` for the e2e.
