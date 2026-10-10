import type { AccountHost, AccountStatus, FileSystem, ScannedFile, SkippedFile, TmRequest, TmResponse } from "./types";

/**
 * Dev server / e2e only: an NGA account and a Task Mentor projects API in
 * memory, following server/src/tmcode/PROJECTS_API.md closely enough to drive
 * TMCode's Projects view end to end in a browser.
 *
 * Test hooks on `window.__TMCODE_PROJECTS__`: `remoteSave(projectId, files)`
 * (another computer saved), `state()`, `setAssignmentStatus(id, status)`,
 * `grade(assignmentId, grade, feedback)`, `setTeacher(on)`, `setQuizOpen(on)`,
 * `returnForChanges(assignmentId, message)`, `setDueDate(assignmentId, iso)`,
 * `failAssignments(code | null)`, `setQuota(maxProjectBytes | null)`,
 * `setLegacyGradeComments(on)`, `gradeOf(type, id, questionId, studentId)`,
 * `setScanLimit(maxFileBytes)`; `grade(id, grade, feedback, rubricScores?)`.
 *
 * Assignments follow docs/ASSIGNMENTS_PLAN.md: practical 51 has starter files,
 * case study 52 has none.
 */

const IGNORED = new Set([".git", "node_modules", "dist", "build", "out", "target", ".venv", "venv", "__pycache__", ".next", ".gradle", ".idea", ".DS_Store", ".tmcode"]);
const API = "http://localhost:5002";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const unb64 = (data: string) => new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));

interface Rev {
  id: number;
  project_id: number;
  number: number;
  parent_id: number | null;
  author_id: number;
  message: string;
  files: ScannedFile[];
  source: string;
  created_at: string;
}

export function createMemoryAccountHost(fs: FileSystem, folders?: { newFolder(name: string): Promise<string> }): AccountHost {
  const user = { id: 7, mis_user_id: 1007, name: "Ada Student", email: "ada@nga.test", role: "student", avatar_url: null, permissions: ["PROJECTS_USE"] };
  let signedIn = localStorage.getItem("tmcode:mock-account") === "signed-in";
  let phase: AccountStatus["phase"] = "idle";
  const listeners = new Set<(s: AccountStatus) => void>();
  // Why the session ended (expireSession): the account shows it until the next sign-in.
  let accountError: string | null = null;
  // e2e: localStorage "tmcode:mock-signin-wait" keeps the browser sign-in waiting; "tmcode:mock-keychain-fail" fails the keychain save.
  const SIGNIN_URL = "http://localhost:5173/desktop/signin?redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fsignin&state=mock&challenge=mock";
  let keychainError: string | null = null;
  const status = (): AccountStatus => ({
    signed_in: signedIn,
    user: signedIn ? user : null,
    tm_api: API,
    phase,
    error: signedIn ? null : accountError,
    signin_url: phase === "waiting" ? SIGNIN_URL : null,
    keychain_error: signedIn ? keychainError : null,
  });
  const emit = () => listeners.forEach((l) => l(status()));

  const projects: Record<string, unknown>[] = [];
  const revisions: Rev[] = [];
  const blobs = new Map<string, string>(); // sha → text
  const links: Record<string, unknown>[] = [];
  // GET /activities/linkable answers {type, id, …} (server projects.controller linkableActivities).
  const activities = [
    { type: "assignment", id: 31, title: "Build a calculator", course_id: 1, course_name: "Programming 101", due_date: new Date(Date.now() + 86400000).toISOString(), submission_type: "project" },
    { type: "quiz", id: 77, title: "Python Practical 2", course_id: 1, course_name: "Programming 101", due_date: null },
    { type: "manual_assessment", id: 90, title: "Lab presentation", course_id: 1, course_name: "Programming 101", due_date: null },
    { type: "assignment", id: 32, title: "Portfolio website", course_id: 3, course_name: "Web Development", due_date: new Date(Date.now() + 3 * 86400000).toISOString(), submission_type: "project" },
    // A quiz with a TMCode practical question (quiz_questions.id 501): GET /activities/linkable lists it.
    { type: "quiz", id: 78, title: "Web Quiz 3", course_id: 3, course_name: "Web Development", due_date: new Date(Date.now() + 86400000).toISOString(), practical_questions: [{ question_id: 501, title: "Build a navbar", points: 10 }] },
  ];
  let seq = 100;
  let teacher = false;
  let latency = 0;
  // Task Mentor's project lifecycle (live since 2026-10-07); setLifecycle(false) mimics an older server.
  let lifecycle = true;
  const day = 86_400_000;
  const assignments: Record<string, unknown>[] = [
    { id: 51, title: "Build a to-do list", kind: "practical", course_id: 3, course_name: "Web Development", status: "published", due_date: new Date(Date.now() + 2 * day).toISOString(), points: 20, language: "javascript", description_html: '<p>Build a <b>to-do list</b> page. <a href="https://developer.mozilla.org/">MDN</a> helps.</p><script>alert(1)</script>', instructions: "1. Open `index.html`\n2. Make **Add** work\n3. Submit", attachments: [], rubric: [{ criteria: "Adding items works", description: "Typing a task and pressing Add shows it in the list", max_score: 12 }, { criteria: "Code quality", description: "Clear names, no repeated code", max_score: 8 }], starter_project_id: 0 },
    { id: 52, title: "Library case study", kind: "case_study", course_id: 3, course_name: "Web Development", status: "published", due_date: new Date(Date.now() - day).toISOString(), points: 10, language: null, description_html:
        // Like Task Mentor's rich editor writes it: black serif text, a white background, an uploaded image and one from another site.
        '<h2 style="color: rgb(0, 0, 0); font-family: \'Times New Roman\'; text-align: center">Model a small library</h2><p style="color: black; background-color: #ffffff; font-size: 12pt; font-family: \'Times New Roman\'">Design the <strong>books</strong>, <strong>members</strong> and <strong>loans</strong> tables.</p><p><img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%2290%22%3E%3Crect width=%22240%22 height=%2290%22 rx=%2210%22 fill=%22%233b82f6%22/%3E%3Ctext x=%2220%22 y=%2255%22 font-size=%2228%22 fill=%22white%22%3EER diagram%3C/text%3E%3C/svg%3E" alt="ER diagram"></p><p><img src="https://images.example.org/library.png"></p>',
      instructions: null, attachments: [], rubric: null, starter_project_id: null },
  ];
  const grades = new Map<number, { grade: number; feedback: string; rubric_scores?: { index: number; score: number; comment: string | null }[] | null }>();
  // Files bigger than this are left out of the scan (projects.rs: 10 MB); setScanLimit lowers it for e2e.
  let maxScanFileBytes = 10 * 1_048_576;
  // An older Task Mentor without rubric_scores / accepts_submissions (setOldServer), and closed assignments (closeAssignment).
  let oldServer = false;
  const closed = new Set<number>();
  // Teachers' grading (GET/PUT /grading…): other students' work, seeded by setTeacher(true).
  let gradingList = true;
  const people = new Map<number, string>([[21, "Ben Learner"], [22, "Chloe Coder"], [23, "Dan Doer"]]);
  const studentGrades = new Map<string, { score: number; rubric_scores: { index: number; score: number; comment?: string | null }[] | null; feedback: string; graded_at: string }>();
  let gradingSeeded = false;
  let legacyComments = false;
  // Is the student's quiz attempt open? (Task Mentor records a practical answer only then.)
  let quizOpen = true;
  // Teachers' "Return for changes", per assignment: when, and their message.
  const returned = new Map<number, { at: string; message: string | null }>();
  // GET /assignments and /activities/linkable fail with this (Central MIS down: MIS_SCOPE_UNAVAILABLE).
  let failScope: string | null = null;
  let maxProjectBytes: number | null = null;
  async function seedGrading() {
    if (gradingSeeded) return;
    gradingSeeded = true;
    const work = async (sid: number, files: Record<string, string>, link: { type: string; id: number; question_id?: number }, submit: boolean) => {
      const id = ++seq;
      projects.push({ id, name: `${people.get(sid)}'s work`, slug: `w${id}`, description: null, language: "javascript", kind: "tm", visibility: "course", repo_url: null, repo_full_name: null, default_branch: null, size_bytes: 0, file_count: 0, git: null, archived_at: null, last_activity_at: now(), created_at: now(), updated_at: now(), owner: { id: sid, name: people.get(sid)!, avatar_url: null }, my_role: "teacher", assignment_id: link.type === "assignment" ? link.id : null, share_presence: true, status: submit ? "submitted" : "draft", hidden: true });
      const list: ScannedFile[] = [];
      for (const [path, text] of Object.entries(files)) {
        const sha = await sha256(text);
        blobs.set(sha, text);
        list.push({ path, sha256: sha, size: text.length });
      }
      const rev: Rev = { id: ++seq, project_id: id, number: 2, parent_id: null, author_id: sid, message: "Work", files: list, source: "save", created_at: now() };
      revisions.push(rev);
      links.push({ id: ++seq, project_id: id, activity_type: link.type, activity_id: link.id, question_id: link.question_id ?? null, status: submit ? "submitted" : "linked", revision_id: submit ? rev.id : null, revision_number: submit ? rev.number : null, git_commit: null, submitted_at: submit ? new Date(Date.now() - sid * 60_000).toISOString() : null, linked_by: sid, created_at: now() });
    };
    await work(21, { "index.html": "<h1>Ben's list</h1>\n<script src=\"app.js\"></script>\n", "app.js": "const items = [];\n" }, { type: "assignment", id: 51 }, true);
    await work(22, { "index.html": "<h1>Chloe's list</h1>\n", "app.js": "// todo\n", "README.md": "# Chloe\n" }, { type: "assignment", id: 51 }, true);
    await work(23, { "index.html": "<h1>Dan</h1>\n" }, { type: "assignment", id: 51 }, false);
    await work(21, { "index.html": "<nav>Ben's navbar</nav>\n" }, { type: "quiz", id: 78, question_id: 501 }, true);
  }
  function roster(type: string, id: number, qid: number | null) {
    const a = type === "assignment" ? assignments.find((x) => x.id === id) : null;
    const quiz = type === "quiz" ? activities.find((x) => x.type === "quiz" && x.id === id) : null;
    const questions = ((quiz as { practical_questions?: { question_id: number; title: string; points: number }[] } | null)?.practical_questions ?? []);
    const q = questions.find((x) => x.question_id === (qid ?? questions[0]?.question_id));
    if (!a && !q) return null;
    const max = a ? (a.points as number) : q!.points;
    const rubric = a ? ((a.rubric as { criteria: string; description: string | null; max_score: number }[] | null) ?? []) : [{ criteria: "Layout", description: null, max_score: 6 }, { criteria: "Links", description: null, max_score: 4 }];
    const ls = links.filter((l) => l.activity_type === type && l.activity_id === id && (type !== "quiz" || l.question_id === q!.question_id));
    const rows = ls.map((l) => {
      const proj = projects.find((x) => x.id === l.project_id)!;
      const sid = (proj.owner as { id: number }).id;
      const g = studentGrades.get(`${type}:${id}:${type === "quiz" ? q!.question_id : ""}:${sid}`);
      const state = g ? "graded" : l.status === "submitted" ? "submitted" : "in_progress";
      return {
        student: { id: sid, name: people.get(sid) ?? user.name, avatar_url: null },
        state,
        project: { id: proj.id, name: proj.name, status: proj.status ?? "draft", kind: "tm", language: proj.language ?? null, repo_url: null },
        link: { id: l.id, status: l.status, submitted_at: l.submitted_at, revision_id: l.revision_id, revision_number: l.revision_number, git_commit: null },
        // Older servers keep the notes only inside the feedback (setLegacyGradeComments).
        grade: g ? { score: g.score, rubric_scores: legacyComments ? (g.rubric_scores ?? []).map(({ index, score }) => ({ index, score })) : g.rubric_scores, feedback: g.feedback, graded_at: g.graded_at, ref_id: 1 } : null,
        submitted_at: l.submitted_at,
        late: false,
      };
    });
    rows.push({ student: { id: 24, name: "Eve Absent", avatar_url: null }, state: "not_started", project: null, link: null, grade: null, submitted_at: null, late: false } as never);
    const order: Record<string, number> = { submitted: 0, in_progress: 1, graded: 2, not_started: 3 };
    rows.sort((x, y) => order[x.state] - order[y.state] || x.student.name.localeCompare(y.student.name));
    return {
      activity: { type, id, title: a ? a.title : quiz!.title, course_id: 3, due_date: a ? a.due_date : quiz!.due_date, max_points: max, rubric, question: q ? { id: q.question_id, text: `<p>${q.title}</p>`, instructions: "" } : null, questions: type === "quiz" ? questions : [], can_grade: true },
      counts: { total: rows.length, to_grade: rows.filter((r) => r.state === "submitted").length, graded: rows.filter((r) => r.state === "graded").length },
      rows,
    };
  }
  const now = () => new Date().toISOString();
  const head = (pid: number) => revisions.filter((r) => r.project_id === pid).sort((a, b) => b.number - a.number)[0] ?? null;
  const revOut = (r: Rev | null) => (r ? { id: r.id, project_id: r.project_id, number: r.number, parent_id: r.parent_id, author_id: r.author_id, author_name: user.name, message: r.message, file_count: r.files.length, size_bytes: r.files.reduce((n, f) => n + f.size, 0), source: r.source, git_commit: null, created_at: r.created_at } : null);
  const projectOut = (p: Record<string, unknown>) => ({
    ...p,
    share_presence: p.share_presence !== false,
    ...(lifecycle ? { status: p.status ?? "draft" } : {}),
    assignment: (() => {
      const a = assignments.find((x) => x.id === p.assignment_id);
      return a ? { id: a.id, title: a.title, status: a.status, kind: a.kind } : null;
    })(),
    read_only: assignments.find((x) => x.id === p.assignment_id)?.status === "completed",
    head: revOut(head(p.id as number)),
    head_revision_id: head(p.id as number)?.id ?? null,
    links: links.filter((l) => l.project_id === p.id).map((l) => ({ ...l, activity: { title: activities.find((a) => a.type === l.activity_type && a.id === l.activity_id)?.title ?? assignments.find((a) => a.id === l.activity_id)?.title, course_id: 1, open: true, due_date: null } })),
    presence: { online: false, devices_online: 0, last_seen_at: null, file: null, dirty: null },
  });
  const err = (status: number, error_code: string, message: string, extra: object = {}): TmResponse => ({ status, body: { error_code, message, ...extra } });

  // Practical 51's starter: the teacher's project (owner 9), revision 1.
  const starterFiles: Record<string, string> = { "index.html": '<!doctype html>\n<ul id="todos"></ul>\n<script src="app.js"></script>\n', "app.js": "// TODO: add items\n" };
  const seeded = (async () => {
    const id = ++seq;
    projects.push({ id, name: "To-do starter", slug: "to-do-starter", description: null, language: "javascript", kind: "tm", visibility: "course", repo_url: null, repo_full_name: null, default_branch: null, size_bytes: 0, file_count: 2, git: null, archived_at: null, last_activity_at: now(), created_at: now(), updated_at: now(), owner: { id: 9, name: "Mr Teacher", avatar_url: null }, my_role: "viewer", assignment_id: null, share_presence: true, hidden: true });
    const files: ScannedFile[] = [];
    for (const [path, text] of Object.entries(starterFiles)) {
      const sha = await sha256(text);
      blobs.set(sha, text);
      files.push({ path, sha256: sha, size: text.length });
    }
    revisions.push({ id: ++seq, project_id: id, number: 1, parent_id: null, author_id: 9, message: "Starter", files, source: "save", created_at: now() });
    assignments[0].starter_project_id = id;
  })();
  const workspaceOf = (aid: number) => projects.find((x) => x.assignment_id === aid && (x.owner as { id: number }).id === user.id);
  const assignmentSummary = (a: Record<string, unknown>, scope: "student" | "teaching") => {
    const ws = workspaceOf(a.id as number);
    const link = ws ? links.find((l) => l.project_id === ws.id) : undefined;
    const g = grades.get(a.id as number);
    const state = g ? "graded" : link?.status === "submitted" ? "submitted" : ws ? "in_progress" : "not_started";
    const { description_html: _d, instructions: _i, attachments: _a, rubric: _r, starter_project_id: _s, ...rest } = a;
    return {
      ...rest,
      read_only: a.status === "completed",
      late: !!a.due_date && Date.parse(a.due_date as string) < Date.now(),
      my:
        scope === "student"
          ? {
              project_id: ws?.id ?? null,
              link_id: link?.id ?? null,
              state,
              submitted_at: link?.submitted_at ?? null,
              revision_number: link?.revision_number ?? null,
              grade: g?.grade ?? null,
              max_points: g ? a.points : null,
              feedback: g?.feedback ?? null,
              // Per-criterion scores and notes once graded, else null (Task Mentor 0.11; older ones omit it).
              ...(oldServer ? {} : { rubric_scores: g?.rubric_scores ?? null }),
              // Whether the hand-in itself was late (Task Mentor's submissions.is_late), null before one.
              is_late: link?.submitted_at ? !!link.is_late : null,
              returned_at: returned.get(a.id as number)?.at ?? null,
              returned_message: returned.get(a.id as number)?.message ?? null,
            }
          : null,
      // Task Mentor 0.11: closing stops submissions; late work is accepted (marked late) until then.
      ...(oldServer ? {} : { accepts_submissions: a.status !== "completed" && !closed.has(a.id as number), late_policy: "until_closed", accepts_late_until: null }),
      ...(scope === "teaching" ? { teaching: { students: 24, started: ws ? 1 : 0, submitted: link?.status === "submitted" ? 1 : 0, graded: g ? 1 : 0 } } : {}),
    };
  };
  const assignmentDetail = (a: Record<string, unknown>) => {
    const sid = a.starter_project_id as number | null;
    const h = sid ? head(sid) : null;
    return { ...assignmentSummary(a, teacher ? "teaching" : "student"), description_html: a.description_html, instructions: a.instructions, attachments: a.attachments, rubric: a.rubric, starter: h ? { project_id: sid, revision_id: h.id, file_count: h.files.length, size_bytes: h.files.reduce((n, f) => n + f.size, 0) } : null };
  };
  const assignmentOfProject = (proj: Record<string, unknown>) => assignments.find((a) => a.id === proj.assignment_id);

  async function route(req: TmRequest): Promise<TmResponse> {
    await seeded;
    if (!signedIn) return err(401, "UNAUTHENTICATED", "Sign in");
    const url = new URL(req.path, API);
    const p = url.pathname.replace(/^\/api\/tmcode/, "");
    const body = (req.json ?? {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;
    if (p === "/auth/me") return { status: 200, body: { user, token_kind: "tmcode-user" } };
    if (p === "/projects" && req.method === "GET") {
      const scope = url.searchParams.get("scope");
      const status = url.searchParams.get("status") ?? "active";
      const st = (x: Record<string, unknown>) => (x.status as string) ?? "draft";
      const keep = (x: Record<string, unknown>) => (status === "active" ? st(x) !== "removed" : status === "all" ? true : st(x) === status);
      return { status: 200, body: { projects: scope === "shared" ? [] : projects.filter((x) => !x.hidden && keep(x)).map(projectOut), stats: {} } };
    }
    if (p === "/projects" && req.method === "POST") {
      const id = ++seq;
      const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const proj = { id, name: body.name, slug, description: body.description ?? null, language: body.language ?? null, kind: body.kind, visibility: "private", repo_url: body.repo_url ?? null, repo_full_name: body.repo_url ? String(body.repo_url).replace("https://github.com/", "") : null, default_branch: null, size_bytes: 0, file_count: 0, git: null, archived_at: null, last_activity_at: now(), created_at: now(), updated_at: now(), owner: { id: user.id, name: user.name, avatar_url: null }, my_role: "owner" };
      projects.push(proj);
      return { status: 201, body: { project: projectOut(proj) } };
    }
    if (failScope && (p === "/assignments" || p === "/activities/linkable")) {
      return failScope === "UNAUTHENTICATED" ? err(401, failScope, "Sign in again.") : { status: 409, body: { code: failScope, message: "Central MIS can't be reached, so your subjects are unknown." } };
    }
    if ((m = p.match(/^\/assignments$/)) && req.method === "GET") {
      const scope = url.searchParams.get("scope") === "teaching" ? "teaching" : "student";
      // Like Task Mentor: students are refused the teaching scope.
      if (scope === "teaching") return teacher ? { status: 200, body: { assignments: assignments.map((a) => assignmentSummary(a, "teaching")) } } : err(403, "FORBIDDEN", "Only teachers have a teaching scope.");
      return { status: 200, body: { assignments: teacher ? [] : assignments.map((a) => assignmentSummary(a, "student")) } };
    }
    if ((m = p.match(/^\/assignments\/(\d+)$/))) {
      const a = assignments.find((x) => x.id === Number(m![1]));
      return a ? { status: 200, body: { assignment: assignmentDetail(a) } } : err(404, "NOT_FOUND", "Assignment not found");
    }
    if ((m = p.match(/^\/assignments\/(\d+)\/start$/)) && req.method === "POST") {
      const a = assignments.find((x) => x.id === Number(m![1]));
      if (!a) return err(404, "NOT_FOUND", "Assignment not found");
      const existing = workspaceOf(a.id as number);
      if (existing) return { status: 200, body: { project: projectOut(existing), created: false } };
      if (a.status === "completed") return err(409, "ASSIGNMENT_COMPLETED", "This assignment is completed.");
      const id = ++seq;
      const proj = { id, name: a.title, slug: String(a.title).toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: null, language: a.language, kind: "tm", visibility: "course", repo_url: null, repo_full_name: null, default_branch: null, size_bytes: 0, file_count: 0, git: null, archived_at: null, last_activity_at: now(), created_at: now(), updated_at: now(), owner: { id: user.id, name: user.name, avatar_url: null }, my_role: "owner", assignment_id: a.id, share_presence: true };
      projects.push(proj);
      const sh = a.starter_project_id ? head(a.starter_project_id as number) : null;
      if (sh) revisions.push({ id: ++seq, project_id: id, number: 1, parent_id: null, author_id: user.id, message: "Starter files", files: sh.files, source: "save", created_at: now() });
      links.push({ id: ++seq, project_id: id, activity_type: "assignment", activity_id: a.id, status: "linked", revision_id: null, revision_number: null, git_commit: null, submitted_at: null, linked_by: user.id, created_at: now() });
      return { status: 201, body: { project: projectOut(proj), created: true } };
    }
    if ((m = p.match(/^\/assignments\/(\d+)\/tmcode$/)) && req.method === "PUT") {
      const a = assignments.find((x) => x.id === Number(m![1]));
      if (!a || !teacher) return err(403, "FORBIDDEN", "Only the assignment's teachers can change it.");
      Object.assign(a, { kind: body.kind ?? a.kind, language: body.language ?? a.language, starter_project_id: body.starter_project_id ?? null, instructions: body.instructions ?? a.instructions });
      return { status: 200, body: { assignment: assignmentDetail(a) } };
    }
    if ((m = p.match(/^\/assignments\/(\d+)\/workspaces$/))) {
      return { status: 200, body: { workspaces: [{ user: { id: 7, name: "Ada Student" }, project_id: 140, state: "submitted", last_activity_at: now(), presence: { online: true }, revision_number: 2, submitted_at: now(), grade: null }, { user: { id: 8, name: "Ben Learner" }, project_id: null, state: "not_started", last_activity_at: null, presence: null, revision_number: null, submitted_at: null, grade: null }] } };
    }
    if (p === "/grading" && req.method === "GET") {
      if (!gradingList) return err(404, "NOT_FOUND", "No route");
      if (!teacher) return err(403, "FORBIDDEN", "Teachers only.");
      await seedGrading();
      return {
        status: 200,
        body: {
          activities: [
            ...assignments.map((a) => ({ type: "assignment", id: a.id, title: a.title, course_id: a.course_id, course_name: a.course_name, due_date: a.due_date, status: a.status, max_points: a.points, questions: null })),
            ...activities.filter((x) => x.type === "quiz" && (x as { practical_questions?: unknown[] }).practical_questions?.length).map((x) => ({ type: "quiz", id: x.id, title: x.title, course_id: x.course_id, course_name: x.course_name, due_date: x.due_date, status: "published", max_points: null, questions: (x as { practical_questions?: unknown[] }).practical_questions })),
          ],
        },
      };
    }
    if ((m = p.match(/^\/grading\/(assignment|quiz)\/(\d+)$/)) && req.method === "GET") {
      if (!teacher) return err(403, "FORBIDDEN", "Teachers only.");
      await seedGrading();
      const r = roster(m[1], Number(m[2]), url.searchParams.get("question_id") ? Number(url.searchParams.get("question_id")) : null);
      return r ? { status: 200, body: r } : err(404, "NOT_FOUND", "Activity not found.");
    }
    if ((m = p.match(/^\/grading\/(assignment|quiz)\/(\d+)\/students\/(\d+)$/)) && req.method === "PUT") {
      const r = roster(m[1], Number(m[2]), (body.question_id as number | null) ?? null);
      if (!r) return err(404, "NOT_FOUND", "Activity not found.");
      const scores = (body.rubric_scores as { index: number; score: number; comment?: string | null }[]) ?? [];
      for (const sc of scores) {
        const c = r.activity.rubric[sc.index];
        if (!c) return err(422, "UNKNOWN_CRITERION", `There is no criterion #${sc.index + 1}.`);
        if (sc.score > c.max_score) return err(422, "SCORE_TOO_HIGH", `“${c.criteria}” is out of ${c.max_score}.`);
      }
      const total = r.activity.rubric.length ? scores.reduce((n, x) => n + x.score, 0) : Number(body.score ?? 0);
      const sid = Number(m[3]);
      // Like Task Mentor: the notes per criterion also go into the feedback the student reads.
      const notes = scores.filter((x) => x.comment?.trim()).map((x) => `• ${r.activity.rubric[x.index]?.criteria ?? `Criterion ${x.index + 1}`}: ${x.comment!.trim()}`);
      const feedback = [String(body.feedback ?? "").trim(), notes.length ? `Criteria notes:\n${notes.join("\n")}` : ""].filter(Boolean).join("\n\n");
      studentGrades.set(`${m[1]}:${m[2]}:${m[1] === "quiz" ? r.activity.question!.id : ""}:${sid}`, { score: total, rubric_scores: scores.map((x) => ({ index: x.index, score: x.score, comment: x.comment?.trim() || null })), feedback, graded_at: now() });
      const row = r.rows.find((x) => x.student.id === sid);
      const proj = row?.project ? projects.find((x) => x.id === row.project!.id) : null;
      if (proj) proj.status = "graded";
      return { status: 200, body: { ok: true, score: total, max_points: r.activity.max_points } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/revisions\/(\d+)\/manifest$/))) {
      const rev = revisions.find((r) => r.id === Number(m![2]) && r.project_id === Number(m![1]));
      return rev ? { status: 200, body: { revision: revOut(rev), files: rev.files } } : err(404, "REVISION_NOT_FOUND", "Revision not found.");
    }
    if ((m = p.match(/^\/projects\/(\d+)\/preview$/)) && req.method === "POST") {
      const rev = revisions.find((r) => r.id === Number(body.rev) && r.project_id === Number(m![1]));
      const page = rev?.files.find((f) => /\.html?$/.test(f.path));
      if (!rev || !page) return err(422, "NO_HTML", "There's no HTML page to preview in this revision.");
      const url2 = URL.createObjectURL(new Blob([blobs.get(page.sha256) ?? ""], { type: "text/html" }));
      return { status: 200, body: { url: url2, entry: page.path, expires_in: 600 } };
    }
    if ((m = p.match(/^\/projects\/(\d+)$/)) && req.method === "PATCH") {
      const proj = projects.find((x) => x.id === Number(m![1]));
      if (!proj) return err(404, "NOT_FOUND", "Project not found");
      const a = assignmentOfProject(proj);
      if (body.share_presence === false && a && a.status !== "completed") return err(409, "PRESENCE_LOCKED", "Live status stays on while the assignment is open, so your teacher can follow the practical.");
      if (typeof body.share_presence === "boolean") proj.share_presence = body.share_presence;
      return { status: 200, body: { project: projectOut(proj) } };
    }
    if ((m = p.match(/^\/projects\/(\d+)$/)) && req.method === "GET") {
      const proj = projects.find((x) => x.id === Number(m![1]));
      return proj ? { status: 200, body: { project: projectOut(proj) } } : err(404, "NOT_FOUND", "Project not found");
    }
    if ((m = p.match(/^\/projects\/(\d+)\/revisions\/head\/manifest$/))) {
      const h = head(Number(m[1]));
      return h ? { status: 200, body: { revision: revOut(h), files: h.files } } : err(404, "NO_REVISIONS", "No revisions yet");
    }
    if ((m = p.match(/^\/projects\/(\d+)\/blobs\/missing$/))) return { status: 200, body: { missing: (body.sha256 as string[]).filter((s) => !blobs.has(s)) } };
    if ((m = p.match(/^\/projects\/(\d+)\/blobs\/([0-9a-f]{64})$/))) {
      if (req.method === "PUT") {
        const text = unb64(req.body_base64 ?? "");
        if ((await sha256(text)) !== m[2]) return err(422, "HASH_MISMATCH", "Hash mismatch");
        blobs.set(m[2], text);
        return { status: 201, body: { sha256: m[2] } };
      }
      const text = blobs.get(m[2]);
      return text === undefined ? err(404, "NOT_FOUND", "No blob") : { status: 200, body: { base64: b64(text) } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/revisions$/)) && req.method === "POST") {
      const pid = Number(m[1]);
      const h = head(pid);
      const owner = projects.find((x) => x.id === pid);
      if (owner && assignmentOfProject(owner)?.status === "completed") return err(409, "ASSIGNMENT_READ_ONLY", "This assignment is completed: its workspace is read-only.");
      if (lifecycle && owner && (owner.status ?? "draft") === "submitted") return err(409, "PROJECT_LOCKED", "This project is submitted. Withdraw the submission to change it.");
      if ((body.base_revision_id ?? null) !== (h?.id ?? null)) return err(409, "REVISION_CONFLICT", "Task Mentor has newer changes.", { head: revOut(h) });
      const files = body.files as ScannedFile[];
      const total = files.reduce((n, f) => n + f.size, 0);
      if (maxProjectBytes !== null && total > maxProjectBytes) return err(413, "QUOTA_EXCEEDED", `A project may be at most ${maxProjectBytes} bytes.`, { limit: "project_size", max: maxProjectBytes });
      const missing = files.filter((f) => !blobs.has(f.sha256)).map((f) => f.sha256);
      if (missing.length) return err(422, "BLOBS_MISSING", "Upload these first", { missing });
      const rev: Rev = { id: ++seq, project_id: pid, number: (h?.number ?? 0) + 1, parent_id: h?.id ?? null, author_id: user.id, message: String(body.message ?? ""), files, source: String(body.source ?? "save"), created_at: now() };
      revisions.push(rev);
      return { status: 201, body: { revision: revOut(rev) } };
    }
    if (p === "/activities/linkable") {
      // Published TMCode practicals are assignments in the student's subjects too.
      const practicals = assignments.filter((a) => a.status === "published").map((a) => ({ type: "assignment", id: a.id, title: a.title, course_id: a.course_id, course_name: a.course_name, due_date: a.due_date, submission_type: "project" }));
      return { status: 200, body: { activities: [...activities, ...practicals] } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/links\/(\d+)$/)) && req.method === "DELETE") {
      const i = links.findIndex((l) => l.id === Number(m![2]) && l.project_id === Number(m![1]));
      if (i < 0) return err(404, "LINK_NOT_FOUND", "Link not found.");
      if (links[i].status === "submitted") return err(409, "LINK_SUBMITTED", "A submitted link can't be removed.");
      links.splice(i, 1);
      return { status: 200, body: { ok: true } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/links$/))) {
      const mineIds = projects.filter((x) => (x.owner as { id: number }).id === user.id).map((x) => x.id);
      const dup = links.find((l) => l.activity_type === body.activity_type && l.activity_id === body.activity_id && (l.question_id ?? null) === (body.question_id ?? null) && mineIds.includes(l.project_id as number));
      if (dup) return err(409, "ALREADY_LINKED", dup.project_id === Number(m[1]) ? "Already linked." : "Another of your projects is linked to this activity.");
      const link = { id: ++seq, project_id: Number(m[1]), activity_type: body.activity_type, activity_id: body.activity_id, question_id: body.question_id ?? null, status: "linked", revision_id: null, revision_number: null, git_commit: null, submitted_at: null, linked_by: user.id, created_at: now() };
      links.push(link);
      return { status: 201, body: { link } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/links\/(\d+)\/submit$/))) {
      const link = links.find((l) => l.id === Number(m![2]));
      if (!link) return err(404, "NOT_FOUND", "No link");
      const owner = projects.find((x) => x.id === Number(m![1]));
      if (owner && assignmentOfProject(owner)?.status === "completed") return err(409, "ASSIGNMENT_COMPLETED", "This assignment is completed: it can no longer be submitted.");
      if (owner && closed.has(assignmentOfProject(owner)?.id as number)) return err(409, "ASSIGNMENT_CLOSED", "This assignment is closed: it no longer takes submissions.");
      // Like Task Mentor (2026-10-10): a practical answer needs the student's quiz attempt open.
      if (link.activity_type === "quiz" && !quizOpen) return { status: 409, body: { code: "QUIZ_NOT_OPEN", message: "Open the quiz in Task Mentor first." } };
      const h = head(Number(m[1]));
      const due = link.activity_type === "assignment" ? (assignments.find((a) => a.id === link.activity_id)?.due_date as string | null | undefined) : null;
      const isLate = !!due && Date.parse(due) < Date.now();
      Object.assign(link, { status: "submitted", revision_id: h?.id ?? null, revision_number: h?.number ?? null, submitted_at: now(), is_late: isLate });
      if (lifecycle && owner) owner.status = "submitted";
      if (link.activity_type === "assignment") returned.delete(link.activity_id as number);
      return { status: 200, body: { link, submission: { id: 1, status: "submitted", is_late: isLate } } };
    }
    if ((m = p.match(/^\/quizzes\/(\d+)\/questions\/(\d+)\/start$/)) && req.method === "POST") {
      const quiz = activities.find((a) => a.type === "quiz" && a.id === Number(m![1]));
      const q = (quiz as { practical_questions?: { question_id: number; title: string }[] } | undefined)?.practical_questions?.find((x) => x.question_id === Number(m![2]));
      if (!quiz || !q) return err(404, "NOT_FOUND", "Practical question not found.");
      const existing = links.find((l) => l.activity_type === "quiz" && l.activity_id === quiz.id && l.question_id === q.question_id);
      const ex = existing && projects.find((x) => x.id === existing.project_id && x.status !== "removed");
      if (ex) return { status: 200, body: { project: projectOut(ex), link_id: existing!.id, created: false } };
      const id = ++seq;
      const name = `${quiz.title} — ${q.title}`;
      const proj = { id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), description: null, language: "html", kind: "tm", visibility: "course", repo_url: null, repo_full_name: null, default_branch: null, size_bytes: 0, file_count: 0, git: null, archived_at: null, last_activity_at: now(), created_at: now(), updated_at: now(), owner: { id: user.id, name: user.name, avatar_url: null }, my_role: "owner", assignment_id: null, share_presence: true, status: "draft" };
      projects.push(proj);
      const files: ScannedFile[] = [];
      for (const [path, text] of Object.entries({ "index.html": "<nav><!-- TODO --></nav>\n" })) {
        const sha = await sha256(text);
        blobs.set(sha, text);
        files.push({ path, sha256: sha, size: text.length });
      }
      revisions.push({ id: ++seq, project_id: id, number: 1, parent_id: null, author_id: user.id, message: "Starter files", files, source: "save", created_at: now() });
      const link = { id: ++seq, project_id: id, activity_type: "quiz", activity_id: quiz.id, question_id: q.question_id, status: "linked", revision_id: null, revision_number: null, git_commit: null, submitted_at: null, linked_by: user.id, created_at: now() };
      links.push(link);
      return { status: 201, body: { project: projectOut(proj), link_id: link.id, created: true } };
    }
    if ((m = p.match(/^\/projects\/(\d+)$/)) && req.method === "DELETE") {
      const proj = projects.find((x) => x.id === Number(m![1]));
      if (!proj) return err(404, "NOT_FOUND", "Project not found");
      if (["submitted", "graded"].includes((proj.status as string) ?? "draft")) return err(409, "PROJECT_SUBMITTED", "This project was submitted for an activity. Archive it instead.");
      proj.status = "removed";
      return { status: 200, body: { ok: true, removed: true, status: "removed" } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/restore$/)) && req.method === "POST") {
      const proj = projects.find((x) => x.id === Number(m![1]));
      if (!proj) return err(404, "NOT_FOUND", "Project not found");
      proj.status = links.some((l) => l.project_id === proj.id && l.status === "submitted") ? "submitted" : "draft";
      return { status: 200, body: { status: proj.status, project: projectOut(proj) } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/withdraw$/)) && req.method === "POST") {
      const proj = projects.find((x) => x.id === Number(m![1]));
      if (!proj) return err(404, "NOT_FOUND", "Project not found");
      if ((proj.status ?? "draft") !== "submitted") return err(409, "NOT_SUBMITTED", "Only a submitted project can be withdrawn.");
      proj.status = "draft";
      return { status: 200, body: { project: projectOut(proj) } };
    }
    if (p.match(/^\/projects\/\d+\/(presence|git)$/)) return { status: 200, body: { ok: true } };
    return err(404, "NOT_FOUND", `No mock route for ${req.method} ${p}`);
  }

  /** `.gitignore` lines of the root, simply: `name`, `*.ext`, `dir/` (enough for e2e). */
  async function ignoreRules(): Promise<((name: string, dir: boolean) => boolean)> {
    const text = await fs.readFile(".gitignore").catch(() => "");
    const rules = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
      .map((l) => {
        const dirOnly = l.endsWith("/");
        const glob = l.replace(/\/+$/, "").replace(/^\//, "");
        const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, ".")}$`);
        return { re, dirOnly };
      });
    return (name, dir) => rules.some((r) => (!r.dirOnly || dir) && r.re.test(name));
  }

  const NOT_WORK = new Set([".git", ".tmcode", ".DS_Store"]);
  async function scan(dir = "", out: ScannedFile[] = [], skipped: SkippedFile[] = [], ignored?: (name: string, dir: boolean) => boolean): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }> {
    const isIgnored = ignored ?? (await ignoreRules());
    for (const e of await fs.readDir(dir)) {
      if (IGNORED.has(e.name)) {
        if (!NOT_WORK.has(e.name)) skipped.push({ path: e.path, reason: "folder", dir: e.kind === "dir", size: null });
        continue;
      }
      if (isIgnored(e.name, e.kind === "dir")) {
        skipped.push({ path: e.path, reason: "ignored", dir: e.kind === "dir", size: null });
        continue;
      }
      if (e.kind === "dir") await scan(e.path, out, skipped, isIgnored);
      else {
        const text = await fs.readFile(e.path);
        const size = new TextEncoder().encode(text).length;
        if (size > maxScanFileBytes) skipped.push({ path: e.path, reason: "too-large", dir: false, size });
        else out.push({ path: e.path, sha256: await sha256(text), size });
      }
    }
    return { files: out, skipped };
  }

  (window as unknown as { __TMCODE_PROJECTS__: unknown }).__TMCODE_PROJECTS__ = {
    /** Another computer saved new content (files: path → text). */
    async remoteSave(projectId: number, files: Record<string, string>) {
      const h = head(projectId);
      const map = new Map((h?.files ?? []).map((f) => [f.path, f]));
      for (const [path, text] of Object.entries(files)) {
        const sha = await sha256(text);
        blobs.set(sha, text);
        map.set(path, { path, sha256: sha, size: text.length });
      }
      revisions.push({ id: ++seq, project_id: projectId, number: (h?.number ?? 0) + 1, parent_id: h?.id ?? null, author_id: user.id, message: "Saved on another computer", files: [...map.values()], source: "save", created_at: now() });
    },
    setAssignmentStatus(id: number, status: string) {
      const a = assignments.find((x) => x.id === id);
      if (a) a.status = status;
    },
    /** `rubricScores`: per-criterion scores + notes as a newer Task Mentor sends them (omit: an older one). */
    grade(id: number, grade: number, feedback: string, rubricScores?: { index: number; score: number; comment?: string | null }[] | null) {
      grades.set(id, { grade, feedback, rubric_scores: rubricScores === undefined ? undefined : rubricScores && rubricScores.map((s) => ({ index: s.index, score: s.score, comment: s.comment ?? null })) });
      const ws = workspaceOf(id);
      if (ws && lifecycle) ws.status = "graded";
    },
    /** The teacher graded a project's submission (any activity). */
    setProjectStatus(projectId: number, status: string) {
      const proj = projects.find((x) => x.id === projectId);
      if (proj) proj.status = status;
    },
    setTeacher(on: boolean) {
      teacher = on;
    },
    /** Every request waits this long (ms) before Task Mentor answers. */
    setLatency(ms: number) {
      latency = ms;
    },
    /** No TMCode assignments or quiz practicals at all (the empty Assignments view). */
    clearAssignments() {
      assignments.splice(0, assignments.length);
      for (let i = activities.length - 1; i >= 0; i--) if ((activities[i] as { practical_questions?: unknown[] }).practical_questions?.length) activities.splice(i, 1);
    },
    /** false: Task Mentor without GET /grading (TMCode falls back to its own list). */
    setGradingList(on: boolean) {
      gradingList = on;
    },
    setLifecycle(on: boolean) {
      lifecycle = on;
    },
    /** false: the student's quiz attempt isn't open, so a practical submit is refused (409 QUIZ_NOT_OPEN). */
    setQuizOpen(on: boolean) {
      quizOpen = on;
    },
    /** The teacher sends the student's submitted work back for changes, with a message. */
    returnForChanges(assignmentId: number, message: string | null) {
      const ws = workspaceOf(assignmentId);
      if (!ws) return;
      ws.status = "draft";
      for (const l of links) if (l.project_id === ws.id && l.status === "submitted") l.status = "linked";
      returned.set(assignmentId, { at: now(), message });
    },
    setDueDate(assignmentId: number, iso: string | null) {
      const a = assignments.find((x) => x.id === assignmentId);
      if (a) a.due_date = iso;
    },
    /** GET /assignments and /activities/linkable fail with this code (MIS_SCOPE_UNAVAILABLE, UNAUTHENTICATED), or work again (null). */
    failAssignments(code: string | null) {
      failScope = code;
    },
    /** Saves bigger than this (bytes, all files) are refused with 413 QUOTA_EXCEEDED; null: no limit. */
    setQuota(bytes: number | null) {
      maxProjectBytes = bytes;
    },
    /** true: a Task Mentor before 0.11 (no rubric_scores, accepts_submissions, late_policy). */
    setOldServer(on: boolean) {
      oldServer = on;
    },
    /** The teacher closes (or reopens) an assignment: accepts_submissions false, submits refused. */
    closeAssignment(id: number, on = true) {
      if (on) closed.add(id);
      else closed.delete(id);
    },
    /** Files bigger than this many bytes are left out of saves (default 10 MB, as the desktop app). */
    setScanLimit(bytes: number) {
      maxScanFileBytes = bytes;
    },
    /** true: an older Task Mentor that keeps criterion notes only inside the feedback text. */
    setLegacyGradeComments(on: boolean) {
      legacyComments = on;
    },
    /** What Task Mentor stored for a student's grade. */
    gradeOf(type: string, id: number, questionId: number | null, studentId: number) {
      return studentGrades.get(`${type}:${id}:${type === "quiz" ? questionId : ""}:${studentId}`) ?? null;
    },
    assignments: () => assignments,
    /** A teacher publishes a new TMCode assignment (fields over a practical's defaults). */
    addAssignment(fields: Record<string, unknown>) {
      assignments.push({ id: ++seq, title: "New practical", kind: "practical", course_id: 3, course_name: "Web Development", status: "published", due_date: new Date(Date.now() + 5 * day).toISOString(), points: 10, language: "javascript", description_html: "<p>New work</p>", instructions: null, attachments: [], rubric: null, starter_project_id: null, ...fields });
    },
    /** A quiz's practical fields: start_date / attempt_open on the quiz, state / grade on its questions. */
    setQuizPractical(quizId: number, quiz: Record<string, unknown>, questions: Record<number, Record<string, unknown>> = {}) {
      const a = activities.find((x) => x.type === "quiz" && x.id === quizId) as Record<string, unknown> | undefined;
      if (!a) return;
      Object.assign(a, quiz);
      for (const q of (a.practical_questions as Record<string, unknown>[] | undefined) ?? []) Object.assign(q, questions[q.question_id as number] ?? {});
    },
    /** The NGA session ends here (expired, or signed out elsewhere): signed out, with the reason. */
    expireSession(reason = "Your NGA session ended.") {
      signedIn = false;
      accountError = reason;
      localStorage.removeItem("tmcode:mock-account");
      emit();
    },
    // The student's view of the data: the teacher's starter project is not theirs.
    state: () => ({ projects: projects.filter((x) => !x.hidden), revisions: revisions.filter((r) => !projects.find((x) => x.id === r.project_id)?.hidden).map((r) => ({ id: r.id, number: r.number, project_id: r.project_id, files: r.files.map((f) => f.path) })), links }),
  };

  return {
    async status() {
      return status();
    },
    async signIn() {
      phase = "waiting";
      emit();
      if (localStorage.getItem("tmcode:mock-signin-wait")) return;
      setTimeout(() => {
        if (phase !== "waiting") return;
        signedIn = true;
        accountError = null;
        keychainError = localStorage.getItem("tmcode:mock-keychain-fail") ? "The user name or passphrase you entered is not correct." : null;
        phase = "idle";
        localStorage.setItem("tmcode:mock-account", "signed-in");
        emit();
      }, 400);
    },
    async cancel() {
      phase = "idle";
      emit();
    },
    async reopenBrowser() {
      if (phase !== "waiting") throw new Error("No sign-in is waiting. Choose Sign in with NGA.");
      localStorage.setItem("tmcode:mock-signin-opened", String(Number(localStorage.getItem("tmcode:mock-signin-opened") ?? "0") + 1));
    },
    async signOut() {
      signedIn = false;
      localStorage.removeItem("tmcode:mock-account");
      emit();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    // `latency`: a slow network, to see that loading shows at once (setLatency).
    request: async (req) => {
      if (latency) await new Promise((r) => setTimeout(r, latency));
      return route(req) as Promise<TmResponse<never>>;
    },
    async scan() {
      const res = await scan();
      const files = res.files.sort((a, b) => a.path.localeCompare(b.path));
      const skipped = res.skipped.sort((a, b) => a.path.localeCompare(b.path));
      const big = skipped.find((s) => s.reason === "too-large");
      return { files, truncated: big ? `${big.path} is larger than the limit and was left out` : null, total_bytes: files.reduce((n, f) => n + f.size, 0), skipped, skipped_count: skipped.length };
    },
    async readBlob(path) {
      const text = await fs.readFile(path);
      return [await sha256(text), b64(text)];
    },
    async writeBlob(path, sha, data) {
      const text = unb64(data);
      if ((await sha256(text)) !== sha) throw new Error("checksum mismatch");
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) await fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
      await fs.writeFile(path, text).catch(async () => {
        await fs.createFile(path);
        await fs.writeFile(path, text);
      });
    },
    async newFolder(name) {
      if (!folders) throw new Error("New folders need the TMCode desktop app.");
      return folders.newFolder(name);
    },
  };
}
