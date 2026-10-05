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
}

export interface TerminalSession {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface TerminalSpawnOptions {
  cols: number;
  rows: number;
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
