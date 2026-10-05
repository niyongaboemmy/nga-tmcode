# TMCode

The New Generation Academy code editor for Task Mentor: a Visual Studio Code–style
desktop app (Tauri 2 + Monaco) for coding practicals and exams that Task Mentor
launches, controls and grades.

It is also a general-purpose editor you can use instead of VS Code. It has an explorer, search, terminal, run (F5), tests, and live web/React preview for Python, JavaScript, TypeScript, C, C++, Java and HTML/CSS. It works offline and updates itself.

## Download

| | |
|---|---|
| macOS (Apple Silicon and Intel) | [TMCode-macOS.dmg](https://github.com/niyongaboemmy/nga-tmcode/releases/latest/download/TMCode-macOS.dmg) |
| Windows | [TMCode-Windows-Setup.exe](https://github.com/niyongaboemmy/nga-tmcode/releases/latest/download/TMCode-Windows-Setup.exe) · [MSI for IT](https://github.com/niyongaboemmy/nga-tmcode/releases/latest/download/TMCode-Windows.msi) |
| Linux | [AppImage](https://github.com/niyongaboemmy/nga-tmcode/releases/latest/download/TMCode-Linux.AppImage) · [.deb](https://github.com/niyongaboemmy/nga-tmcode/releases/latest/download/TMCode-Linux.deb) |

All versions are listed on the [Releases page](https://github.com/niyongaboemmy/nga-tmcode/releases). The installers aren't code-signed yet, so your system will ask you to confirm the first time:

- **macOS:** if it says TMCode "can't be opened", go to System Settings › Privacy & Security and choose **Open Anyway**.
- **Windows:** in "Windows protected your PC", choose **More info › Run anyway**.
- **Linux:** run `chmod +x TMCode-Linux.AppImage` and start it, or install the .deb with `sudo apt install ./TMCode-Linux.deb`.

**Updates** are signed and install from inside the app: Help › Check for Updates. Automatic checks can be changed under Settings › Application › Update: Mode. TMCode never updates during an exam.

**From a terminal:** run `TMCode <folder or file>`. On macOS that's `open -a TMCode .`. If TMCode is already running, the folder opens in the running window.

## Release (maintainers)

```sh
npm run release -- 0.3.0 --push   # bumps every version, writes CHANGELOG.md, tags v0.3.0 and pushes
```
The Release workflow builds and signs macOS (universal), Windows and Linux. It checks the updater manifest, adds fixed-name download links, then publishes. The signing key is `~/.tauri/tmcode.key`, with its password in `~/.tauri/tmcode.key.password`; the repo secrets are `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. **Back up the key:** without it, installed apps can't receive updates.

## Project

- Plan: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) · Task Mentor protocol: [docs/PROTOCOL.md](docs/PROTOCOL.md)
- `apps/desktop` — the Tauri app (Rust in `src-tauri`, web entry in `src`, Playwright e2e in `e2e`)
- `packages/workbench` — the VS Code–style workbench UI (runs in Tauri or a plain browser)
- `packages/protocol` — wire formats shared with Task Mentor (profiles, exam package, telemetry)
- `packages/profiles` — built-in language profiles
- `services/judge` — tm-judge, the sandboxed grader Task Mentor uses (`deploy/install.sh`)

## Develop

```sh
npm install
npm run dev            # workbench in the browser (in-memory demo project) at http://localhost:1430
npm run tauri:dev      # the desktop app (needs Rust: PATH="$HOME/.cargo/bin:$PATH")
```

## Test

```sh
npm run typecheck
npm test               # vitest unit tests
npm run test:e2e       # Playwright on Chromium (≈ WebView2) and WebKit (≈ WKWebView)
npm run test:rust      # Rust unit tests (workspace sandbox, PTY, window sizing)
```

The desktop app logs to `~/Library/Logs/com.amashuri.tmcode/` (macOS); on start it
records a Monaco worker self-check line (`workbench ready; … monaco workers ok …`).
