# TMCode practicals: assignments and case studies in the editor

_Plan, 2026-10-07. Builds on `PROJECTS_PLAN.md` (Task Mentor projects, live since 2026-10-06)._

## Goal

A teacher prepares a **practical** (a graded coding assignment) or a **case study** (a problem to work on) in Task Mentor's Assignments feature and attaches **starter files**. Then:

1. Students enrolled in the subject see it in TMCode's **Assignments** view.
2. One click on **Start** creates their own copy of the starter files and opens it in TMCode, with the brief beside the code.
3. Students save as they work and **Submit**. The teacher sees each submission with its exact code, then grades it.
4. When the teacher sets the assignment to **Completed**, it is **read-only** in TMCode: still viewable, no more saving or submitting, and Task Mentor enforces this too.

Also: a student can **stop syncing** a folder (disconnect it from Task Mentor) and **stop live monitoring** of a project.

## Data model (Task Mentor migration `20261007090000-tmcode-assignments.js`)

| Table | New columns |
|---|---|
| `assignments` | `tmcode_kind` ENUM('practical','case_study') NULL (NULL = not a TMCode assignment), `tmcode_language` VARCHAR(40) NULL, `tmcode_starter_project_id` INT NULL, `tmcode_starter_revision_id` INT NULL (NULL = the starter project's head at start time), `tmcode_instructions` TEXT NULL |
| `projects` | `assignment_id` INT NULL (the student's workspace for that assignment; unique per owner+assignment), `share_presence` BOOL NOT NULL DEFAULT 1 |

A TMCode assignment always uses `submission_type = 'project'`. Setting `tmcode_kind` sets it.

## API (all under `/api/tmcode`, TMCode user token or web token)

### Students

`GET /assignments?scope=student` → `{ assignments: AssignmentSummary[] }`. Only published or completed TMCode assignments of the subjects the student is enrolled in, scoped the way the web Assignments page scopes them. Drafts and removed assignments are never listed.

```ts
AssignmentSummary = {
  id, title, kind: "practical" | "case_study",
  course_id, course_name,
  status: "published" | "completed",
  due_date, points, language,
  read_only: boolean,           // status === "completed"
  late: boolean,                // due date passed
  my: {
    project_id: number | null,
    link_id: number | null,
    state: "not_started" | "in_progress" | "submitted" | "graded",
    submitted_at, revision_number, grade, max_points, feedback,
  } | null,                     // null in teaching scope
  teaching?: { students: number, started: number, submitted: number, graded: number },
}
```

`GET /assignments/:id` → `{ assignment: AssignmentSummary & { description_html, instructions, attachments: [{ name, url }], rubric, starter: { project_id, revision_id, file_count, size_bytes } | null } }`

`POST /assignments/:id/start` → `{ project: ProjectCore & { assignment, read_only }, created: boolean }`. It's idempotent:
- **First call:**
  - creates the student's project: kind `tm`, the assignment's title, `assignment_id` set, visibility `course`;
  - seeds revision 1 from the starter's files (manifest copy; blobs are shared, so nothing is copied) and the link to the assignment.
- **Later calls:** return the existing project.
- **Errors:** `409 ASSIGNMENT_COMPLETED` if it is completed and not started; `403 NOT_ENROLLED`.

**Submitting** uses the existing `POST /projects/:id/links/:linkId/submit`. It returns `409 ASSIGNMENT_COMPLETED` when the assignment is completed.

**Read-only is enforced on the server:** `POST /projects/:id/revisions` for a project whose `assignment_id` is completed returns `409 ASSIGNMENT_READ_ONLY`. `GET /projects/:id` gains `assignment: { id, title, status, kind } | null` and `read_only: boolean`.

### Teachers

- `GET /assignments?scope=teaching` → their TMCode assignments (creator, or a teacher of the course) with `teaching` counts.
- `PUT /assignments/:id/tmcode` with `{ kind | null, language, starter_project_id | null, starter_revision_id | null, instructions }`:
  - turns TMCode on (sets `submission_type = 'project'`) or off;
  - the starter must be a project the teacher can read.
- `GET /assignments/:id/workspaces` → each enrolled student with `{ user, project_id, state, last_activity_at, presence, revision_number, submitted_at, grade }`, for the teacher's submissions view.

### Projects

`PATCH /projects/:id` accepts `share_presence: boolean`. When it is false:
- presence is still stored for the owner (their own devices);
- presence is never sent to `/monitor/live`, and teachers' views show "Live status not shared".

Students cannot stop sharing an assignment workspace while the assignment is open, so that teachers can still monitor it during the practical.

**Deep link:** `tmcode://assignment?id=<id>&api=<origin>`. The Task Mentor web "Open in TMCode" button for students uses it.

## TMCode

### Assignments view

A new activity-bar item (mortar-board icon), visible when signed in:
- Grouped by state: **To do**, **Submitted**, **Graded**, **Completed (read-only)**.
- Each row shows the course, a due countdown (red when late), state chips and the kind (practical or case study).
- Teachers get a **Teaching** section with counts.

### Assignment page

An editor tab with:
- the brief (sanitised HTML), instructions, attachments, points and rubric;
- the due date with a countdown;
- the state and grade/feedback;
- the actions: **Start** or **Continue**, **Save**, **Submit** (with a confirm dialog that shows what is submitted), and **Open in Task Mentor**.

### Start and Continue

1. Start (or Continue) creates the workspace, in `~/TMCode Projects/<course>/<assignment>`, or opens the existing folder.
2. It pulls the starter files.
3. It opens the folder with the assignment page beside the code, and reveals the first file.

### Read-only

When the assignment is completed:
- the whole workbench is read-only, through the existing `readOnly` mode;
- a banner explains why;
- Save to Task Mentor and Submit are disabled.

### Projects view fixes

- **Disconnect from Task Mentor:** removes the binding and keeps the files.
- **Share live status** switch per project. It is locked on for open assignments.
- Fix the alignment of the Connect button and of every row.

### Teacher in TMCode

**Use as Starter for an Assignment…** publishes the open project (saved to Task Mentor) as an assignment's starter, through `PUT /assignments/:id/tmcode`.

## Task Mentor web

- **Assignment form:**
  - a "TMCode practical" section: off, practical or case study;
  - language;
  - a starter project picker (the teacher's projects, with "latest saved version" or a revision);
  - instructions;
  - a preview of the starter's file list.
- **Assignment page (student):**
  - an **Open in TMCode** button (the deep link, with a download fallback);
  - their workspace state;
  - a code viewer of what they submitted.
- **Assignment page (teacher):**
  - a **Workspaces** panel: each student's state (not started, working with live status, submitted, graded);
  - open their code at the submitted revision;
  - grade it with the existing grading.
- **Projects pages:** a UX review (spacing, alignment, responsive), the Share live status switch, and an assignment badge on workspace projects.

## Tests

- **Task Mentor:**
  - jest: start (idempotent, seeded files), completed assignments reject start, save and submit, enrolment scope, share_presence and the monitor;
  - vitest: the forms and panels;
  - Playwright with a mocked API.
- **TMCode:**
  - vitest: the state mapping;
  - e2e with the memory fake: list, start, edit, save, submit, read-only;
  - a native projects self-test extended with an assignment flow against a real local Task Mentor.
