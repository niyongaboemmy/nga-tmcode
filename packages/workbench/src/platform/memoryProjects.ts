import type { AccountHost, AccountStatus, FileSystem, ScannedFile, TmRequest, TmResponse } from "./types";

/**
 * Dev server / e2e only: an NGA account and a Task Mentor projects API in
 * memory, following server/src/tmcode/PROJECTS_API.md closely enough to drive
 * TMCode's Projects view end to end in a browser.
 *
 * Test hooks on `window.__TMCODE_PROJECTS__`: `remoteSave(projectId, files)`
 * (another computer saved), `state()`.
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

export function createMemoryAccountHost(fs: FileSystem): AccountHost {
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
  const activities = [
    { activity_type: "assignment", activity_id: 31, title: "Build a calculator", course_name: "Programming 101", due_date: new Date(Date.now() + 86400000).toISOString(), open: true },
    { activity_type: "quiz", activity_id: 77, title: "Python Practical 2", course_name: "Programming 101", due_date: null, open: true },
  ];
  let seq = 100;
  const now = () => new Date().toISOString();
  const head = (pid: number) => revisions.filter((r) => r.project_id === pid).sort((a, b) => b.number - a.number)[0] ?? null;
  const revOut = (r: Rev | null) => (r ? { id: r.id, project_id: r.project_id, number: r.number, parent_id: r.parent_id, author_id: r.author_id, author_name: user.name, message: r.message, file_count: r.files.length, size_bytes: r.files.reduce((n, f) => n + f.size, 0), source: r.source, git_commit: null, created_at: r.created_at } : null);
  const projectOut = (p: Record<string, unknown>) => ({
    ...p,
    head: revOut(head(p.id as number)),
    head_revision_id: head(p.id as number)?.id ?? null,
    links: links.filter((l) => l.project_id === p.id).map((l) => ({ ...l, activity: { title: activities.find((a) => a.activity_id === l.activity_id)?.title, course_id: 1, open: true, due_date: null } })),
    presence: { online: false, devices_online: 0, last_seen_at: null, file: null, dirty: null },
  });
  const err = (status: number, error_code: string, message: string, extra: object = {}): TmResponse => ({ status, body: { error_code, message, ...extra } });

  async function route(req: TmRequest): Promise<TmResponse> {
    if (!signedIn) return err(401, "UNAUTHENTICATED", "Sign in");
    const url = new URL(req.path, API);
    const p = url.pathname.replace(/^\/api\/tmcode/, "");
    const body = (req.json ?? {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;
    if (p === "/auth/me") return { status: 200, body: { user, token_kind: "tmcode-user" } };
    if (p === "/projects" && req.method === "GET") {
      const scope = url.searchParams.get("scope");
      return { status: 200, body: { projects: scope === "shared" ? [] : projects.map(projectOut), stats: {} } };
    }
    if (p === "/projects" && req.method === "POST") {
      const id = ++seq;
      const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const proj = { id, name: body.name, slug, description: body.description ?? null, language: body.language ?? null, kind: body.kind, visibility: "private", repo_url: body.repo_url ?? null, repo_full_name: body.repo_url ? String(body.repo_url).replace("https://github.com/", "") : null, default_branch: null, size_bytes: 0, file_count: 0, git: null, archived_at: null, last_activity_at: now(), created_at: now(), updated_at: now(), owner: { id: user.id, name: user.name, avatar_url: null }, my_role: "owner" };
      projects.push(proj);
      return { status: 201, body: { project: projectOut(proj) } };
    }
    if ((m = p.match(/^\/projects\/(\d+)$/))) {
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
      if ((body.base_revision_id ?? null) !== (h?.id ?? null)) return err(409, "REVISION_CONFLICT", "Task Mentor has newer changes.", { head: revOut(h) });
      const files = body.files as ScannedFile[];
      const missing = files.filter((f) => !blobs.has(f.sha256)).map((f) => f.sha256);
      if (missing.length) return err(422, "BLOBS_MISSING", "Upload these first", { missing });
      const rev: Rev = { id: ++seq, project_id: pid, number: (h?.number ?? 0) + 1, parent_id: h?.id ?? null, author_id: user.id, message: String(body.message ?? ""), files, source: String(body.source ?? "save"), created_at: now() };
      revisions.push(rev);
      return { status: 201, body: { revision: revOut(rev) } };
    }
    if (p === "/activities/linkable") return { status: 200, body: { activities } };
    if ((m = p.match(/^\/projects\/(\d+)\/links$/))) {
      const link = { id: ++seq, project_id: Number(m[1]), activity_type: body.activity_type, activity_id: body.activity_id, status: "linked", revision_id: null, revision_number: null, git_commit: null, submitted_at: null, linked_by: user.id, created_at: now() };
      links.push(link);
      return { status: 201, body: { link } };
    }
    if ((m = p.match(/^\/projects\/(\d+)\/links\/(\d+)\/submit$/))) {
      const link = links.find((l) => l.id === Number(m![2]));
      if (!link) return err(404, "NOT_FOUND", "No link");
      const h = head(Number(m[1]));
      Object.assign(link, { status: "submitted", revision_id: h?.id ?? null, revision_number: h?.number ?? null, submitted_at: now() });
      return { status: 200, body: { link, submission: { id: 1, status: "submitted", is_late: false } } };
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
    state: () => ({ projects, revisions: revisions.map((r) => ({ id: r.id, number: r.number, project_id: r.project_id, files: r.files.map((f) => f.path) })), links }),
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
    async newFolder() {
      throw new Error("New folders need the TMCode desktop app.");
    },
  };
}
