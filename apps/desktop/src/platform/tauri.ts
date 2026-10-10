import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { fetch as httpFetch } from "@tauri-apps/plugin-http";
import type {
  DebugHost,
  DebugInstallEvent,
  DebugPrepared,
  DebugProbe,
  DebugTransportEvent,
  DirEntry,
  ExtHostTransportEvent,
  AccountHost,
  AccountStatus,
  GitEvent,
  GitHost,
  GitTask,
  JournalEntry,
  Platform,
  ProcEvent,
  RunEvent,
  StoredExtension,
  TerminalSession,
  TerminalProfile,
  Toolchain,
  UpdateInfo,
  UpdateProgress,
} from "@tmcode/workbench";

type PtyEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

/** Run and Debug over the Rust DAP bridge (src-tauri/src/debug.rs). */
function createDebugHost(): DebugHost {
  return {
    kinds: ["python", "node", "native", "java", "go", "dart", "flutter", "ruby", "dotnet", "php"],
    probe: (kind) => invoke<DebugProbe>("debug_probe", { kind }),
    async install(what, onEvent) {
      const channel = new Channel<DebugInstallEvent>();
      channel.onmessage = onEvent;
      await invoke("debug_install", { what, onEvent: channel });
    },
    async prepare(request, onEvent) {
      const channel = new Channel<RunEvent>();
      channel.onmessage = onEvent;
      return invoke<DebugPrepared>("debug_prepare", { request, onEvent: channel });
    },
    async start(kind, { parent, target }, onEvent) {
      const channel = new Channel<DebugTransportEvent>();
      channel.onmessage = onEvent;
      const id = await invoke<number>("debug_start", { kind, parent: parent ?? null, target: target ?? null, onEvent: channel });
      return {
        id,
        send: (message) => void invoke("debug_send", { id, message }).catch(() => {}),
        stop: () => void invoke("debug_stop", { id }).catch(() => {}),
      };
    },
    setExamPolicy: (allowed) => void invoke("debug_policy", { allowed }).catch(() => {}),
    async runInTerminal(request, onEvent) {
      const channel = new Channel<RunEvent>();
      channel.onmessage = onEvent;
      const id = await invoke<number>("debug_run_in_terminal", { request, onEvent: channel });
      return {
        input: (data) => void invoke("run_input", { id, data }).catch(() => {}),
        kill: () => void invoke("run_kill", { id }).catch(() => {}),
      };
    },
  };
}

/** The desktop platform: workbench calls → capability-gated Rust commands. */
export interface DevOptions {
  workspace: string | null;
  selftest: boolean;
  /** TMCODE_DEV_SELFTEST=git */
  selftestGit: boolean;
  /** TMCODE_DEV_SELFTEST=ui */
  selftestUi: boolean;
  /** TMCODE_DEV_SELFTEST=projects */
  selftestProjects: boolean;
  /** TMCODE_DEV_SELFTEST=exthost */
  selftestExthost?: boolean;
  /** TMCODE_DEV_SELFTEST=extensions */
  selftestExtensions?: boolean;
  launch: string | null;
}
export let devOptions: DevOptions = { workspace: null, selftest: false, selftestGit: false, selftestUi: false, selftestProjects: false, launch: null };
/** Folder or file passed on the command line (`tmcode ~/project`). */
export let launchPath: string | null = null;

export async function createTauriPlatform(): Promise<Platform> {
  const info = await invoke<{
    version: string;
    os: Platform["os"];
    dev_workspace: string | null;
    dev_selftest: boolean;
    dev_selftest_git: boolean;
    dev_selftest_ui: boolean;
    dev_selftest_projects: boolean;
    dev_selftest_exthost?: boolean;
    dev_selftest_extensions?: boolean;
    dev_launch: string | null;
    open_path: string | null;
  }>("app_info");
  devOptions = { workspace: info.dev_workspace, selftest: info.dev_selftest, selftestGit: info.dev_selftest_git, selftestUi: info.dev_selftest_ui, selftestProjects: info.dev_selftest_projects, selftestExthost: !!info.dev_selftest_exthost, selftestExtensions: !!info.dev_selftest_extensions, launch: info.dev_launch };
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
    openExternal: (url) => invoke("open_external", { url }),
    clipboard: {
      readText: async () => (await import("@tauri-apps/plugin-clipboard-manager")).readText().then((t) => t ?? ""),
      writeText: async (text) => (await import("@tauri-apps/plugin-clipboard-manager")).writeText(text),
    },
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
      readBase64: (path) => invoke<string>("ws_read_base64", { path }),
      writeFile: (path, content) => invoke("ws_write_file", { path, content }),
      createFile: (path) => invoke("ws_create_file", { path }),
      createDir: (path) => invoke("ws_create_dir", { path }),
      rename: (from, to) => invoke("ws_rename", { from, to }),
      copy: (from, to) => invoke("ws_copy", { from, to }),
      remove: (path) => invoke("ws_remove", { path }),
      trash: (path) => invoke("ws_trash", { path }),
    },
    terminal: {
      async spawn({ cols, rows, cwd, profile, onData, onExit }): Promise<TerminalSession> {
        const channel = new Channel<PtyEvent>();
        channel.onmessage = (e) => (e.type === "data" ? onData(e.data) : onExit(e.code));
        const id = await invoke<number>("pty_spawn", { cols, rows, cwd: cwd || null, profile: profile || null, onEvent: channel });
        return {
          write: (data) => void invoke("pty_write", { id, data }).catch(() => {}),
          resize: (c, r) => void invoke("pty_resize", { id, cols: c, rows: r }).catch(() => {}),
          kill: () => void invoke("pty_kill", { id }).catch(() => {}),
          busy: () => invoke<boolean>("pty_busy", { id }).catch(() => false),
        };
      },
      profiles: () => invoke<TerminalProfile[]>("pty_profiles"),
    },
    runner: {
      interactive: true,
      detect: (refresh = false) => invoke<Toolchain[]>("toolchains_detect", { refresh }),
      candidates: (tool) => invoke<Toolchain[]>("toolchains_candidates", { tool }),
      select: (tool, path) => invoke<Toolchain>("toolchains_select", { tool, path }),
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
    debug: createDebugHost(),
    http: {
      request: (req) => invoke("api_request", { req: { ...req, body: req.body ?? null } }),
    },
    proc: {
      run: async (command, cwd, onEvent) => {
        const channel = new Channel<ProcEvent>();
        channel.onmessage = onEvent;
        return invoke<number>("proc_run", { command, cwd: cwd || null, onEvent: channel });
      },
      kill: (id) => invoke("proc_kill", { id }),
    },
    preview: {
      publish: (root, entry, overlay, { internet }) => invoke<string>("preview_publish", { root, entry, overlay, internet }),
    },
    // Extension webviews: pages and localResourceRoots files at tmwebview:// (webview.rs).
    webviews: {
      base: info.os === "windows" ? "http://tmwebview.localhost" : "tmwebview://localhost",
      cspSource: info.os === "windows" ? "http://tmwebview.localhost" : "tmwebview://localhost tmwebview:",
      publish: (handle, html, roots) => invoke<string>("webview_publish", { handle, html, roots }),
      dispose: (handle) => void invoke("webview_dispose", { handle }).catch(() => {}),
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
    // ── extensions (feat/extensions): Open VSX only, unpacked under <app data>/extensions ──
    extensions: {
      fetch: (url, as) => invoke<string>("ext_fetch", { url, encoding: as }),
      list: () => invoke<StoredExtension[]>("ext_list"),
      install: (id, downloadUrl) => invoke<StoredExtension>("ext_install", { id, url: downloadUrl }),
      installVsix: () => invoke<StoredExtension | null>("ext_install_vsix"),
      uninstall: (id) => invoke("ext_uninstall", { id }),
      readFile: (id, path, as) => invoke<string>("ext_read_file", { id, path, encoding: as }),
      // ── extension host (feat/exthost): Node.js over stdio, src-tauri/src/exthost.rs ──
      async startNodeHost(onEvent) {
        const channel = new Channel<ExtHostTransportEvent>();
        channel.onmessage = onEvent;
        const r = await invoke<{ id: number; extensions_dir: string; storage_dir: string; node: string; node_version: string }>("exthost_start", { onEvent: channel });
        return {
          extensionsDir: r.extensions_dir,
          storageDir: r.storage_dir,
          node: r.node,
          nodeVersion: r.node_version,
          send: (message) => void invoke("exthost_send", { id: r.id, message }).catch(() => {}),
          stop: () => void invoke("exthost_stop", { id: r.id }).catch(() => {}),
        };
      },
      setHostPolicy: (allowed) => void invoke("exthost_policy", { allowed }).catch(() => {}),
      secrets: (op, extension, key, value) => invoke("exthost_secret", { op, extension, key: key ?? null, value: value ?? null }),
    },
    git: createTauriGit(),
    account: createTauriAccount(),
  };
}

// ───────────── git & GitHub (git.rs, github.rs) ─────────────

let gitTaskSeq = 0;
/** A cancellable streamed git command: the task id lets `git_cancel` kill it. */
function gitTask<T>(command: string, args: Record<string, unknown>, onEvent: (e: GitEvent) => void): GitTask<T> {
  const task = ++gitTaskSeq;
  const channel = new Channel<GitEvent>();
  channel.onmessage = onEvent;
  return {
    done: invoke<T>(command, { ...args, task, onEvent: channel }),
    cancel: () => void invoke("git_cancel", { task }).catch(() => {}),
  };
}

function createTauriGit(): GitHost {
  return {
    info: (refresh = false) => invoke("git_info", { refresh }),
    status: () => invoke("git_status"),
    show: (path, rev) => invoke("git_show", { path, rev }),
    showAt: (path, commit) => invoke("git_show", { path, rev: commit }),
    fileLog: (path, limit) => invoke("git_file_log", { path, limit }),
    stageContent: (path, content) => invoke("git_stage_content", { path, content }),
    stage: (paths) => invoke("git_stage", { paths }),
    unstage: (paths) => invoke("git_unstage", { paths }),
    discard: (tracked, untracked) => invoke("git_discard", { tracked, untracked }),
    commit: (options) => invoke("git_commit", { options }),
    branches: () => invoke("git_branches"),
    checkout: (name, o = {}) => invoke("git_checkout", { name, create: !!o.create, from: o.from ?? null, remote: !!o.remote }),
    log: (limit) => invoke("git_log", { limit }),
    init: () => invoke("git_init"),
    stash: (action, message) => invoke("git_stash", { action, message: message ?? null }),
    checkIgnore: (paths) => invoke("git_check_ignore", { paths }),
    setIdentity: (name, email) => invoke("git_set_identity", { name, email }),
    remote: (op, options, onEvent) => gitTask<void>("git_remote", { op, options }, onEvent),
    pickCloneParent: () => invoke("git_pick_clone_parent"),
    clone: (url, onEvent) => gitTask<string>("git_clone", { url }, onEvent),
    onLog(cb) {
      let un: (() => void) | null = null;
      let stopped = false;
      void listen<string>("git-log", (e) => cb(e.payload)).then((u) => (stopped ? u() : (un = u)));
      return () => {
        stopped = true;
        un?.();
      };
    },
    onRepoChange(cb) {
      let un: (() => void) | null = null;
      let stopped = false;
      void listen("git-changed", () => cb()).then((u) => (stopped ? u() : (un = u)));
      return () => {
        stopped = true;
        un?.();
      };
    },
    openExternal: (url) => void invoke("git_open_url", { url }).catch(() => {}),
    github: {
      signIn: (token) => invoke("github_sign_in", { token }),
      user: () => invoke("github_user"),
      signOut: () => invoke("github_sign_out"),
      repos: () => invoke("github_repos"),
    },
  };
}

// ───────────── NGA account + projects (account.rs, projects.rs) ─────────────
function createTauriAccount(): AccountHost {
  return {
    status: (refresh = false) => invoke("auth_status", { refresh }),
    signIn: () => invoke("auth_sign_in"),
    cancel: () => invoke("auth_cancel"),
    reopenBrowser: () => invoke("auth_reopen_browser"),
    signOut: () => invoke("auth_sign_out"),
    onChange(cb) {
      let un: (() => void) | null = null;
      let stopped = false;
      void listen<AccountStatus>("account-changed", (e) => cb(e.payload)).then((u) => (stopped ? u() : (un = u)));
      return () => {
        stopped = true;
        un?.();
      };
    },
    request: (request) => invoke("tm_api", { request }),
    scan: (l = {}) => invoke("proj_scan", { maxFiles: l.maxFiles ?? null, maxFileMb: l.maxFileMb ?? null, maxTotalMb: l.maxTotalMb ?? null }),
    readBlob: (path) => invoke("proj_read_blob", { path }),
    writeBlob: (path, sha256, gzBase64) => invoke("proj_write_blob", { path, sha256, gzBase64 }),
    newFolder: (slug, base) => invoke("proj_new_folder", { slug, base: base ?? null }),
    useProjectsFolderForClone: () => invoke("proj_use_projects_folder"),
  };
}
