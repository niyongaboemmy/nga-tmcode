# TMCode ↔ Task Mentor protocol (v1)

The wire contract between the TMCode desktop app and Task Mentor (`nga-task-mentor`). Schemas live in `packages/protocol` (zod). Task Mentor is a separate repo, so this document plus the test vectors in §4 are the source of truth for its side.

Base URL: `https://taskmentor-api.amashuri.com/api/tmcode` (dev: `http://localhost:5002/api/tmcode`).
Errors: HTTP status + `{ "error_code": "SNAKE_CASE", "message": "Human text" }`.

---

## 1. Launch (plan §5.1, §10.2)

1. The student opens a coding quiz in Task Mentor web and clicks **Open in TMCode**.
2. Web calls `POST /launch` with the normal TM JWT.
3. Web opens the returned deep link: `tmcode://launch?t=<ticket>&api=<urlencoded API base>`.
4. TMCode accepts `api` **only** from its allow-list (`https://taskmentor-api.amashuri.com`, plus `http://localhost:5002` in debug builds), so a crafted link can't point a student at a fake server.
5. TMCode redeems the ticket at `POST /sessions` and receives an attempt-scoped token.

### `POST /launch` — auth: TM JWT (student)
Request `{ "quiz_id": 77 }` → `200`:
```json
{ "ticket": "base64url 32 bytes", "expires_at": "2026-11-10T08:02:00Z",
  "deeplink": "tmcode://launch?t=...&api=https%3A%2F%2Ftaskmentor-api.amashuri.com" }
```
Creates or resumes the student's `in_progress` QuizSubmission (same availability, enrolment and max-attempt rules as the web start).
- The ticket is single-use, valid for 120 s, and stored hashed (`tmcode_launch_tickets`).
- Errors:
  - `QUIZ_NOT_AVAILABLE` (400)
  - `NOT_ENROLLED` (403)
  - `MAX_ATTEMPTS_REACHED` (409)
  - `TMCODE_NOT_ENABLED` (409, the quiz isn't TMCode delivery)
  - `LOCKDOWN_REQUIRED` (409, SEB required and missing)

### `POST /sessions` — auth: the ticket itself
Request:
```json
{ "ticket": "...",
  "device": { "id": "uuid (random per install)", "os": "mac|windows|linux", "os_version": "15.1", "arch": "aarch64", "app_version": "0.1.0" },
  "env_report": { "toolchains": [{ "tool": "python", "version": "Python 3.12.7" }] } }
```
`200`:
```json
{ "session_id": "uuid", "token": "jwt", "expires_at": "...", "submission_id": 812 }
```
- **Token:** HS256 with secret `JWT_SECRET + ":tmcode"`. Claims `{ sid, sub: <local user id>, submission_id, aud: "tmcode" }`; `exp` = attempt deadline + submit grace + offline grace.
- **Scope:** the token is valid only on `/api/tmcode/sessions/<sid>/*`.
- **Supersede:** redeeming makes any other `active` session of the same submission `superseded`.
- Errors: `TICKET_INVALID` (401), `TICKET_USED` (409), `ATTEMPT_TIME_EXPIRED` (409).

## 2. Exam package — `GET /sessions/:sid/package` (Bearer token)
Returns `ExamPackageSchema` (`packages/protocol/src/exam.ts`):
```json
{ "submission_id": 812,
  "quiz": { "id": 77, "title": "Python Practical 2", "type": "Exam" },
  "deadline": "2026-11-10T09:40:00Z", "server_time": "2026-11-10T08:00:03Z",
  "policy": { "mode": "monitored", "intelligence": "basic", "paste": "internal_only", "terminal": "off",
              "internet_in_preview": false, "require_seb": false, "allow_offline_grace_minutes": 10, "locked_settings": [] },
  "journal_nonce": "base64 of 32 random bytes (stored on the session)",
  "profiles": [ { "...": "full Profile objects for the profiles the tasks use" } ],
  "toolchains": ["python"],
  "tasks": [ { "question_id": 4411, "order": 1, "points": 20, "title": "Grade calculator", "brief_md": "...",
               "profile_id": "python-3",
               "files": [ { "path": "main.py", "content": "...", "readonly": false } ],
               "visible_tests": [ { "id": "t1", "name": "example", "input": "2\n80\n90\n", "expected_output": "85.0 A\n", "points": 5 } ],
               "hidden_test_count": 6,
               "resume": { "snapshot_seq": 41, "files": [ "..." ] } } ],
  "live": null }
```
- **`min_app_version`** (optional, e.g. `"0.12.0"`): the oldest TMCode that can take this exam. An older TMCode stops with "This exam needs TMCode 0.12.0 or newer" and an Update TMCode button (the in-app updater is allowed then: the exam has not started). A package an older TMCode can't parse shows "TMCode is out of date for this exam", never a schema dump.
- **System check:** before the task view opens, TMCode checks the language tools each task needs, the package round trip (reachable), `server_time` against the local clock, and that the exam folder is writable. Problems hold the student in a lobby (Start the Exam / Check Again). The attempt's time is already running on Task Mentor then; a server-side "start the timer after the check" would need a new endpoint. "Check My Computer" runs the same checks outside an exam and uses `GET /profiles` (no auth) for reachability and its `Date` header for the clock.
- **`policy.debugger`** (optional, default `false`): `true` lets students use Run and Debug (breakpoints, stepping, the Debug Console) during this exam. Debugger downloads (js-debug, debugpy) are still never made during an exam.
- **Never sent:** hidden tests, reference solutions and web-check specs.
- **`resume`:** present when the server already holds synced snapshots for that question; it is the latest one.
- **Profile mapping** (Task Mentor language → profile): python→`python-3`, javascript→`node-22`, typescript→`typescript`, c→`c17`, cpp/c++→`cpp17`, java→`java-21`, html/css/web→`web`, react→`react`.

## 3. While working (all Bearer token)

| Endpoint | Body | Response | Notes |
|---|---|---|---|
| `POST /sessions/:sid/snapshots` | `{ seq, question_id, kind: "auto"\|"run"\|"final"\|"offline_final", client_ts, files: [{path,content}], files_hash, hmac }` | `{ accepted_seq, server_ts }` | See below the table. |
| `POST /sessions/:sid/telemetry` | `{ seq, events: TelemetryEvent[] }` (`packages/protocol/src/telemetry.ts`) | `{ ok: true }` | Idempotent per `(sid, seq)`. Stored for Phase 4 (replay and flags). |
| `POST /sessions/:sid/heartbeat` | `{ synced_seq, current_question, focus: "in"\|"out" }` | `{ server_time, deadline, status: "active"\|"superseded"\|"revoked"\|"ended", paused, message }` | Every 10 s while online. A deadline extension is picked up here. |
| `POST /sessions/:sid/server-run` | `{ question_id, files }` | `{ tests: [{ id, verdict, passed, stdout, stderr, time_ms }] }` | Visible tests only, on tm-judge. TMCode calls it when the task's language tool is missing on the computer ("Running on Task Mentor… (queued)"). Rate-limited (10/min): `429 RATE_LIMITED`, with `retry_after_s` in the body or a `Retry-After` header if available, else TMCode counts its own runs ("Run again in 40 s"). |
| `POST /sessions/:sid/submit` | `{ final: [{ question_id, seq }] }` | `{ status: "grading" }` | See below the table. |
| `GET /sessions/:sid/results` | — | `{ status: "grading"\|"hidden"\|"released", score?, max_score?, questions?: [{ question_id, points, max_points, tests: [{ id, name, hidden, passed, verdict? }] }] }` | `verdict` (optional, same values as server-run) lets TMCode say why an example test failed. Released by the quiz's existing visibility rules (`resultVisibility`). |

**Snapshots** (`POST /sessions/:sid/snapshots`):
- **Idempotency:** idempotent per `(sid, seq)`. The same `hmac` again returns 200; a different `hmac` returns `409 SEQ_CONFLICT`.
- **Order:** a missing `seq-1` returns `409 SEQ_GAP { expected_seq }`.
- **Checks:** the server verifies `files_hash` and the chain (§4); a failure returns `409 JOURNAL_TAMPERED` and raises a flag.
- **Deadline:** after deadline + grace, only `offline_final` with a valid chain and `client_ts ≤ deadline` is accepted, within `allow_offline_grace_minutes`. Anything else returns `409 ATTEMPT_TIME_EXPIRED`.
- **Answer copy:** each accepted snapshot also updates the question's QuizAttempt answer (project-mode shape, ungraded) so the web views show the latest code.

**Submit** (`POST /sessions/:sid/submit`):
- The listed seqs must be stored.
- It marks the submission completed, ends the session, and queues grading (`tmcode_runs`): all tests, visible and hidden, run on tm-judge.

## 4. Snapshot chain (tamper evidence)

```
key        = HMAC-SHA256(key = base64decode(journal_nonce), message = "tmcode-journal-v1:" + session_id)
files_hash = hex(SHA-256(JSON.stringify(files sorted by path (code-unit order) as [[path, content], ...])))
hmac_n     = hex(HMAC-SHA256(key, hmac_{n-1} + "|" + seq + "|" + question_id + "|" + kind + "|" + files_hash + "|" + client_ts))
hmac_0     = ""   (the chain is per session, across questions)
```

**Test vectors**
- Inputs:
  - nonce = base64 of the ASCII `0123456789abcdef0123456789abcdef` = `MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=`
  - session_id = `6b1f0f3e-5c55-4b7a-9d55-2d6f1d0a9e01`
  - files = `main.py` = `print(1)\n` and `data/in.txt` = `2 3\n`
- Canonical files: `[["data/in.txt","2 3\n"],["main.py","print(1)\n"]]`
- Outputs:
  - files_hash = `73362b40acc83d209172257229759322f14c6f68cf5f892757c5c6ba8d12e692`
  - key = `d8285399eb1ac762c955b6e46085613a4f7c2b3fba1fa1d7949acccdd63d6f8c`
  - seq 1 (question 42, auto, `2026-10-05T10:00:00.000Z`): hmac = `f9bb208003aa8286b0cc58e586b0ce76013fe9e3d5ffa8853d0bf49ca46b2dfa`
  - seq 2 (question 42, final, `2026-10-05T10:05:00.000Z`, prev = seq 1): hmac = `f95e202aa9cb68ed3e7c5b8e746b8d928751e1006b0c8728122e378d7f312035`

## 5. tm-judge — `services/judge` (private: `127.0.0.1:5010`, or the runner host's WireGuard address `10.66.0.2:5010`; `Authorization: Bearer $JUDGE_TOKEN`)

| Method / path | Purpose |
|---|---|
| `GET /v1/health` | Status, legacy profiles, per-runtime versions, cache layers, catalog version, queue |
| `GET /v1/catalog` | The Runtime Catalog (`@nga/runtimes`) filtered to the kinds this runner can run |
| `POST /v1/detect` | `{ files: [{ path, content? }], language? }` → ranked kinds with entry files |
| `POST /v1/run` | Synchronous run. Two request shapes: a **language profile** (§5.1, unchanged) or a **catalog project** (§5.2) |
| `/v1/sessions…` | Interactive runs with live stdin/stdout (§5.6); a real terminal with `pty: true` (tier 3) |
| `/v1/previews…`, `/p/…` | Server previews (tier 3, §5.8) |

Errors: HTTP status + `{ "error": "Human text", "code": "..." }` with `code` one of `INVALID_REQUEST` (400), `NOT_FOUND` (404), `KIND_UNSUPPORTED` (409: unknown kind, a tier this runner doesn't run (e.g. containers off), or a missing run/test step), `RUNTIME_UNAVAILABLE` (503: the kind's toolchain isn't installed), `BUSY` (503 + `Retry-After`; queue full), `INTERNAL` (500). Older clients that only read `error` keep working.

### 5.1 Language profile (unchanged; what Task Mentor sends today)

`language` is a TMCode profile id (`python-3`, `node-22`, `typescript`, `c17`, `cpp17`, `java-21`) and there is no `kind`.

```json
{ "language": "python-3", "entry": "main.py",
  "files": [{ "path": "main.py", "content": "..." }],
  "tests": [{ "id": "t1", "input": "2 3\n", "expected_output": "5\n" }],
  "limits": { "time_s": 5, "wall_s": 10, "memory_mb": 256, "output_kb": 256 },
  "checker": { "type": "whitespace" } }
```
Response:
```json
{ "language": "python-3", "sandbox": "isolate",
  "compile": null,
  "tests": [{ "id": "t1", "verdict": "accepted", "passed": true, "stdout": "5\n", "stderr": "",
              "exit_code": 0, "time_ms": 23, "memory_kb": 7400, "truncated": false }] }
```
- `checker` (optional, per request or per test) is new; everything else is as before. A profile request with `"actions": ["test"]` runs as the profile's single-file kind (§5.2).
- `compile` is `{ ok, output, time_ms }` for compiled languages (and TypeScript's transpile). On a failed compile it is `{ ok: false, output }` and every test gets `compile-error`, `passed: false`, with the compiler output (64 KB max) as its `stderr`.
- **Fresh state per test:** the submission is compiled once, then every test starts from the files as they were right after the compile (sources + build outputs). Files a test writes are gone in the next test.
- **Java:** all `.java` files are compiled with `-d .`; the program runs the entry's fully-qualified class (its `package` declaration + file stem), so `src/rw/ac/nga/Main.java` with `package rw.ac.nga;` runs `rw.ac.nga.Main`.
- **Output in the response:** `stdout` up to `min(output_kb, 1024)` KB, `stderr` up to 64 KB. `truncated: true` when either was cut (including an `output-limit` stop).

### 5.2 Catalog project (`kind`, or detected)

Used when the body has `kind`, or has no profile `language` (then the kind is detected from the files; a catalog `language` key such as `"java"` narrows the detection).

```json
{ "kind": "java/maven",
  "files": [{ "path": "pom.xml", "content": "..." }, { "path": "src/main/java/rw/ac/nga/App.java", "content": "..." }],
  "entry": "src/main/java/rw/ac/nga/App.java",
  "actions": ["build", "run", "test"],
  "tests": [{ "id": "t1", "input": "2 3\n", "expected_output": "5\n", "checker": { "type": "token" } }],
  "checker": { "type": "float", "tolerance": 1e-6 },
  "test_filter": "AppTest",
  "limits": { "time_s": 5, "wall_s": 10, "memory_mb": 512, "output_kb": 256 } }
```
| Field | |
|---|---|
| `kind` | A catalog kind id (`c/single`, `c/make`, `cpp/cmake`, `java/maven`, `python/project`, `js/npm`, `go/module`, `rust/cargo`…). `GET /v1/catalog` lists the ones this runner has. Optional: detected from `files` when absent. |
| `language` | Optional: a catalog language key (`java`, `python`…) to narrow detection. |
| `files` | Up to 400 files, 1.5 MB in total. |
| `entry` | Optional: found from the kind (manifest, file declaring `main`, the kind's default). Needed by kinds whose steps use `{entry}`/`{main_class}`. |
| `actions` | Any of `build`, `run`, `test`. Default: `["build","run"]` when `tests` is given, else `["build","test"]` (or `["build","run"]` when the kind has no test step). `run` builds first; `test` alone runs the restore step and the test step only (the build tool compiles what it needs). |
| `tests` | I/O tests for `run`: `{ id, input, expected_output? (alias expected), checker? }`, at most 60, input ≤ 256 KB. `run` without tests runs once with empty input (verdict `ok`). |
| `checker` | `{ type, tolerance? }`, default `whitespace`. See below. |
| `services` | Optional, tier 3: `["postgres"]` or `["mysql"]`, a per-run database (§5.9). A kind's own `services` (`sql/postgres`, `sql/mysql`) are always added. A non-container kind with `services` runs in a container from its runtime's image (409 when the runner has none). |
| `test_filter` | Optional: only these unit tests, in the framework's own syntax (a class, method or pattern). Letters, digits, `. * # : / $ - [ ]` and spaces. |
| `limits` | The **run** step's limits, capped (cpu ≤ max(kind, 20 s), wall ≤ max(kind, 30 s), memory ≤ max(kind, 1024 MB); the kind's memory is a floor). Build and test steps use the kind's catalog limits. |

Response:
```json
{ "kind": "java/maven", "language": "java", "entry": "src/main/java/rw/ac/nga/App.java",
  "sandbox": "isolate", "catalog_version": "2026.10.1", "actions": ["build", "run", "test"],
  "compile": { "ok": true, "output": "", "time_ms": 8123 },
  "steps": [{ "step": "build", "ok": true, "status": "ok", "exit_code": 0, "time_ms": 8123 },
            { "step": "test", "ok": true, "status": "ok", "exit_code": 0, "time_ms": 6020 }],
  "tests": [{ "id": "t1", "verdict": "accepted", "passed": true, "stdout": "5\n", "stderr": "",
              "exit_code": 0, "time_ms": 180, "memory_kb": 41000, "truncated": false }],
  "unit": { "framework": "maven-surefire", "report": "junit-dir", "verdict": "passed",
            "total": 2, "passed": 2, "failed": 0, "skipped": 0, "errors": 0,
            "exit_code": 0, "time_ms": 6020, "output": "", "truncated": false,
            "tests": [{ "id": "rw.ac.nga.AppTest::addsTwoNumbers", "name": "addsTwoNumbers", "group": "rw.ac.nga.AppTest",
                        "file": null, "line": null, "status": "passed",
                        "durationMs": 12, "message": null, "details": null }] } }
```
- **How it runs.** One **build box** (the kind's build limits, writable project folder): `restore` (when the kind has one and its `when` files exist) → `build`. The box is snapshotted (sources + build outputs, timestamps kept so make/cargo see the build as up to date). The `test` step runs on top of the build. **Every I/O test then starts from the snapshot in a clean box.** Steps come from the catalog only: a logical tool resolved through the runtime's `tools` map to an absolute path, plus typed tokens (`{entry}`, `{entry_stem}`, `{out}`, `{sources:ext}`, `{main_class}`, `{test_filter}`, `{report_path}`); no shell, no user commands. The whole request has a 120 s budget (`JUDGE_RUN_BUDGET_S`); steps that would run past it stop with `time-limit`.
- `compile`: restore + build output, `null` when the kind has neither (Python, `test`-only). On failure every I/O test gets `compile-error` (or `package-not-available`) with the output as `stderr`, and `unit.verdict` is `error` (or `package-not-available`).
- `steps[].status`: `ok`, `runtime-error`, `signal`, `timeout`, `memory`, `output-limit`, `internal`.
- `unit` (only when `actions` has `test`): results from the framework's report (JUnit XML: pytest, Maven Surefire, Gradle, node:test, Vitest, ctest, PHPUnit; TRX; Jest JSON; RSpec JSON) or output (`go test -json`, cargo, unittest, minitest, TAP; `make test` without TAP gives one result from the exit code). `unit.tests[]` is the `TestResult` shape of `@nga/runtimes` `testing` (`id`, `name`, `group`, `file`, `line`, `status`: `passed|failed|skipped|error`, `durationMs`, `message`, `details`). `unit.verdict`: `passed` (every test passed and the step exited 0), `failed`, or why there are no results: `error` (e.g. the tests didn't compile; see `output`), `time-limit`, `memory-limit`, `package-not-available`, `internal-error`. A report file shipped inside `files` is ignored.
- `error` appears only for `PACKAGE_NOT_AVAILABLE`: `{ "code": "PACKAGE_NOT_AVAILABLE", "manager": "maven|gradle|npm|pip|cargo|go|bundler|nuget|composer", "package": "org.x:y:jar:1.0" | "express" | null, "message": "PACKAGE_NOT_AVAILABLE: \"express\" is not in the school package list (npm, offline)." }`.

### 5.3 Verdicts and checkers (both shapes)

- Verdicts: `accepted`, `wrong-answer`, `ok` (no expected output), `compile-error`, `runtime-error`, `time-limit`, `memory-limit`, `output-limit`, `package-not-available` (a dependency isn't in the runner's offline cache layers; projects only), `internal-error`.
- Checkers: `whitespace` (default: CRLF→LF, trailing whitespace at the very end ignored; the same rule as `packages/protocol/src/output.ts` `normalizeOutput`), `exact` (byte-for-byte, CRLF = LF), `token` (whitespace-separated tokens), `float` (tokens; numbers within `tolerance` absolute **or** relative, default `1e-6`; other tokens exact), `unordered` (lines as a multiset, trailing spaces and blank lines at the end ignored). A test's `checker` overrides the request's.

### 5.4 Catalog and detection

`GET /v1/catalog` →
```json
{ "version": "2026.10.1",
  "runtimes": [{ "id": "jdk-21", "label": "OpenJDK 21 (Maven 3.9, Gradle 8)", "version": "openjdk version \"21.0.8\"", "healthy": true,
                 "tools": { "java": true, "javac": true, "mvn": true, "gradle": true } }],
  "languages": [{ "key": "java", "label": "Java", "...": "..." }],
  "kinds": [{ "id": "java/maven", "label": "Java – Maven project", "tier": "isolate-build", "steps": {}, "limits": {},
              "caches": ["m2-school"], "starters": ["java-maven-junit"], "actions": ["build", "run", "test"], "missing_caches": [] }],
  "unavailable": [{ "id": "java/spring-boot", "reason": "tier container is not run by this runner" }],
  "caches": { "m2-school": true, "npm-school": false } }
```
`kinds` are full `KindDef`s (see `packages/runtimes/src/schema.ts`) for kinds whose tier this runner executes (`isolate`, `isolate-build`) and whose step tools are installed. Tools of conditional steps (e.g. `uv` for a `requirements.txt` restore) don't hide a kind; such a project gets 503 when it needs them.

`POST /v1/detect` with `{ "files": [{ "path": "pom.xml" }, { "path": "src/main/java/rw/App.java", "content": "..." }] }` →
```json
{ "kinds": [{ "kind": "java/maven", "language": "java", "label": "Java – Maven project", "score": 50000, "tier": "isolate-build",
              "entry": "src/main/java/rw/App.java", "available": true, "actions": ["build", "run", "test"], "unit_tests": { "report": "junit-dir" } }],
  "best": "java/maven", "entry": "src/main/java/rw/App.java",
  "warnings": ["Cache layer m2-school is not installed on this runner: only dependency-free projects of this kind build."] }
```
Content is optional; it improves `contains` rules (frameworks) and entry detection (`main` declarations).

`kinds` also lists tier-3 (`container`) kinds when Docker is reachable, the container runtime (gVisor `runsc`) is registered and the kind runtime's image is built; those entries carry `image`. Otherwise they are in `unavailable` with the reason (`containers are off on this runner (JUDGE_CONTAINERS is not 1)`, `Docker is not reachable (...)`, `the container runtime 'runsc' is not registered with Docker`, `image nga-runner/dotnet-8:2026.10.1 is not built on this runner`, `the postgres database image (postgres:16) is not available on this runner`).

`GET /v1/health` → `{ ok, sandbox, features, languages: { "<profile>": version|null }, catalog: "2026.10.3", runtimes: { "<runtime>": version|null }, caches: { "<id>": bool }, queue: { running, waiting, concurrency }, sessions: { running, max }, containers: { enabled, usable, runtime, runtime_registered, arch, reason, images: { "<image>": bool } }, previews: { running, max } }`.

`features` is `["run", "projects", "catalog", "detect", "checkers", "sessions"]` plus, **only when actually usable** (Docker reachable + runtime registered + at least one runner image built):
- `containers`, `pty`: tier-3 kinds and terminal sessions;
- `previews`: also needs `JUDGE_PREVIEW_SECRET` (32+ characters) and a built image for a kind with a server;
- `databases`: the `postgres:16` and/or `mysql:8.4` sidecar image is present.

### 5.5 Toolchains and offline caches (runner configuration)

- `JUDGE_TOOLCHAINS` (JSON, optional): `{ "<runtime id>": { "<tool>": "/abs/path" }, "*": { "<tool>": "/abs/path" } }` overrides the catalog's tool paths. Resolution: override → catalog path → `command -v <tool>` (disable with `JUDGE_TOOL_LOOKUP=0`). Tool folders outside `/usr` are bound read-only into boxes and put on `PATH`.
- `JUDGE_CACHES` (JSON): `{ "<cache id>": "/host/folder" }`. A non-empty folder is mounted read-only at `/caches/<id>` in the boxes of kinds that list that cache (isolate `--dir=/caches/<id>=<host>`; read-only is isolate's default). Boxes have no network: a dependency missing from the layers fails the step offline and becomes `package-not-available`. Layers: `m2-school` (Maven tail repo), `gradle-school` (`GRADLE_RO_DEP_CACHE`), `npm-school` (npm cache), `wheels-school` + `site-packages-school` (Python), `cargo-registry-school` (`cargo vendor` folder; the runner writes a `.cargo/config.toml` pointing crates-io at it), `go-mod-school` (module cache; `GOPROXY=file:///caches/go-mod-school/cache/download,off`). `services/judge/deploy/build-caches.sh` fills them from the starters and `deploy/allowlists/`.

### 5.6 Sessions (interactive runs)

A program run with live pipes (no PTY): output streams as server-sent events while stdin arrives over HTTP. Same bearer auth as `/v1/run`. `GET /v1/health` lists `"sessions"` in `features` when the runner supports them (Task Mentor shows the live terminal only then).

| Method / path | Body | Answer |
|---|---|---|
| `POST /v1/sessions` | `{ language?, kind?, files: [{ path, content }], entry?, limits? }` (the same rules as `/v1/run`: a profile `language` such as `python-3`, or a catalog `kind`, or files to detect one from) | `201 { "id": "<uuid>" }` |
| `GET /v1/sessions/:id/events` | — | `200 text/event-stream` (below) |
| `POST /v1/sessions/:id/stdin` | `{ "data": "Ada\n" }` (≤ 64 KB per call) | `204` |
| `POST /v1/sessions/:id/eof` | — | `204` (closes the program's stdin) |
| `POST /v1/sessions/:id/signal` | `{ "name": "SIGINT" \| "SIGTERM" }` | `204` |
| `POST /v1/sessions/:id/resize` | `{ "cols": 100, "rows": 40 }` (PTY sessions; cols 10–500, rows 2–200) | `204`; `409 NOT_A_TERMINAL` without `pty` |
| `DELETE /v1/sessions/:id` | — | `204` (kills the program, frees the box) |

Events, each written as `event: <name>\ndata: <json>\n\n` (plus `: ping` comments every 20 s):

| Event | Data |
|---|---|
| `stage` | `{ "name": "build" \| "run" }` (`build` only when the language/kind builds) |
| `stdout` / `stderr` | `{ "data": "text" }` (UTF-8, chunked as the program writes) |
| `exit` | `{ "code": 0, "signal": null, "verdict": "ok", "time_ms": 412, "memory_kb": 7400 }`: always the last event; the stream then ends |
| `error` | `{ "message": "..." }`: the judge stopped the program (output cap, idle, wall clock) or could not start it; an `exit` follows |

- **Verdicts** in `exit`: `ok` (exit code 0), `runtime-error` (non-zero exit, or a signal the client sent), `compile-error` / `package-not-available` (the build failed; its output came as `stderr`, `code` is the build tool's), `time-limit` (wall clock or idle), `memory-limit`, `output-limit`, `internal-error`.
- **Limits:** the batch run's limits (memory, processes, CPU time; `limits` as in `/v1/run`), a **10-minute wall clock**, a **2-minute idle timeout** (no stdin and no output; counted from the run stage), and **1 MB of stdout+stderr**, after which an `error` event is sent and the program is killed.
- **Concurrency:** at most `JUDGE_SESSIONS` (default 4) at a time; more → `429 { code: "BUSY" }`. Sessions use their own isolate boxes (from `JUDGE_SESSION_FIRST_BOX`, default after the batch range) and don't take batch slots.
- **Clean-up:** the box is removed when the program exits, on `DELETE`, or when the last event stream disconnects before the `exit` event. A finished session's events stay readable for 60 s (`GET .../events` replays them), then the id answers 404.
- stdin sent before the program starts (during the build) is queued. `stdin`/`eof`/`signal` after the end → `409 { code: "SESSION_ENDED" }`; an unknown id → `404`.
- **Signals under isolate:** isolate does not forward signals to the program; `SIGINT`/`SIGTERM` end the box (the program stops; `exit.signal` is the name sent). A program's own Ctrl-C handler only runs with the local development sandbox.
- Programs see pipes, not a terminal: Python runs with `-u`, compiled profiles run under `stdbuf -oL`, catalog run steps already use `stdbuf` where needed; other programs should flush prompts.
- Container kinds (tier 3) without `pty` also run on pipes, in a container instead of an isolate box.

**PTY sessions (tier 3).** `POST /v1/sessions` with `"pty": true` (optional `"cols"`, `"rows"`; default **120×30**) gives the program a real terminal: a container with `Tty: true`, attached through the Docker Engine API. Only when `/v1/health` `features` has `"pty"`; otherwise `409 { code: "PTY_UNAVAILABLE" }`, also for a kind whose runtime has no container image (e.g. C with no gcc image). A profile `language` (`python-3`…) runs as its single-file kind in that runtime's image; any catalog kind with an image works, container kinds always do.
- Output: the terminal's raw output as `stdout` events (`stderr` is merged into it by the terminal), **ANSI escape sequences included**, `\r\n` line ends. `data` is UTF-8 text decoded incrementally (a multi-byte character split across reads is kept whole; invalid bytes become U+FFFD). The terminal echoes what is typed.
- Input: `stdin` writes keystrokes/lines as they are (`{ "data": "Ada\n" }`); `eof` sends Ctrl-D (`\x04`).
- `signal` `SIGINT`/`SIGTERM` reach the program (Docker kill → `tini` as PID 1 → the program): a program's own Ctrl-C handler runs, a REPL survives SIGINT. `exit.signal` is the signal's name when the program died of it.
- The environment has `TERM=xterm-256color`, `COLUMNS`, `LINES`. Limits, timeouts and verdicts as for pipes sessions.

### 5.7 Container tier (tier 3)

Kinds with `tier: "container"` in the catalog (C#/F#/VB, Kotlin Gradle, Spring Boot, Flutter, web-server kinds, `sql/postgres`, `sql/mysql`), PTY sessions, previews and per-run databases run in **Docker containers under gVisor**. Off unless `JUDGE_CONTAINERS=1` (the shared host leaves it off). Requests and responses are the same as §5.2 (`build`/`run`/`test`, I/O tests with fresh state per test, unit reports through the same parsers, `compile`, verdicts); the response has `"sandbox": "container"`.

- **One container per step or test**, from the runtime's image `nga-runner/<image>:<tag>` (`services/judge/images/`; `typescript` shares `node-22`, `kotlin-2` shares `jdk-21`, `dart-3` shares `flutter-3`). Images provide every tool at the catalog's absolute path, so steps are the catalog's argv exactly.
- **Isolation of every container:** `--runtime runsc` (gVisor; `runc` only with `JUDGE_ALLOW_RUNC=1`, otherwise tm-judge refuses to start), `--network none` (a per-run internal network only for databases and previews), `--read-only` root, the box folder bound at `/box` (a host tmpfs), `--tmpfs /tmp`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory` = `--memory-swap` (no swap), `--cpus`, the judge's own non-root uid:gid, `--init`, `fsize`/`nofile`/`core` ulimits, cache layers bound read-only at `/caches/<id>`, no logging driver, optional `JUDGE_CONTAINER_CGROUP_PARENT` slice for all containers together. Wall-clock kill and output caps as with isolate.
- **Exit mapping:** OOM-killed or an unexplained SIGKILL → `memory-limit`; our wall-clock kill → `time-limit`; stdout over the cap → `output-limit`; exit `128+n` → killed by signal n (`runtime-error`); other non-zero → `runtime-error`.
- **Settings:** `JUDGE_CONTAINER_RUNTIME` (`runsc`), `JUDGE_CONTAINER_WORKDIR` (box folders), `JUDGE_CONTAINER_CONCURRENCY` (2 steps at once), `JUDGE_CONTAINER_CPUS` (1), `JUDGE_CONTAINER_MEMORY_MB` (1536, ceiling), `JUDGE_CONTAINER_TMP_MB` (256), `JUDGE_CONTAINER_IMAGES` (JSON overrides `{ "<runtime id>": "<image>" }`), `JUDGE_IMAGE_PREFIX`/`JUDGE_IMAGE_TAG`, `JUDGE_DOCKER_SOCKET`, `JUDGE_CONTAINER_PROBE_S` (300: images built later are picked up without a restart).

### 5.8 Server previews (tier 3)

A project's web server (kinds with a `serve` step: `js/express`, `ts/nest`, `python/flask|fastapi|django`, `java/spring-boot`, `csharp/aspnet`, `php/web|laravel`, `ruby/sinatra|rails`, `go/web`, `rust/web`) built and started in a container on its **own internal Docker network** (`Internal: true`: no route out), reachable only through tm-judge's proxy.

| Method / path | Auth | Body / answer |
|---|---|---|
| `POST /v1/previews` | bearer | `{ kind?, language?, files: [{ path, content }], entry?, services? }` → `201 { "id": "<uuid>" }`; `429 BUSY` over `JUDGE_PREVIEWS` (4); `409 KIND_UNSUPPORTED` for a kind without a server |
| `GET /v1/previews/:id/events` | bearer | `text/event-stream` (below); closing it does **not** stop the preview |
| `DELETE /v1/previews/:id` | bearer | `204` |
| `ANY /v1/previews/:id/http/<path>` | bearer | the server's answer for `/<path>` (the bearer is not forwarded) |
| `ANY /p/:id/:token/<path>` | **token** | the same, for browsers: serve this from a **separate site** (e.g. `https://preview.<ip-with-dashes>.sslip.io` or `https://nga-preview.duckdns.org`, never a subdomain of the apps' domain, whose cookies would ride along; the app host's nginx proxies `/p/` to tm-judge) |

- **Start-up:** the kind's `restore`/`build` steps (as in §5.2), then the `serve` step with `PORT=<the kind's port>` and `HOST=0.0.0.0`; ready when the port accepts connections (up to `JUDGE_PREVIEW_READY_S`, 120 s).
- **Events:** `stage { name: "build" | "start" }`, `log { stream: "stdout" | "stderr", data }` (256 KB replayed at most), `ready { path: "/" }`, `error { message }`, `exit { code, signal, reason }` (always last). Before `ready` the proxy answers `409 PREVIEW_NOT_READY`; after `exit`, `410 PREVIEW_ENDED`.
- **Token** (Task Mentor mints it; tm-judge checks it): `token = "<exp>.<sig>"`, `exp` = unix seconds (Task Mentor: now + 900), `sig = base64url(HMAC-SHA256(key = JUDGE_PREVIEW_SECRET, message = "<id>.<exp>"))` (Node `digest("base64url")`, no padding). Compared in constant time; expired → `403 PREVIEW_TOKEN`. Public URL: `${JUDGE_PREVIEW_BASE}/p/${encodeURIComponent(id)}/${exp}.${sig}/`. `/p/:id/:token` without the trailing slash redirects (308) to it, so relative links resolve under the prefix.
- **Rewriting:** request `Host: localhost:<port>` (frameworks' development host checks pass), `X-Forwarded-Host/Proto/Prefix`; hop-by-hop headers dropped. Response: `Location` that is an absolute path (or points at the server itself) is kept under the prefix; `Set-Cookie` loses `Domain` and gets `Path=<prefix><path>`; `X-Frame-Options` removed; added `Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-same-origin` (allow-same-origin = the preview origin, so the page can call its own API), `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`. Absolute links to `/…` in HTML/JS are not rewritten: apps should use relative URLs or `X-Forwarded-Prefix`.
- **WebSockets** (and other `Upgrade`s) are tunnelled on both proxy paths.
- **Limits:** `JUDGE_PREVIEWS` (4) at once; **15-minute** lifetime (`JUDGE_PREVIEW_TTL_S`), **5-minute** idle timeout without proxied requests (`JUDGE_PREVIEW_IDLE_S`); memory `JUDGE_PREVIEW_MEMORY_MB` (768) and the container CPU cap; responses over `JUDGE_PREVIEW_RESPONSE_MB` (10 MB) are cut, request bodies over 10 MB refused; 30 s upstream timeout per request.

### 5.9 Per-run databases (tier 3)

`services: ["postgres"]` or `["mysql"]` on `/v1/run`, `/v1/sessions` or `/v1/previews` (or a kind's own `services`):
- A sidecar from the pinned `postgres:16` / `mysql:8.4` image (`JUDGE_POSTGRES_IMAGE`, `JUDGE_MYSQL_IMAGE`) under gVisor, data on tmpfs, read-only root, capabilities dropped to what the image's entrypoint needs to switch users, on a **per-run internal network** that the program's containers join.
- `schema.sql` then `seed.sql` from the project are loaded (a failure, or a database that doesn't start, becomes the run's `compile` output with verdict `compile-error`).
- **Fresh per I/O test:** PostgreSQL copies the seeded template (`CREATE DATABASE app TEMPLATE seed`), MySQL drops `app` and replays schema + seed.
- The program connects as user `student` (PostgreSQL: `NOSUPERUSER`; MySQL: privileges on `app` only) to database `app`: `DATABASE_URL` (`postgres://student:…@<ip>:5432/app`, `mysql://student:…@<ip>:3306/app`), plus `PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE` or `MYSQL_HOST MYSQL_TCP_PORT MYSQL_USER MYSQL_PWD MYSQL_PASSWORD MYSQL_DATABASE`. Passwords are random per run. PostgreSQL has `statement_timeout = 10s`, MySQL `max_execution_time = 10 s`.
- The sidecar, network and seed folder are removed when the run (or session/preview) ends. At most one database per run.
- Kinds `sql/postgres` (`psql -X -q -v ON_ERROR_STOP=1 -P border=2 -P footer=off -f <entry>`) and `sql/mysql` (`mysql --batch --table app < <entry>`) print boxed tables in the same layout:
  ```
  +-------+-------+
  | name  | class |
  +-------+-------+
  | Grace | S4B   |
  +-------+-------+
  ```
  Starters `sql-postgres-select` and `sql-mysql-select` (detected by a `-- dialect: postgres|mysql` comment).

## 6. Task Mentor v1 implementation notes (branch `feat/tmcode-phase3`)

These are agreed refinements of §1–§3.
- **Token `sub`** is the local user id as a *string*.
- **`GET /profiles`** returns `{ "profiles": Profile[] }`. It needs no auth and is cached for 5 minutes.
- **`brief_md`** may be the question's rich-text **HTML** (Task Mentor's editor) rather than Markdown. TMCode renders HTML through DOMPurify (no scripts, handlers, links or forms) and Markdown through `marked` with raw HTML escaped.
- **Resume** = the latest synced snapshot of the question across *all* sessions of the submission. Its `snapshot_seq` belongs to the session that wrote it. If the resume replaces different local files, TMCode keeps the local copy in `.recovered/`.
- **Deadline fallback:** a quiz with neither a duration nor an end date gets start + 12 h.
- **Submit** grades every coding question: the listed final snapshot, else the latest synced one.
- **A late `offline_final`** (after the attempt closed) is accepted, re-graded and flagged `offline_final_late`.
- **Heartbeat** `paused` / `message` are always `false` / `null` until the Phase 5 console.

Additional error codes (all use the `{ error_code, message, ...extra }` shape):

| Code | Status | When |
|---|---|---|
| `TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_EXPIRED` | 401 | Bad or missing bearer token |
| `SESSION_SCOPE` | 403 | Token used on another `sid` |
| `SESSION_SUPERSEDED` | 409 | Package, snapshots, server-run or submit on a non-active session. The heartbeat still answers and reports the status. |
| `SNAPSHOT_MISSING` | 409 | Submit lists seqs that aren't stored; returns `{ missing: [...] }` |
| `QUESTION_NOT_IN_EXAM` | 400 | Snapshot or server-run for a question outside the exam |
| `VALIDATION_ERROR` | 400 | Bad body; returns `{ errors: [{ field, message }] }` |
| `UNSUPPORTED_PROFILE` | 409 | Package when a question's language has no profile; returns `question_ids` |
| `JUDGE_UNAVAILABLE` | 503 | server-run while tm-judge is down |
| `RATE_LIMITED` | 429 | server-run over 10/min |
| `QUIZ_NOT_FOUND` | 404 | Launch |
| `FORBIDDEN` | 403 | Launch by a non-student |
