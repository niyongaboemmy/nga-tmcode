import { createJsWorkerRunner } from "./jsWorkerRunner";
import { createMemoryExtensionHost } from "./memoryExtensions";
import { createMemoryGit } from "./memoryGit";
import { createMemoryAccountHost } from "./memoryProjects";
import { createSimulatedDebugHost } from "../debug/fakeAdapter";
import { createSimulatedProc } from "./memoryProc";
import { createSimulatedTerminal } from "./memoryTerminal";
import type { DirEntry, ExamHost, FileEncoding, FileSystem, JournalEntry, JournalStore, KeyValueStore, OsKind, Platform, Runner } from "./types";

/**
 * An in-memory file system. Used by the browser build (dev server, Playwright,
 * vitest) and as the fallback store for TMCode Web.
 */
export class MemoryFileSystem implements FileSystem {
  private files = new Map<string, string>();
  private dirs = new Set<string>([""]);

  constructor(seed: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(seed)) this.put(path, content);
  }

  private put(path: string, content: string) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
    this.files.set(path, content);
  }

  private parentOf(path: string) {
    const i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }

  private assertFree(path: string) {
    if (this.files.has(path) || this.dirs.has(path)) throw new Error(`'${path}' already exists`);
    if (!this.dirs.has(this.parentOf(path))) throw new Error(`Folder '${this.parentOf(path)}' does not exist`);
  }

  async readDir(path: string): Promise<DirEntry[]> {
    if (!this.dirs.has(path)) throw new Error(`Folder '${path}' does not exist`);
    const out: DirEntry[] = [];
    const prefix = path ? `${path}/` : "";
    for (const d of this.dirs) {
      if (d && this.parentOf(d) === path) out.push({ name: d.slice(prefix.length), path: d, kind: "dir" });
    }
    for (const f of this.files.keys()) {
      if (this.parentOf(f) === path) out.push({ name: f.slice(prefix.length), path: f, kind: "file" });
    }
    return out;
  }

  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`File '${path}' does not exist`);
    return content;
  }

  async writeFile(path: string, content: string) {
    if (!this.files.has(path)) this.assertFree(path);
    this.files.set(path, content);
  }

  async createFile(path: string) {
    this.assertFree(path);
    this.files.set(path, "");
  }

  async createDir(path: string) {
    this.assertFree(path);
    this.dirs.add(path);
  }

  async copy(from: string, to: string) {
    this.assertFree(to);
    if (to === from || to.startsWith(`${from}/`)) throw new Error(`Cannot copy '${from}' into itself.`);
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      return;
    }
    if (!this.dirs.has(from)) throw new Error(`'${from}' does not exist`);
    const copied = (p: string) => to + p.slice(from.length);
    for (const d of [...this.dirs]) if (d === from || d.startsWith(`${from}/`)) this.dirs.add(copied(d));
    for (const [f, c] of [...this.files]) if (f.startsWith(`${from}/`)) this.files.set(copied(f), c);
  }

  async rename(from: string, to: string) {
    if (from === to) return;
    this.assertFree(to);
    if (this.files.has(from)) {
      this.files.set(to, this.files.get(from)!);
      this.files.delete(from);
      return;
    }
    if (!this.dirs.has(from)) throw new Error(`'${from}' does not exist`);
    const moved = (p: string) => to + p.slice(from.length);
    for (const d of [...this.dirs]) {
      if (d === from || d.startsWith(`${from}/`)) {
        this.dirs.delete(d);
        this.dirs.add(moved(d));
      }
    }
    for (const [f, c] of [...this.files]) {
      if (f.startsWith(`${from}/`)) {
        this.files.delete(f);
        this.files.set(moved(f), c);
      }
    }
  }

  /** Memory files are text already; the encoding is only a label the status bar shows and saves keep. */
  private encodings = new Map<string, FileEncoding>();
  async encodingOf(path: string): Promise<FileEncoding> {
    if (!this.files.has(path)) throw new Error(`File '${path}' does not exist`);
    return this.encodings.get(path) ?? "utf8";
  }
  async reopenWithEncoding(path: string, encoding: FileEncoding) {
    this.encodings.set(path, encoding);
    return this.readFile(path);
  }
  async setEncoding(path: string, encoding: FileEncoding) {
    this.encodings.set(path, encoding);
  }

  async remove(path: string) {
    if (this.files.delete(path)) return;
    if (!this.dirs.has(path) || path === "") throw new Error(`'${path}' does not exist`);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
    for (const f of [...this.files.keys()]) if (f.startsWith(`${path}/`)) this.files.delete(f);
  }
}

/** A FileSystem whose backing store can be swapped (practice folder ↔ exam folder). */
export class SwitchableFileSystem implements FileSystem {
  constructor(public target: FileSystem) {}
  readDir(p: string) {
    return this.target.readDir(p);
  }
  readFile(p: string) {
    return this.target.readFile(p);
  }
  writeFile(p: string, c: string) {
    return this.target.writeFile(p, c);
  }
  createFile(p: string) {
    return this.target.createFile(p);
  }
  createDir(p: string) {
    return this.target.createDir(p);
  }
  rename(a: string, b: string) {
    return this.target.rename(a, b);
  }
  copy(a: string, b: string) {
    return this.target.copy ? this.target.copy(a, b) : Promise.reject(new Error("Copying is not supported here."));
  }
  remove(p: string) {
    return this.target.remove(p);
  }
  encodingOf(p: string) {
    return this.target.encodingOf ? this.target.encodingOf(p) : Promise.resolve<FileEncoding>("utf8");
  }
  reopenWithEncoding(p: string, e: FileEncoding) {
    return this.target.reopenWithEncoding ? this.target.reopenWithEncoding(p, e) : this.target.readFile(p);
  }
  setEncoding(p: string, e: FileEncoding) {
    return this.target.setEncoding ? this.target.setEncoding(p, e) : Promise.resolve();
  }
  /** Set by the dev / e2e platform only: the browser has no Trash. */
  trash?: (p: string) => Promise<void>;
}

/** Journal in localStorage (browser build); survives reloads like the desktop one survives crashes. */
export class LocalStorageJournal implements JournalStore {
  private key = (sid: string) => `tmcode:journal:${sid}`;
  async load(sid: string): Promise<JournalEntry[]> {
    try {
      return JSON.parse(localStorage.getItem(this.key(sid)) ?? "[]") as JournalEntry[];
    } catch {
      return [];
    }
  }
  async append(sid: string, e: JournalEntry) {
    const all = await this.load(sid);
    all.push(e);
    localStorage.setItem(this.key(sid), JSON.stringify(all));
  }
  async markSynced(sid: string, seq: number) {
    const all = await this.load(sid);
    for (const e of all) if (e.seq <= seq) e.synced = true;
    localStorage.setItem(this.key(sid), JSON.stringify(all));
  }
}

class LocalStorageStore implements KeyValueStore {
  constructor(private prefix: string) {}
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = localStorage.getItem(this.prefix + key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  }
  async set<T>(key: string, value: T) {
    try {
      localStorage.setItem(this.prefix + key, JSON.stringify(value));
    } catch {
      // Private windows and blocked storage: settings just don't persist.
    }
  }
}

function detectOs(): OsKind {
  const p = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  if (/mac/i.test(p)) return "mac";
  if (/win/i.test(p)) return "windows";
  return "linux";
}

export const DEMO_PROJECT: Record<string, string> = {
  "main.py": `"""Grade calculator: reads scores and prints the average and letter grade."""


def letter(average: float) -> str:
    if average >= 80:
        return "A"
    if average >= 70:
        return "B"
    if average >= 60:
        return "C"
    return "F"


def main() -> None:
    count = int(input())
    scores = [float(input()) for _ in range(count)]
    average = sum(scores) / count
    print(f"{average:.1f} {letter(average)}")


if __name__ == "__main__":
    main()
`,
  "README.md": "# Practice project\n\nRead `count`, then that many scores, and print the average and a letter grade.\n",
  "web/index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Portfolio</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <nav><a href="#about">About</a><a href="#work">Work</a><a href="#contact">Contact</a></nav>
    <h1>Hello, NGA!</h1>
    <button id="theme">Toggle theme</button>
    <p><a href="about.html">About me</a></p>
    <script src="app.js"></script>
  </body>
</html>
`,
  "web/about.html": `<!doctype html>\n<html lang="en">\n  <head><meta charset="utf-8" /><title>About</title><link rel="stylesheet" href="style.css" /></head>\n  <body><h1>About me</h1><p><a href="index.html">Home</a></p></body>\n</html>\n`,
  "web/style.css": `body {\n  font-family: system-ui, sans-serif;\n  margin: 2rem;\n}\n\nbody.dark {\n  background: #111;\n  color: #eee;\n}\n`,
  "web/app.js": `document.getElementById("theme").addEventListener("click", () => {\n  document.body.classList.toggle("dark");\n  console.log("dark mode:", document.body.classList.contains("dark"));\n});\n`,
  "js/sum.js": `// Reads two numbers and prints their sum.
const [a, b] = require("fs").readFileSync(0, "utf8").trim().split(/\\s+/).map(Number);
console.log(a + b);
`,
  ".tmcode/tests.json": JSON.stringify(
    {
      entry: "js/sum.js",
      tests: [
        { id: "t1", name: "small numbers", input: "2 3\n", expected_output: "5\n" },
        { id: "t2", name: "negative", input: "-4 10\n", expected_output: "6\n" },
        { id: "t3", name: "large", input: "1000000 2000000\n", expected_output: "3000000\n" },
      ],
    },
    null,
    2,
  ),
  "react-app/index.html": `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Counter</title></head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  "react-app/src/main.jsx": `import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./App.css";

createRoot(document.getElementById("root")).render(<App />);
`,
  "react-app/src/App.jsx": `import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  console.log("render", count);
  return (
    <main>
      <h1>Counter</h1>
      <button onClick={() => setCount(count + 1)}>Clicked {count} times</button>
    </main>
  );
}
`,
  "react-app/src/App.css": `main { font-family: system-ui, sans-serif; padding: 2rem; }\nbutton { font-size: 1rem; padding: .5rem 1rem; }\n`,
  "py/stats.py": `# Straight-line code: try breakpoints (F9), stepping (F10) and the Debug Console.
scores = [72, 85, 90]
total = sum(scores)
count = len(scores)
mean = total / count
print("mean:", mean)
best = max(scores)
print("best:", best)
`,
  "src/utils.ts": `export function average(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n`,
};

/** A browser-only platform with an in-memory demo project. */
/** Browser build: lets tests (and TMCode Web) simulate a change made outside the editor. */
const watchers = new Set<(paths: string[]) => void>();
export async function simulateExternalWrite(platform: Platform, path: string, content: string) {
  // Like `git checkout` / `npm install`: missing folders are created too.
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) await platform.fs.createDir(parts.slice(0, i).join("/")).catch(() => {});
  await platform.fs.writeFile(path, content);
  watchers.forEach((w) => w([path]));
}

/**
 * Browser build: requests go through fetch (CORS applies). Dev server / e2e:
 * http://localhost:4000 answers as a small to-do API, so the API Tester can be
 * tested without a server.
 */
function createMemoryHttp(): import("./types").HttpHost {
  const todos = [
    { id: 1, title: "Learn SQL", done: true },
    { id: 2, title: "Build an API", done: false },
  ];
  const json = (status: number, value: unknown, ms = 12): import("./types").ApiResponse => {
    const body = JSON.stringify(value);
    return { status, status_text: status === 200 ? "OK" : status === 201 ? "Created" : status === 404 ? "Not Found" : "Bad Request", headers: [["content-type", "application/json; charset=utf-8"], ["x-powered-by", "Express"]], body, binary: false, size: body.length, truncated: false, ms };
  };
  return {
    async request(req) {
      const u = new URL(req.url);
      if (import.meta.env?.DEV && u.host === "localhost:4000") {
        await new Promise((r) => setTimeout(r, 30));
        const m = /^\/api\/todos(?:\/(\d+))?$/.exec(u.pathname);
        if (u.pathname === "/") return { ...json(200, {}), headers: [["content-type", "text/html"]], body: "<h1>Todo API</h1><p>Try GET /api/todos</p>", size: 40 };
        if (!m) return json(404, { error: "Not found" });
        if (req.method === "GET" && !m[1]) return json(200, todos);
        if (req.method === "GET") return todos.find((t) => t.id === Number(m[1])) ? json(200, todos.find((t) => t.id === Number(m[1]))) : json(404, { error: "No such todo" });
        if (req.method === "POST") {
          try {
            const body = JSON.parse(req.body ?? "{}") as { title?: string };
            if (!body.title) return json(400, { error: "title is required" });
            const t = { id: todos.length + 1, title: body.title, done: false };
            todos.push(t);
            return json(201, t);
          } catch {
            return json(400, { error: "Invalid JSON" });
          }
        }
        return json(404, { error: "Not found" });
      }
      const t0 = performance.now();
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : (req.body ?? undefined) });
      const body = await res.text();
      return { status: res.status, status_text: res.statusText, headers: [...res.headers.entries()], body, binary: false, size: body.length, truncated: false, ms: Math.round(performance.now() - t0) };
    },
  };
}

/** Dev server / e2e: localStorage "tmcode:mock-folder:<root>" = { path: content } seeds that folder (a second project). */
function mockFolderSeed(root: string): Record<string, string> {
  if (!import.meta.env?.DEV) return {};
  try {
    return JSON.parse(localStorage.getItem(`tmcode:mock-folder:${root}`) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Dev server / e2e: localStorage "tmcode:mock-no-tools" makes this computer
 * have no language tools (the exam system check, server runs, Check My Computer).
 */
function noToolsForE2e(runner: Runner): Runner {
  if (!import.meta.env?.DEV) return runner;
  const none = () => {
    try {
      return !!localStorage.getItem("tmcode:mock-no-tools");
    } catch {
      return false;
    }
  };
  return {
    ...runner,
    detect: (refresh) => (none() ? Promise.resolve([]) : runner.detect(refresh)),
    start: (req, onEvent) =>
      none() ? Promise.reject(new Error("TMCode could not find Node.js on this computer. Install it, then choose \"Refresh Toolchains\".")) : runner.start(req, onEvent),
  };
}

export function createMemoryPlatform(seed: Record<string, string> = DEMO_PROJECT): Platform {
  const practice = new MemoryFileSystem(seed);
  const fs = new SwitchableFileSystem(practice);
  const exams = new Map<number, MemoryFileSystem>();
  // Dev server / e2e: folders TMCode creates for projects and assignments (memory://folders/<name>).
  const folders = new Map<string, MemoryFileSystem>();
  // Dev server / e2e: a pretend Trash, so Delete behaves as on the desktop (deleted in memory).
  // localStorage "tmcode:mock-trash-fail" makes it fail, for the permanent-delete fallback.
  if (import.meta.env?.DEV) {
    fs.trash = async (p) => {
      if (localStorage.getItem("tmcode:mock-trash-fail")) throw new Error("The Trash is not available.");
      await fs.remove(p);
    };
  }
  const switchTo = (root: string) => {
    if (root.startsWith("memory://folders/")) {
      if (!folders.has(root)) folders.set(root, new MemoryFileSystem(mockFolderSeed(root)));
      fs.target = folders.get(root)!;
    } else if (root === "memory://practice-project") fs.target = practice;
    return { name: root.split("/").pop() || root, root };
  };
  const exam: ExamHost = {
    dev: true,
    async device() {
      let id = localStorage.getItem("tmcode:device-id");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("tmcode:device-id", id);
      }
      return { id, os: detectOs(), os_version: navigator.userAgent.slice(0, 60), arch: "web", app_version: "0.1.0-web" };
    },
    async openExamWorkspace(submissionId, title) {
      if (!exams.has(submissionId)) exams.set(submissionId, new MemoryFileSystem({}));
      fs.target = exams.get(submissionId)!;
      return { name: title, root: `memory://exam-${submissionId}` };
    },
    journal: new LocalStorageJournal(),
    fetch: (url, init) => fetch(url, init),
    async toolchains() {
      return [{ tool: "node", version: "browser sandbox" }];
    },
  };
  return {
    kind: "web",
    os: detectOs(),
    version: "0.1.0-web",
    async openFolder() {
      fs.target = practice;
      return { name: "practice-project", root: "memory://practice-project" };
    },
    async reopenFolder(root) {
      return switchTo(root);
    },
    fs,
    store: new LocalStorageStore("tmcode:"),
    runner: noToolsForE2e(createJsWorkerRunner(fs)),
    // Dev server / e2e only (`?terminal=sim`): a pretend shell for the Run hub's dev-server flow.
    ...(import.meta.env?.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("terminal") === "sim"
      ? { terminal: createSimulatedTerminal(fs) }
      : {}),
    // Dev server / e2e: a simulated Python debugger so Run and Debug can be exercised without processes.
    ...(import.meta.env?.DEV ? { debug: createSimulatedDebugHost((p) => fs.readFile(p)) } : {}),
    exam,
    extensions: createMemoryExtensionHost(),
    http: createMemoryHttp(),
    // Dev server / e2e: a pretend pytest for the Testing view's framework suites.
    ...(import.meta.env?.DEV ? { proc: createSimulatedProc(fs) } : {}),
    // Dev server / e2e only: an NGA account and Task Mentor projects in memory.
    ...(import.meta.env?.DEV ? {
          account: createMemoryAccountHost(fs, {
            async newFolder(name) {
              let root = `memory://folders/${name}`;
              for (let i = 2; folders.has(root); i++) root = `memory://folders/${name}-${i}`;
              folders.set(root, new MemoryFileSystem({}));
              return root;
            },
          }),
        } : {}),
    // Dev server / e2e only: a mock git over this file system (`?git=none`: no repository yet).
    ...(import.meta.env?.DEV
      ? { git: createMemoryGit(fs, seed, { repo: typeof location === "undefined" || new URLSearchParams(location.search).get("git") !== "none" }) }
      : {}),
    // Dev server / e2e only: a scripted updater (localStorage "tmcode:mock-update" = UpdateInfo JSON).
    ...(import.meta.env?.DEV
      ? {
          updater: {
            async check() {
              const raw = localStorage.getItem("tmcode:mock-update");
              return raw ? JSON.parse(raw) : null;
            },
            async install(onProgress: (p: import("./types").UpdateProgress) => void) {
              onProgress({ type: "started", total: 100 });
              for (let d = 25; d <= 100; d += 25) {
                await new Promise((r) => setTimeout(r, 50));
                onProgress({ type: "chunk", downloaded: d, total: 100 });
              }
              onProgress({ type: "installing" });
              localStorage.setItem("tmcode:mock-installed", localStorage.getItem("tmcode:mock-update") ?? "");
            },
          },
        }
      : {}),
    watch(onChange) {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
  };
}
