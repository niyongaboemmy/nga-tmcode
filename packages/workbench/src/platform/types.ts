/**
 * Everything the workbench needs from the host. The desktop app implements it
 * over Tauri commands; the browser build (dev, tests, TMCode Web) implements it
 * in memory. The workbench never talks to Tauri directly.
 */

export type OsKind = "mac" | "windows" | "linux";

export interface DirEntry {
  name: string;
  /** Workspace-relative path using "/" separators, no leading slash. */
  path: string;
  kind: "file" | "dir";
}

export interface FileSystem {
  readDir(path: string): Promise<DirEntry[]>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Binary files (images) as base64; absent where unsupported. */
  readBase64?(path: string): Promise<string>;
}

export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalSpawnOptions {
  cols: number;
  rows: number;
  /** Workspace-relative working directory (default: the workspace root). */
  cwd?: string;
  onData(data: string): void;
  onExit(code: number | null): void;
}

export interface WindowControls {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
}

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

export interface Platform {
  kind: "desktop" | "web";
  os: OsKind;
  /** App version shown in About and the status bar tooltip. */
  version: string;
  /** Opens a workspace and returns its display name, or null if cancelled. */
  openFolder(): Promise<{ name: string; root: string } | null>;
  /** Re-opens a folder chosen before (recent list). */
  reopenFolder(root: string): Promise<{ name: string; root: string } | null>;
  /** Picks a file; its folder becomes the workspace and `file` is the file inside it. */
  openFile?(): Promise<{ name: string; root: string; file?: string } | null>;
  /** Opens a folder or file given by absolute path (command line, Open With). */
  openPath?(path: string): Promise<{ name: string; root: string; file?: string }>;
  /** Shows a workspace path in Finder / File Explorer. */
  reveal?(path: string): Promise<void>;
  /** Changes made outside TMCode (workspace-relative paths). Returns an unsubscribe. */
  watch?(onChange: (paths: string[]) => void): () => void;
  /** Signed in-app updates (desktop). */
  updater?: Updater;
  /** Opens a URL in the system browser. */
  openExternal?(url: string): Promise<void>;
  /** Sets the OS window title. */
  setTitle?(title: string): void;
  fs: FileSystem;
  /** Absent where a shell is impossible (web) or forbidden by policy. */
  terminal?: { spawn(opts: TerminalSpawnOptions): Promise<TerminalSession> };
  /** Absent in the browser, where the page has no window chrome to drive. */
  window?: WindowControls;
  store: KeyValueStore;
  /** Runs student code; absent where nothing can run (then the run fallbacks apply). */
  runner?: Runner;
  /** Exams from Task Mentor; absent where they can't be taken. */
  exam?: ExamHost;
  /** Desktop preview origin; without it previews are composed into an iframe srcdoc. */
  preview?: PreviewHost;
  /** Sets the native window background/appearance so resize flashes match the theme. */
  setNativeTheme?(theme: "dark" | "light"): void;
  /** Git & GitHub (desktop: the system git; dev browser build: a mock). Absent → no Source Control. */
  git?: GitHost;
  /** Run and Debug (Debug Adapter Protocol); absent where nothing can be debugged. */
  debug?: DebugHost;
}

// ───────────── running code (plan §8) ─────────────

export interface Toolchain {
  tool: string;
  path: string;
  version: string;
}

export interface RunStep {
  tool: string;
  args: string[];
}

export interface RunRequest {
  /** Workspace-relative entry file. */
  entry: string;
  build: RunStep[];
  run: RunStep;
  /** "pty": interactive console; "pipe": tests (stdin fed in full). */
  mode: "pty" | "pipe";
  stdin?: string;
  timeout_ms?: number;
  output_limit_kb?: number;
  cols?: number;
  rows?: number;
  /** "Run with Arguments…": appended to the run step. */
  args?: string[];
}

export type RunEvent =
  | { type: "step"; phase: "build" | "run"; command: string }
  | { type: "stdout"; data: string }
  | { type: "stderr"; data: string }
  | {
      type: "exit";
      phase: "build" | "run";
      code: number | null;
      timed_out: boolean;
      truncated: boolean;
      killed: boolean;
      duration_ms: number;
    }
  | { type: "error"; message: string };

export interface RunHandle {
  input(data: string): void;
  resize?(cols: number, rows: number): void;
  kill(): void;
}

export interface Runner {
  /** Interactive (pty) runs are only possible on the desktop. */
  interactive: boolean;
  detect(refresh?: boolean): Promise<Toolchain[]>;
  start(request: RunRequest, onEvent: (e: RunEvent) => void): Promise<RunHandle>;
  /** Every usable copy of a tool ("Select Interpreter"). */
  candidates?(tool: string): Promise<Toolchain[]>;
  /** Uses one of `candidates(tool)` from now on. */
  select?(tool: string, path: string): Promise<Toolchain>;
}

// ───────────── Run and Debug (Debug Adapter Protocol) ─────────────

/** "native" = C/C++ (lldb-dap or GDB). */
export type DebugAdapterKind = "python" | "node" | "native" | "java";

export interface DebugProbe {
  available: boolean;
  /** What would make it available: a package to install or an adapter to download. */
  install: "debugpy" | "js-debug" | null;
  detail: string | null;
  message: string | null;
}

export type DebugInstallEvent = { type: "output"; data: string } | { type: "progress"; downloaded: number; total: number | null };

export interface DebugPrepared {
  /** Workspace root as the adapter sees paths (absolute on the desktop). */
  root: string;
  entry: string;
  cwd: string;
  /** The profile's run step resolved: interpreter (python/node) or the built binary. */
  program: string;
  args: string[];
}

/** From the adapter: one DAP message as JSON text, adapter diagnostics, or the end of the connection. */
export type DebugTransportEvent = { type: "message"; message: string } | { type: "stderr"; data: string } | { type: "exit"; code: number | null };

export interface DebugConnection {
  id: number;
  /** Sends one DAP message (JSON text). */
  send(message: string): void;
  /** Closes the connection; for a root adapter, kills its process tree. */
  stop(): void;
}

export interface DebugHost {
  /** Short note shown in the Run and Debug view (e.g. that the browser debugger is simulated). */
  note?: string;
  /** Languages this host can debug at all (decides whether F5 debugs or runs). */
  kinds: DebugAdapterKind[];
  probe(kind: DebugAdapterKind): Promise<DebugProbe>;
  install?(what: "debugpy" | "js-debug", onEvent: (e: DebugInstallEvent) => void): Promise<void>;
  /** Resolves the program and runs the profile's build steps (output streamed like a run). */
  prepare(request: { entry: string; build: RunStep[]; run: RunStep }, onEvent: (e: RunEvent) => void): Promise<DebugPrepared>;
  /** Starts an adapter, or with `parent` opens a child session (js-debug `startDebugging`). */
  start(kind: DebugAdapterKind, opts: { parent?: number }, onEvent: (e: DebugTransportEvent) => void): Promise<DebugConnection>;
  /** The exam policy's `debugger` flag, so the host can refuse adapters in exam folders unless it is on. */
  setExamPolicy?(allowed: boolean): void;
  /** DAP `runInTerminal`: the debuggee runs in the Run console (so it can read input). */
  runInTerminal?(request: { args: string[]; cwd?: string; env?: Record<string, string | null>; cols?: number; rows?: number }, onEvent: (e: RunEvent) => void): Promise<RunHandle>;
}

// ───────────── web preview (plan §9) ─────────────

export interface PreviewHost {
  /**
   * Serves `root` (a workspace folder) at a sandboxed preview origin, with
   * `overlay` files (generated HTML, bundles, unsaved edits) taking priority.
   * Returns the URL of `entry`.
   */
  publish(root: string, entry: string, overlay: Record<string, string>, opts: { internet: boolean }): Promise<string>;
}

// ───────────── exams (plan §10, §13) ─────────────

export interface JournalEntry {
  seq: number;
  question_id: number;
  kind: "auto" | "run" | "final" | "offline_final";
  client_ts: string;
  files: { path: string; content: string }[];
  files_hash: string;
  hmac: string;
  synced: boolean;
}

/** Append-only, crash-safe local store of snapshots for one session. */
export interface JournalStore {
  load(sessionId: string): Promise<JournalEntry[]>;
  append(sessionId: string, entry: JournalEntry): Promise<void>;
  markSynced(sessionId: string, seq: number): Promise<void>;
}

export interface ExamHost {
  /** Debug builds and the browser build accept a localhost Task Mentor. */
  dev: boolean;
  device(): Promise<{ id: string; os: string; os_version: string; arch: string; app_version: string }>;
  /** Creates (if needed) and opens the folder an exam's tasks live in. */
  openExamWorkspace(submissionId: number, title: string): Promise<{ name: string; root: string }>;
  journal: JournalStore;
  /** fetch() for Task Mentor (Rust-side on the desktop: no CORS, host allow-list). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Installed toolchains, reported to Task Mentor at session start. */
  toolchains(): Promise<{ tool: string; version: string }[]>;
}

// ───────────── updates ─────────────

export interface UpdateInfo {
  version: string;
  current_version: string;
  notes: string | null;
  date: string | null;
}

export type UpdateProgress = { type: "started"; total: number | null } | { type: "chunk"; downloaded: number; total: number | null } | { type: "installing" };

export interface Updater {
  check(): Promise<UpdateInfo | null>;
  /** Downloads, verifies the signature, installs and restarts the app. */
  install(onProgress: (p: UpdateProgress) => void): Promise<void>;
}

// ───────────── git & GitHub ─────────────

export interface GitInfo {
  installed: boolean;
  version: string | null;
  path: string | null;
}

export type GitEntryKind = "changed" | "renamed" | "copied" | "unmerged" | "untracked" | "ignored";

/** One `git status --porcelain=v2` entry; `x`/`y` are the index/worktree letters ("." = unchanged). */
export interface GitEntry {
  /** Workspace-relative. */
  path: string;
  orig_path?: string;
  x: string;
  y: string;
  kind: GitEntryKind;
}

export interface GitStatus {
  /** null when HEAD is detached. */
  branch: string | null;
  /** null on an unborn branch (no commits yet). */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitEntry[];
  truncated: boolean;
  /** Absolute repository root and the workspace's path inside it ("" or "sub/"). */
  root: string;
  prefix: string;
  remotes: string[];
  merging: boolean;
}

export interface GitBranch {
  name: string;
  kind: "local" | "remote";
  current: boolean;
  commit: string;
  upstream: string | null;
  subject: string;
  date: number;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: number;
  refs: string;
  subject: string;
}

export type GitEvent = { type: "step"; name: string } | { type: "progress"; line: string };

/** A long-running git operation (clone, pull, push…). */
export interface GitTask<T> {
  done: Promise<T>;
  cancel(): void;
}

export interface GitRemoteOptions {
  remote?: string;
  branch?: string;
  /** First push of a branch: `push -u <remote> <branch>`. */
  set_upstream?: boolean;
}

export interface GitHubUser {
  login: string;
  name?: string | null;
  /** data: URL (the desktop CSP allows no remote images). */
  avatar?: string | null;
}

export interface GitHubRepo {
  full_name: string;
  description?: string | null;
  clone_url: string;
  private: boolean;
  updated_at?: string | null;
}

export interface GitHost {
  info(refresh?: boolean): Promise<GitInfo>;
  /** null when the workspace is not inside a repository. */
  status(): Promise<GitStatus | null>;
  /** A file at HEAD or in the index; null when it doesn't exist there. */
  show(path: string, rev: "HEAD" | "index"): Promise<string | null>;
  stage(paths: string[]): Promise<void>;
  unstage(paths: string[]): Promise<void>;
  /** Tracked files return to their index version; untracked ones are deleted. */
  discard(tracked: string[], untracked: string[]): Promise<void>;
  commit(options: { message: string; amend?: boolean; signoff?: boolean; all?: boolean }): Promise<void>;
  branches(): Promise<GitBranch[]>;
  checkout(name: string, options?: { create?: boolean; from?: string; remote?: boolean }): Promise<void>;
  log(limit: number): Promise<GitCommit[]>;
  init(): Promise<void>;
  stash(action: "push" | "pop", message?: string): Promise<void>;
  /** Which of these workspace paths git ignores (folders end with "/"). */
  checkIgnore(paths: string[]): Promise<string[]>;
  setIdentity(name: string, email: string): Promise<void>;
  remote(op: "pull" | "push" | "fetch" | "sync", options: GitRemoteOptions, onEvent: (e: GitEvent) => void): GitTask<void>;
  /** "Select as Repository Destination"; the next clone goes there. */
  pickCloneParent(): Promise<string | null>;
  /** Clones into the picked folder; resolves to the new folder's path. */
  clone(url: string, onEvent: (e: GitEvent) => void): GitTask<string>;
  /** Every git command line and its errors (redacted), for the Git output channel. */
  onLog(cb: (line: string) => void): () => void;
  /** Repository state changed outside TMCode (commit in a terminal, fetch…). */
  onRepoChange?(cb: () => void): () => void;
  /** Opens a help / token page (an allow-listed https URL) in the browser. */
  openExternal?(url: string): void;
  github?: {
    signIn(token: string): Promise<GitHubUser>;
    user(): Promise<GitHubUser | null>;
    signOut(): Promise<void>;
    repos(): Promise<GitHubRepo[]>;
  };
}
