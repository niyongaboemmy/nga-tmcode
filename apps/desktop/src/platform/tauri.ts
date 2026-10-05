import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { DirEntry, Platform, TerminalSession } from "@tmcode/workbench";

type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

/** The desktop platform: workbench calls → capability-gated Rust commands. */
export async function createTauriPlatform(): Promise<Platform> {
  const info = await invoke<{ version: string; os: Platform["os"] }>("app_info");
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
