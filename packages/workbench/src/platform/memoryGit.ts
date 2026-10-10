import type { FileSystem, GitBranch, GitCommit, GitEntry, GitEvent, GitHost, GitHubRepo, GitStatus, GitTask } from "./types";

/**
 * A tiny in-memory git for the browser build (dev server and Playwright only):
 * HEAD and the index are snapshots of the file system, so editing, staging and
 * committing in the UI behave like the real thing. Remote operations fake
 * git's progress lines. Options: `?git=none` starts without a repository.
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function walk(fs: FileSystem, dir = "", out = new Map<string, string>()) {
  for (const e of await fs.readDir(dir)) {
    if (e.kind === "dir") await walk(fs, e.path, out);
    else out.set(e.path, await fs.readFile(e.path));
  }
  return out;
}

/** Makes the demo project start with a few changes to look at. */
function initialHead(seed: Record<string, string>): Map<string, string> {
  const head = new Map(Object.entries(seed));
  if (head.has("main.py")) head.set("main.py", head.get("main.py")!.replace("    if average >= 60:\n        return \"C\"\n", ""));
  if (head.has("README.md")) head.set("README.md", "# Practice project\n");
  head.delete("src/utils.ts");
  head.set("notes/todo.txt", "- finish the grade calculator\n");
  return head;
}

export function createMemoryGit(fs: FileSystem, seed: Record<string, string>, opts: { repo?: boolean } = {}): GitHost {
  const logs = new Set<(line: string) => void>();
  const changes = new Set<() => void>();
  const log = (line: string) => logs.forEach((l) => l(line));
  let repo = opts.repo ?? true;
  let head = repo ? initialHead(seed) : new Map<string, string>();
  // README.md is staged: the index already has the working copy.
  let index = new Map(head);
  if (seed["README.md"] !== undefined) index.set("README.md", seed["README.md"]);
  let current = "main";
  let upstream: string | null = "origin/main";
  let ahead = repo ? 1 : 0;
  let behind = 0;
  const branches = new Set(["main", "feature/login"]);
  const remoteBranches = new Set(["origin/main", "origin/feature/login"]);
  let commits: GitCommit[] = repo
    ? [
        { hash: "b".repeat(40), short: "bbbbbbb", author: "Ada", email: "ada@example.com", date: 1759500000, refs: "HEAD -> main", subject: "Add letter grades" },
        { hash: "a".repeat(40), short: "aaaaaaa", author: "Ada", email: "ada@example.com", date: 1759400000, refs: "origin/main", subject: "Initial commit" },
      ]
    : [];
  const stashes: { index: Map<string, string>; files: Map<string, string> }[] = [];
  // Each commit's files, for the Timeline (showAt / fileLog).
  const snapshots = new Map<string, Map<string, string>>();
  if (repo) {
    snapshots.set("b".repeat(40), new Map(head));
    const first = new Map(head);
    if (first.has("main.py")) first.set("main.py", first.get("main.py")!.replace('    if average >= 80:\n        return "A"\n', ""));
    snapshots.set("a".repeat(40), first);
  }

  const run = async <T>(cmd: string, fn: () => Promise<T> | T): Promise<T> => {
    log(`> git ${cmd}`);
    const t = performance.now();
    try {
      return await fn();
    } catch (e) {
      log(String((e as Error)?.message ?? e));
      throw e;
    } finally {
      log(`${Math.round(performance.now() - t)} ms`);
    }
  };
  const need = () => {
    if (!repo) throw new Error("fatal: not a git repository (or any of the parent directories): .git");
  };
  const changed = () => changes.forEach((c) => c());

  async function status(): Promise<GitStatus | null> {
    if (!repo) return null;
    const work = await walk(fs);
    const paths = [...new Set([...head.keys(), ...index.keys(), ...work.keys()])].sort();
    const entries: GitEntry[] = [];
    for (const p of paths) {
      const h = head.get(p);
      const i = index.get(p);
      const w = work.get(p);
      if (h === undefined && i === undefined) {
        if (w !== undefined) entries.push({ path: p, x: "?", y: "?", kind: "untracked" });
        continue;
      }
      const x = h === i ? "." : h === undefined ? "A" : i === undefined ? "D" : "M";
      const y = i === undefined ? "." : w === undefined ? "D" : w === i ? "." : "M";
      if (x === "." && y === ".") continue;
      entries.push({ path: p, x, y, kind: "changed" });
      // A file deleted from the index but present on disk is also untracked.
      if (i === undefined && w !== undefined) entries.push({ path: p, x: "?", y: "?", kind: "untracked" });
    }
    return {
      branch: current,
      oid: commits[0]?.hash ?? null,
      upstream,
      ahead,
      behind,
      entries,
      truncated: false,
      root: "memory://practice-project",
      prefix: "",
      remotes: ["origin"],
      merging: false,
    };
  }

  function fakeNetwork<T>(cmd: string, steps: string[], onEvent: (e: GitEvent) => void, finish: () => T): GitTask<T> {
    let cancelled = false;
    const done = run(cmd, async () => {
      for (const step of steps) {
        onEvent({ type: "step", name: step });
        for (let pct = 0; pct <= 100; pct += 20) {
          await delay(40);
          if (cancelled) throw new Error("Cancelled");
          onEvent({ type: "progress", line: `Receiving objects: ${String(pct).padStart(3)}% (${pct / 10}/10)` });
        }
      }
      const r = finish();
      changed();
      return r;
    });
    return { done, cancel: () => (cancelled = true) };
  }

  const host: GitHost = {
    info: async () => ({ installed: true, version: "2.50.1 (mock)", path: "/usr/bin/git" }),
    status: () => status(),
    async show(path, rev) {
      need();
      const v = (rev === "HEAD" ? head : index).get(path);
      return v ?? null;
    },
    async showAt(path, commit) {
      need();
      const c = commits.find((x) => x.hash.startsWith(commit));
      return (c && snapshots.get(c.hash)?.get(path)) ?? null;
    },
    async fileLog(path, limit) {
      if (!repo) return [];
      // Commits where the file differs from the commit before (or first appears).
      return commits
        .filter((c, i) => {
          const now = snapshots.get(c.hash)?.get(path);
          const before = commits[i + 1] ? snapshots.get(commits[i + 1].hash)?.get(path) : undefined;
          return now !== undefined && now !== before;
        })
        .slice(0, limit);
    },
    stageContent: (path, content) =>
      run(`update-index --add --cacheinfo 100644,<blob>,${path}`, () => {
        need();
        index.set(path, content);
        changed();
      }),
    stage: (paths) =>
      run(`add -A -- ${paths.join(" ")}`, async () => {
        need();
        const work = await walk(fs);
        for (const p of paths) {
          const w = work.get(p);
          if (w === undefined) index.delete(p);
          else index.set(p, w);
        }
        changed();
      }),
    unstage: (paths) =>
      run(`restore --staged -- ${paths.join(" ")}`, () => {
        need();
        for (const p of paths) {
          const h = head.get(p);
          if (h === undefined) index.delete(p);
          else index.set(p, h);
        }
        changed();
      }),
    discard: (tracked, untracked) =>
      run(`restore --worktree -- ${[...tracked, ...untracked].join(" ")}`, async () => {
        need();
        for (const p of tracked) {
          const i = index.get(p);
          if (i === undefined) continue;
          await fs.writeFile(p, i).catch(async () => {
            // Deleted on disk: recreate the folders on the way.
            const parts = p.split("/");
            for (let k = 1; k < parts.length; k++) await fs.createDir(parts.slice(0, k).join("/")).catch(() => {});
            await fs.writeFile(p, i);
          });
        }
        for (const p of untracked) await fs.remove(p).catch(() => {});
        changed();
      }),
    commit: ({ message, amend, all }) =>
      run(`commit --quiet --cleanup=strip${amend ? " --amend" : ""} -F -`, async () => {
        need();
        if (all) {
          const work = await walk(fs);
          index = new Map(work);
        }
        const same = head.size === index.size && [...index].every(([k, v]) => head.get(k) === v);
        if (same && !amend) throw new Error("nothing to commit, working tree clean");
        if (!message.trim() && !amend) throw new Error("Aborting commit due to empty commit message.");
        head = new Map(index);
        const hash = Math.random().toString(16).slice(2).padEnd(40, "0").slice(0, 40);
        snapshots.set(hash, new Map(head));
        const c: GitCommit = { hash, short: hash.slice(0, 7), author: "You", email: "you@example.com", date: Math.floor(Date.now() / 1000), refs: `HEAD -> ${current}`, subject: message.trim().split("\n")[0] || commits[0]?.subject || "" };
        commits = amend ? [c, ...commits.slice(1)] : [c, ...commits.map((x) => ({ ...x, refs: x.refs.replace(`HEAD -> ${current}`, "").replace(/^, /, "") }))];
        if (!amend) ahead++;
        changed();
      }),
    branches: () =>
      run("for-each-ref refs/heads refs/remotes", (): GitBranch[] => {
        need();
        return [
          ...[...branches].map((name) => ({ name, kind: "local" as const, current: name === current, commit: "bbbbbbb", upstream: name === current ? upstream : null, subject: "Add letter grades", date: 1759500000 })),
          ...[...remoteBranches].map((name) => ({ name, kind: "remote" as const, current: false, commit: "aaaaaaa", upstream: null, subject: "Initial commit", date: 1759400000 })),
        ];
      }),
    checkout: (name, o = {}) =>
      run(`checkout -q ${o.create ? "-b " : o.remote ? "--track " : ""}${name}`, () => {
        need();
        if (o.create) {
          if (branches.has(name)) throw new Error(`fatal: a branch named '${name}' already exists`);
          branches.add(name);
          current = name;
          upstream = null;
          ahead = 0;
          behind = 0;
        } else if (o.remote) {
          const local = name.replace(/^[^/]+\//, "");
          branches.add(local);
          current = local;
          upstream = name;
          ahead = 0;
        } else {
          if (!branches.has(name)) throw new Error(`error: pathspec '${name}' did not match any file(s) known to git`);
          current = name;
          upstream = remoteBranches.has(`origin/${name}`) ? `origin/${name}` : null;
          ahead = 0;
        }
        changed();
      }),
    log: async (limit) => (repo ? commits.slice(0, limit) : []),
    init: () =>
      run("init -q", () => {
        repo = true;
        head = new Map();
        index = new Map();
        commits = [];
        upstream = null;
        ahead = 0;
        changed();
      }),
    stash: (action) =>
      run(`stash ${action}`, async () => {
        need();
        if (action === "push") {
          const work = await walk(fs);
          stashes.push({ index: new Map(index), files: work });
          for (const [p] of work) if (!head.has(p)) await fs.remove(p).catch(() => {});
          for (const [p, c] of head) await fs.writeFile(p, c).catch(() => {});
          index = new Map(head);
        } else {
          const s = stashes.pop();
          if (!s) throw new Error("No stash entries found.");
          for (const [p, c] of s.files) await fs.writeFile(p, c).catch(() => {});
          index = s.index;
        }
        changed();
      }),
    checkIgnore: async (paths) => paths.filter((p) => /(^|\/)(node_modules|dist|__pycache__)(\/|$)/.test(p)),
    setIdentity: async () => {},
    remote(op, options, onEvent) {
      const steps = op === "sync" ? ["Pulling", "Pushing"] : [op === "pull" ? "Pulling" : op === "push" ? "Pushing" : "Fetching"];
      return fakeNetwork(`${op} --progress${options.set_upstream ? ` -u origin ${options.branch}` : ""}`, steps, onEvent, () => {
        if (op === "push" || op === "sync") {
          if (options.set_upstream && options.branch) {
            upstream = `origin/${options.branch}`;
            remoteBranches.add(upstream);
          }
          if (!upstream) throw new Error(`fatal: The current branch ${current} has no upstream branch.`);
          ahead = 0;
        }
        if (op === "pull" || op === "sync") behind = 0;
      });
    },
    pickCloneParent: async () => "memory://clones",
    clone: (url, onEvent) => fakeNetwork(`clone --progress -- ${url}`, ["Cloning"], onEvent, () => `memory://clones/${url.split("/").pop()?.replace(/\.git$/, "")}`),
    onLog(cb) {
      logs.add(cb);
      return () => logs.delete(cb);
    },
    onRepoChange(cb) {
      changes.add(cb);
      return () => changes.delete(cb);
    },
    openExternal: (url) => void window.open(url, "_blank", "noopener"),
    github: (() => {
      let user: { login: string; name: string; avatar: null } | null = null;
      return {
        async signIn(token: string) {
          await delay(150);
          if (token.trim().length < 20) throw new Error("That doesn't look like a GitHub personal access token.");
          if (token.includes("bad")) throw new Error("GitHub did not accept this token. Check that it is correct and has not expired.");
          user = { login: "octocat", name: "The Octocat", avatar: null };
          return user;
        },
        user: async () => user,
        signOut: async () => {
          user = null;
        },
        async repos(): Promise<GitHubRepo[]> {
          await delay(500);
          if (!user) throw new Error("Sign in to GitHub first.");
          const names = ["Hello-World", "Spoon-Knife", "linguist", "octocat.github.io", "git-consortium", "hello-worId", "test-repo1", "boysenberry-repo-1"];
          return names.map((n, i) => ({ full_name: `octocat/${n}`, description: i % 2 ? null : `The ${n} repository`, clone_url: `https://github.com/octocat/${n}.git`, private: i === 6, updated_at: null }));
        },
      };
    })(),
  };
  return host;
}
