import { createJsWorkerRunner } from "./jsWorkerRunner";
import { createMemoryExtensionHost } from "./memoryExtensions";
import { createMemoryGit } from "./memoryGit";
import { createMemoryAccountHost } from "./memoryProjects";
import { createSimulatedDebugHost } from "../debug/fakeAdapter";
import type { DirEntry, ExamHost, FileSystem, JournalEntry, JournalStore, KeyValueStore, OsKind, Platform } from "./types";

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
  remove(p: string) {
    return this.target.remove(p);
  }
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

export function createMemoryPlatform(seed: Record<string, string> = DEMO_PROJECT): Platform {
  const practice = new MemoryFileSystem(seed);
  const fs = new SwitchableFileSystem(practice);
  const exams = new Map<number, MemoryFileSystem>();
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
      return { name: root.split("/").pop() || root, root };
    },
    fs,
    store: new LocalStorageStore("tmcode:"),
    runner: createJsWorkerRunner(fs),
    // Dev server / e2e: a simulated Python debugger so Run and Debug can be exercised without processes.
    ...(import.meta.env?.DEV ? { debug: createSimulatedDebugHost((p) => fs.readFile(p)) } : {}),
    exam,
    extensions: createMemoryExtensionHost(),
    // Dev server / e2e only: an NGA account and Task Mentor projects in memory.
    ...(import.meta.env?.DEV ? { account: createMemoryAccountHost(fs) } : {}),
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
