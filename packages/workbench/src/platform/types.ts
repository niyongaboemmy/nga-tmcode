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
  /** Sets the native window background/appearance so resize flashes match the theme. */
  setNativeTheme?(theme: "dark" | "light"): void;
}
