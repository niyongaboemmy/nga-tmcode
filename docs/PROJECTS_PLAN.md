# TMCode Projects: implementation plan

_Draft, 2026-10-06. Covers TMCode, Task Mentor (server and client) and Central MIS (no change needed in v1)._

## 0. Goal

A student or teacher keeps their **personal coding projects** in Task Mentor (TM) and works on them in **TMCode**:

- **Sign-in.** One TMCode sign-in gives the user both a Central MIS session and a Task Mentor session, and the Projects feature needs both.
- **Projects sync on sign-in.** TMCode shows "My projects" and "Shared with me" straight away.
- **Two kinds of project:**
  - **GitHub projects.** Files live on GitHub, and git push/pull work as usual. TM keeps the repo link and the live git status (branch, ahead/behind, last commit, uncommitted changes).
  - **Task Mentor projects** (e.g. C++ practice). Files are saved to TM with **Save to Task Mentor**, plus optional auto-save. TM keeps revisions, and the user sees whether the folder is synced.
- **Open in TMCode.** A button on a TM project page opens it in TMCode: TMCode clones or downloads it the first time, then opens the local folder.
- **Activity links.** A project can be linked to a quiz, an assignment or a recorded (manual) assessment. Submitting freezes the revision (or the git commit).
- **Live monitoring.** The owner, and teachers allowed to, see live status in TM: whether it's open in TMCode now, the open file, unsaved files, the last run, and sync state.
- **Projects dashboard** in TM: list, search, filters, stats and activity.
- **Collaboration** for GitHub projects only. The owner adds TM members (with their GitHub usernames), and TMCode can grant them access on GitHub with the owner's token.

Exam mode stays as it is: projects, sign-in and syncing are all disabled during an exam session.

## 1. Sign-in (MIS + TM together)

The flow reuses the existing **desktop handoff** (PKCE, loopback), so **MIS needs no change**:

1. TMCode (Rust) generates a PKCE verifier and challenge and binds `127.0.0.1:0`.
2. It opens `MIS/desktop/signin?redirect_uri=http://127.0.0.1:<port>/signin&state&challenge` in the system browser. Google sign-in works there.
3. The browser form-POSTs `{code, state}` to the loopback. Rust checks `state` and answers with a "You can close this tab" page.
4. Rust calls `POST MIS/api/auth/desktop-handoff/redeem {code, verifier}`, which returns the **MIS JWT**.
5. Rust calls **new** `POST TM/api/tmcode/auth/exchange` with `Authorization: Bearer <MIS JWT>`. TM verifies the token with MIS `/auth/verify`, upserts the local user exactly as `sso/callback` does, and returns a **TMCode user token**: HS256 signed with `JWT_SECRET+":tmcode-user"`, `aud: "tmcode-user"`, `sub` = local user id, `mis` = MIS user id, valid 30 days. The response is `{ token, expires_at, user: { id, mis_user_id, name, email, role, avatar_url, permissions[] } }`.
6. Both tokens are stored in the **OS keychain** (service `TMCode`, accounts `mis` and `tm`). Neither the webview nor disk ever sees the TMCode token; Rust attaches it to every TM project request (the `tm_api` command).
7. **Validity.** At startup and every 10 minutes, Rust calls `GET TM/api/tmcode/auth/me`. A 401, including `SESSION_ENDED` after an MIS sign-out, clears both tokens and shows "Signed out".
8. **Sign out.** TMCode calls `POST MIS/api/auth/logout` with the MIS token, which triggers back-channel logout to every app, then forgets both tokens.

"Force a user to log in to both" means the Projects view, Save to TM and Open in TMCode all require a valid **pair**. If only one token works, TMCode asks the user to sign in again.

A sign-in can be **started from TM web**: the "Open in TMCode" deep link includes `api=`, and TMCode starts this flow if it isn't signed in.

## 2. Task Mentor data model

New tables, created by migrations `20261006100000-create-projects.js` and `20261006110000-add-projects-permissions.js`:

| Table | Columns |
|---|---|
| `projects` | id, owner_id (local user), name, slug, description, language (profile id or free text), kind (`github` or `tm`), visibility (`private` or `course`), repo_url, repo_full_name, default_branch, head_revision_id (`tm` projects), size_bytes, file_count, archived_at, timestamps |
| `project_members` | project_id, user_id, role (`owner`, `collaborator` or `viewer`), github_username, invited_by, status (`invited`, `active` or `removed`), timestamps. Collaborators exist only for `github` projects. |
| `project_revisions` | id, project_id, number, parent_id, author_id, message, manifest_gz (gzip JSON `[{path, sha256, size}]`), file_count, size_bytes, source (`save`, `auto` or `submit`), git_commit (nullable), created_at |
| `project_blobs` | sha256 (PK), size, storage (`db` or `fs`), data_gz LONGBLOB (null when on the file-server), created_at |
| `project_presence` | project_id, user_id, device_id, app_version, state JSON (`{open, file, dirty, branch, ahead, behind, changes, last_commit, last_run, sync}`), last_seen_at; one row per project and device |
| `project_activity_links` | id, project_id, activity_type (`quiz`, `assignment` or `manual_assessment`), activity_id, linked_by, revision_id (nullable; frozen when submitted), git_commit (nullable), status (`linked` or `submitted`), submitted_at, timestamps |
| `project_events` | id, project_id, user_id, type (`created`, `saved`, `pushed`, `opened`, `linked`, `submitted`, `member_added`, …), data JSON, created_at; feeds the activity timeline |

**Blobs.** Small blobs (under 256 KB) are stored gzipped in MySQL. Larger ones go to the existing internal **file-server** (`nga-task-mentor/projects/<sha>`). Blobs are content-addressed, so each identical file is stored only once across all revisions and users.

**Quotas,** configurable by env: 100 MB per project, 5,000 files, 10 MB per file, 50 projects per user. TMCode leaves out `node_modules`, `.git`, `dist`, `build`, `target`, `.venv`, `__pycache__`, `.next`, `.gradle`, anything matched by `.gitignore`, and anything matched by `.tmignore`.

## 3. Task Mentor API (all under `/api/tmcode`)

TMCode's Tauri HTTP scope is already limited to `/api/tmcode/*`, so everything stays under that prefix.

**Auth: a TMCode user token or a TM web token** (both are accepted by the new `tmcodeUserAuth` middleware):

| Method and path | Purpose |
|---|---|
| `POST /auth/exchange` | MIS Bearer → TMCode user token (§1) |
| `GET /auth/me` | user and permissions; 401 when the token is revoked |
| `GET /projects?scope=mine\|shared\|all` | list (`all` needs `PROJECTS_VIEW_ALL`) with `head`, `presence` and `links` summaries |
| `POST /projects` | create `{name, description, language, kind, repo_url?}` |
| `GET /projects/:id` | details, members, links, last 20 events, presence |
| `PATCH /projects/:id` | rename, describe, change visibility, archive |
| `DELETE /projects/:id` | owner only; blobs are deleted when no revision uses them |
| `GET /projects/:id/revisions?limit` | revision list |
| `GET /projects/:id/revisions/:rev/manifest` | file list of one revision |
| `POST /projects/:id/blobs/missing` | `{sha256[]}` → `{missing[]}` |
| `PUT /projects/:id/blobs/:sha` | raw gzip body; the server checks the hash and size |
| `GET /projects/:id/blobs/:sha` | gzip body |
| `POST /projects/:id/revisions` | `{base_revision_id, message, files:[{path, sha256, size}], source}` → `201 {revision}`. Returns `409 REVISION_CONFLICT {head}` when the base is not the current head. Returns `422 BLOBS_MISSING {missing}`. |
| `GET /projects/:id/files/*path?rev=` | one file's content (TM web file viewer) |
| `PUT /projects/:id/presence` | `{device_id, state}`; TMCode sends it every 20 s while the project is open, plus `{open:false}` on close |
| `GET /projects/:id/live` | **SSE** stream of presence, revision and event updates (the TM web page and the monitor) |
| `GET /monitor/live` | SSE stream for teachers (`PROJECTS_MONITOR`): presence of students in their scoped courses |
| `POST /projects/:id/git` | TMCode reports git state `{branch, head_commit, ahead, behind, changes, remote_url, pushed?: {commit, message}}` |
| `POST /projects/:id/members` | `{user_id or email, github_username, role}`; `github` projects only |
| `DELETE /projects/:id/members/:userId` | remove a member |
| `GET /projects/:id/open-link` | `{deeplink: "tmcode://project?id=…&api=…"}` |
| `GET /activities/linkable` | the user's open quizzes, assignments and recorded assessments (scoped as the TM pages are) |
| `POST /projects/:id/links` | `{activity_type, activity_id}` |
| `POST /projects/:id/links/:linkId/submit` | freezes the head revision or the git commit and records the submission. For assignments it also creates or updates the `submissions` row (`submission_type` `project`). |
| `DELETE /projects/:id/links/:linkId` | unlink, only while not submitted |
| `GET /activities/:type/:id/projects` | teacher view: the projects linked to an activity, with their frozen revisions |

**Permissions** (in `constants/permissions.ts`, the access-v2 manifest, and a seeding migration):

| Permission | Default roles | Grants |
|---|---|---|
| `PROJECTS_USE` | all users | own projects, sync, links |
| `PROJECTS_VIEW_ALL` | super admin | any project, read-only |
| `PROJECTS_MONITOR` | teachers, admins | live monitor and linked projects, scoped to their courses |

**Live updates.** The TM server keeps an in-process pub/sub (it is a single pm2 process) and pushes **Server-Sent Events**. nginx gets `proxy_buffering off` for `/api/tmcode/.*/live`. No change to the live-server is needed.

## 4. TMCode

1. **Account.** The status-bar avatar and the Accounts menu offer *Sign in with NGA (MIS + Task Mentor)*, *Signed in as …*, and *Sign out*. Rust commands: `auth_sign_in`, `auth_status`, `auth_sign_out`, and `tm_api` (an authenticated request proxy limited to `/api/tmcode/*`).
2. **Projects view** in the activity bar:
   - Sections: My projects, Shared with me, Linked activities. Each row shows a status badge (synced, ↑ local changes, ↓ newer in TM, conflict, git ↑/↓).
   - Actions: New project (from a template or the current folder), Open, Save to Task Mentor, Link to activity, Submit, Open in Task Mentor.
3. **Sync engine** (`projects/sync.ts`):
   - It hashes the folder (sha256 in Rust; `ws_hash_tree` honours the ignore rules) and compares it with the local base manifest kept in `.tmcode/project.json`.
   - **Save** uploads only the missing blobs, then commits a revision against its base.
   - **Pull** downloads only the missing blobs and applies them. Locally changed files cause a conflict, which is shown in a 2-way diff (Keep mine / Take Task Mentor).
4. **Status bar item.** It shows ☁ *Synced*, ☁ *3 changes* (click to save), ⟳ *Saving…*, ⚠ *Conflict*, or for GitHub projects the git status plus *TM ✓*.
5. **Git reporting.** For `github` projects, TMCode reports git state to TM after each commit, push, pull or fetch, and every 2 minutes. It never sends file contents for GitHub projects; they stay on GitHub.
6. **Presence.** A heartbeat every 20 s while a project folder is open; it is skipped during exams and when signed out.
7. **Deep link** `tmcode://project?id=<id>&api=<origin>` (the api must be on the allow-list):
   - If the user is signed out, sign in first.
   - If the project is already cloned on this device, open it. The device mapping is kept in the store.
   - Otherwise, offer to clone (`github`) or download (`tm`) into `~/TMCode Projects/<slug>` or a chosen folder.
8. **Settings:** `projects.autoSave` (off / on save / every 5 min), `projects.folder`, `projects.presence` (on/off).

## 5. TM web (client)

- **Sidebar:** "Projects" (`/projects`) for users with `PROJECTS_USE`, and "Project monitor" (`/projects/monitor`) for users with `PROJECTS_MONITOR`.
- **Projects dashboard:**
  - Cards or table with a live dot, language, kind (GitHub or TM), last activity, size and linked activities.
  - Stats: active this week, revisions, submissions.
  - Search and filters.
  - Buttons: New project and "Get TMCode".
- **Project page:**
  - Header with an *Open in TMCode* deep link; it falls back to the download page.
  - **Live panel** fed by SSE: "Open in TMCode on MacBook · editing src/main.cpp · 2 unsaved · branch main ↑1".
  - Tabs:
    - Files: a read-only tree plus a Monaco viewer at any revision (TM projects).
    - Revisions or Git: TM revisions, or GitHub commits as reported.
    - Activity timeline.
    - Links: link to an activity, submit, and status.
    - Members: GitHub projects only.
    - Settings.
- **Teacher side:**
  - Activity pages (quiz, assignment, recorded assessment) get a *Linked projects* panel, with an open-revision viewer.
  - The monitor page shows live student presence in their courses, through SSE.

## 6. Modern TMCode features in this phase

Picked from `EDITOR_ANALYSIS.md` because they make daily work easier:

1. **Project templates** for New Project: React (Vite), Node/Express API, Python, C++ (CMake + main.cpp), Java (Maven), HTML/CSS/JS. Each template has a ready `launch.json` and tasks.
2. **Local History / Timeline.** Every save keeps a local copy in `.tmcode/history`, capped at 50 per file. A Timeline panel shows them and can restore one.
3. **Outline view** in the explorer, from Monaco document symbols.
4. **Recent projects** in the Welcome page and on the command center (`Ctrl+R`).

## 7. Phases and testing

| # | Scope | Tests |
|---|---|---|
| P1 | TM server: models, migrations, permissions, auth exchange and all `/api/tmcode/projects*` routes, SSE | jest: sync protocol (missing blobs, conflict, quotas, hash mismatch), permissions, links and submit, SSE fan-out |
| P2 | TMCode: Rust auth (loopback + keychain + `tm_api`), `ws_hash_tree`, deep link | Rust: PKCE, state check, loopback handler, hashing with ignore rules |
| P3 | TMCode: Projects view, sync engine, status bar, presence, git reporting, templates, timeline, outline | vitest: sync planner (diff and conflict); e2e against a mock TM projects API |
| P4 | TM web: dashboard, project page, live panel, links and submit, teacher panels, monitor | client vitest; Playwright against the dev server |
| P5 | Integration | **end to end:** real TM dev server + MIS dev + TMCode native self-test (sign in → create → save → pull on a second folder → link → submit) |

**Deploy order** (after your approval):

1. TM PR (stacked on #28, because it needs #27/#28 merged first).
2. Run the migrations with the `migrate` workflow.
3. Add nginx SSE buffering off.
4. Release TMCode 0.4.0.

The open blocker is still the production check you need to run before #27/#28 can merge: `SELECT quiz_id FROM proctoring_settings WHERE enabled=1 AND lockdown_browser=1;`.
