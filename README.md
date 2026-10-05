# TMCode

The New Generation Academy code editor for Task Mentor: a Visual Studio Code–style
desktop app (Tauri 2 + Monaco) for coding practicals and exams that Task Mentor
launches, controls and grades.

- Plan: [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- `apps/desktop` — the Tauri app (Rust in `src-tauri`, web entry in `src`, Playwright e2e in `e2e`)
- `packages/workbench` — the VS Code–style workbench UI (runs in Tauri or a plain browser)
- `packages/protocol` — wire formats shared with Task Mentor (profiles, exam package, telemetry)

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
