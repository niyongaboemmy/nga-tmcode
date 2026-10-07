import type { AccountHost, AccountStatus, FileSystem, ScannedFile, TmRequest, TmResponse } from "./types";

/**
 * Dev server / e2e only: an NGA account and a Task Mentor projects API in
 * memory, following server/src/tmcode/PROJECTS_API.md closely enough to drive
 * TMCode's Projects view end to end in a browser.
 *
 * Test hooks on `window.__TMCODE_PROJECTS__`: `remoteSave(projectId, files)`
 * (another computer saved), `state()`, `setAssignmentStatus(id, status)`,
 * `grade(assignmentId, grade, feedback)`, `setTeacher(on)`.
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
  const status = (): AccountStatus => ({ signed_in: signedIn, user: signedIn ? user : null, tm_api: API, phase, error: null });
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
  // Task Mentor's project lifecycle (live since 2026-10-07); setLifecycle(false) mimics an older server.
  let lifecycle = true;
  const day = 86_400_000;
  const assignments: Record<string, unknown>[] = [
    { id: 51, title: "Build a to-do list", kind: "practical", course_id: 3, course_name: "Web Development", status: "published", due_date: new Date(Date.now() + 2 * day).toISOString(), points: 20, language: "javascript", description_html: '<p>Build a <b>to-do list</b> page. <a href="https://developer.mozilla.org/">MDN</a> helps.</p><script>alert(1)</script>', instructions: "1. Open `index.html`\n2. Make **Add** work\n3. Submit", attachments: [], rubric: null, starter_project_id: 0 },
    { id: 52, title: "Library case study", kind: "case_study", course_id: 3, course_name: "Web Development", status: "published", due_date: new Date(Date.now() - day).toISOString(), points: 10, language: null, description_html: "<p>Model a small library.</p>", instructions: null, attachments: [], rubric: null, starter_project_id: null },
  ];
  const grades = new Map<number, { grade: number; feedback: string }>();
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
          ? { project_id: ws?.id ?? null, link_id: link?.id ?? null, state, submitted_at: link?.submitted_at ?? null, revision_number: link?.revision_number ?? null, grade: g?.grade ?? null, max_points: g ? a.points : null, feedback: g?.feedback ?? null }
          : null,
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
    if ((m = p.match(/^\/assignments$/)) && req.method === "GET") {
      const scope = url.searchParams.get("scope") === "teaching" ? "teaching" : "student";
      if (scope === "teaching") return { status: 200, body: { assignments: teacher ? assignments.map((a) => assignmentSummary(a, "teaching")) : [] } };
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
      const h = head(Number(m[1]));
      Object.assign(link, { status: "submitted", revision_id: h?.id ?? null, revision_number: h?.number ?? null, submitted_at: now() });
      if (lifecycle && owner) owner.status = "submitted";
      return { status: 200, body: { link, submission: { id: 1, status: "submitted", is_late: false } } };
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

  async function scan(dir = "", out: ScannedFile[] = []): Promise<ScannedFile[]> {
    for (const e of await fs.readDir(dir)) {
      if (IGNORED.has(e.name)) continue;
      if (e.kind === "dir") await scan(e.path, out);
      else {
        const text = await fs.readFile(e.path);
        out.push({ path: e.path, sha256: await sha256(text), size: new TextEncoder().encode(text).length });
      }
    }
    return out;
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
    grade(id: number, grade: number, feedback: string) {
      grades.set(id, { grade, feedback });
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
    setLifecycle(on: boolean) {
      lifecycle = on;
    },
    assignments: () => assignments,
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
      setTimeout(() => {
        signedIn = true;
        phase = "idle";
        localStorage.setItem("tmcode:mock-account", "signed-in");
        emit();
      }, 400);
    },
    async cancel() {
      phase = "idle";
      emit();
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
    request: (req) => route(req) as Promise<TmResponse<never>>,
    async scan() {
      const files = (await scan()).sort((a, b) => a.path.localeCompare(b.path));
      return { files, truncated: null, total_bytes: files.reduce((n, f) => n + f.size, 0) };
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
