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
- **Never sent:** hidden tests, reference solutions and web-check specs.
- **`resume`:** present when the server already holds synced snapshots for that question; it is the latest one.
- **Profile mapping** (Task Mentor language → profile): python→`python-3`, javascript→`node-22`, typescript→`typescript`, c→`c17`, cpp/c++→`cpp17`, java→`java-21`, html/css/web→`web`, react→`react`.

## 3. While working (all Bearer token)

| Endpoint | Body | Response | Notes |
|---|---|---|---|
| `POST /sessions/:sid/snapshots` | `{ seq, question_id, kind: "auto"\|"run"\|"final"\|"offline_final", client_ts, files: [{path,content}], files_hash, hmac }` | `{ accepted_seq, server_ts }` | See below the table. |
| `POST /sessions/:sid/telemetry` | `{ seq, events: TelemetryEvent[] }` (`packages/protocol/src/telemetry.ts`) | `{ ok: true }` | Idempotent per `(sid, seq)`. Stored for Phase 4 (replay and flags). |
| `POST /sessions/:sid/heartbeat` | `{ synced_seq, current_question, focus: "in"\|"out" }` | `{ server_time, deadline, status: "active"\|"superseded"\|"revoked"\|"ended", paused, message }` | Every 10 s while online. A deadline extension is picked up here. |
| `POST /sessions/:sid/server-run` | `{ question_id, files }` | `{ tests: [{ id, verdict, passed, stdout, stderr, time_ms }] }` | Visible tests only, on tm-judge. For profiles with no local toolchain (`fallback: "server"`). Rate-limited (10/min). |
| `POST /sessions/:sid/submit` | `{ final: [{ question_id, seq }] }` | `{ status: "grading" }` | See below the table. |
| `GET /sessions/:sid/results` | — | `{ status: "grading"\|"hidden"\|"released", score?, max_score?, questions?: [{ question_id, points, max_points, tests: [{ id, name, hidden, passed }] }] }` | Released by the quiz's existing visibility rules (`resultVisibility`). |

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

## 5. tm-judge — `services/judge` (private: `127.0.0.1:5010`, `Authorization: Bearer $JUDGE_TOKEN`)

`POST /v1/run` request:
```json
{ "language": "python-3", "entry": "main.py",
  "files": [{ "path": "main.py", "content": "..." }],
  "tests": [{ "id": "t1", "input": "2 3\n", "expected_output": "5\n" }],
  "limits": { "time_s": 5, "wall_s": 10, "memory_mb": 256, "output_kb": 256 } }
```
Response:
```json
{ "language": "python-3", "sandbox": "isolate",
  "compile": null,
  "tests": [{ "id": "t1", "verdict": "accepted", "passed": true, "stdout": "5\n", "stderr": "",
              "exit_code": 0, "time_ms": 23, "memory_kb": 7400 }] }
```
- Verdicts: `accepted`, `wrong-answer`, `ok` (no expected output), `runtime-error`, `time-limit`, `memory-limit`, `output-limit`, `internal-error`.
- `compile` is `{ ok, output, time_ms }` for compiled languages. On a failed compile every test fails.
- `GET /v1/health` returns `{ ok, sandbox, languages: { id: version|null }, queue }`.
- Output comparison: `normalizeOutput` (CRLF→LF, trim trailing whitespace at the end only), the same rule as `packages/protocol/src/output.ts`.

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
