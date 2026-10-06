# TMCode — Implementation Plan

**A VS Code–style desktop code editor for coding practicals and exams, controlled and graded by Task Mentor**

| | |
|---|---|
| Status | Draft v1 for review |
| Date | 2026-10-05 |
| Project | `nga-tmcode` (new, separate repo, sibling of `nga-desktop`) |
| Owner apps touched | **TMCode** (new), **nga-task-mentor** (server, client, live-server), **nga_central_mis** (desktop handoff + release routes) |
| Audience | NGA engineering team (full-stack + desktop) and the Coding Academy lead |

---

## Implementation status (updated 2026-10-06)

Repo: **github.com/niyongaboemmy/nga-tmcode** (public; CI on Linux, macOS, Windows, all green).

| Phase | State | Notes |
|---|---|---|
| 0 — TM-FIX (Task Mentor) | **Items 1–8 done.** Task Mentor PR #27 is open. | Not merged. Before merging, check production quizzes with `lockdown_browser=1` (they will require SEB). TM-FIX-10 is in PR #28; TM-FIX-9 is still open; TM-FIX-11 moves to Phase 7. |
| 0 — Spikes | S1 ✅ S2 ✅ S3 ✅ S4 ✅ (deep link + launch ticket). S5 (lockdown) moves to Phase 4. | S3: **Piston and Judge0 were replaced by our own tm-judge on `isolate`**. The shared server (2 vCPU, 3.8 GB, cgroup v2, no Docker) can't host Docker judges. |
| 1 — Workbench | ✅ | Monaco 0.57. |
| 2 — Profiles, runner, preview | ✅ (except toolchain packs and the Pyodide fallback) | Verified with real toolchains and inside WKWebView. |
| 3 — Task Mentor integration | **Code complete.** Task Mentor PR #28 is open (stacked on #27). The TMCode client is on main. **tm-judge is live on the shared server.** | Remaining before students use it: merge and deploy #27 and #28, run their migrations, set the `TMJUDGE_*` and `CODERUNNER_ENGINE` secrets. Still to do: MIS desktop handoff (`app=tmcode`, for practice sign-in), `/desktop/:product`, toolchain packs. |
| 6 (partly) — Distribution | **Live.** v0.2.2 is published on GitHub Releases for macOS (universal), Windows and Linux. Signed in-app updates are verified: an installed 0.2.1 detected 0.2.2. Task Mentor has a "Get TMCode" button and a public `/tmcode` page. | Distribution went to GitHub Releases instead of the MIS `/desktop/:product` routes (no MIS change needed). It's also usable as a general developer editor: file watching, `tmcode <path>`, Open With, responsive layout. |
| v0.3 — Developer editor | **Done on main (2026-10-06).** | Added:<br>• **Source Control:** clone, diff, stage/commit/push/pull, branches, gutter and explorer decorations, GitHub token in the keychain.<br>• **Run and Debug:** DAP for Python, Node and C/C++; launch.json; breakpoints; Debug Console; install guides.<br>• **Extensions:** an Open VSX marketplace, plus VS Code themes, TextMate grammars, snippets and icon themes. Only declarative contributions; code extensions don't run yet.<br>• **Terminal:** links, find, recent commands, dev-server detection.<br>• **Previews and editors:** Simple Browser, Markdown and media previews.<br>• **Projects:** Run Task, type acquisition from node_modules, Prettier, Emmet.<br>• **UI:** skeletons, motion, Zen Mode.<br>See `docs/EDITOR_ANALYSIS.md`. |
| v0.4 — Task Mentor projects | **TMCode done (0.4.0). Task Mentor side ready on `feat/tmcode-projects`, not deployed yet.** | See `docs/PROJECTS_PLAN.md`.<br>• Sign-in: MIS + Task Mentor in one go.<br>• Projects view, sync with revisions, conflict handling.<br>• Links to activities, and submit.<br>• Live presence over SSE.<br>• Task Mentor web: dashboard, project page, monitor, teacher panels.<br>• New editor features: templates, Local History, Outline.<br>Deploying the Task Mentor side needs #27/#28 merged first (the production lockdown query is still pending). |
| v0.5 — Extensions that run, Run hub, editing fixes | **On `feat/editor-dev`.** | Added:<br>• **Extension host:** Node + Web Worker host with the `vscode` API (`packages/exthost`, `docs/EXTENSION_HOST.md`). 19 of 22 popular Open VSX extensions activate (`docs/RECOMMENDED_EXTENSIONS.md`).<br>• **Run hub:** project detection, Run Project, live preview on save, JS console + REPL, dev servers in the built-in browser, Go/Rust.<br>• **Desktop editing fixes:** terminal clipboard, contextual Select All, Explorer clipboard, no false disk-change warnings, MIS redeem reply parsing.<br>• **Native UI probe:** `TMCODE_DEV_SELFTEST=ui` covers selection, copy, paste, delete, terminal selection/copy and Select All. |
| 4, 5, 7 | Not started | |

**tm-judge in production** (`/opt/apps/tm-judge`, pm2 `tm-judge`, 127.0.0.1:5010, token in `.judge.env`):
- Runtimes: Python 3.14, Node 22, GCC/G++ 15, OpenJDK 21.
- Each submission runs in its own isolate box: memory, process, time and output limits, and no network.
- All boxes together are capped by `isolate.slice` (1200 MB memory, 150 % CPU).
- A probe from inside a box could not read `/opt/apps`, home folders, `/etc/shadow` or the judge's own token.

**Verification:**
- TypeScript tests: 35 unit tests, 46 Playwright runs (Chromium + WebKit, including the full exam flow against a mock Task Mentor), 18 judge tests (CI runs them inside isolate, with containment tests).
- Rust: 25 tests, including real-toolchain runs on macOS and Windows CI.
- Native debug self-tests in the macOS app: workbench, runner, previews, and a full exam (launch → submit → graded).

## Contents

1. [Problem and goals](#1-problem-and-goals)
2. [What exists today (audit)](#2-what-exists-today-audit)
3. [Research findings and option analysis](#3-research-findings-and-option-analysis)
4. [Decisions](#4-decisions)
5. [Target architecture](#5-target-architecture)
6. [The editor (VS Code look and behaviour)](#6-the-editor-vs-code-look-and-behaviour)
7. [Language profiles](#7-language-profiles)
8. [Running code: local runs vs authoritative grading](#8-running-code-local-runs-vs-authoritative-grading)
9. [Browser preview for web languages](#9-browser-preview-for-web-languages)
10. [Task Mentor integration](#10-task-mentor-integration)
11. [Exam integrity: modes, lockdown, AI controls, evidence](#11-exam-integrity-modes-lockdown-ai-controls-evidence)
12. [Instructor experience: live console, review, grading](#12-instructor-experience-live-console-review-grading)
13. [Offline-first saving and submission](#13-offline-first-saving-and-submission)
14. [Data model changes](#14-data-model-changes)
15. [API and protocol](#15-api-and-protocol)
16. [Security model](#16-security-model)
17. [Repository layout and tech stack](#17-repository-layout-and-tech-stack)
18. [Build, release and distribution](#18-build-release-and-distribution)
19. [Phased delivery plan](#19-phased-delivery-plan) (incl. [§19.1 Work package TM-FIX](#191-work-package-tm-fix-task-mentor-defects))
20. [Testing strategy](#20-testing-strategy)
21. [Risks and mitigations](#21-risks-and-mitigations)
22. [Open decisions for the team](#22-open-decisions-for-the-team)
23. [Appendix: sources and versions](#23-appendix-sources-and-versions)

---

## 1. Problem and goals

### 1.1 Problem

Coding Academy students sit practical tests and exams in general-purpose editors such as VS Code, IDLE and online IDEs. In those editors:

- **AI help is one keystroke away.** Copilot, ChatGPT and Claude desktop apps, browser tabs, and AI extensions are all within reach. Teachers cannot see or prove what happened.
- **Collecting work is manual.** Students zip, upload or email files, and some are lost or late. Task Mentor's assignment upload even rejects `.py`/`.js` files (whitelist in `server/src/middleware/submissionUpload.ts`).
- **Grading is manual and inconsistent.** Teachers have to open every project, install dependencies and run it themselves.
- **No common environment.** Language versions differ from machine to machine, so "it works on my laptop" disputes happen.

### 1.2 Goals

| # | Goal | Measured by |
|---|------|-------------|
| G1 | A desktop editor that **looks and feels like VS Code**: activity bar, explorer, tabs, editor groups, panel, status bar, command palette, themes, shortcuts | Students familiar with VS Code use it with no training (pilot survey ≥ 80 % "felt like VS Code") |
| G2 | **Controlled by Task Mentor:** exams open in TMCode from TM, TM's settings drive the editor policy, and the instructor can pause, extend or terminate | 100 % of a pilot exam's sessions started, monitored and ended from TM |
| G3 | **Run code and preview web work** inside the editor, per language | Python, JS/Node, TS, HTML/CSS/JS, React, C, C++, Java profiles pass their acceptance suites |
| G4 | **Authoritative, reproducible auto-grading** on the server, with per-test results stored | Re-grading the same snapshot gives the same score; the client never sends a score |
| G5 | **Instructor review:** open any submission, replay how it was written, re-run it, preview it, rubric-grade it | A teacher grades a 30-student practical in under 45 min (baseline: hours) |
| G6 | **Make AI misuse hard and visible:** block in-app AI, control paste, detect AI/remote apps, keep tamper-evident telemetry, check similarity | Every flagged event appears in the review with evidence |
| G7 | **Never lose work:** offline-first journal, resumable submit | 0 lost submissions in the pilot, including forced network cuts |

### 1.3 Non-goals (v1)

- A general-purpose IDE replacement for professional use. There will be no extension marketplace, git UI or debugger in v1.
- Linux builds. Labs and laptops are Windows/macOS. The architecture keeps Linux possible later.
- Guaranteed cheating *prevention* on unmanaged personal laptops. See §11.1: we promise deterrence plus evidence there, and prevention only on managed lab machines.
- Webcam proctoring inside TMCode. Task Mentor already has a browser-based camera proctoring stack, and v1 reuses its live-server events rather than re-implementing camera ML in the desktop app.

---

## 2. What exists today (audit)

Audit of `nga-task-mentor`, `nga-desktop` and `nga_central_mis` (2026-10-05). File references are relative to each repo.

### 2.1 Task Mentor: coding questions

| Area | Today | Where |
|---|---|---|
| Question types | 13 types including `coding` and `algorithmic` | `server/src/models/QuestionBank.model.ts:12-25` |
| Coding data | JSON in `question_bank.question_data`: `language`, `starter_code`, `allowed_languages[]`, `test_cases[] {input, expected_output, is_hidden, points, time_limit, memory_limit}`, client-only `project_mode` + `project_files[]` | `server/src/types/quiz.types.ts:145-166`, `client/src/types/quiz.types.ts:116-141` |
| Answer storage | `QuizAttempt.submitted_answer` JSON `{code, language}` (project mode: `code` is a JSON-stringified file array). **There is no column for per-test results.** | `server/src/models/QuizAttempt.model.ts` |
| Execution | **Judge0 only, through RapidAPI's hosted `judge0-ce`** (old runtimes, e.g. Node 12, Python 3.8). Unknown languages silently fall back to Node (id 63). | `server/src/services/Judge0Service.ts:30-168` |
| Grading | `CodingGrader.gradeCoding`: weighted per-test points, optional AI rubric that can only *raise* a score | `server/src/utils/quizGrader.ts:1785-1973` |
| Hidden tests | Blanked before reaching students | `server/src/utils/quizStudentView.ts:300-306` |
| Editor | `@monaco-editor/react` 4.7, Monaco loaded **from CDN**; a VS Code–like `CodeSpaceEditor` with explorer, console, preview and AI panels | `client/src/components/Quizzes/QuestionTypes/CodeSpaceEditor.tsx` (1,367 lines) |
| Web preview | `iframe srcDoc` with React/Babel/Vue pulled from unpkg | `client/src/components/Quizzes/QuestionTypes/LivePreviewPanel.tsx` |
| Proctoring | Browser webcam ML (MediaPipe, face-api, COCO-SSD), fullscreen watch, live-server for warn/pause/resume/terminate/screenshot | `client/src/services/proctoringMonitor.ts`, `live-server/src/index.ts` |
| Auth | Local HS256 JWT (`tm_auth_token`) as Bearer or cookie. MIS SSO code flow. Live-socket tickets (120 s). | `server/src/middleware/auth.ts`, `server/src/utils/liveSocketTicket.ts` |

### 2.2 Task Mentor defects to fix first

The audit found these defects in today's Task Mentor. TMCode builds on the same grading pipeline, so **D1–D6 must be fixed before TMCode can be trusted**. They also break *today's* web quizzes, so they ship to production on their own, ahead of TMCode.

Each one has a scheduled work item with files, steps, tests and acceptance criteria in **[§19.1 Work package TM-FIX](#191-work-package-tm-fix-task-mentor-defects)**.

| # | Defect | Where (nga-task-mentor) | Effect | Fix (summary) | Severity | Scheduled |
|---|---|---|---|---|---|---|
| **D1** | `AdvancedQuizGrader.gradeCoding` replaces `detailed_feedback` with `{strategy_used, breakdown, penalties_applied}`, dropping `testResults`. No column stores per-test results. | `server/src/utils/quizGrader.ts:3036-3043`; `QuizAttempt` model | Students and teachers never see which tests passed; "Run tests" shows "Waiting for results…" forever | Merge instead of replacing; add `quiz_attempts.grading_details` and persist | **High** | TM-FIX-1 (Phase 0) |
| **D2** | The algorithmic widget is a *trace/predict* exercise with **hardcoded** steps that scores itself in the browser. It submits `{solution:"Algorithm progress", language:"algorithm", predictions…}`, while the server grades it as code (`gradeAlgorithmic` → `CodingGrader.gradeCoding`), which needs `code`. | `client/src/components/Quizzes/QuestionTypes/AlgorithmicQuestion.tsx:50-90, 166-250`; `server/src/utils/quizGrader.ts:1487-1494` | Every algorithmic answer scores **0** ("code is required"), and the client-side score can't be trusted | Answer algorithmic questions with the code editor and grade them on the judge; migrate stored answers | **High** | TM-FIX-2 (Phase 0) |
| **D3** | `runCode` runs the `test_cases` **sent by the client** and never loads the question (`questionId` unused) | `server/src/controllers/quiz.controller.ts:2070-2178`; routes `quizzes.ts:148-152, 181-185` | Students can use the judge as a free oracle for arbitrary inputs; runs don't match the real tests | Load tests from the DB; students get visible tests only; rate-limit | **High** (integrity) | TM-FIX-3 (Phase 0) |
| **D4** | Unknown languages fall back to Node (`|| 63`) | `server/src/services/Judge0Service.ts:112-139` | A Python/Go/SQL answer silently runs as JavaScript, so it fails or is mis-graded | Fail closed with `UNSUPPORTED_LANGUAGE`; validate at authoring time | **Medium** | TM-FIX-4 (Phase 0) |
| **D5** | `prevent_copy_paste`, `prevent_tab_switching`, `prevent_window_minimization`, `prevent_right_click` and `lockdown_browser` are stored and shown in the UI but **nothing enforces them**. No `tab_switch` event is ever emitted, and `startQuizAttempt` checks no proctoring setting. | `server/src/models/ProctoringSettings.model.ts`; `client/src/pages/QuizTakingPage.tsx:446`; `server/src/controllers/attempt.controller.ts:77` | Teachers believe protections are on when they are off | Enforce in the web quiz page now; server gate for `lockdown_browser`; TMCode enforces them natively | **High** (trust) | TM-FIX-5 (Phase 0 web part, Phase 4 TMCode part) |
| **D6** | Production code execution uses **RapidAPI's shared `judge0-ce`** (`JUDGE0_URL=https://judge0-ce.p.rapidapi.com`) with 2019-era runtimes (Node 12, Python 3.8, GCC 9, OpenJDK 13) | `server/src/services/Judge0Service.ts:30-45`; `server/.env.production` | Outdated language features; rate limits and quota exhaustion on exam day; student code leaves our infrastructure | Interim: newest runtime ids + monitoring. Final: self-hosted judge behind a `CodeRunner` adapter (§8.3). | **High** (reliability) | TM-FIX-6 (interim Phase 0, cutover Phase 3) |

**Also found (lower priority, scheduled in TM-FIX-7 to TM-FIX-11):**

| # | Defect | Where | Effect | Scheduled |
|---|---|---|---|---|
| D7 | The web editor's "Run tests" posts to the **graded answer endpoint**, so every test run is a graded save against all tests, hidden ones included | `client/src/components/Quizzes/QuestionTypes/CodeSpaceEditor.tsx:562+` | Students learn their hidden-test pass count by trial and error; noisy judge load | TM-FIX-7 (Phase 0, with D3) |
| D8 | Coding answers are not background-saved in the web quiz (only on navigation or submit) | `client/src/utils/quizTimer.ts:81-96` | A crash or closed tab loses the code | TM-FIX-8 (Phase 0) |
| D9 | Monaco and preview libraries (React, Babel, Vue) load from public CDNs at runtime | `@monaco-editor/react` default loader; `LivePreviewPanel.tsx:90-116` | Exams break offline or behind a lab allow-list | TM-FIX-9 (Phase 3) |
| D10 | Final coding score = `max(test points, AI points)`: the AI can raise a score that the tests did not earn | `quizGrader.ts:1918-1945` | Unreproducible grades | TM-FIX-10 (Phase 3) |
| D11 | Assignment uploads reject source files (`.py`, `.js`, `.java` …) | `server/src/middleware/submissionUpload.ts` | Code practicals can't be handed in as assignments | TM-FIX-11 (Phase 7) |

### 2.3 nga-desktop pieces we reuse

`nga-desktop` (Tauri `=2.12.1`, React 19, Vite 8) has already solved several hard problems:

| Piece | Reuse in TMCode |
|---|---|
| `browser_signin.rs`: RFC 8252 loopback + PKCE → MIS `/desktop/signin` → `POST /auth/desktop-handoff` + `/redeem` | Standalone sign-in (practice mode). MIS needs an `app`/audience parameter (§10.2). |
| `updates.rs` + MIS `routes/desktop.ts` (`/desktop/update/{target}/{arch}/{ver}`, release/publish workflows, minisign key) | In-app updates. MIS desktop routes get a `product` dimension (`nga` / `tmcode`). |
| `dialogs.rs` (WKWebView alert/confirm fix), `os_notify.rs`, `theme.rs`, `menus.rs` | Copy as-is (or extract to a shared crate later). |
| `build.rs` + capability-gated commands | Same pattern: every Rust command behind an explicit permission. |
| One-line installers, winget packaging, unsigned-install guides on `/apps` | Same distribution path, no certificate budget needed. |
| Known traps (no WebView2 creation inside callbacks, `page_url()` instead of `Webview::url()`, the `.dmg` volume trap) | Inherit as rules in TMCode's CONTRIBUTING. |

**TMCode is a separate app, not a tab in NGA Desktop.** Exam mode must own the whole process, window, network and clipboard. It must not share a process or webview data store with MIS, Tendo and the other apps.

---

## 3. Research findings and option analysis

### 3.1 How to get a VS Code look-alike

| Option | Licence / version | Fit for an exam editor | Verdict |
|---|---|---|---|
| Fork Code-OSS / VSCodium | MIT; upstream ships about weekly | Pixel-perfect, but Electron (~100–150 MB), a huge build chain, endless rebasing, and we would have to *remove* terminal, extensions, AI and accounts | ✗ |
| Eclipse Theia | EPL-2.0, v1.75 | A full IDE framework (DI, plugin host); Electron-sized; overkill | ✗ |
| OpenSumi | MIT, v2.27 | Same class as Theia, docs mostly in Chinese | ✗ |
| code-server / openvscode-server | MIT | Needs a server per student, no offline mode, the full IDE is exposed | ✗ |
| Zed / Lapce | GPL/AGPL / Apache-2 | Native Rust editors; forking a whole editor | ✗ |
| `@codingame/monaco-vscode-api` (VS Code workbench services on Monaco) | MIT, v37.3.x (VS Code 1.138) | Real VS Code views, themes and TextMate grammars; opt-in services. But a breaking major roughly monthly, and the full workbench + worker extension host is the riskiest path on WebKit | ◐ Phase 7 option |
| **Monaco 0.56 + our own React workbench styled exactly like VS Code** | MIT | Monaco *is* VS Code's editor core. We build only the chrome an exam needs, so every feature is policy-controllable. Smallest, most stable. | ✓ **v1** |
| CodeMirror 6 | MIT | Smaller, but doesn't look like VS Code | ✗ (TM already uses it for SQL only) |

**Why this choice:** students see Monaco (identical editing, IntelliSense UX, minimap, multi-cursor and keybindings) inside chrome that reproduces VS Code's layout, codicons and Dark Modern / Light Modern themes. In an exam we mostly need to *remove* features, which is trivial when we own the workbench and painful in a fork.

### 3.2 Desktop runtime: Tauri 2 vs Electron

| Concern | Tauri 2 | Electron |
|---|---|---|
| Installer size | ~8–20 MB (plus optional toolchain packs) | ~80–120 MB, which matters on lab bandwidth |
| Rendering | WebKit (macOS) + Chromium/WebView2 (Windows); must test both | One Chromium |
| Team knowledge | **Already shipping NGA Desktop on it** (updater key, CI, `/apps`, winget) | New stack |
| Native exam controls (process scan, hooks, content protection) | Rust: `sysinfo`, `windows` crate, objc2 | Needs native addons anyway |
| Unsigned macOS updates | Tauri updater uses minisign, independent of Apple signing | electron-updater on macOS needs a signed app |
| PTY / sidecars | `portable-pty`, `bundle.externalBin` | node-pty (ABI rebuilds) |

**Decision: Tauri 2, pinned to the same `=2.12.1` as NGA Desktop.**

### 3.3 Where code runs

| Approach | Use |
|---|---|
| Local native toolchains (Python, Node, C/C++, JDK) | **Feedback runs only** ("Run", "Run visible tests") |
| WASM in-app (Pyodide 314, esbuild-wasm, sandboxed iframe JS) | Fallback when no native toolchain is available; web preview bundling |
| WebContainers | ✗ Commercial licence for production use |
| CheerpJ (Java in WASM) | ✗ Licence unclear for us; ship a JDK pack instead |
| **Server judge (self-hosted)** | **The only source of grades.** Re-runs the submitted snapshot against hidden tests. |

### 3.4 Lockdown reality check

| Mechanism | Works without admin? | Notes |
|---|---|---|
| Fullscreen, always-on-top, close-guard | ✓ | Easy; detectable escape (focus loss) |
| Content protection (hide TMCode from screen capture/share) | ✓ | `WDA_EXCLUDEFROMCAPTURE` / `NSWindowSharingNone`. Stops *streaming answers out*, but not capture-hidden overlay apps. |
| Low-level keyboard hook (block Alt+Tab, Win, Cmd+Tab) | ✓ Windows; partial macOS | Can't block Ctrl+Alt+Del; the student can kill the process (detected via heartbeat) |
| Process scan + blocklist (AI apps, remote desktop, screen recorders) | ✓ | Evadable by renaming; also match signer/path; report and block start |
| VM detection | ✓ heuristics | CPUID hypervisor bit, SMBIOS, MAC OUI, `kern.hv_vmm_present` |
| macOS Assessment Mode (`AEAssessmentSession`) | ✗ | Needs a paid Apple Developer account + entitlement request. Not possible under the no-certificate budget. **Safe Exam Browser for macOS already uses it.** |
| Safe Exam Browser (SEB, MPL-2, free, signed) | Installed once by IT | Windows kiosk desktop + process control; macOS AAC; can permit third-party apps; sends verifiable Config-Key headers |
| **Router/firewall allow-list during the exam** | Lab network only | **The most effective single control**: it kills ChatGPT, Copilot and every browser AI at once |

**Conclusion:** two security tiers (§11). Unmanaged laptops get *deterrence + evidence*; labs get *prevention* (SEB + network allow-list + TMCode exam mode).

### 3.5 Detecting AI assistance

- **Edit telemetry is the strongest signal we control.** Keystroke and edit deltas, paste events (size, internal/external origin), focus loss, run cadence. It enables a **replay player** (as Codio's Code Playback does).
- **Similarity:** **Dolos** (MIT, Ghent University; npm `@dodona/dolos`, embeddable in Node) is preferred over JPlag (GPL-3, Java CLI) and MOSS (sends code off-site). Add **LLM-generated baseline solutions** to the corpus (the "pseudo-AI submission" approach).
- **AI-text/code detectors are unreliable.** Never sanction on a detector score. Flags lead to a **short viva** (oral explanation).

---

## 4. Decisions

| ID | Decision | Rationale |
|---|---|---|
| **D-01** | New repo **`nga-tmcode`**, product name **TMCode**, bundle id `com.amashuri.tmcode` | Exam isolation; independent release cadence |
| **D-02** | **Tauri `=2.12.1`** + React 19 + Vite 8 + TypeScript, same as NGA Desktop | Team knowledge; reuse of signing, updater, CI |
| **D-03** | **Monaco `0.56.x` bundled locally** (never CDN) + custom VS Code–replica workbench | Offline exams; full policy control |
| **D-04** | **Server grades, client never scores.** The client sends source snapshots only. | Integrity; reproducibility |
| **D-05** | **Self-hosted judge** replaces RapidAPI Judge0, behind a `CodeRunner` adapter in TM. **Piston is preferred** (MIT, native multi-file, current runtimes); Judge0 CE 1.13.1 is the alternative. The Phase 0 spike decides on cgroup v2. | D6; multi-file projects; exam-day reliability |
| **D-06** | **Web tasks graded by Playwright** (DOM assertions, optional pixel diff with `pixelmatch`, `axe-core` rubric items) | HTML/CSS/JS/React need behaviour tests, not stdout |
| **D-07** | **Language profiles are server-defined data** (§7), cached by TMCode | Add or adjust a language without an app release |
| **D-08** | **Managed toolchain packs** downloaded on demand (SHA-256 pinned) with system-toolchain fallback | Same versions on every machine; no "Python not installed" |
| **D-09** | **Three modes:** Practice, Monitored exam, Secure exam (§11) | Honest security per environment |
| **D-10** | **Launch from Task Mentor** via `tmcode://` deep link + single-use launch ticket → attempt-scoped token | TM controls everything; no student credentials typed in exam mode |
| **D-11** | **Tamper-evident local journal** (HMAC chain keyed by a server nonce) + idempotent sync | Never lose work; detect edited journals |
| **D-12** | Instructor review lives **in the Task Mentor web app** (Monaco read-only + replay + preview + rubric). A desktop "Review mode" is a later phase. | Teachers grade from anywhere; no install needed |
| **D-13** | **No AI features inside TMCode in exam modes.** In Practice mode, TM's existing Socratic AI hint (`AiSocraticChat`) is allowed if the task allows it. | Policy clarity |

---

## 5. Target architecture

```
┌──────────────────────────── Student machine ────────────────────────────┐
│ TMCode (Tauri 2)                                                         │
│ ┌───────────────────── Workbench webview (React) ─────────────────────┐ │
│ │ Title bar · Activity bar · Explorer · Editor groups (Monaco 0.56)   │ │
│ │ Panel: Output │ Tests │ Problems │ Terminal* │ Preview              │ │
│ │ Status bar: task · timer · sync · mode · language · Ln/Col          │ │
│ └──────────────▲──────────────────────────────────────▲───────────────┘ │
│     Tauri IPC (capability-gated commands, Channels)   │                  │
│ ┌──────────────┴──────────────── Rust core ───────────┴───────────────┐ │
│ │ session   workspace(fs)   journal(HMAC)   sync(queue)   runner       │ │
│ │ toolchains(packs)   preview(tmpreview://)   lockdown   telemetry     │ │
│ │ heartbeat(ws)   auth(launch ticket / PKCE)   updater   pty*          │ │
│ └──────────────┬───────────────────────────────────────────────────────┘ │
│                │                    Preview child webview (sandboxed)    │
└────────────────┼──────────────────────────────────────────────────────────┘
                 │ HTTPS (REST) + WSS (live)          * Practice mode only
┌────────────────▼───────────────────── Server side ──────────────────────┐
│ Task Mentor API (taskmentor-api.amashuri.com, Express/MySQL)             │
│   /api/tmcode/*  exam package · snapshots · telemetry · runs · submit    │
│   CodeRunner adapter ──► tm-judge (Piston/Judge0, isolate)  [new host]   │
│                     └──► tm-webgrader (Playwright worker)   [new host]   │
│   Similarity job (Dolos) · AI rubric (existing aiService)                │
│ Task Mentor live-server (live.amashuri.com, socket.io)                   │
│   + tmcode namespace: heartbeat, status, pause/extend/terminate, flags   │
│ Task Mentor web client: Exam console · Review & grading workspace        │
│ MIS: SSO, desktop handoff (+app param), /desktop releases (+product)     │
│ MIS file-server (:5004): snapshot blobs under nga-task-mentor/tmcode/    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Main flows

**Exam start**

1. The student opens the quiz in Task Mentor (web or NGA Desktop) and clicks **Open in TMCode**.
2. TM creates or resumes the `QuizSubmission` and issues a **launch ticket**: single use, 120 s, bound to `{user, submission, device-unbound}`. It then opens `tmcode://launch?t=<ticket>&api=<origin>`.
3. If TMCode is missing, the page shows install instructions. Detection: a deep-link timeout plus a "version handshake" on `127.0.0.1` is *not* used, to avoid exposing a local port.
4. TMCode redeems the ticket at `POST /api/tmcode/sessions` with its device fingerprint and environment report. It receives an **attempt-scoped token** (`aud=tmcode`, `scope=attempt:<id>`, TTL = deadline + grace) and the **exam package**: tasks, starter files, visible tests, language profiles, policy, server deadline, journal nonce.
5. TMCode applies the policy (mode, lockdown, paste, terminal, LSP level). It runs pre-flight checks (toolchains, process scan, monitors, VM) and shows a checklist. A blocking failure stops the start and is reported to TM.
6. The student works: autosave to the journal, background sync, heartbeat every 10 s, local runs, preview.
7. **Submit**, or reaching the deadline: the final snapshot is sealed and uploaded, and the server re-runs everything on the judge and stores per-test results.
8. TMCode leaves exam mode and shows the results (only if the quiz releases them; reuse `resultVisibility` in `quizStudentView.ts`).

**Instructor**

- **Before:** create the coding task (profile, starter files, tests, policy) in TM's question form, and validate it with a reference solution on the judge.
- **During:** the **Exam console** shows each student's state (online / offline / submitted), last sync, flags, current file and test progress, with pause, extend, message and terminate actions.
- **After:** the **Review workspace** shows the file tree, diffs vs starter, replay, a re-run button, web preview, test results, flags, similarity clusters and the rubric, then releases grades.

---

## 6. The editor (VS Code look and behaviour)

### 6.1 Layout parity checklist

| VS Code element | TMCode v1 | Notes |
|---|---|---|
| Custom title bar with command center | ✓ | Shows task title + countdown in exams; native traffic lights on macOS (`titleBarStyle: Overlay`) |
| Activity bar | ✓ Explorer, Search (in workspace), Tests, Task (instructions), Settings | No Extensions, SCM or Accounts icons |
| Side bar views | ✓ Explorer tree (create/rename/delete/move, drag-drop), Outline (Monaco symbols), Task brief (Markdown, read-only) | Explorer: `react-arborist` or a custom virtual tree |
| Editor groups + tabs | ✓ Split right/down, preview tabs (italic), dirty dot, pinned tabs | `allotment` (VS Code's own sash logic) for splits |
| Breadcrumbs, minimap, sticky scroll, bracket-pair colours, indent guides | ✓ | Monaco built-ins |
| Panel | ✓ Output, **Tests**, Problems, **Preview** (or side-by-side), Terminal (Practice only) | xterm.js 5 |
| Status bar | ✓ Mode badge (PRACTICE / MONITORED / SECURE), sync state, timer, language, encoding, EOL, Ln/Col, toolchain version | Colour of the bar = mode (like VS Code's remote indicator) |
| Command palette (Ctrl/Cmd+Shift+P) and Quick Open (Ctrl/Cmd+P) | ✓ | Commands filtered by policy |
| Keybindings | ✓ VS Code defaults (Windows/macOS) | Copy/paste keys routed through the paste policy |
| Themes | ✓ Dark Modern, Light Modern, High Contrast | Port VS Code theme JSON → Monaco + CSS variables; sync with the NGA preferred theme |
| Icons | ✓ `@vscode/codicons` + Seti-style file icons | — |
| Settings UI | ✓ Font size, font family (bundled JetBrains Mono / Cascadia Code), word wrap, tab size, minimap, theme | Exam policy can lock some settings |
| Notifications toasts (bottom-right) | ✓ | Same placement |
| Welcome page | ✓ Recent tasks from TM, "Open practice folder", toolchain status | — |

### 6.2 Editor intelligence by level (policy-controlled)

| Level | What students get | Default |
|---|---|---|
| `none` | Syntax colouring only (Monarch); no suggestions | Secure exams where recall is assessed |
| `basic` | Word-based suggestions, bracket matching, snippets for language keywords | Monitored / Secure exams |
| `diagnostics` | `basic` + errors/warnings (TS worker; Python via basedpyright worker; C/C++ via compile errors from the runner) | Practice / formative tests |
| `full` | `diagnostics` + IntelliSense, hover, go-to-definition (built-in TS; optional basedpyright and clangd sidecars) | Practice |

AI completion (Copilot-style) is **never** available. There is no extension host, so there is nothing to install.

### 6.3 Workbench implementation notes

- Monaco workers are bundled with Vite `?worker` imports. CSP: `worker-src 'self' blob:`. The **Phase 0 spike** must prove that the workers run on WKWebView under the `tauri://` scheme (otherwise Monaco silently falls back to the main thread and the UI janks).
- State: Zustand store for workbench layout and open editors; Monaco models are the source of truth for file contents; the Rust `workspace` owns disk.
- File model: every exam task is a **workspace folder** `attempts/<submissionId>/<questionId>/`, written to disk so that native runners and preview read real files.
- Accessibility: Monaco's screen-reader mode toggle, keyboard-only navigation of all views, high-contrast theme.
- i18n: English first; strings in a catalog (Kinyarwanda/French later if needed).

---

## 7. Language profiles

Profiles are JSON documents served by Task Mentor (`GET /api/tmcode/profiles`), versioned and cached by TMCode. A question refers to a `profile_id` (replacing the free-text `language`, with migration of the old values).

### 7.1 Profile schema (abridged)

```jsonc
{
  "id": "python-3.12",
  "label": "Python 3.12",
  "monaco_language": "python",
  "file_icons": ["py"],
  "entry_point": "main.py",
  "templates": { "script": ["main.py"], "tests": ["test_main.py"] },
  "local": {
    "toolchain": "python",            // pack id or system probe
    "min_version": "3.10",
    "run": ["{python}", "-u", "{entry}"],
    "test": ["{python}", "-m", "pytest", "-q", "--tb=short", "--json-report"],
    "fallback": "pyodide"             // when no native toolchain
  },
  "judge": { "engine": "piston", "language": "python", "version": "3.12.*" },
  "preview": null,                    // "static" | "bundle-react" | null
  "lsp": { "diagnostics": "basedpyright-wasm", "full": "basedpyright-sidecar" },
  "test_kinds": ["io", "unit-pytest"],
  "limits": { "cpu_s": 5, "wall_s": 10, "memory_mb": 256, "output_kb": 256 }
}
```

### 7.2 Initial profile set

| Profile | Local run | Fallback | Server grading | Test kinds | Preview | Editor intelligence (max) |
|---|---|---|---|---|---|---|
| **Python 3.12** | Python pack (python-build-standalone / Windows embeddable) | Pyodide 314 (worker) | Judge | stdin/stdout I/O; **pytest** unit tests | — (Turtle/Tkinter: out of scope v1) | basedpyright |
| **JavaScript (Node 22 LTS)** | Node pack | Sandboxed worker (no `fs`) | Judge | I/O; `node:test` unit tests | — | Monaco TS worker |
| **TypeScript** | Node pack + bundled `esbuild` | esbuild-wasm → worker | Judge (TS) | I/O; `node:test` | — | Monaco TS worker |
| **HTML/CSS/JS (Web)** | — | — | **Playwright web grader** | DOM/behaviour assertions, visual diff, axe | `static` via `tmpreview://` | Monaco HTML/CSS/TS workers |
| **React (Vite-like)** | esbuild (native, or wasm) with **vendored** React 19, no npm install | esbuild-wasm | Playwright (built bundle) | Component behaviour via DOM | `bundle-react` | TS/JSX worker |
| **C (C17)** | **zig cc** pack (one ~45 MB cross-platform compiler) or system gcc/clang | none → "Run on server" button (rate-limited, visible tests only) | Judge (gcc) | I/O | — | Compile errors → Problems; optional clangd |
| **C++ (C++17)** | zig c++ pack or system | same as C | Judge (g++) | I/O | — | same |
| **Java 21** | Temurin JDK 21 pack (on demand, ~190 MB; lab machines pre-provisioned) | Server run | Judge | I/O; JUnit 5 (console launcher) | — | Compile errors → Problems; jdtls not bundled |
| **SQL (SQLite)** *(Phase 7)* | `sql.js` (wasm) | — | Server sqlite | Result-set comparison | Table view | Monaco SQL |
| **PHP** *(Phase 7, if needed)* | PHP pack | — | Judge | I/O | `static`+server preview | basic |

Each profile has an **acceptance suite** in the repo (`profiles/<id>/fixtures`: hello world, stdin echo, compile error, runtime error, timeout, infinite output, multi-file, and unit tests pass/fail) that runs against both the local runner and the server judge in CI. **Local and server must agree on every fixture.**

### 7.3 Toolchain packs

- Served from `https://api.amashuri.com/tmcode/toolchains/<pack>/<ver>/<os>-<arch>.tar.zst` with a signed `toolchains.json` index (minisign, same key family as the updater) and a SHA-256 per file.
- Installed per user under the app data dir (no admin). Lab IT can pre-seed them with `tmcode --install-toolchains all` (MSI/winget flag for labs).
- Before an exam: a **pre-flight** downloads whatever the exam's profiles need. The **exam package lists the required packs**, so students are told on the exam *lobby* page, ahead of time.
- System toolchains are detected (`python3`/`py`, `node`, `gcc`/`clang`, `javac`) and used only if the profile allows `system` and the version is in range.

---

## 8. Running code: local runs vs authoritative grading

### 8.1 Local runner (Rust `runner` module)

- Spawns the profile command in the task workspace (a temp copy for test runs), with `stdin` from the panel or the test input.
- **Limits:** wall-clock timeout, output cap (truncate + kill), process tree kill (Windows **Job Objects** with `KILL_ON_JOB_CLOSE`; Unix process groups + `setrlimit` CPU/AS where available).
- **Environment scrubbing:** clean `PATH` (pack bin dirs first), no inherited proxy/AI env vars, `HOME`/`USERPROFILE` → sandbox dir, `PYTHONNOUSERSITE=1`, no network enforcement in v1 (documented limitation; Secure labs rely on the router allow-list).
- Output streams to the UI via Tauri **Channels** (ordered, back-pressured). ANSI colours are rendered in the Output panel.
- **Interactive programs** (`input()`): the Output panel turns into an input-capable console (xterm.js without a shell) wired to the process stdin. This works in all modes, unlike the full terminal.
- **Visible-test runner:** runs the visible tests locally and shows a VS Code–style **Tests** view (pass/fail, diff of expected vs actual with whitespace markers, time). Results are *advisory*: the UI labels them "Local check — your grade is computed on the server."

### 8.2 Terminal (Practice mode only)

`portable-pty` (wezterm) + xterm.js gives a full shell. In exam modes the terminal view is **removed**, because a shell gives `curl`, AI CLIs, package managers and file access outside the workspace. An instructor may enable a **restricted console** per exam (only the profile's run/test commands, `pip`/`npm` disabled).

### 8.3 Server judge (authoritative)

- New service **`tm-judge`** on a **separate small EC2 instance** (recommended: 2 vCPU / 4 GB, Ubuntu 24.04). It must not share the box hosting MIS/TM/Tupo, because student code is hostile by definition. It is reachable only from TM over a private network or WireGuard, never public.
- Engine: **Piston** (preferred), or **Judge0 CE 1.13.1**, both running `isolate`. The Phase 0 spike checks cgroup v2 on Ubuntu 24.04 (Judge0 historically needs cgroup v1 / privileged containers).
- TM server gets a **`CodeRunner` interface** (`server/src/services/coderunner/`) with `PistonRunner`, `Judge0Runner` (the existing `Judge0Service` wrapped) and `WebGraderRunner`. `CodingGrader` calls the interface, not Judge0 directly. Config: `CODERUNNER_ENGINE`, `CODERUNNER_URL`, and a per-profile mapping.
- **Multi-file:** Piston accepts `files[]` natively. For Judge0, use language 89 "multi-file" with a zip in `additional_files`.
- **Test harnesses:** I/O tests compare normalised output (configurable: trim trailing whitespace, ignore case, float tolerance, regex). Unit tests (`pytest`, `node:test`, JUnit) run with a harness that emits a **JSON report**, which is parsed into per-test results.
- **Queue:** exam-time load is bursty (30–60 students submitting at the deadline). TM enqueues judge jobs into a MySQL-backed job table (`tmcode_runs`, §14) processed by a worker with bounded concurrency (start at `cpu_count` parallel jobs). Students see "Grading…" and results arrive via the socket or polling. **No synchronous judge calls in the submit request.**
- **Web grader `tm-webgrader`:** a Playwright (Chromium) worker on the judge host. Per task: serve the snapshot statically → run instructor-authored checks (TS spec file stored with the question) → optional screenshot `pixelmatch` vs reference → `axe-core` → per-check results. Every job runs in a fresh browser context, network-blocked except the local static server.
- **AI rubric:** keep the existing `aiService.gradeCoding` as an *optional suggestion* for the teacher in the review UI. It does not change the auto score; this replaces today's "max(test, AI)" behaviour for TMCode tasks.

### 8.4 Grade computation

```
auto_score   = Σ(test.points × passed) over all tests (visible + hidden), per question
penalties    = optional, explicit per question (e.g. compile error = 0 for that question), no keyword heuristics
final_score  = auto_score + manual_adjustment (rubric), clamped to question points
grade_status = auto_graded | pending (manual rubric required) | graded
```

All inputs (snapshot hash, profile version, judge engine/version, test-suite version) are stored with the run, so **re-grading reproduces the result** or explains the difference (e.g. the tests were edited after the exam).

---

## 9. Browser preview for web languages

### 9.1 In-editor preview

- Rust registers a custom protocol **`tmpreview://<session>/…`** that serves files from the task workspace (and vendored libraries from the app bundle). There is no local HTTP port, so other apps can't reach the preview.
- The preview renders in a **separate child webview** (Tauri multi-webview, as NGA Desktop does). It has no IPC access, its own data store and a strict CSP (`connect-src` limited to `tmpreview:`, so no internet from preview in exam modes).
- **Live reload** on save (or on keystroke with a 300 ms debounce, as a setting). The preview position is a VS Code–style panel, side-by-side, or a detached window (Practice only).
- **Console capture:** an injected shim forwards `console.*`, uncaught errors and unhandled rejections to a "Preview Console" view with source links back into Monaco.
- **Device toolbar:** responsive presets (mobile 375, tablet 768, desktop 1280) and zoom, since layout tasks are graded at fixed viewports.
- **React profile:** `esbuild` (native sidecar, or `esbuild-wasm` fallback) bundles `src/main.jsx` with **vendored React 19 + ReactDOM**. Bare imports are restricted to a vendored allow-list (react, react-dom; optionally a small set the instructor enables). There are no npm installs in exams.
- Fix vs TM today: no unpkg/CDN at runtime, so it works offline and the exam network allow-list stays short.

### 9.2 Grading web work

Playwright checks are authored per question in TM with a helper DSL and templates. Examples:

```ts
test('has a nav with 3 links', async ({ page }) => {
  await expect(page.getByRole('navigation').getByRole('link')).toHaveCount(3);
});
test('button toggles dark class', async ({ page }) => {
  await page.getByRole('button', { name: /theme/i }).click();
  await expect(page.locator('body')).toHaveClass(/dark/);
});
```

- **Visual checks** are optional, tolerance-based and fixed-viewport. They are recommended only for "reproduce this layout" tasks.
- Teachers also get **side-by-side preview** (student vs reference) in the review workspace (§12.2).

---

## 10. Task Mentor integration

### 10.1 Authoring (TM web)

Extend the existing coding question form (`client/src/components/Quizzes/QuestionForms/CodingSetupTab.tsx`, `CodingTestsTab.tsx`, `CodingTemplateTab.tsx`, `CodingConstraintsTab.tsx`):

- **Profile picker** (from `/api/tmcode/profiles`) replaces the free-text language.
- **Workspace template:** multiple files, entry point, read-only files (e.g. provided tests or assets), hidden files (graded but not shown).
- **Tests:** I/O cases (existing), unit test files (pytest/node:test/JUnit), web checks (Playwright spec), with points per test and visible/hidden flags.
- **Reference solution** (stored, never sent to students) plus a **"Validate on judge"** button: it runs the reference against all tests, and must be 100 % before the quiz can be published.
- **Rubric** (manual criteria, e.g. code style, comments, structure) using the shape of the existing Assignment rubric `[{criteria, max_score, description}]`.

**Quiz-level settings** (new "TMCode" section in `CreateQuizPage.tsx`):

| Setting | Values |
|---|---|
| `delivery` | `web` (today's CodeSpaceEditor) · `tmcode_optional` · **`tmcode_required`** |
| `mode` | `practice` · `monitored` · `secure` |
| `intelligence` | `none` · `basic` · `diagnostics` · `full` |
| `paste` | `allow` · `internal_only` (default for exams) · `block` |
| `terminal` | `off` · `restricted` · `full` (practice only) |
| `internet_in_preview` | on / off |
| `require_seb` | on / off (Secure mode, §11.3) |
| `allow_offline_grace_minutes` | 0–30 (§13) |
| `flags_policy` | thresholds: auto-pause after N high-severity flags (default: never auto-terminate) |
| `results_release` | reuse the existing `show_results_immediately` / `show_correct_answers` (hidden test inputs are never shown) |

This extends the existing `ProctoringSettings` model rather than adding a parallel concept, and finally gives `prevent_copy_paste` / `prevent_tab_switching` an enforcement point (D5).

### 10.2 Authentication paths

| Path | Used for | Flow |
|---|---|---|
| **Launch ticket** (primary) | Exams and assigned practicals | TM web → `POST /api/tmcode/launch` (auth: TM JWT) → ticket (single-use, 120 s, stored hashed) → `tmcode://launch?t=` → TMCode redeems → **attempt-scoped JWT** (`aud: tmcode`, `sub: user`, `sid: tmcode_session`, `scope: attempt:<submissionId>`, `exp: deadline + grace`). It is valid only on `/api/tmcode/*` for that attempt. |
| **Desktop sign-in** (secondary) | Practice mode, "My tasks" list on the welcome page | Reuse NGA Desktop's `browser_signin.rs`: MIS `/desktop/signin` + PKCE + `/auth/desktop-handoff` with a new **`app=tmcode`** parameter (MIS: allow-list the audience) → MIS session → TM `POST /api/auth/sso/callback`-equivalent exchange → TM JWT stored in the OS keychain (`keyring` crate). |
| **Single sign-out** | Both | TM already receives MIS back-channel logout. TM revokes TMCode sessions too; the next heartbeat or sync returns `401 SESSION_REVOKED`. **In exam mode TMCode keeps working offline and keeps the journal**, then asks to re-launch from TM. |

*Why not reuse the 30-day TM JWT in TMCode?* A leaked exam-scoped token can only touch one attempt until its deadline, while the general TM JWT could do anything the user can.

### 10.3 Exam package

`GET /api/tmcode/sessions/:sid/package` returns:

```jsonc
{
  "submission_id": 812, "quiz": { "id": 77, "title": "Python Practical 2", "type": "Exam" },
  "deadline": "2026-11-10T09:40:00Z", "server_time": "…",   // clock-skew correction
  "policy": { "mode": "monitored", "intelligence": "basic", "paste": "internal_only", "terminal": "off", … },
  "journal_nonce": "base64…",          // HMAC key derivation (§13)
  "profiles": [ { …python-3.12… } ], "toolchains": ["python@3.12.7"],
  "tasks": [ {
      "question_id": 4411, "order": 1, "points": 20, "title": "Grade calculator",
      "brief_md": "…", "profile_id": "python-3.12",
      "files": [ { "path": "main.py", "content": "…", "readonly": false } ],
      "visible_tests": [ … ], "hidden_test_count": 6,
      "resume": { "snapshot_seq": 41, "files": [ … ] }   // when resuming
  } ],
  "live": { "url": "wss://live.amashuri.com", "ticket": "…" }
}
```

Hidden tests, reference solutions and web-check specs **never leave the server**.

### 10.4 Server-side enforcement

- If `delivery = tmcode_required`, then `submitQuestionAnswer` / `submitAllAnswers` **reject coding answers that don't come through `/api/tmcode/*`** with a valid TMCode session (`409 TMCODE_REQUIRED`), and TM's web `CodeSpaceEditor` shows "This exam must be taken in TMCode".
- If `require_seb`, TM validates the SEB `X-SafeExamBrowser-ConfigKeyHash` (= `SHA256(url + ConfigKey)`) on the exam lobby page and on `POST /api/tmcode/launch`.
- One active TMCode session per attempt: a second launch **supersedes** the first. The old one gets `SESSION_SUPERSEDED`, is shown to the instructor as a flag, and its journal keeps syncing read-only.
- The deadline is **server-owned** (reuse `quizTiming.ts`: `computeAttemptEndTime`, `SUBMIT_GRACE_SECONDS`, `finalizeFromSavedAttempts`). The instructor "extend" action updates `end_time` server-side and pushes it live.

### 10.5 Mapping onto existing tables

A TMCode attempt **is** a `QuizSubmission`, and each task answer **is** a `QuizAttempt`. The final snapshot is written into `QuizAttempt.submitted_answer` in the existing project-mode shape (`{code: JSON.stringify(files), language}`). Existing results pages, reports, rankings and report cards therefore keep working unchanged. TMCode-specific detail (snapshots, runs, telemetry, flags) lives in new tables (§14) keyed by `submission_id` + `question_id`.

Assignments (take-home practicals): **Phase 7** adds "Code assignment" delivery, using the same snapshot/judge pipeline linked to `Submission` instead of `QuizSubmission`. It also fixes the source-extension upload whitelist.

---

## 11. Exam integrity: modes, lockdown, AI controls, evidence

### 11.1 Modes

| Control | Practice | **Monitored** (personal laptops) | **Secure** (lab machines) |
|---|---|---|---|
| Window | Normal | Fullscreen, always-on-top, close-guard ("Submit or Save & exit") | Fullscreen kiosk (TMCode inside SEB, or SEB-permitted app) |
| Focus loss | — | Logged + toast; instructor sees a live count | Blocked by SEB; any escape = high flag |
| Keyboard escapes (Alt+Tab, Win, Cmd+Tab, Mission Control) | — | Windows: low-level hook swallows them; macOS: presentation options hide Dock/menu and disable process switching (`NSApplicationPresentationDisableProcessSwitching` in kiosk presentation) | SEB (Windows kiosk desktop; macOS AAC) |
| Screen capture of TMCode | — | Content protection ON | ON |
| Paste | Allowed | **Internal only**: TMCode keeps its own clipboard ring and only pastes text copied inside this attempt; external pastes are blocked and logged with size | Same, or `block` |
| OS clipboard | — | Cleared at start and end | Same |
| Terminal | Full | Off (or restricted console) | Off |
| Editor intelligence | Up to `full` | Per quiz (default `basic`) | Per quiz (default `none`/`basic`) |
| AI tools in TMCode | Socratic hints if the task allows | None | None |
| Process scan (every 5 s) | — | Blocklist → **warn, flag, and block exam start** until closed | Same; SEB also kills them |
| VM / remote desktop / multi-monitor detection | — | Flag (blocking is configurable) | Block |
| Network | Any | App-level: TMCode only talks to TM/live/toolchain hosts; preview has no internet | **Router/firewall allow-list** (TM API, live, toolchains) during the exam window; preview no internet |
| Heartbeat | — | 10 s via live-server; gap > 30 s = offline flag | Same |
| Webcam | — | Optional: student also keeps TM's browser proctoring open (existing stack) | Optional |

### 11.2 Blocklist (server-managed, updatable without a release)

`GET /api/tmcode/blocklist` returns signed JSON with categories and match rules (process name, executable path pattern, Windows signer / macOS bundle id):

- **AI assistants:** ChatGPT, Claude, Copilot (Microsoft Copilot app), Gemini, Perplexity, Cursor, Windsurf, Zed AI, **VS Code** (it carries Copilot), Ollama/LM Studio (local LLMs), and capture-hidden "interview helper" overlays (e.g. Cluely)
- **Remote access:** AnyDesk, TeamViewer, RustDesk, Chrome Remote Desktop host, Parsec, VNC servers
- **Capture/streaming:** OBS, Discord (screen share), Zoom, Teams, Meet PWA windows
- **Browsers:** a policy choice. Default for Monitored mode: warn and log, since closing every browser is a hard ask. Block in Secure mode.

Detection is honest about its limits (renamed binaries, a second device, a phone). The flag record keeps what matched (name, path, signer) as evidence.

### 11.3 Safe Exam Browser integration (Secure labs)

Two supported setups. Pick per lab in Phase 6 testing.

1. **TMCode as an SEB permitted application (Windows).** The SEB config (`.seb`) starts at the TM exam lobby URL, permits `TMCode.exe` (by signature or path), blocks everything else, and SEB sends `X-SafeExamBrowser-ConfigKeyHash`. TM verifies it and only then issues the launch ticket. On macOS, permitted third-party apps need a special user setup, so prefer option 2 on Macs.
2. **TMCode Web inside SEB (macOS and fallback).** A web build of the TMCode workbench (same React code; Rust-only features replaced by server execution: "Run" calls the judge with visible tests, preview runs from a sandboxed service worker) served at `tmcode.amashuri.com`, opened only inside SEB, with the Config Key verified on every API call. This also covers Chromebooks and broken laptops.

IT gets one `.seb` file per exam template (generated by TM: `GET /api/tmcode/quizzes/:id/seb-config`), opened via `sebs://`.

### 11.4 Evidence: telemetry and flags

**Telemetry** (Monaco `onDidChangeModelContent` deltas + app events), batched every 5 s into the journal and synced:

| Event | Data |
|---|---|
| `edit` | file, offset, removed length, inserted text, t (ms) |
| `paste` | file, length, origin (`internal`/`external-blocked`/`external-allowed`), first 200 chars hash |
| `focus` | lost/gained, duration, foreground app name (Windows/macOS API, if available) |
| `run` / `test` | profile, result summary, duration |
| `file` | create/rename/delete |
| `env` | process-scan hits, monitor count change, VM verdict, network change |
| `lifecycle` | start, resume, supersede, offline/online, submit |

Size: ~50–200 KB gzip per student per exam. It is stored as compressed blobs on the MIS file-server, with an index in MySQL.

**Flag rules** (computed server-side on sync, so they can't be bypassed client-side; thresholds configurable):

- External paste blocked/allowed > 80 chars or > 1 line
- "Teleport insert": > 200 chars inserted in one delta without a paste event
- Sustained typing > 15 chars/s for > 20 s
- Large code arrival within 10 s after a focus return of > 30 s
- Near-zero delete ratio with a long final solution and no exploratory runs
- Process-scan hit, VM, extra monitor, remote access, content-protection disabled
- Heartbeat gap > 30 s (offline), session superseded, journal HMAC break (tamper)

Severity: info / warn / high. **Flags never change grades automatically.** They prioritise the instructor's review and can trigger a **viva** (TM records the viva outcome as part of the manual grade).

**Similarity:** after the exam closes, a job runs **Dolos** per question over all final snapshots + previous cohorts (optional) + **LLM baseline solutions** generated from the task brief by the existing AI providers (5 per question). The result is clusters with highlighted overlapping fragments in the review UI.

---

## 12. Instructor experience: live console, review, grading

### 12.1 Live Exam Console (TM web, `/quizzes/:id/tmcode-console`)

- **Grid of students:** status (not started · pre-flight · working · offline · submitted · grading · done), time left, current task, local test pass ratio (self-reported, labelled), last sync, flag count by severity.
- **Actions per student or bulk:** message, warn, pause/resume (reuse live-server `pause-student-exam` / `resume-student-exam`), **extend time** (server `end_time`), force submit, terminate (reuse `end-student-quiz`), allow re-launch on a new device.
- **Live peek** (Monitored/Secure): read-only view of the student's latest synced snapshot (≤ 10 s old). This is not a screen stream (lower bandwidth, no extra consent issues).
- Realtime: new socket.io namespace `/tmcode` on the existing live-server, authenticated with the existing live tickets (`liveSocketTicket.ts`). Rooms: `quiz:<id>:proctors`, `session:<sid>`.

### 12.2 Review & Grading workspace (TM web, `/quizzes/:id/submissions/:sid/code`)

| Pane | Content |
|---|---|
| Left | Student list (sort by score / flags / similarity), task tabs |
| Centre | Read-only Monaco: file tree, **diff vs starter**, **diff vs another student** (from a similarity cluster) |
| Right | Test results (each test: input, expected, actual, diff, time; hidden tests visible to staff), **Re-run** (judge, same snapshot), web **preview** (student vs reference side by side) |
| Bottom | **Replay timeline:** scrub through the session with markers for pastes, focus losses, runs and flags; playback speed 1–20× |
| Grade box | Auto score breakdown, rubric criteria, manual adjustment with reason (audit-logged), feedback (Markdown + inline code comments anchored to lines), AI rubric suggestion (optional, clearly labelled) |

Grades flow through the existing `POST /api/quizzes/submissions/:id/grade` (`grading.controller.ts`), extended with `{rubric_scores, line_comments}`. `grade_status` semantics are unchanged.

**Export:** CSV of scores per test/rubric item, ZIP of all final snapshots, similarity report PDF (existing `pdfkit` in the TM server).

### 12.3 Student feedback

After release, the student sees in TMCode and in TM web: per-test pass/fail (hidden tests by name only, without inputs), rubric scores, inline comments in their code, and the teacher's feedback.

---

## 13. Offline-first saving and submission

1. **Local journal** (Rust `journal`, SQLite via `rusqlite` in the app data dir, one DB per attempt). It is append-only:
   - `snapshot(seq, question_id, files_hash, files_blob(zstd), client_ts, mono_ts)`, taken every 10 s if dirty, on every run, on task switch and on submit
   - `telemetry(seq, batch_blob)`
   - Each record carries `hmac = HMAC-SHA256(k_attempt, prev_hmac ‖ record)`, where `k_attempt = HKDF(journal_nonce, device_id)`. A deleted or edited record breaks the chain, which the server detects on sync.
2. **Sync queue:** uploads in order with idempotency key `(session_id, seq)`, exponential backoff, resumes after restart. Snapshots are **deltas** (changed files only) after the first full one.
3. **Clock:** the deadline is enforced with server time, using the offset measured at package download and on each heartbeat, plus a monotonic clock while offline (so changing the OS clock does nothing).
4. **Deadline while offline:** the editor locks at the deadline and shows *"Saved on this computer – waiting for connection. Do not close TMCode."* The server accepts the final snapshot later **if** its monotonic-adjusted time is ≤ deadline + `allow_offline_grace_minutes` and the HMAC chain is intact. TM marks it "submitted offline at T, received at T2".
5. **Last resort (labs):** *Export sealed bundle* writes the encrypted journal to a USB stick, and the invigilator uploads it from TM's console. The same HMAC verification applies.
6. **Crash/restart:** relaunching from TM resumes from the journal (the local journal is newer than the server one, so a merge picks the highest seq).
7. **The device is lost or dies:** re-launch on another machine resumes from the last *synced* snapshot (≤ 10 s of work lost while online).

---

## 14. Data model changes (Task Mentor MySQL)

New Sequelize migrations in `nga-task-mentor/server/migrations/` (production: apply SQL by hand, per the deploy notes).

```sql
-- per-test results finally persisted (fixes D1); used by web + TMCode
ALTER TABLE quiz_attempts ADD COLUMN grading_details JSON NULL;

CREATE TABLE tmcode_profiles (
  id VARCHAR(40) PRIMARY KEY, version INT NOT NULL, definition JSON NOT NULL,
  status ENUM('active','deprecated') NOT NULL DEFAULT 'active',
  updated_at DATETIME NOT NULL
);

CREATE TABLE tmcode_devices (
  id CHAR(36) PRIMARY KEY,                    -- random per install, stored in app data
  user_id INT NOT NULL, os VARCHAR(40), os_version VARCHAR(40), arch VARCHAR(16),
  app_version VARCHAR(20), first_seen DATETIME, last_seen DATETIME,
  INDEX (user_id)
);

CREATE TABLE tmcode_sessions (
  id CHAR(36) PRIMARY KEY, submission_id INT NOT NULL, user_id INT NOT NULL,
  device_id CHAR(36) NOT NULL, mode ENUM('practice','monitored','secure') NOT NULL,
  status ENUM('active','superseded','revoked','ended') NOT NULL,
  journal_nonce VARBINARY(32) NOT NULL, env_report JSON, seb_verified TINYINT(1) DEFAULT 0,
  started_at DATETIME NOT NULL, last_heartbeat DATETIME, ended_at DATETIME,
  INDEX (submission_id), INDEX (user_id)
);

CREATE TABLE tmcode_launch_tickets (
  ticket_hash CHAR(64) PRIMARY KEY, submission_id INT NOT NULL, user_id INT NOT NULL,
  expires_at DATETIME NOT NULL, used_at DATETIME NULL
);

CREATE TABLE tmcode_snapshots (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, session_id CHAR(36) NOT NULL,
  submission_id INT NOT NULL, question_id INT NOT NULL, seq INT NOT NULL,
  kind ENUM('auto','run','final','offline_final') NOT NULL,
  files_hash CHAR(64) NOT NULL, blob_path VARCHAR(255) NOT NULL,  -- MIS file-server
  client_ts DATETIME(3), server_ts DATETIME(3) NOT NULL, hmac CHAR(64) NOT NULL,
  UNIQUE KEY (session_id, seq), INDEX (submission_id, question_id)
);

CREATE TABLE tmcode_runs (                    -- judge job queue + results
  id BIGINT AUTO_INCREMENT PRIMARY KEY, snapshot_id BIGINT NOT NULL,
  purpose ENUM('grade','regrade','validate_reference','server_run') NOT NULL,
  engine VARCHAR(20), engine_version VARCHAR(40), profile_id VARCHAR(40), profile_version INT,
  tests_version CHAR(64), status ENUM('queued','running','done','error') NOT NULL,
  results JSON, score DECIMAL(8,2), max_score DECIMAL(8,2),
  queued_at DATETIME(3), started_at DATETIME(3), finished_at DATETIME(3),
  INDEX (status, queued_at)
);

CREATE TABLE tmcode_telemetry (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, session_id CHAR(36) NOT NULL, seq INT NOT NULL,
  blob_path VARCHAR(255) NOT NULL, events INT, t_from DATETIME(3), t_to DATETIME(3),
  UNIQUE KEY (session_id, seq)
);

CREATE TABLE tmcode_flags (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, session_id CHAR(36) NOT NULL,
  submission_id INT NOT NULL, question_id INT NULL,
  rule VARCHAR(40) NOT NULL, severity ENUM('info','warn','high') NOT NULL,
  evidence JSON, at DATETIME(3) NOT NULL, reviewed_by INT NULL, review_note TEXT NULL,
  INDEX (submission_id)
);

CREATE TABLE tmcode_similarity (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, quiz_id INT NOT NULL, question_id INT NOT NULL,
  run_at DATETIME NOT NULL, report JSON NOT NULL   -- Dolos pairs/clusters/fragments
);
```

**Question data:** `question_bank.question_data` for `coding` gains `profile_id`, `workspace{files[], entry, readonly[], hidden[]}`, `tests{io[], unit_files[], web_spec}`, `reference{files[]}` (stripped for students by `sanitizeQuestionForStudent`), and `rubric[]`. A migration maps old `language` + `starter_code` + `project_files` onto the new shape. The old fields stay readable.

**Quiz settings:** `proctoring_settings` gains `tmcode_delivery`, `tmcode_mode`, `tmcode_policy JSON`.

**Permissions** (new migration, following `20260929120000-add-rankings-permissions.js`):

| Key | Default roles |
|---|---|
| `TMCODE_USE` | student, instructor, admin |
| `TMCODE_CONSOLE_VIEW` | instructor (own/assigned subjects via `getScopedSubjects`), admin |
| `TMCODE_CONSOLE_CONTROL` (pause/extend/terminate) | instructor, admin |
| `TMCODE_REVIEW_TELEMETRY` (replay, flags) | instructor, admin |
| `TMCODE_PROFILES_MANAGE` | admin |
| `TMCODE_BLOCKLIST_MANAGE` | admin |

---

## 15. API and protocol

All under `https://taskmentor-api.amashuri.com/api/tmcode`. Student endpoints use the attempt-scoped token; staff endpoints use the TM JWT plus permissions.

| Method & path | Who | Purpose |
|---|---|---|
| `GET /profiles` · `GET /toolchains` · `GET /blocklist` | any TMCode | Signed, cacheable config |
| `POST /launch` `{quiz_id}` | student (TM JWT) | Creates/resumes the submission → `{ticket, deeplink}` |
| `POST /sessions` `{ticket, device, env_report}` | TMCode | Redeem → `{session_id, token, package_url}`; supersedes an older session |
| `GET /sessions/:sid/package` | TMCode | Exam package (§10.3) |
| `POST /sessions/:sid/snapshots` (multipart: meta + zstd blob) | TMCode | Idempotent by `seq`; verifies the HMAC chain |
| `POST /sessions/:sid/telemetry` | TMCode | Idempotent by `seq` |
| `POST /sessions/:sid/server-run` `{question_id, snapshot_seq}` | TMCode | Visible tests on the judge (for profiles with no local toolchain); rate-limited |
| `POST /sessions/:sid/submit` `{final_seqs[]}` | TMCode | Seals; enqueues grading; returns `{status:'grading'}` |
| `GET /sessions/:sid/results` | TMCode | Released results only |
| `POST /questions/:id/validate` | instructor | Reference solution vs all tests |
| `GET /quizzes/:id/console` | staff | Console snapshot (then socket updates) |
| `POST /sessions/:sid/actions` `{pause|resume|extend|message|force_submit|terminate|allow_relaunch}` | staff | Mirrors to live-server |
| `GET /submissions/:id/review` · `GET /snapshots/:id/files` · `GET /sessions/:sid/replay` | staff | Review workspace |
| `POST /runs` `{snapshot_id, purpose:'regrade'}` | staff | Re-grade |
| `POST /quizzes/:id/similarity` · `GET /quizzes/:id/similarity` | staff | Dolos job |
| `GET /quizzes/:id/seb-config` | staff | Generates a `.seb` file |

**Socket.io namespace `/tmcode`** (live-server):

- Client → server: `hb {sid, seq_synced, task, local_tests, focus}`, `flag {…}` (also persisted via REST)
- Server → client: `paused`, `resumed`, `deadline {end_time}`, `message {text}`, `force_submit`, `terminated`, `superseded`
- Server → proctors: `student_state`, `flag_raised`, `snapshot_synced`

**Error codes** (house style, as in `quizStudentView.ts`): `TMCODE_REQUIRED`, `TICKET_INVALID`, `TICKET_USED`, `SESSION_SUPERSEDED`, `SESSION_REVOKED`, `ATTEMPT_TIME_EXPIRED`, `JOURNAL_TAMPERED`, `UNSUPPORTED_PROFILE`, `SEB_REQUIRED`, `PREFLIGHT_BLOCKED`.

---

## 16. Security model

| Threat | Control |
|---|---|
| Student forges a score | No client scoring; server re-run only (D-04) |
| Student extracts hidden tests | Never sent; `server-run` runs visible tests only; judge output for hidden tests is reduced to pass/fail for students |
| Student probes the judge with arbitrary tests | Fix D3; `server-run` rate-limited per session |
| Malicious student code on the judge | Isolated host, `isolate` sandbox, no network, CPU/mem/pids/output limits, wiped per job, private network only |
| Malicious code on the student machine (local run) | It is their own machine; scrubbed env and workspace cwd; Job Objects / process groups to kill the tree |
| Preview XSS reaching the app | Separate webview, no IPC, `tmpreview://` scheme, strict CSP, no `allow-same-origin` with app origin |
| Tampering with the journal or replaying old snapshots | HMAC chain with server nonce, monotonic seq, server-side timestamps, supersede detection |
| Ticket theft (e.g. from browser history) | Single use, 120 s, hashed at rest, bound to user + submission, redeem logs the device |
| Stolen attempt token | Scoped to one attempt + `/api/tmcode/*`, expires at the deadline, revoked on sign-out or supersede |
| Fake TMCode client (script talking to the API) | Partially detectable: missing telemetry patterns, missing environment report, no SEB key in Secure mode. **Secure mode requires an SEB Config-Key** on launch. Accept residual risk in Monitored mode. |
| Updater compromise | minisign signature (existing key infrastructure); HTTPS only |
| Privacy | Telemetry is code edits + app names only, with no keystrokes outside TMCode, no screenshots and no webcam. A consent screen at first exam start. Retention 12 months (configurable), then purge. Documented in the student-facing policy. |

Tauri hardening: a single capability per webview (`workbench.json` for commands; preview has **none**), `build.rs` permission gating, strict CSP, no `shell` plugin open-ended commands (only the runner's profile commands), `dangerousRemoteDomainIpcAccess` never used.

---

## 17. Repository layout and tech stack

```
nga-tmcode/
├── apps/
│   ├── desktop/                 # Tauri app
│   │   ├── src/                 # React workbench entry (desktop adapters)
│   │   └── src-tauri/
│   │       ├── src/
│   │       │   ├── lib.rs  main.rs
│   │       │   ├── session.rs       # launch ticket, token, package, supersede
│   │       │   ├── auth.rs          # PKCE desktop sign-in (from nga-desktop)
│   │       │   ├── workspace.rs     # attempt folders, file ops, watcher
│   │       │   ├── journal.rs       # SQLite + HMAC chain
│   │       │   ├── sync.rs          # upload queue, backoff, idempotency
│   │       │   ├── runner/          # spawn, limits (job objects / rlimit), channels
│   │       │   ├── toolchains.rs    # packs: index, download, verify, detect system
│   │       │   ├── preview.rs       # tmpreview:// protocol, child webview
│   │       │   ├── lockdown/        # windows.rs (hooks, content protection), macos.rs
│   │       │   ├── scan.rs          # process/VM/monitor checks
│   │       │   ├── heartbeat.rs     # socket.io client (rust_socketio) or WS bridge
│   │       │   ├── pty.rs           # practice terminal (portable-pty)
│   │       │   ├── updates.rs  dialogs.rs  theme.rs  menus.rs   # from nga-desktop
│   │       └── capabilities/  build.rs  tauri.conf.json
│   └── web/                     # TMCode Web build (SEB / fallback, §11.3)
├── packages/
│   ├── workbench/               # React VS Code–replica UI (shared by desktop + web)
│   │   ├── layout/ (TitleBar, ActivityBar, SideBar, EditorGroups, Panel, StatusBar)
│   │   ├── views/  (Explorer, Outline, Tests, Problems, Output, Preview, TaskBrief)
│   │   ├── monaco/ (setup, workers, themes, keybindings, paste-guard, telemetry)
│   │   └── platform.ts          # interface implemented by desktop (Tauri) and web
│   ├── protocol/                # zod schemas: package, snapshot, telemetry, events
│   │                            #   → also consumed by nga-task-mentor (npm git dep)
│   ├── profiles/                # profile JSON + acceptance fixtures
│   └── themes/                  # VS Code theme JSON → Monaco/CSS converter
├── services/
│   ├── judge/                   # docker-compose for Piston/Judge0 + isolate, runtime pins
│   └── webgrader/               # Playwright worker (Node), job API
├── toolchains/                  # pack build scripts (CI) + toolchains.json
├── docs/  IMPLEMENTATION_PLAN.md  ARCHITECTURE.md  RELEASING.md  LAB_SETUP.md
└── .github/workflows/           # ci, release, publish, toolchains, profile-acceptance
```

**Stack and pins**

| Layer | Choice |
|---|---|
| Shell | Tauri `=2.12.1`, Rust ≥ 1.85; plugins single-instance, window-state, store, updater, log, process, deep-link (`tmcode://`), clipboard-manager |
| Rust crates | `rusqlite` (bundled), `zstd`, `hmac`/`sha2`/`hkdf`, `portable-pty`, `sysinfo`, `windows` (Job Objects, hooks, `SetWindowDisplayAffinity`), `objc2-app-kit`, `keyring`, `reqwest` (rustls), `tokio-tungstenite` or `rust_socketio` |
| UI | React 19, Vite 8, TypeScript, Zustand, `monaco-editor` 0.56.x (local), `@vscode/codicons`, `allotment`, `react-arborist`, xterm.js 5 + fit/web-links addons |
| Web preview | `esbuild` (native sidecar) / `esbuild-wasm`, vendored React 19 |
| Fallback runtimes | Pyodide 314 (Python), Web Worker (JS) |
| LSP (optional) | `monaco-languageclient` + basedpyright (worker or sidecar), clangd sidecar (Practice) |
| Server additions (TM) | `CodeRunner` adapters, job worker, `@dodona/dolos`, zod schemas from `@nga/tmcode-protocol` |
| Judge host | Ubuntu 24.04, Docker, Piston (or Judge0 CE 1.13.1), Playwright Chromium |

---

## 18. Build, release and distribution

- **Same model as NGA Desktop:** tag `vX.Y.Z` → `release.yml` builds Windows NSIS + MSI and a macOS universal dmg + `.app.tar.gz`, signs the updater artifacts (minisign; **a separate key `~/.tauri/tmcode.key`** for blast-radius isolation, with the same backup routine), and rsyncs to `/opt/apps/desktop-releases/tmcode/X.Y.Z/`. `publish.yml` makes it live.
- **MIS change:** `routes/desktop.ts` gets a `:product` segment (`/desktop/tmcode/release`, `/desktop/tmcode/update/{target}/{arch}/{ver}`, `/desktop/tmcode/install.sh|ps1`), keeping the existing NGA paths as aliases.
- `/apps` page in MIS: a TMCode card (OS-aware download, one-line installers with no Gatekeeper/SmartScreen warning, winget `Amashuri.TMCode`).
- **Exam freeze:** the updater never installs during an active exam session. TM can set a **minimum TMCode version** per quiz (sent in the launch response; older clients are told to update in the lobby, *before* the exam starts).
- **Lab deployment guide** (`docs/LAB_SETUP.md`): silent MSI install, toolchain pre-seed, SEB install + config, router allow-list hostnames, pre-exam checklist, invigilator script.
- macOS: ad-hoc bundle signature (as NGA Desktop 0.2.1). Revisit Developer ID + notarisation if the Apple education fee waiver comes through. The same waiver would unlock the Assessment Mode entitlement (§3.4).

---

## 19. Phased delivery plan

Estimates assume **2 engineers** (one full-stack TS, one Rust/desktop) plus part-time QA from the Coding Academy staff. Calendar weeks, including review.

### Phase 0: Spikes and TM fixes (2.5 weeks)

| Item | Exit criterion |
|---|---|
| S1 Monaco 0.56 in Tauri on WKWebView + WebView2 with workers via `tauri://` | Typing 10k-line file at 60 fps; workers confirmed off-main-thread on both OSes |
| S2 `tmpreview://` protocol + child webview + console shim | Static site + React (esbuild-wasm) preview works offline on both OSes |
| S3 Judge host: Piston vs Judge0 on Ubuntu 24.04 (cgroup v2), multi-file, 60 concurrent submissions | Engine chosen; p95 grading latency < 15 s at 60 parallel jobs |
| S4 Launch ticket + `tmcode://` deep link from TM web and from inside NGA Desktop | Round trip < 3 s; works when TMCode is closed or already open (single-instance) |
| S5 Windows content protection + keyboard hook; macOS kiosk presentation options | Demonstrated, with known limits documented |
| **Work package TM-FIX** items 1–8 + the D6 interim (§19.1), shipped to production independently of TMCode | All TM-FIX exit criteria met; deployed; existing web quizzes regression-tested |

**Go/no-go gate:** if S1 fails on WKWebView, fall back to running Monaco workers in the main thread for the macOS build only (acceptable for exam-sized files) and re-evaluate.

### 19.1 Work package TM-FIX: Task Mentor defects

The full-stack engineer owns this work package in parallel with the desktop spikes. It runs on its own branch in `nga-task-mentor`, with **one PR per item**, each with tests. Run the server jest suites with `--runInBand` against the dev DB (DB contention otherwise). Deploy as each PR merges.

| Item | Defect | Phase | Effort |
|---|---|---|---|
| TM-FIX-1 | D1 per-test results dropped | 0 | 2 d |
| TM-FIX-2 | D2 algorithmic always 0 | 0 | 3 d |
| TM-FIX-3 | D3 client-supplied test cases | 0 | 1.5 d |
| TM-FIX-4 | D4 unknown language → Node | 0 | 0.5 d |
| TM-FIX-5 | D5 unenforced proctoring settings | 0 (web) / 4 (TMCode) | 3 d + Phase 4 |
| TM-FIX-6 | D6 RapidAPI Judge0 | 0 (interim) / 3 (cutover) | 1 d + Phase 3 |
| TM-FIX-7 | D7 "Run tests" = graded save | 0 | 1 d |
| TM-FIX-8 | D8 coding answers not autosaved | 0 | 1 d |
| TM-FIX-9 | D9 CDN-loaded Monaco and preview libs | 3 | 1.5 d |
| TM-FIX-10 | D10 AI can raise test score | 3 | 0.5 d |
| TM-FIX-11 | D11 source files rejected on upload | 7 | 0.5 d |

**Phase 0 total ≈ 13 engineer-days.** That is about 2.5 weeks for one engineer, so Phase 0 stretches to 2.5 weeks for the TM side; the desktop spikes are unaffected.

#### TM-FIX-1: Persist and return per-test results (D1)

- **Steps**
  1. In `AdvancedQuizGrader.gradeCoding` (`quizGrader.ts` ~2976–3044), **merge** instead of replacing: `detailed_feedback: { ...basicResult.detailed_feedback, strategy_used, breakdown, penalties_applied }`, so `testResults`, `passedTests` and `totalTests` survive.
  2. Migration: `ALTER TABLE quiz_attempts ADD COLUMN grading_details JSON NULL` (§14). Add the field to `QuizAttempt.model.ts`, and write it in `submitQuestionAnswer` and `submitAllAnswers` (`attempt.controller.ts:206`, `:409`).
  3. Strip results for students before responding, in `quizStudentView.ts`: hidden tests → `{id, is_hidden:true, passed, points}` only (no input, expected or actual). Staff (`QUIZZES_VIEW_RESULTS_ALL`) get everything.
  4. Show stored results in `QuizResultsPage` and the instructor grading view (`grading.controller.ts::getSubmissionForGrading`).
- **Tests:** a grader unit test asserting `testResults` survives the advanced wrapper; an integration test (extend `quizSettings.integration.spec.ts`) asserting hidden inputs never reach a student response.
- **Done when:** "Run tests" in the web editor shows pass/fail per visible test; the teacher sees all tests; the DB row has `grading_details`.

#### TM-FIX-2: Make algorithmic questions gradable (D2)

The algorithmic *authoring* schema (`algorithm_description`, `input_format`, `output_format`, `constraints`, `test_cases[]`) already describes an I/O programming problem. Only the *answer widget* is wrong.

- **Steps**
  1. **Client:** render `algorithmic` questions with `CodeSpaceEditor` (language picker limited to `allowed_languages`, default from the question), plus a header showing the description, input/output format and constraints. The answer shape becomes `{code, language}`, the same as `coding`.
  2. **Retire the trace/predict widget.** Its steps are hardcoded placeholders (`AlgorithmicQuestion.tsx:50-90`), and its client-computed `score` must never be trusted. If a genuine "trace the algorithm" exercise is wanted later, it becomes a new question type with server-side expected states (Phase 7 backlog).
  3. **Server:** `gradeAlgorithmic` keeps delegating to `CodingGrader.gradeCoding`. `normalizeAnswer` maps `solution` → `code` **only** when `solution` looks like source code (not one of the widget's placeholder strings). Otherwise it returns `points 0, grade_status 'pending'` with feedback "No code submitted – needs manual review" instead of a silent error.
  4. **Data repair script** (`server/scripts/repairAlgorithmicAttempts.ts`, dry-run by default): list existing algorithmic attempts scored 0 with no `code`, and mark their submissions `grade_status = 'pending'` so teachers can review them. It never auto-awards points.
  5. **Authoring form:** require at least one test case and a supported language for algorithmic questions.
- **Tests:** grader unit tests for `{code}`, `{solution: <code>}` and widget-placeholder answers; client test that the algorithmic question renders the code editor and emits `{code, language}`.
- **Done when:** a correct algorithmic answer scores full marks through the judge, and the repair script's report has been reviewed with the Coding Academy lead before running it for real.

#### TM-FIX-3: Server-owned test cases for code runs (D3)

- **Steps**
  1. `runCode` (`quiz.controller.ts:2070`) loads the question by `:questionId` and **ignores `test_cases` from the body** for anyone without `QUIZZES_EDIT`.
  2. Students: run **visible** tests only, and only if the question belongs to a quiz they may currently attempt (`quizAvailability` / `studentAttemptSummary` from `quizStudentView.ts`).
  3. Authors (`/preview-run`, `QUIZZES_EDIT`): may still post draft test cases (needed while authoring).
  4. Free "Run with stdin" stays, but is capped: input ≤ 64 KB, output ≤ 256 KB, and a rate limit of 10 runs/min per user (`express-rate-limit` keyed by user id).
- **Tests:** an integration test where a student posts custom `test_cases` → they are ignored and visible DB tests run; a non-enrolled student → 403; the rate limit → 429.
- **Done when:** no student request can make the judge evaluate test data the student supplied (other than plain stdin runs).

#### TM-FIX-4: Fail closed on unknown languages (D4)

- **Steps**
  1. `Judge0Service.getLanguageId` returns `null` for unknown languages. Callers return `400 UNSUPPORTED_LANGUAGE` (run) or grade `pending` with feedback (submission). There is no Node fallback.
  2. The question form only offers languages present in the server's supported list (`GET /api/quizzes/code-languages`). On save, the server validates `language` and `allowed_languages`.
  3. One-off audit query: list existing coding/algorithmic questions whose language is unmapped, for teachers to fix.
- **Tests:** a unit test for the mapping (each known language; unknown → null); an integration test for the 400.
- **Done when:** no code is ever executed under a runtime other than the one its question declares.

#### TM-FIX-5: Enforce the proctoring settings that exist (D5)

**Part A, web quiz page (Phase 0):**
1. New hook `client/src/hooks/useQuizLockdown.ts`, used by `QuizTakingPage`, driven by `ProctoringSettings`:
   - `prevent_copy_paste` → block `copy`/`cut`/`paste` events on the page, plus Monaco paste. Same rule as TMCode: text copied *inside* the quiz may be pasted back; external pastes are blocked and logged with their length.
   - `prevent_right_click` → `contextmenu` prevented.
   - `prevent_tab_switching` / `prevent_window_minimization` → `visibilitychange` + `blur` produce **`tab_switch`** events (the type already exists in `ProctoringEvent.model.ts:19`) via `POST /api/proctoring/events`, emit `proctoring-violation` on the live-server, and show a warning overlay with the count. Browsers cannot *prevent* switching, so the UI wording must say "monitored", not "prevented".
2. The `max_flags_allowed` / `auto_terminate_on_high_risk` settings start counting these events (existing settings, currently inert for them).
3. **Honest labels** in `ProctoringSettings.tsx` / `CreateQuizPage.tsx`: rename "Prevent tab switching" to "Detect and log tab switching", and so on.

**Part B, server gate (Phase 0):**
4. `startQuizAttempt` (`attempt.controller.ts:77`) reads the quiz's proctoring settings. If `lockdown_browser` is on, it refuses with **`409 LOCKDOWN_REQUIRED`** unless the request carries a valid SEB Config-Key hash (`X-SafeExamBrowser-ConfigKeyHash`, verified against the quiz's configured key) or comes through a TMCode session (Phase 3+). Until TMCode exists, `lockdown_browser` therefore means "Safe Exam Browser required".
5. `submitQuestionAnswer` refuses answers for a submission that was started without the required lockdown.

**Part C, TMCode (Phase 4):** native enforcement as in §11.1 (paste guard, focus monitoring, kiosk), plus the `tmcode_required` gate (§10.4).

- **Tests:** client tests for each setting (events blocked or logged); an integration test where `lockdown_browser` on with no SEB header → 409, and a valid header → 200.
- **Done when:** every setting in the proctoring form either does what its label says or has been relabelled to what it does.

#### TM-FIX-6: Replace the RapidAPI judge (D6)

**Interim (Phase 0), on the current Judge0 CE:**
1. At server start, fetch and cache `GET /languages` from the judge. Map each language to the **newest runtime the instance offers**, chosen from that list, not hardcoded from memory. Log the chosen versions and expose them to authors in the question form ("Python 3.x.y").
2. Health and quota monitoring: a daily check run plus logged RapidAPI quota headers, with an alert to admins when under 20 % remains; a **pre-exam check** button on the quiz page (runs a hello-world in each language the quiz uses).
3. Make sure judge calls retry with backoff on 429/5xx and never mark a student wrong because the judge was down: grade `pending` with "Judge unavailable – will re-grade". Add a re-grade job for pending answers.

**Cutover (Phase 3):** introduce the `CodeRunner` interface (`server/src/services/coderunner/`). `Judge0Runner` wraps today's `Judge0Service`; `PistonRunner` (or a self-hosted Judge0) runs on the isolated judge host (§8.3); `CODERUNNER_ENGINE` env selects the engine. Switch production once the profile acceptance suites pass on the new engine. Keep RapidAPI configured as a **practice-only** fallback, never for exams.

- **Done (interim) when:** authors see real runtime versions, exam-day quota exhaustion can't silently zero scores, and admins get alerts.
- **Done (cutover) when:** production grading runs on our own judge host and the RapidAPI key is only used by practice runs (or removed).

#### TM-FIX-7: Separate "Run tests" from graded saves (D7)

- `CodeSpaceEditor`'s "Run tests" calls the TM-FIX-3 visible-tests run endpoint, not the answer-submit endpoint. Saving stays on navigation, autosave (TM-FIX-8) and submit.
- Graded saves return hidden-test results to students only when the quiz releases results (`resultVisibility`).
- **Done when:** clicking "Run tests" never creates or changes a graded `QuizAttempt`.

#### TM-FIX-8: Autosave coding answers in the web quiz (D8)

- Add `coding` and `algorithmic` to the background-save types in `client/src/utils/quizTimer.ts`. Debounce 5 s after the last edit (and on blur), saving through the "Answer saved" path without running the judge. Grading happens on submit, or on explicit save in per-question mode.
- Keep a localStorage draft per question as a crash backup (pattern already used for `quiz_${id}_qtime`).
- **Done when:** killing the tab after an edit loses at most ~5 s of code.

#### TM-FIX-9: Bundle Monaco and preview libraries (D9, Phase 3)

- Install `monaco-editor` and point `@monaco-editor/loader` at the local bundle (`loader.config({ monaco })`). Serve React, ReactDOM, Babel standalone and Vue from TM's own static assets instead of unpkg in `LivePreviewPanel.tsx` / `CodePreviewModal.tsx`.
- **Done when:** the web quiz editor and preview work with only `taskmentor*.amashuri.com` reachable.

#### TM-FIX-10: Tests decide the auto score (D10, Phase 3)

- Remove the `max(testPoints, aiPoints)` rule (`quizGrader.ts:1918-1945`). The AI rubric becomes a **suggestion** shown to the teacher in grading (§8.3), applied only by a manual grade action. Add an existing-quiz flag if any teacher depends on the old behaviour (check before switching).
- **Done when:** re-grading the same code always gives the same auto score.

#### TM-FIX-11: Accept source files for code assignments (D11, Phase 7)

- Add common source extensions (`.py .js .ts .jsx .tsx .html .css .java .c .cpp .h .php .sql .json .md`) to `submissionUpload.ts`, plus `.zip` project archives (already allowed), with content-type sniffing and the same 10 MB limit. Do this together with the Phase 7 "code assignments" feature.

### Phase 1: Workbench foundation (3 weeks)

- Repo scaffold, CI, capability gating, single-instance, window state, theme sync, updater wiring (dev key).
- VS Code–replica layout (§6.1): title bar, activity bar, explorer (full file ops), editor groups and tabs, panel, status bar, command palette, quick open, keybindings, Dark/Light Modern + HC themes, settings.
- Practice mode: open local folder, terminal (pty), recent folders.
- **Deliverable:** internal build that a VS Code user recognises immediately (5-person hallway test).

### Phase 2: Language profiles, runner, preview (3 weeks)

- Profile schema + the 8 v1 profiles + acceptance fixtures.
- Toolchain packs (Python, Node, zig cc, JDK 21) with build pipeline, signed index and installer UI. System detection.
- Runner with limits, interactive console, Tests view (visible tests), Problems from compiler output.
- Preview for Web and React profiles; device toolbar; preview console.
- Pyodide/JS fallbacks.
- **Deliverable:** all profile acceptance suites green locally on Windows + macOS.

### Phase 3: Task Mentor integration (4 weeks)

- TM: migrations (§14), `CodeRunner` adapters, judge job worker, self-hosted judge deployed (private network), web grader (Playwright). This is the **TM-FIX-6 cutover** off RapidAPI.
- TM: **TM-FIX-9** (bundle Monaco and preview libraries) and **TM-FIX-10** (tests decide the auto score).
- TM: authoring UI (profile picker, workspace template, tests, reference validation, rubric, TMCode quiz settings).
- TM: `/api/tmcode/*` endpoints, launch flow, exam package, snapshots, submit, results.
- TMCode: session flow, journal + sync, resume, deadline handling, submit, results view.
- MIS: desktop handoff `app=tmcode`; `/desktop/:product` routes.
- **Deliverable:** end-to-end practice quiz: author → launch → solve → submit → server grade → results.

### Phase 4: Exam integrity (3 weeks)

- Modes and policy enforcement; paste guard; intelligence levels; terminal policy.
- Lockdown (Windows hooks, content protection, fullscreen/close-guard; macOS presentation options), pre-flight checks, process/VM/monitor scan, signed blocklist.
- Telemetry capture + sync; server flag rules; heartbeat via live-server `/tmcode` namespace; supersede.
- `tmcode_required` server gate; SEB Config-Key verification (extends the TM-FIX-5 Part B gate); `.seb` generator.
- **TM-FIX-5 Part C:** native enforcement of the proctoring settings inside TMCode.
- **Deliverable:** red-team session by staff (try to cheat for 1 hour) → every attempt is either blocked or produces a flag.

### Phase 5: Instructor console and review (3 weeks)

- Live Exam Console with actions.
- Review & Grading workspace: diffs, test details, re-run, preview side-by-side, replay timeline, rubric + inline comments, AI rubric suggestion.
- Dolos similarity job + LLM baselines + cluster view.
- Exports (CSV, ZIP, PDF).
- **Deliverable:** a teacher grades a 30-student mock practical in < 45 min.

### Phase 6: Hardening, pilot, release (3 weeks)

- Offline drills (pull the network mid-exam, kill the app, reboot, change OS clock), load test at 2× cohort size, accessibility pass.
- TMCode Web build for SEB/macOS labs.
- Lab setup guide, student guide (install + unsigned-app steps), invigilator script.
- **Pilot:** one Coding Academy class: a formative practical (Monitored) then a summative practical (Secure in lab). Collect metrics (§1.2) and a survey.
- Production release v1.0 via `/apps`, winget.

### Phase 7: After v1 (backlog, prioritise after pilot)

- Code assignments (take-home) on the same pipeline, with **TM-FIX-11** (accept source files on upload).
- A real "trace the algorithm" question type with server-side expected states (replaces the widget retired in TM-FIX-2).
- Desktop "Review mode" for teachers (offline grading of a ZIP).
- SQL and PHP profiles; Turtle/pygame canvas preview; Jupyter-style cells.
- Evaluate `@codingame/monaco-vscode-api` (views mode, TextMate grammars) for even closer VS Code parity.
- Full LSP sidecars (clangd, basedpyright) in Practice mode.
- Linux build; Developer ID + macOS Assessment Mode if the Apple waiver arrives.
- Pair-programming / teacher "join session" (live cursor) for Practice mode.

**Total to v1.0: ~21.5 weeks** with 2 engineers. Phase 0 can start immediately. A slimmer **MVP for a formative pilot** (Phases 0–3 + paste guard + telemetry from Phase 4) is reachable in **~12–13 weeks**.

---

## 20. Testing strategy

| Layer | Tooling | What |
|---|---|---|
| Rust units | `cargo test` | Journal HMAC chain, sync idempotency, runner limits (timeout, output cap, tree kill), policy evaluation, blocklist matching, ticket/session state machine |
| Workbench | Vitest + Testing Library | Layout commands, explorer ops, paste guard, telemetry batching, intelligence levels, preview console |
| Profile acceptance | CI matrix (windows-latest, macos-latest, judge container) | Every fixture gives the same result locally and on the judge |
| TM server | Jest (`--runInBand`, real dev DB per the TM test notes) | Launch/redeem, supersede, snapshot HMAC verification, deadline/grace, `TMCODE_REQUIRED` gate, job queue, permission scoping |
| E2E desktop | Reuse NGA Desktop's CI probe approach (real WebView2/WKWebView, OS-level input, screenshots as artifacts) | Launch from TM → solve → submit; offline mid-exam; crash/resume |
| Load | k6 against TM + judge | 120 concurrent sessions, deadline submit burst, heartbeat fan-out |
| Red team | Staff exercise per release | Cheating playbook (pastes, AI apps, VM, second monitor, renamed binaries, killing the app, clock change, fake client) |

---

## 21. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Monaco workers unreliable in WKWebView | Medium | High | Phase 0 spike S1 + main-thread fallback; TMCode Web for Macs if needed |
| Judge host cgroup / isolate issues | Medium | High | Spike S3; Piston and Judge0 both behind `CodeRunner`; keep RapidAPI as emergency fallback for practice only |
| Exam-day network failure | Medium | High | Offline-first journal, grace window, USB export, lab router allow-list includes only needed hosts |
| Students' laptops can't run toolchains (old Windows, low disk) | Medium | Medium | Pre-flight in the exam lobby days before; server-run fallback; lab machines for Secure exams |
| Unsigned installer friction / antivirus false positives (keyboard hook + process scan look "suspicious") | High | Medium | One-line installer (no MOTW), winget, clear guides; submit builds to Microsoft Defender for analysis; keep hook code minimal |
| Determined cheating on personal laptops (phone, second device, hidden overlays) | High | Medium | Honest tiering; evidence + viva; summative exams in Secure labs only |
| Telemetry privacy concerns | Low | Medium | Collect edits/app names only, consent screen, retention policy, staff-only access with permission |
| Scope creep toward "full IDE" | Medium | Medium | Non-goals (§1.3); Phase 7 backlog gate after pilot |
| Small team, two codebases (TMCode + TM changes) | High | Medium | Shared `protocol` package; Phase 3 split by owner; feature flags in TM (`TMCODE_ENABLED`) |
| Hosting cost of the judge host | Low | Low | One small instance; stop outside term or scale only for exam windows |

---

## 22. Open decisions for the team

1. **Judge engine:** Piston (recommended) vs Judge0 CE. Settled by spike S3.
2. **Judge hosting:** a separate EC2 instance (recommended) vs the shared production box with strict limits. Cost vs blast radius.
3. **Default mode for summative exams on personal laptops:** allow Monitored, or require Secure labs only?
4. **Browsers during Monitored exams:** warn and log (default) vs block start.
5. **Java pack size (~190 MB):** on-demand download (default) vs lab-only Java exams.
6. **Webcam proctoring alongside TMCode:** keep TM's browser proctoring as a parallel optional step, or drop it for coding exams?
7. **Telemetry retention period** (proposed: 12 months) and who may view replays (proposed: subject teacher + admins).
8. **Apple Developer Program / education fee waiver:** pursue it? It unlocks notarisation and macOS Assessment Mode.
9. **Repo visibility:** public, like nga-desktop (unlimited Actions minutes, see the billing notes) vs private. Public is fine because no secrets live in the client; the blocklist and profiles are served signed from the server.

---

## 23. Appendix: sources and versions

Research date 2026-10-05. Items marked † must be re-verified during Phase 0.

| Topic | Version / note | Source |
|---|---|---|
| Monaco Editor | 0.56.0 | https://github.com/microsoft/monaco-editor |
| @codingame/monaco-vscode-api | v37.3.x (VS Code 1.138), frequent majors | https://github.com/CodinGame/monaco-vscode-api |
| monaco-languageclient | 11.0.x | https://github.com/TypeFox/monaco-languageclient |
| Eclipse Theia | 1.75 | https://theia-ide.org/releases/ |
| VSCodium / Open VSX | Marketplace terms restrict forks → Open VSX | https://open-vsx.org |
| Tauri | 2.12.1 pinned (as nga-desktop); updater plugin 2.13.x | https://v2.tauri.app |
| Safe Exam Browser | Windows 3.10.2; macOS 3.7.x (AAC default); Config Key / BEK headers | https://safeexambrowser.org/developer/seb-config-key.html |
| Apple Automatic Assessment Configuration | Entitlement + paid developer account required | https://developer.apple.com/documentation/automaticassessmentconfiguration |
| Windows Take a Test | Web-only kiosk (not usable for a native app) | https://learn.microsoft.com/education/windows/take-tests-in-windows |
| Judge0 CE | 1.13.1, GPL-3, isolate; cgroup v1 concerns† | https://github.com/judge0/judge0 |
| Piston | MIT, isolate; public API restricted, so self-host† | https://github.com/engineer-man/piston |
| isolate | GPL-2, cgroup v2 support in recent versions† | https://github.com/ioi/isolate |
| Pyodide | 314.0 (CPython-aligned versioning) | https://blog.pyodide.org/posts/314-release |
| WebContainers | Commercial licence for production | https://webcontainers.io/enterprise |
| CheerpJ | Non-commercial free; education should enquire | https://cheerpj.com/licensing/ |
| Dolos | MIT, `@dodona/dolos` | https://dolos.ugent.be |
| JPlag | 6.3.0, GPL-3 | https://github.com/jplag/JPlag |
| AI-code detection reliability | Detectors and TA heuristics unreliable | https://arxiv.org/abs/2311.16292 , https://arxiv.org/pdf/2505.20158 |
| Comparable products | HackerRank Desktop App Mode (2026), CodeSignal Suspicion Score, Codio Code Playback, Moodle CodeRunner 5.8 + Jobe, VPL + SEB | vendor docs |
| Playwright / pixelmatch / axe-core | Apache-2 / ISC / MPL-2 | npm |

**Internal references:** NGA Desktop `docs/IMPLEMENTATION_PLAN.md`, `docs/RELEASING.md`, `docs/BROWSER_COMPATIBILITY.md`; MIS `SSO_CLIENT_INTEGRATION.md`, `backend/src/routes/desktop.ts`, `backend/src/utils/desktopHandoff.ts`; Task Mentor `server/src/utils/quizStudentView.ts`, `server/src/utils/quizTiming.ts`, `server/src/utils/quizGrader.ts`, `server/src/services/Judge0Service.ts`, `client/src/components/Quizzes/QuestionTypes/CodeSpaceEditor.tsx`, `live-server/src/index.ts`.
