import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import type { DirEntry, JournalEntry, Platform, RunEvent, TerminalSession, Toolchain, UpdateInfo, UpdateProgress } from "@tmcode/workbench";

type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

/** The desktop platform: workbench calls → capability-gated Rust commands. */
export interface DevOptions {
  workspace: string | null;
  selftest: boolean;
  launch: string | null;
}
export let devOptions: DevOptions = { workspace: null, selftest: false, launch: null };
/** Folder or file passed on the command line (`tmcode ~/project`). */
export let launchPath: string | null = null;

export async function createTauriPlatform(): Promise<Platform> {
  const info = await invoke<{
    version: string;
    os: Platform["os"];
    dev_workspace: string | null;
    dev_selftest: boolean;
    dev_launch: string | null;
    open_path: string | null;
  }>("app_info");
  devOptions = { workspace: info.dev_workspace, selftest: info.dev_selftest, launch: info.dev_launch };
  // Command-line path, else the last path macOS asked us to open before we were listening.
  const queued = await invoke<string[]>("take_pending_open").catch(() => []);
  launchPath = info.open_path ?? queued[queued.length - 1] ?? null;
  const store = new LazyStore("settings.json", { defaults: {}, autoSave: 200 });
  const win = getCurrentWindow();

  return {
    kind: "desktop",
    os: info.os,
    version: info.version,
    async openFolder() {
      return invoke<{ name: string; root: string } | null>("ws_open");
    },
    async reopenFolder(root) {
      return invoke<{ name: string; root: string }>("ws_reopen", { root });
    },
    openFile: () => invoke("ws_open_file"),
    openPath: (path) => invoke("ws_open_path", { path }),
    reveal: (path) => invoke("ws_reveal", { path }),
    watch(onChange) {
      let un: (() => void) | null = null;
      let stopped = false;
      void listen<string[]>("fs-changed", (e) => onChange(e.payload)).then((u) => (stopped ? u() : (un = u)));
      return () => {
        stopped = true;
        un?.();
      };
    },
    setTitle: (title) => void win.setTitle(title).catch(() => {}),
    updater: {
      check: () => invoke<UpdateInfo | null>("update_check"),
      async install(onProgress) {
        const channel = new Channel<UpdateProgress>();
        channel.onmessage = onProgress;
        await invoke("update_install", { onProgress: channel });
      },
    },
    fs: {
      readDir: (path) => invoke<DirEntry[]>("ws_read_dir", { path }),
      readFile: (path) => invoke<string>("ws_read_file", { path }),
      writeFile: (path, content) => invoke("ws_write_file", { path, content }),
      createFile: (path) => invoke("ws_create_file", { path }),
      createDir: (path) => invoke("ws_create_dir", { path }),
      rename: (from, to) => invoke("ws_rename", { from, to }),
      remove: (path) => invoke("ws_remove", { path }),
    },
    terminal: {
      async spawn({ cols, rows, onData, onExit }): Promise<TerminalSession> {
        const channel = new Channel<PtyEvent>();
        channel.onmessage = (e) => (e.type === "data" ? onData(e.data) : onExit(e.code));
        const id = await invoke<number>("pty_spawn", { cols, rows, onEvent: channel });
        return {
          write: (data) => void invoke("pty_write", { id, data }).catch(() => {}),
          resize: (c, r) => void invoke("pty_resize", { id, cols: c, rows: r }).catch(() => {}),
          kill: () => void invoke("pty_kill", { id }).catch(() => {}),
        };
      },
    },
    runner: {
      interactive: true,
      detect: (refresh = false) => invoke<Toolchain[]>("toolchains_detect", { refresh }),
      async start(request, onEvent) {
        const channel = new Channel<RunEvent>();
        channel.onmessage = onEvent;
        const id = await invoke<number>("run_start", { request, onEvent: channel });
        return {
          input: (data) => void invoke("run_input", { id, data }).catch(() => {}),
          kill: () => void invoke("run_kill", { id }).catch(() => {}),
        };
      },
    },
    exam: {
      dev: import.meta.env.DEV,
      device: () => invoke("exam_device"),
      openExamWorkspace: (submissionId, title) => invoke("exam_workspace", { submissionId, title }),
      journal: {
        load: (sessionId) => invoke<JournalEntry[]>("journal_load", { sessionId }),
        append: (sessionId, entry) => invoke("journal_append", { sessionId, entry }),
        markSynced: (sessionId, seq) => invoke("journal_mark_synced", { sessionId, seq }),
      },
      // Through Rust: no CORS, and the capability allows only Task Mentor's /api/tmcode.
      fetch: (url, init) => httpFetch(url, init),
      toolchains: async () => (await invoke<Toolchain[]>("toolchains_detect", { refresh: false })).map((t) => ({ tool: t.tool, version: t.version })),
    },
    preview: {
      publish: (root, entry, overlay, { internet }) => invoke<string>("preview_publish", { root, entry, overlay, internet }),
    },
    window:
      info.os === "mac"
        ? undefined // native traffic lights
        : {
            minimize: () => void win.minimize(),
            toggleMaximize: () => void win.toggleMaximize(),
            close: () => void win.close(),
            isMaximized: () => win.isMaximized(),
            onMaximizedChange(cb) {
              let un: (() => void) | null = null;
              void win.onResized(async () => cb(await win.isMaximized())).then((u) => (un = u));
              return () => un?.();
            },
          },
    store: {
      get: <T,>(key: string) => store.get<T>(key),
      set: (key, value) => store.set(key, value),
    },
    setNativeTheme: (theme) => void invoke("set_native_theme", { theme }).catch(() => {}),
  };
}
