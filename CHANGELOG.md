# Changelog

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

