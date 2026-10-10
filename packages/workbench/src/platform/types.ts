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
  /** Copies a file or folder (recursively, binary-safe). */
  copy?(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Moves a file or folder to the OS Trash / Recycle Bin; absent where there is none (Delete is then permanent). */
  trash?(path: string): Promise<void>;
  /** Binary files (images) as base64; absent where unsupported. */
  readBase64?(path: string): Promise<string>;
  // ── encodings and imports (feat/files-search) ──
  /** The encoding a file is read and saved with ("utf8", "utf8bom", "utf16le", "utf16be", "windows1252", "iso88591"). */
  encodingOf?(path: string): Promise<FileEncoding>;
  /** Reads the file again with this encoding; later saves use it too. */
  reopenWithEncoding?(path: string, encoding: FileEncoding): Promise<string>;
  /** Saves of this file use this encoding from now on (Save with Encoding). */
  setEncoding?(path: string, encoding: FileEncoding): Promise<void>;
  /**
   * Copies files and folders from outside the workspace (absolute paths dropped
   * from Finder / File Explorer) into folder `dest`. Without `overwrite`, nothing
   * is copied when a name is taken: the taken names come back in `conflicts`.
   */
  importPaths?(sources: string[], dest: string, overwrite: boolean): Promise<{ imported: string[]; conflicts: string[] }>;
}

export type FileEncoding = "utf8" | "utf8bom" | "utf16le" | "utf16be" | "windows1252" | "iso88591";

/** Files dragged over / dropped on the window from the OS, in CSS pixels. */
export interface FileDropEvent {
  type: "over" | "drop" | "leave";
  paths: string[];
  x: number;
  y: number;
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
  /** The system clipboard as text (the terminal's selection is not a DOM selection WebKit can copy). */
  clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
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
  /** The API Tester's transport (desktop: Rust, no CORS). */
  http?: HttpHost;
  /** One-shot commands with captured output (the Testing view's framework runs); absent → none. */
  proc?: ProcHost;
  /** Origin of extension webviews (desktop: tmwebview://, webview.rs); without it they use srcdoc with resources inlined. */
  webviews?: WebviewHost;
  /** Sets the native window background/appearance so resize flashes match the theme. */
  setNativeTheme?(theme: "dark" | "light"): void;
  /** Whole-window zoom (1 = 100 %); absent → the workbench zooms with CSS. */
  setZoom?(factor: number): void;
  /** Files dragged in from Finder / File Explorer (desktop). Returns an unsubscribe. */
  onFileDrop?(cb: (e: FileDropEvent) => void): () => void;
  // ── extensions (feat/extensions) ──
  /** VS Code extensions from Open VSX (declarative contributions only). */
  extensions?: ExtensionHost;
  // ── end extensions ──
  /** Git & GitHub (desktop: the system git; dev browser build: a mock). Absent → no Source Control. */
  git?: GitHost;
  /** NGA account (MIS + Task Mentor) and Task Mentor projects; absent → no Projects view. */
  account?: AccountHost;
  /** Run and Debug (Debug Adapter Protocol); absent where nothing can be debugged. */
  debug?: DebugHost;
}

// ───────────── extensions ─────────────

/** An unpacked extension in the app data folder. */
export interface StoredExtension {
  /** "publisher.name", lower-cased. */
  id: string;
  version: string;
  /** extension/package.json as text. */
  manifest: string;
  /** extension/package.nls.json, when present (localised labels). */
  nls?: string;
}

export interface ExtensionHost {
  /** GET from the Open VSX registry (https://open-vsx.org/ only): text, or base64 for images. */
  fetch(url: string, as: "text" | "base64"): Promise<string>;
  list(): Promise<StoredExtension[]>;
  /** Downloads a .vsix from Open VSX, unpacks its `extension/` folder and stores it (replacing an older version). */
  install(id: string, downloadUrl: string): Promise<StoredExtension>;
  /** Desktop: "Install from VSIX…" — a native file dialog, then the package's own id (null when cancelled). */
  installVsix?(): Promise<StoredExtension | null>;
  uninstall(id: string): Promise<void>;
  /** A file of an installed extension (path relative to its root): text, or base64 for images and fonts. */
  readFile(id: string, path: string, as: "text" | "base64"): Promise<string>;
  // ── extension host (feat/exthost) ──
  /** Desktop: runs extensions' code in Node.js (src-tauri/src/exthost.rs). Absent in the browser build (Web Worker host only). */
  startNodeHost?(onEvent: (e: ExtHostTransportEvent) => void): Promise<ExtHostProcess>;
  /** Exams switch the extension host off on the native side too. */
  setHostPolicy?(allowed: boolean): void;
  /** `ExtensionContext.secrets` (desktop: the OS keychain). */
  secrets?(op: "get" | "store" | "delete" | "keys", extension: string, key?: string, value?: string): Promise<unknown>;
  // ── end extension host ──
}

/** From the Node extension host: one JSON-RPC message (text), its stderr, or its exit. */
export type ExtHostTransportEvent = { type: "message"; message: string } | { type: "stderr"; data: string } | { type: "exit"; code: number | null };

export interface ExtHostProcess {
  /** Absolute folder holding installed extensions (`<dir>/<publisher.name>`). */
  extensionsDir: string;
  /** Absolute folder for extension storage. */
  storageDir: string;
  node: string;
  nodeVersion: string;
  send(message: string): void;
  stop(): void;
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
export type DebugAdapterKind = "python" | "node" | "native" | "java" | "go" | "dart" | "flutter" | "ruby" | "dotnet" | "php";
/** Debugger parts TMCode installs on request: debugpy (pip), js-debug and netcoredbg (pinned downloads). */
export type DebugComponent = "debugpy" | "js-debug" | "netcoredbg" | "php-debug";

export interface DebugProbe {
  available: boolean;
  /** What would make it available: a package to install or an adapter to download. */
  install: DebugComponent | null;
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
  install?(what: DebugComponent, onEvent: (e: DebugInstallEvent) => void): Promise<void>;
  /** Resolves the program and runs the profile's build steps (output streamed like a run). */
  prepare(request: { entry: string; build: RunStep[]; run: RunStep }, onEvent: (e: RunEvent) => void): Promise<DebugPrepared>;
  /** Starts an adapter, or with `parent` opens a child session (js-debug `startDebugging`). */
  /** `target`: the program and its arguments, for adapters that run it themselves (rdbg). */
  start(kind: DebugAdapterKind, opts: { parent?: number; target?: string[] }, onEvent: (e: DebugTransportEvent) => void): Promise<DebugConnection>;
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

// ───────────── extension webviews ─────────────

export interface WebviewHost {
  /** Origin of pages and resources ("tmwebview://localhost"); asWebviewUri builds `<base>/<handle>/file/<path>`. */
  base: string;
  /** `webview.cspSource`. */
  cspSource: string;
  /** Serves one webview's page; its `file/` resources come only from `roots` (absolute folders). Returns the page URL. */
  publish(handle: string, html: string, roots: string[]): Promise<string>;
  dispose(handle: string): void;
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

// ───────────── NGA account + Task Mentor projects (docs/PROJECTS_PLAN.md) ─────────────

export interface AccountUser {
  id: number;
  mis_user_id?: number | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  avatar_url?: string | null;
  permissions: string[];
}

export interface AccountStatus {
  signed_in: boolean;
  user: AccountUser | null;
  tm_api: string;
  phase: "idle" | "waiting" | "completing";
  error: string | null;
  /** While waiting: the browser sign-in page (Open the Browser Again, Copy Sign-in Link). */
  signin_url?: string | null;
  /** Signed in, but the session couldn't be saved to the system keychain (signed out at the next start). */
  keychain_error?: string | null;
}

export interface TmRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Must start with /api/tmcode/. */
  path: string;
  json?: unknown;
  /** Raw body (blob uploads), base64. */
  body_base64?: string;
  content_type?: string;
  /** "base64": the body comes back as { base64 } (blob downloads). */
  response?: "json" | "base64";
}

export interface TmResponse<T = unknown> {
  status: number;
  body: T;
}

export interface ScannedFile {
  path: string;
  sha256: string;
  size: number;
}

/** Left out of a save/hand-in, and why (projects.rs `SkippedFile`). */
export interface SkippedFile {
  path: string;
  reason: "folder" | "ignored" | "too-large" | "file-limit" | "size-limit" | "long-path" | "link" | "unreadable";
  /** A whole folder (nothing under it is listed). */
  dir: boolean;
  size: number | null;
}

export interface ProjectScan {
  files: ScannedFile[];
  truncated: string | null;
  total_bytes: number;
  /** What was left out (older desktop builds don't say). At most 1000 listed. */
  skipped?: SkippedFile[];
  /** All left-out entries, listed or not. */
  skipped_count?: number;
}

export interface AccountHost {
  status(refresh?: boolean): Promise<AccountStatus>;
  /** Opens the browser; the result arrives through onChange. */
  signIn(): Promise<void>;
  cancel(): Promise<void>;
  /** Opens the waiting sign-in page in the browser again. */
  reopenBrowser?(): Promise<void>;
  signOut(): Promise<void>;
  onChange(cb: (s: AccountStatus) => void): () => void;
  /** Authenticated Task Mentor request (/api/tmcode/… only). */
  request<T = unknown>(req: TmRequest): Promise<TmResponse<T>>;
  /** The open folder's files as git sees them (sha256 + size). */
  scan(limits?: { maxFiles?: number; maxFileMb?: number; maxTotalMb?: number }): Promise<ProjectScan>;
  /** [sha256, gzip+base64] of a workspace file. */
  readBlob(path: string): Promise<[string, string]>;
  /** Writes a downloaded gzip+base64 blob after checking its sha256. */
  writeBlob(path: string, sha256: string, gzBase64: string): Promise<void>;
  /** A new empty folder for a local copy (default ~/TMCode Projects/<slug>). Absolute path. */
  newFolder(slug: string, base?: string): Promise<string>;
  /** The next git clone goes into ~/TMCode Projects (instead of a picked folder). */
  useProjectsFolderForClone?(): Promise<string>;
}

export interface ApiRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string | null;
}

export interface ApiResponse {
  status: number;
  status_text: string;
  headers: [string, string][];
  /** Text, or base64 when `binary`. */
  body: string;
  binary: boolean;
  size: number;
  truncated: boolean;
  ms: number;
}

export interface HttpHost {
  request(req: ApiRequest): Promise<ApiResponse>;
}

// ───────────── one-shot commands ─────────────

export type ProcEvent = { type: "stdout"; data: string } | { type: "stderr"; data: string } | { type: "exit"; code: number | null };

export interface ProcHost {
  /** Runs `command` in the login shell, in `cwd` (workspace-relative); returns an id for `kill`. */
  run(command: string, cwd: string, onEvent: (e: ProcEvent) => void): Promise<number>;
  kill(id: number): Promise<void>;
}
