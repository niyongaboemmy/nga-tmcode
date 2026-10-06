# Recommended VS Code extensions for TMCode

TMCode installs extensions from **Open VSX**, the open marketplace that VSCodium, Gitpod and Eclipse Theia use. Since 0.5 it also **runs their code** in its own extension host, the same design as VS Code's (see `EXTENSION_HOST.md`).

Every extension below was **downloaded from Open VSX and activated in TMCode's extension host** (`node packages/exthost/test/survey.mjs <dir>`, 2026-10-06; downloads as listed on Open VSX that day). The ones marked ✅ are in TMCode's **Recommended** list (Extensions view, empty search box).

## Format, lint and write better code

| Extension | Downloads | Status in TMCode | Why |
|---|---|---|---|
| **Prettier** (`esbenp.prettier-vscode`) | 9.4M | ✅ Formatting and range formatting work, plus status bar items | The standard formatter for JS/TS/CSS/HTML/JSON/Markdown. Set it as the default formatter, and turn on Format on Save. |
| **ESLint** (`dbaeumer.vscode-eslint`) | 6.1M | ✅ Activates with 13 commands and code actions. Needs `eslint` installed in the project (`npm i -D eslint`). | Finds bugs in JavaScript/TypeScript as you type. |
| **Error Lens** (`usernamehw.errorlens`) | 1.2M | ✅ Activates and decorates lines | Shows errors and warnings at the end of the line, so you don't need to open Problems. |
| **Code Spell Checker** (`streetsidesoftware.code-spell-checker`) | 2.0M | ✅ Diagnostics, hover and quick fixes (it runs a language server) | Catches typos in code, comments and Markdown. |
| **Code Formatter & Minifier** (`lyuwenhan.code-formatter-and-minifier`) | 65K | ✅ Beautify and Minify for JS, TS, HTML, CSS and JSON | Use them from the editor's **right-click** menu. From the Command Palette they ask for a file, the same as in VS Code. |

## Faster web development

| Extension | Downloads | Status in TMCode | Why |
|---|---|---|---|
| **Path Intellisense** (`christian-kohler.path-intellisense`) | 550K | ✅ Completes file paths | Autocompletes `./src/...` in imports and `src=""`. |
| **Auto Rename Tag** (`formulahendry.auto-rename-tag`) | 600K | ✅ Renaming `<div>` renames `</div>` | Saves time on every HTML/JSX edit. |
| **Tailwind CSS IntelliSense** (`bradlc.vscode-tailwindcss`) | 2.5M | ✅ Hover, colours, code actions and links. Needs a `tailwind.config` file. | Class-name completion and previews for Tailwind. |
| **ES7+ React snippets** (`dsznajder.es7-react-js-snippets`) | 870K | ✅ Snippets (`rafce` etc.) | Type `rafce` and press Tab to get a component. |
| **Live Server** (`ritwickdey.liveserver`) | 3.0M | ✅ Go Live command and status bar item | An auto-reloading local server for static sites. TMCode's own Live Preview (Run hub) also covers this. |
| **REST Client** (`humao.rest-client`) | 390K | ✅ `.http` files: send requests, code lenses, completion | Test APIs from a `.http` file next to your code. |

## Run, Git and readability

| Extension | Downloads | Status in TMCode | Why |
|---|---|---|---|
| **Code Runner** (`formulahendry.code-runner`) | 1.0M | ✅ Run Code command for many languages | One-key run for languages TMCode doesn't detect. TMCode's Run hub covers the common ones. |
| **GitLens** (`eamodio.gitlens`) | 17.4M | ✅ Activates with code lenses and 771 commands. Its sidebar views are not shown yet. | Blame and history in the editor. TMCode's own Source Control covers stage, commit, push and pull. |
| **Better Comments** (`aaron-bond.better-comments`) | 610K | ✅ Decorations | Colours `// TODO`, `// !`, `// ?` comments. |
| **TODO Highlight** (`wayou.vscode-todo-highlight`) | 145K | ✅ Highlights and a list command | Makes TODO and FIXME stand out. |
| **indent-rainbow** (`oderwat.indent-rainbow`) | 570K | ✅ Decorations | Colours indentation, which helps a lot with Python. |
| **Color Highlight** (`naumovs.color-highlight`) | 220K | ✅ Decorations | Shows colours in CSS and JS. |

## Themes and icons

These are declarative and fully supported since 0.3: **GitHub Theme**, **Dracula**, **One Dark Pro** (`akamud.vscode-theme-onedark`), **Material Icon Theme**, **vscode-icons** and **Catppuccin Icons**.

## Not yet (and why)

| Extension | What happens | What's missing |
|---|---|---|
| **Vue - Official** (`vue.volar`) | Activation fails | It needs VS Code's built-in TypeScript extension (`vscode.typescript-language-features`). TMCode's TypeScript support comes from Monaco instead. |
| **Thunder Client** (`rangav.vscode-thunder-client`) | Never activates | It only starts from its own sidebar view and uses a webview. Neither is supported yet. |
| **Live Preview** by Microsoft (`ms-vscode.live-server`) | Never activates | It is webview-based. Use TMCode's built-in Live Preview instead (▶ Run on an HTML file). |
| **Git Graph** (`mhutchie.git-graph`) | Activates, but its graph doesn't show | It draws the graph in a webview. |
| **Svelte** (`svelte.svelte-vscode`) | Activates with 10 commands | Untested beyond activation. Its language server should work like Code Spell Checker's. |
| **Python** (`ms-python.python`), **Java** (`redhat.java`), **clangd** | Not yet tested | Large language-server extensions that also download tools. They're next on the list. |
| **Go**, **rust-analyzer**, **Markdown All in One** | Not on Open VSX under these IDs | — |

**What's next for the extension host:** views and webviews (which unlock GitLens views, Git Graph and Thunder Client), the built-in TypeScript extension shim (for Volar), and tests of the Python, Java and C/C++ language-server extensions.
