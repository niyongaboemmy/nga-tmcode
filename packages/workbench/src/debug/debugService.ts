import { create } from "zustand";
import { profileForPath } from "@tmcode/profiles";
import { inExam, useExam } from "../exam/state";
import { getDocument, onDocumentChanged, saveAll } from "../monaco/documents";
import { codeEditorFor } from "../monaco/editors";
import type { DebugAdapterKind, DebugComponent, DebugConnection, DebugPrepared, RunEvent, Toolchain } from "../platform/types";
import { attachDebuggeeRun, clearConsole, clearRunMarkers, refreshToolchains, runFile, showDiagnostics, writeConsole } from "../run/runService";
import { activeFilePath, getPlatform, loadDir, log, notify, openFile, revealView, showDialog, showPanel, useWorkbench, workbench } from "../state/store";
import { basename, extname } from "../util/paths";
import { showInputBox } from "../widgets/QuickPick";
import { pickValue } from "./pick";
import type { Capabilities, ExceptionBreakpointsFilter, OutputEventBody, RunInTerminalArguments, StackFrame, StartDebuggingArguments, StoppedEventBody, Variable } from "./dap";
import { DapSession } from "./dapSession";
import { guideForPath, type GuideId } from "./installGuide";
import {
  LAUNCH_FILE,
  TEMPLATES,
  selfHostedConfig,
  selfHostedKindForPath,
  addConfiguration as addConfigurationText,
  adapterKindFor,
  adapterKindForProfile,
  automaticConfig,
  languageNoun,
  parseLaunchJson,
  substitute,
  toWorkspacePath,
  type LaunchConfig,
} from "./launchJson";

// ───────────────────────────── model ─────────────────────────────

export interface BreakpointModel {
  id: string;
  path: string;
  line: number;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  /** null: not sent to a debugger (no session); true/false: the adapter's answer. */
  verified: boolean | null;
  message?: string;
}

export interface FrameView {
  id: number;
  name: string;
  /** Workspace-relative path, or null when the frame is outside the folder (library code). */
  path: string | null;
  sourceName: string | null;
  line: number;
  column: number;
  subtle: boolean;
}

export interface ThreadView {
  id: number;
  name: string;
  sessionId: number;
  stopped: boolean;
  reason: string | null;
  frames: FrameView[];
}

export type ConsoleKind = "output" | "input" | "result" | "error" | "info";
export interface ConsoleEntry {
  id: number;
  kind: ConsoleKind;
  /** Output category (stdout, stderr, console, important). */
  category?: string;
  text: string;
  /** variablesReference of an expandable result. */
  ref?: number;
  type?: string;
}

export interface WatchExpr {
  id: number;
  expression: string;
  result?: string;
  type?: string;
  ref?: number;
  error?: string;
}

export type DebugPhase = "inactive" | "initializing" | "running" | "stopped";

export interface DebugState {
  phase: DebugPhase;
  sessionName: string | null;
  threads: ThreadView[];
  focus: { sessionId: number; threadId: number; frameId: number } | null;
  /** Where the focused frame is (drives the yellow line and the gutter arrow). */
  stoppedAt: { path: string; line: number; column: number; top: boolean } | null;
  scopes: { name: string; ref: number; expensive: boolean }[];
  /** variablesReference → children (cleared on every stop). */
  children: Record<number, Variable[] | { error: string } | "loading">;
  watches: WatchExpr[];
  breakpoints: BreakpointModel[];
  breakpointsActive: boolean;
  exceptionFilters: (ExceptionBreakpointsFilter & { enabled: boolean })[];
  console: ConsoleEntry[];
  configs: LaunchConfig[];
  launchError: string | null;
  /** Name of the chosen launch.json configuration; null = automatic for the active file. */
  selected: string | null;
  progress: { title: string; detail?: string; percent?: number | null } | null;
  capabilities: Capabilities;
  /** The editor title ▶ remembers Run vs Debug, like VS Code's split button. */
  lastEditorAction: "run" | "debug";
  /** Detected toolchains (null until loaded), for the "how to install" card. */
  toolchains: Toolchain[] | null;
  /** A guide asked for explicitly (command palette, a failed start); null = follow the active file. */
  guide: GuideId | null;
  /** Why the last start failed for want of a tool or adapter (shown on the card). */
  missingMessage: string | null;
}

const initial: DebugState = {
  phase: "inactive",
  sessionName: null,
  threads: [],
  focus: null,
  stoppedAt: null,
  scopes: [],
  children: {},
  watches: [],
  breakpoints: [],
  breakpointsActive: true,
  exceptionFilters: [],
  console: [],
  configs: [],
  launchError: null,
  selected: null,
  progress: null,
  capabilities: {},
  lastEditorAction: "run",
  toolchains: null,
  guide: null,
  missingMessage: null,
};

export const useDebug = create<DebugState>()(() => ({ ...initial }));
const get = useDebug.getState;
const set = useDebug.setState;

export function resetDebugForTests() {
  sessions.clear();
  set({ ...initial }, true);
}

// ───────────────────────────── policy ─────────────────────────────

/**
 * Debugging is a practice-mode feature. In an exam it is off unless the exam's
 * policy turns it on (`policy.debugger`); adapters are never downloaded then.
 */
export function debugAllowed() {
  const { policy } = useWorkbench.getState();
  if (!inExam() && policy.mode === "practice") return true;
  return policy.debugger === true;
}

/** Downloads / pip installs: practice only, whatever the exam policy says. */
function installAllowed() {
  return !inExam() && useWorkbench.getState().policy.mode === "practice";
}

export function debugKindForPath(path: string | null): DebugAdapterKind | null {
  if (!path) return null;
  const self = selfHostedKindForPath(path);
  if (self) return self;
  const profile = profileForPath(path);
  return profile?.local ? adapterKindForProfile(profile.id) : null;
}

/** True when F5 should start the debugger (a launch config or a debuggable active file) rather than Run. */
export function debugApplies(): boolean {
  if (!debugAllowed()) return false;
  const host = getPlatform().debug;
  if (!host) return false;
  if (get().selected && get().configs.some((c) => c.name === get().selected)) return true;
  const kind = debugKindForPath(activeFilePath());
  return !!kind && host.kinds.includes(kind);
}

export function isDebugging() {
  return get().phase !== "inactive";
}

// ───────────────────────────── console ─────────────────────────────

let consoleSeq = 0;
const MAX_CONSOLE = 3000;

export function appendConsole(entry: Omit<ConsoleEntry, "id">) {
  const list = get().console;
  const last = list[list.length - 1];
  // Output arrives in fragments; join until a newline like VS Code's REPL does.
  if (entry.kind === "output" && last?.kind === "output" && last.category === entry.category && !last.text.endsWith("\n") && !last.ref && !entry.ref) {
    set({ console: [...list.slice(0, -1), { ...last, text: last.text + entry.text }] });
    return;
  }
  const next = [...list, { ...entry, id: ++consoleSeq }];
  set({ console: next.length > MAX_CONSOLE ? next.slice(-MAX_CONSOLE) : next });
}

export function clearDebugConsole() {
  set({ console: [] });
}

// ───────────────────────────── sessions ─────────────────────────────

interface Session {
  id: number;
  name: string;
  kind: DebugAdapterKind;
  dap: DapSession;
  conn: DebugConnection;
  prepared: DebugPrepared;
  parent: Session | null;
  configured: boolean;
  /** Adapter breakpoint id → model id. */
  bpIds: Map<number, string>;
  config: LaunchConfig;
  ended: boolean;
  /** rdbg pauses at load until a debugger connects: continue past it unless stopOnEntry. */
  skipEntryPause?: boolean;
}

const sessions = new Map<number, Session>();
let lastLaunch: { config: LaunchConfig } | null = null;
let stopping = false;

function rootSessions() {
  return [...sessions.values()].filter((s) => !s.parent);
}

function focusedSession(): Session | null {
  const f = get().focus;
  if (f) return sessions.get(f.sessionId) ?? null;
  const all = [...sessions.values()];
  return all[all.length - 1] ?? null;
}

const caseInsensitive = () => getPlatform().os !== "linux";

function absPath(s: Session, rel: string) {
  const root = s.prepared.root.replace(/[\\/]+$/, "");
  const sep = getPlatform().os === "windows" && !root.includes("://") ? "\\" : "/";
  return `${root}${sep}${rel.split("/").join(sep)}`;
}

function relPath(s: Session, abs: string | undefined): string | null {
  if (!abs) return null;
  return toWorkspacePath(abs, s.prepared.root, caseInsensitive());
}

// ───────────────────────────── configurations ─────────────────────────────

export async function loadLaunchConfigs() {
  const ws = useWorkbench.getState().workspace;
  if (!ws) return set({ configs: [], launchError: null });
  const text = await getPlatform()
    .fs.readFile(LAUNCH_FILE)
    .catch(() => "");
  const { configurations, error } = parseLaunchJson(text);
  set({ configs: configurations, launchError: error, selected: configurations.some((c) => c.name === get().selected) ? get().selected : (configurations[0]?.name ?? null) });
}

/** The configuration F5 would start: the selected launch.json entry, else the automatic one for the active file. */
export function currentConfig(): LaunchConfig | null {
  const { configs, selected } = get();
  const chosen = configs.find((c) => c.name === selected);
  if (chosen) return chosen;
  const file = activeFilePath();
  const profile = file ? profileForPath(file) : null;
  return (profile && file ? automaticConfig(profile, file) : null) ?? (file ? selfHostedConfig(file) : null);
}

export function selectConfiguration(name: string | null) {
  set({ selected: name });
  persist();
}

export async function addConfiguration() {
  if (!useWorkbench.getState().workspace) return notify("info", "Open a folder to create a launch.json file.");
  const kind = debugKindForPath(activeFilePath());
  const order = (t: (typeof TEMPLATES)[number]) => (adapterKindFor(t.config.type) === kind ? 0 : 1);
  const tpl = await pickValue(
    [...TEMPLATES].sort((a, b) => order(a) - order(b)).map((t) => ({ label: t.label, description: t.description, value: t })),
    { placeholder: "Select a debug configuration to add" },
  );
  if (!tpl) return;
  const fs = getPlatform().fs;
  const text = await fs.readFile(LAUNCH_FILE).catch(() => null);
  if (text === null) {
    const dirs = await fs.readDir(".vscode").catch(() => null);
    if (!dirs) await fs.createDir(".vscode").catch(() => {});
  }
  await fs.writeFile(LAUNCH_FILE, addConfigurationText(text ?? "", tpl.config));
  await loadDir("");
  await loadDir(".vscode");
  await loadLaunchConfigs();
  selectConfiguration(tpl.config.name);
  openFile(LAUNCH_FILE, { pinned: true });
  log("Debug", `Added "${tpl.config.name}" to ${LAUNCH_FILE}`);
}

/** "Show all automatic debug configurations": the active file's, plus every launch.json entry. */
export async function pickConfiguration(start = false) {
  const file = activeFilePath();
  const profile = file ? profileForPath(file) : null;
  const auto = profile && file ? automaticConfig(profile, file) : null;
  const items = [
    ...get().configs.map((c, i) => ({ label: c.name, description: "launch.json", group: i === 0 ? "launch.json" : undefined, icon: "debug-alt", value: c as LaunchConfig | "add" })),
    ...(auto ? [{ label: auto.name, description: file ?? undefined, group: "automatic", icon: "debug-alt", value: auto as LaunchConfig | "add" }] : []),
    { label: "Add Configuration...", icon: "add", value: "add" as const },
  ];
  const picked = await pickValue(items, { placeholder: start ? "Select a configuration to start debugging" : "Select a debug configuration" });
  if (!picked) return;
  if (picked === "add") return addConfiguration();
  if (get().configs.includes(picked)) selectConfiguration(picked.name);
  else selectConfiguration(null);
  if (start) await startDebugging(picked);
}

// ───────────────────────────── starting ─────────────────────────────

function setProgress(progress: DebugState["progress"]) {
  set({ progress });
}

async function ensureAdapter(kind: DebugAdapterKind): Promise<boolean> {
  const host = getPlatform().debug!;
  let probe = await host.probe(kind);
  if (!probe.available && probe.install && host.install && installAllowed()) {
    const what = probe.install;
    const download = what !== "debugpy";
    const choice = await showDialog({
      message: what === "js-debug" ? "Download the JavaScript debugger?" : what === "netcoredbg" ? "Download the .NET debugger?" : what === "php-debug" ? "Download the PHP debugger?" : "Install debugpy to debug Python?",
      detail:
        what === "js-debug"
          ? `${probe.message ?? ""}\n\nTMCode downloads Microsoft's js-debug (MIT licence) from github.com/microsoft/vscode-js-debug and checks its SHA-256 before use.`
          : what === "netcoredbg"
            ? `${probe.message ?? ""}\n\nTMCode downloads Samsung's netcoredbg (MIT licence) from github.com/Samsung/netcoredbg and checks its SHA-256 before use.`
            : what === "php-debug"
              ? `${probe.message ?? ""}\n\nTMCode downloads the PHP Debug adapter by the Xdebug team (MIT licence) from open-vsx.org and checks its SHA-256 before use.`
            : `${probe.message ?? ""}\n\nTMCode will run: python -m pip install --user debugpy (output in the Run panel).`,
      buttons: [
        { id: "install", label: download ? "Download" : "Install", primary: true },
        { id: "cancel", label: "Cancel" },
      ],
      cancelId: "cancel",
    });
    if (choice !== "install") return false;
    await runInstall(what);
    probe = await host.probe(kind);
  }
  if (!probe.available) {
    const message = probe.message ?? `Debugging ${languageNoun(kind)} is not available on this computer.`;
    showMissing(message);
    return false;
  }
  log("Debug", `Adapter: ${probe.detail ?? kind}`);
  return true;
}

/** Installs debugpy (pip, output in the Run panel) or downloads js-debug (progress bar). Throws on failure. */
export async function runInstall(what: DebugComponent) {
  const host = getPlatform().debug!;
  if (!installAllowed()) throw new Error("Debugger components are never installed during an exam.");
  if (what === "debugpy") {
    clearConsole();
    showPanel("run");
    writeConsole({ type: "step", phase: "build", command: "python -m pip install --user debugpy" });
  }
  const title = what === "js-debug" ? "Downloading JavaScript debugger…" : what === "netcoredbg" ? "Downloading .NET debugger…" : what === "php-debug" ? "Downloading PHP debugger…" : "Installing debugpy…";
  setProgress({ title, percent: null });
  try {
    await host.install!(what, (e) => {
      if (e.type === "output") writeConsole({ type: "stdout", data: e.data });
      else setProgress({ title, detail: `${(e.downloaded / 1e6).toFixed(1)} MB${e.total ? ` of ${(e.total / 1e6).toFixed(1)} MB` : ""}`, percent: e.total ? Math.round((e.downloaded / e.total) * 100) : null });
    });
    if (what === "debugpy") writeConsole({ type: "info", text: "debugpy installed." });
    log("Debug", `${what} installed`);
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (what === "debugpy") writeConsole({ type: "error", message });
    notify("error", message);
    throw e;
  } finally {
    if (get().phase === "inactive" || get().phase === "initializing") setProgress(get().phase === "initializing" ? { title: "Starting debugger…" } : null);
  }
}

function launchArguments(kind: DebugAdapterKind, config: LaunchConfig, prepared: DebugPrepared, entry: string, terminal: boolean): Record<string, unknown> {
  const { type: _t, request: _r, name, program: _p, ...rest } = config;
  void _t;
  void _r;
  void _p;
  const consoleMode = config.console === "internalConsole" || !terminal ? "internalConsole" : "integratedTerminal";
  const cwd = config.cwd ?? prepared.cwd;
  const args = config.args ?? [];
  if (kind === "python") {
    return { justMyCode: true, showReturnValue: true, ...rest, type: "python", request: "launch", name, program: prepared.entry, python: config.python ?? prepared.program, args, cwd, console: consoleMode };
  }
  if (kind === "node") {
    // The profile's run step is `node [flags] {entry}`: flags become runtimeArgs (TypeScript type stripping).
    const runtimeArgs = prepared.args.filter((a) => a !== prepared.entry);
    return {
      skipFiles: ["<node_internals>/**"],
      ...rest,
      type: "pwa-node",
      request: "launch",
      name,
      program: prepared.entry,
      args,
      cwd,
      runtimeExecutable: prepared.program,
      runtimeArgs: [...runtimeArgs, ...((config.runtimeArgs as string[] | undefined) ?? [])],
      console: consoleMode,
      outputCapture: consoleMode === "internalConsole" ? "std" : undefined,
    };
  }
  if (kind === "java") {
    // The profile's run step is `java -cp <out> <Main>`; the adapter starts the JVM itself with JDWP.
    const cp = prepared.args[prepared.args.indexOf("-cp") + 1];
    const file = `${prepared.root}/${entry}`;
    return {
      ...rest,
      type: "java",
      request: "launch",
      name,
      mainClass: config.mainClass ?? prepared.args.at(-1),
      classPaths: config.classPaths ?? (cp ? [cp] : []),
      sourcePaths: config.sourcePaths ?? [prepared.root, file.slice(0, file.lastIndexOf("/"))],
      javaExec: prepared.program,
      args,
      cwd,
      console: consoleMode,
      stopOnEntry: !!config.stopOnEntry,
    };
  }
  // C/C++ (lldb-dap or gdb -i dap): the program is the binary the build just wrote.
  const env = config.env ? Object.entries(config.env).map(([k, v]) => `${k}=${v}`) : undefined;
  void entry;
  return { ...rest, type: config.type, request: "launch", name, program: prepared.program, args, cwd, env, stopOnEntry: !!config.stopOnEntry, stopAtBeginningOfMainSubprogram: !!config.stopOnEntry };
}

export interface StartOptions {
  /** Self-test: install missing adapters without asking. */
  noConsent?: boolean;
}

/** Runs a command through the proc host; `show` streams it to the Run console. */
function procRun(command: string, cwd: string, show: boolean) {
  const proc = getPlatform().proc!;
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    let out = "";
    proc
      .run(command, cwd, (e) => {
        if (e.type === "exit") return resolve({ code: e.code, out });
        out += e.data;
        if (show) writeConsole({ type: e.type, data: e.data });
      })
      .catch(reject);
  });
}

/** The .csproj of a C# file: in its folder or the nearest one above it (workspace-relative). */
async function findCsproj(file: string | null): Promise<string | null> {
  const fs = getPlatform().fs;
  let dir = file && file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  for (;;) {
    const entries = await fs.readDir(dir).catch(() => []);
    const proj = entries.find((e) => e.kind === "file" && /\.(cs|fs|vb)proj$/.test(e.name));
    if (proj) return dir ? `${dir}/${proj.name}` : proj.name;
    if (!dir) return null;
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}

/**
 * C# / .NET: `dotnet build -c Debug` the project, ask MSBuild for the
 * assembly it wrote, then netcoredbg runs `dotnet <assembly>` under the debugger.
 */
async function startDotnet(config: LaunchConfig, resolved: LaunchConfig, root: string, file: string | null, opts: StartOptions): Promise<boolean> {
  if (!getPlatform().proc) {
    notify("info", "Debugging C# is available in the TMCode desktop app.");
    return false;
  }
  const project = typeof resolved.project === "string" ? resolved.project.replace(`${root}/`, "") : await findCsproj(file);
  if (!project) {
    notify("error", "Debugging C# needs a project (.csproj). Create one with: dotnet new console");
    return false;
  }
  const dir = project.includes("/") ? project.slice(0, project.lastIndexOf("/")) : "";
  const name = basename(project);
  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: "Building…", detail: `dotnet build ${name} (Debug)` }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  try {
    if (!opts.noConsent && !(await ensureAdapter("dotnet"))) return fail();
    clearRunMarkers();
    clearConsole();
    showPanel("run");
    writeConsole({ type: "step", phase: "build", command: `dotnet build ${name} -c Debug` });
    const built = await procRun(`dotnet build "${name}" -c Debug -nologo -clp:NoSummary`, dir, true);
    if (built.code !== 0) {
      const files = await showDiagnostics(built.out, project);
      if (files) showPanel("problems");
      throw new Error(built.code === 127 ? "TMCode could not find the .NET SDK (dotnet). Install .NET 8 or newer, then try again." : "The build failed. See Problems for the errors.");
    }
    const target = (await procRun(`dotnet msbuild "${name}" -getProperty:TargetPath -p:Configuration=Debug -nologo`, dir, false)).out.trim().split(/\r?\n/).pop()!.trim();
    const dotnet = (await procRun(getPlatform().os === "windows" ? "where dotnet" : "command -v dotnet", "", false)).out.trim().split(/\r?\n/)[0];
    if (!/\.dll$/i.test(target)) throw new Error(`Could not find the program the build produced (${target || "no TargetPath"}).`);
    setProgress({ title: "Starting debugger…" });
    const cwd = typeof resolved.cwd === "string" ? resolved.cwd : dir ? `${root}/${dir}` : root;
    const prepared: DebugPrepared = { root, entry: project, cwd, program: target, args: [] };
    const session = await createSession("dotnet", config, prepared, null);
    await session.dap.initialize("coreclr", { runInTerminal: false });
    adoptCapabilities(session);
    showPanel("debugConsole");
    const { type: _t, request: _r, name: label, ...rest } = resolved;
    void _t;
    void _r;
    const args = ((resolved.args as string[] | undefined) ?? []).map(String);
    await configureAndLaunch(session, { justMyCode: true, ...rest, type: "coreclr", request: "launch", name: label, program: dotnet || "dotnet", args: [target, ...args], cwd, console: "internalConsole", stopAtEntry: !!resolved.stopAtEntry }, "launch");
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    if (/could not find/i.test(message)) showMissing(message);
    else notify("error", message);
    await stopDebugging();
    return fail();
  }
}

/**
 * PHP: the PHP Debug adapter starts php with Xdebug, which connects back on a
 * free port (`port: 0`, `client_port=${port}`), as VS Code's "Launch currently open script".
 */
async function startPhp(config: LaunchConfig, resolved: LaunchConfig, root: string, opts: StartOptions): Promise<boolean> {
  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: "Starting the PHP debugger…" }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  try {
    if (!opts.noConsent && !(await ensureAdapter("php"))) return fail();
    // The adapter inherits TMCode's environment: ask the login shell where php is (Homebrew, Herd, XAMPP…).
    const php = getPlatform().proc ? (await procRun(getPlatform().os === "windows" ? "where php" : "command -v php", "", false)).out.trim().split(/\r?\n/)[0] : "";
    const prepared: DebugPrepared = { root, entry: String(resolved.program ?? ""), cwd: String(resolved.cwd ?? root), program: php || "php", args: [] };
    const session = await createSession("php", config, prepared, null);
    await session.dap.initialize("php", { runInTerminal: false });
    adoptCapabilities(session);
    showPanel("debugConsole");
    const { type: _t, request: _r, ...rest } = resolved;
    void _t;
    void _r;
    await configureAndLaunch(session, { port: 0, ...rest, type: "php", request: resolved.request ?? "launch", ...(php && !resolved.runtimeExecutable ? { runtimeExecutable: php } : {}), externalConsole: false }, resolved.request === "attach" ? "attach" : "launch");
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    if (/could not find/i.test(message)) showMissing(message);
    else notify("error", message);
    await stopDebugging();
    return fail();
  }
}

/** Kotlin's class for top-level functions in a file: com.example.MainKt for com/example/main.kt. */
export function kotlinMainClass(file: string, source: string) {
  const pkg = /^\s*package\s+([\w.]+)/m.exec(source)?.[1];
  const stem = basename(file).replace(/\.kt$/, "");
  const cls = `${stem.charAt(0).toUpperCase()}${stem.slice(1).replace(/[^\w$]/g, "_")}Kt`;
  return pkg ? `${pkg}.${cls}` : cls;
}

/**
 * Kotlin files: kotlinc → a jar with the Kotlin runtime (in .tmcode, never
 * uploaded), then TMCode's Java debugger runs its MainKt class.
 */
async function startKotlin(config: LaunchConfig, resolved: LaunchConfig, root: string, opts: StartOptions): Promise<boolean> {
  if (!getPlatform().proc) {
    notify("info", "Debugging Kotlin is available in the TMCode desktop app.");
    return false;
  }
  const program = String(resolved.program ?? "");
  const entry = toWorkspacePath(program, root, caseInsensitive());
  if (!entry || !entry.endsWith(".kt")) {
    notify("error", "Open the .kt file with fun main() to debug it.");
    return false;
  }
  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: "Building…", detail: "kotlinc (the first build takes a while)" }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  try {
    if (!opts.noConsent && !(await ensureAdapter("java"))) return fail();
    clearRunMarkers();
    clearConsole();
    showPanel("run");
    const jar = ".tmcode/kotlin/app.jar";
    writeConsole({ type: "step", phase: "build", command: `kotlinc ${entry} -include-runtime -d ${jar}` });
    const built = await procRun(`kotlinc "${entry}" -include-runtime -d "${jar}"`, "", true);
    if (built.code !== 0) {
      const files = await showDiagnostics(built.out, entry);
      if (files) showPanel("problems");
      throw new Error(built.code === 127 ? "TMCode could not find the Kotlin compiler (kotlinc). Install Kotlin, then try again." : "The build failed. See Problems for the errors.");
    }
    const java = (await procRun(getPlatform().os === "windows" ? "where java" : "command -v java", "", false)).out.trim().split(/\r?\n/)[0];
    const source = getDocument(entry)?.getValue() ?? (await getPlatform().fs.readFile(entry).catch(() => ""));
    const dir = `${root}/${entry}`.slice(0, `${root}/${entry}`.lastIndexOf("/"));
    setProgress({ title: "Starting debugger…" });
    const prepared: DebugPrepared = { root, entry, cwd: root, program: java || "java", args: [] };
    const session = await createSession("java", config, prepared, null);
    const terminal = !!getPlatform().debug?.runInTerminal;
    await session.dap.initialize("java", { runInTerminal: terminal });
    adoptCapabilities(session);
    const { type: _t, request: _r, program: _p, name, ...rest } = resolved;
    void _t;
    void _r;
    void _p;
    const consoleMode = resolved.console === "internalConsole" || !terminal ? "internalConsole" : "integratedTerminal";
    if (consoleMode !== "integratedTerminal") showPanel("debugConsole");
    await configureAndLaunch(
      session,
      { ...rest, type: "java", request: "launch", name, mainClass: resolved.mainClass ?? kotlinMainClass(entry, source), classPaths: [`${root}/${jar}`], sourcePaths: [root, dir], javaExec: java || "java", args: ((resolved.args as string[] | undefined) ?? []).map(String), cwd: typeof resolved.cwd === "string" ? resolved.cwd : root, console: consoleMode, stopOnEntry: !!resolved.stopOnEntry },
      "launch",
    );
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    if (/could not find/i.test(message)) showMissing(message);
    else notify("error", message);
    await stopDebugging();
    return fail();
  }
}

/** The executable a Swift package builds: its first executable target (or product), else the package name. */
export function swiftProduct(manifest: string): string | null {
  return /\.executable(?:Target)?\(\s*name:\s*"([^"]+)"/.exec(manifest)?.[1] ?? /Package\(\s*name:\s*"([^"]+)"/.exec(manifest)?.[1] ?? null;
}

/**
 * Swift packages: `swift build` (debug configuration) through the proc host,
 * then lldb-dap on .build/debug/<product> — Xcode's lldb understands Swift.
 */
async function startSwift(config: LaunchConfig, resolved: LaunchConfig, root: string, opts: StartOptions): Promise<boolean> {
  const proc = getPlatform().proc;
  const fs = getPlatform().fs;
  if (!proc) {
    notify("info", "Debugging Swift is available in the TMCode desktop app.");
    return false;
  }
  const manifest = await fs.readFile("Package.swift").catch(() => null);
  const product = manifest ? swiftProduct(manifest) : null;
  if (!product) {
    notify("error", "Debugging Swift needs a Swift package (Package.swift with an executable target) at the root of the folder.");
    return false;
  }
  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: "Building…", detail: "swift build (debug)" }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  const run = (command: string, show: boolean) => procRun(command, "", show);
  try {
    if (!opts.noConsent && !(await ensureAdapter("native"))) return fail();
    clearRunMarkers();
    clearConsole();
    showPanel("run");
    writeConsole({ type: "step", phase: "build", command: "swift build" });
    const built = await run("swift build", true);
    if (built.code !== 0) {
      const files = await showDiagnostics(built.out, "Package.swift");
      if (files) showPanel("problems");
      throw new Error(built.code === 127 ? "TMCode could not find Swift (swift). Install Xcode or the Swift toolchain, then try again." : "The build failed. See Problems for the errors.");
    }
    const bin = (await run("swift build --show-bin-path", false)).out.trim().split("\n").pop()!;
    const program = `${bin}/${product}`;
    setProgress({ title: "Starting debugger…" });
    const cwd = typeof resolved.cwd === "string" ? resolved.cwd : root;
    const prepared: DebugPrepared = { root, entry: "Package.swift", cwd, program, args: [] };
    const session = await createSession("native", config, prepared, null);
    await session.dap.initialize("lldb", { runInTerminal: !!getPlatform().debug?.runInTerminal });
    adoptCapabilities(session);
    showPanel("debugConsole");
    const { type: _t, request: _r, name, ...rest } = resolved;
    void _t;
    void _r;
    await configureAndLaunch(session, { ...rest, type: "lldb", request: "launch", name, program, args: ((resolved.args as string[] | undefined) ?? []).map(String), cwd, stopOnEntry: !!resolved.stopOnEntry }, "launch");
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    if (/could not find/i.test(message)) showMissing(message);
    else notify("error", message);
    await stopDebugging();
    return fail();
  }
}

/** `com.example.App` for src/com/example/App.java (from its package declaration). */
async function javaMainClass(entry: string) {
  const text = getDocument(entry)?.getValue() ?? (await getPlatform().fs.readFile(entry).catch(() => ""));
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
  const stem = basename(entry).replace(/\.java$/, "");
  return pkg ? `${pkg}.${stem}` : stem;
}

/**
 * Java attach: a JVM already listening for a debugger (Spring Boot or Maven
 * started with -agentlib:jdwp=…,address=5005). Nothing is built.
 */
async function startJavaAttach(config: LaunchConfig, resolved: LaunchConfig, root: string, opts: StartOptions): Promise<boolean> {
  const port = Number(resolved.port ?? 5005);
  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: `Attaching to the JVM on port ${port}…` }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  log("Debug", `Attach "${config.name}" (java) to ${resolved.hostName ?? "127.0.0.1"}:${port}`);
  try {
    if (!opts.noConsent && !(await ensureAdapter("java"))) return fail();
    const { type: _t, request: _r, name, ...rest } = resolved;
    void _t;
    void _r;
    const sourcePaths = (resolved.sourcePaths as string[] | undefined) ?? [root, `${root}/src`, `${root}/src/main/java`, `${root}/src/test/java`, `${root}/src/main/kotlin`];
    const args = { ...rest, type: "java", request: "attach", name, hostName: resolved.hostName ?? "127.0.0.1", port, sourcePaths, cwd: root };
    const prepared: DebugPrepared = { root, entry: "", cwd: root, program: "", args: [] };
    const session = await createSession("java", config, prepared, null);
    await session.dap.initialize("java", { runInTerminal: false });
    adoptCapabilities(session);
    showPanel("debugConsole");
    await configureAndLaunch(session, args, "attach");
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    notify("error", /ECONNREFUSED|connect/i.test(message) ? `No JVM is listening on port ${port}. Start it with -agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=${port}` : message);
    await stopDebugging();
    return fail();
  }
}

/**
 * Go (Delve), Dart and Flutter: their debug adapters build and run the program
 * themselves, so TMCode skips its own build step and passes the paths.
 */
async function startSelfHosted(kind: "go" | "dart" | "flutter" | "ruby", config: LaunchConfig, resolved: LaunchConfig, root: string, opts: StartOptions): Promise<boolean> {
  const host = getPlatform().debug!;
  const abs = (p: string) => (/^([a-z]+:|\/|[A-Za-z]:\\)/.test(p) ? p : `${root}/${p.replace(/^\.\//, "")}`);
  const target = kind === "ruby" ? resolved.script ?? resolved.program : resolved.program;
  const program = typeof target === "string" && target ? abs(target) : root;
  // A Dart program inside a Flutter project debugs with Flutter's adapter.
  if (kind === "dart") {
    const pub = await getPlatform().fs.readFile("pubspec.yaml").catch(() => "");
    if (/sdk:\s*flutter/.test(pub)) kind = "flutter";
  }
  if (!host.kinds.includes(kind)) {
    notify("info", `Debugging ${languageNoun(kind)} is available in the TMCode desktop app.`);
    return false;
  }
  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: kind === "go" ? "Building with Delve…" : kind === "flutter" ? "Starting Flutter (the first build takes a while)…" : kind === "ruby" ? "Starting rdbg…" : "Starting the Dart debugger…" }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  log("Debug", `Start "${config.name}" (${kind}) for ${program}`);
  try {
    if (!opts.noConsent) {
      if (!(await ensureAdapter(kind))) return fail();
    }
    const { type: _t, request: _r, name, program: _p, ...rest } = resolved;
    void _t;
    void _r;
    void _p;
    const cwd = typeof resolved.cwd === "string" ? abs(resolved.cwd) : root;
    const args =
      kind === "go"
        ? { ...rest, type: "go", request: "launch", name, mode: resolved.mode ?? "debug", program, cwd, args: resolved.args ?? [] }
        : { ...rest, type: "dart", request: "launch", name, program, cwd, args: resolved.args ?? [], console: "debugConsole", sendLogsToClient: false };
    const prepared: DebugPrepared = { root, entry: program, cwd, program, args: [] };
    if (kind === "ruby") {
      // rdbg runs the script and waits on a port; TMCode attaches (as vscode-rdbg does).
      const scriptArgs = ((resolved.args as string[] | undefined) ?? []).map(String);
      const session = await createSession(kind, config, prepared, null, [program, ...scriptArgs]);
      session.skipEntryPause = !resolved.stopOnEntry;
      await session.dap.initialize("rdbg", { runInTerminal: false });
      adoptCapabilities(session);
      showPanel("debugConsole");
      await configureAndLaunch(session, { type: "rdbg", request: "attach", name, localfs: true }, "attach");
      setProgress(null);
      if (get().phase === "initializing") set({ phase: "running" });
      return true;
    }
    const session = await createSession(kind, config, prepared, null);
    await session.dap.initialize(kind === "go" ? "go" : "dart", { runInTerminal: false });
    adoptCapabilities(session);
    showPanel("debugConsole");
    await configureAndLaunch(session, args, "launch");
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    if (/could not find/i.test(message)) showMissing(message);
    else notify("error", message);
    log("Debug", `Start failed: ${message}`, "error");
    await stopDebugging();
    return fail();
  }
}

/** F5: starts debugging `config` (default: the selected or automatic configuration). */
export async function startDebugging(cfg?: LaunchConfig | null, opts: StartOptions = {}): Promise<boolean> {
  const host = getPlatform().debug;
  if (!debugAllowed()) {
    notify("info", "Debugging is turned off during exams.");
    return false;
  }
  if (!host) {
    notify("info", "Debugging is available in the TMCode desktop app.");
    return false;
  }
  if (get().phase !== "inactive") {
    revealView("debug");
    return false;
  }
  const ws = useWorkbench.getState().workspace;
  if (!ws) {
    notify("info", "Open a folder to start debugging.");
    return false;
  }
  await saveAll();
  const config = cfg ?? currentConfig();
  const file = activeFilePath();
  if (!config) {
    notify("info", file ? `TMCode can't debug '${basename(file)}'. Open a .py, .js, .ts, .c or .cpp file.` : "Open a file to debug, or create a launch.json file.");
    return false;
  }
  const kind = adapterKindFor(config.type);
  if (!kind) {
    notify("error", `Configured debug type '${config.type}' is not supported.`);
    return false;
  }
  // A launch.json from a cloned folder runs its author's commands: ask once (trust/trust.ts).
  if (get().configs.includes(config) && !(await import("../trust/trust").then((m) => m.ensureTrusted("Debug configurations")))) return false;
  if (!host.kinds.includes(kind === "dart" ? "dart" : kind)) {
    notify(
      "info",
      `Debugging ${languageNoun(kind, extname(file ?? ""))} is available in the TMCode desktop app.`,
      [{ label: "Run Without Debugging", run: () => file && void import("../run/runService").then((m) => m.runFile(file)) }],
    );
    return false;
  }
  let pickedArgs: string[] | undefined;
  if (JSON.stringify(config).includes("${command:pickArgs}")) {
    const text = await showInputBox({ prompt: "Command Line Arguments", placeholder: "Enter the arguments, separated by spaces" });
    if (text === undefined) return false;
    pickedArgs = splitArgs(text);
  }
  const line = codeEditorFor(workbench.get().activeGroup)?.getPosition()?.lineNumber;
  const resolved = substitute(config, { root: ws.root, file, line, args: pickedArgs });
  if (kind === "go" || kind === "dart" || kind === "flutter" || kind === "ruby") return startSelfHosted(kind, config, resolved, ws.root, opts);
  if (kind === "java" && config.request === "attach") return startJavaAttach(config, resolved, ws.root, opts);
  if (config.type === "swift") return startSwift(config, resolved, ws.root, opts);
  if (config.type === "kotlin") return startKotlin(config, resolved, ws.root, opts);
  if (kind === "dotnet") return startDotnet(config, resolved, ws.root, file, opts);
  if (kind === "php") return startPhp(config, resolved, ws.root, opts);
  const program = typeof resolved.program === "string" && resolved.program ? resolved.program : file ? `${ws.root}/${file}` : "";
  const entry = toWorkspacePath(program, ws.root, caseInsensitive()) ?? (program && !/^([a-z]+:|\/|[A-Za-z]:\\)/.test(program) ? program : null);
  const profile = entry ? profileForPath(entry) : null;
  if (!entry || !profile?.local) {
    notify("error", entry ? `'${entry}' is not a program TMCode can debug.` : `The program to debug must be inside the open folder ('${program}').`);
    return false;
  }

  lastLaunch = { config };
  set({ phase: "initializing", sessionName: config.name, progress: { title: "Starting debugger…" }, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, lastEditorAction: "debug" });
  clearDebugConsole();
  revealView("debug");
  log("Debug", `Start "${config.name}" (${kind}) for ${entry}`);
  try {
    if (!opts.noConsent) {
      if (!(await ensureAdapter(kind))) return fail();
    } else {
      const probe = await host.probe(kind);
      if (!probe.available && probe.install) await runInstall(probe.install);
    }
    // javac -g keeps the local variable table the Java debugger shows.
    const build = kind === "java" ? profile.local.build.map((st) => (st.tool === "javac" ? { ...st, args: ["-g", ...st.args] } : st)) : profile.local.build;
    if (kind === "java" && !resolved.mainClass) resolved.mainClass = await javaMainClass(entry);
    if (build.length) {
      setProgress({ title: "Building…", detail: `${profile.label} with debug information (${kind === "java" ? "javac -g" : "-g -O0"})` });
      clearRunMarkers();
      clearConsole();
      showPanel("run");
    }
    let buildOut = "";
    let prepared: DebugPrepared;
    try {
      prepared = await host.prepare({ entry, build, run: profile.local.run }, (e: RunEvent) => {
        writeConsole(e);
        if (e.type === "stdout" || e.type === "stderr") buildOut += e.data;
      });
    } catch (e) {
      if (buildOut) {
        const files = await showDiagnostics(buildOut, entry);
        if (files) showPanel("problems");
      }
      throw e;
    }
    setProgress({ title: "Starting debugger…" });
    const terminal = !!host.runInTerminal;
    const args = launchArguments(kind, resolved, prepared, entry, terminal);
    const session = await createSession(kind, config, prepared, null);
    await session.dap.initialize(kind === "python" ? "debugpy" : kind === "node" ? "pwa-node" : config.type, { runInTerminal: terminal });
    adoptCapabilities(session);
    if (args.console !== "integratedTerminal") showPanel("debugConsole");
    await configureAndLaunch(session, args, "launch");
    setProgress(null);
    if (get().phase === "initializing") set({ phase: "running" });
    return true;
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    appendConsole({ kind: "error", text: message });
    if (/could not find/i.test(message)) showMissing(message);
    else notify("error", message);
    log("Debug", `Start failed: ${message}`, "error");
    await stopDebugging();
    return fail();
  }
}

/** A missing interpreter, compiler or adapter: the Run and Debug view shows how to install it. */
function showMissing(message: string) {
  const file = activeFilePath();
  set({ missingMessage: message, guide: guideForPath(file)?.id ?? get().guide });
  revealView("debug");
  notify("error", message, [{ label: "How to Install", run: () => revealView("debug") }]);
}

/** Shows the "how to install" card for a language (or the active file's). */
export function showInstallGuide(id?: GuideId | null) {
  set({ guide: id ?? guideForPath(activeFilePath())?.id ?? null });
  revealView("debug");
  void loadToolchains();
}

export function dismissInstallGuide() {
  set({ guide: null, missingMessage: null });
}

/** Loads the detected toolchains for the card (`refresh` re-scans the computer). */
export async function loadToolchains(refresh = false) {
  const runner = getPlatform().runner;
  if (!runner) return set({ toolchains: [] });
  try {
    const list = refresh ? await refreshToolchains() : await runner.detect(false);
    set({ toolchains: list, ...(refresh ? { missingMessage: null } : {}) });
  } catch {
    set({ toolchains: [] });
  }
}

/** F5: Continue while paused; otherwise start debugging when a configuration applies, else run the file. */
export async function startOrContinue() {
  const phase = get().phase;
  if (phase === "stopped") return continueExecution();
  if (phase !== "inactive") return;
  if (debugApplies()) {
    await startDebugging();
    return;
  }
  const path = activeFilePath();
  if (path) await runFile(path);
}

/** Ctrl+F5 / the editor's ▶: runs without the debugger (and remembers the choice for the title button). */
export async function runWithoutDebugging() {
  const path = activeFilePath();
  if (!path) return;
  set({ lastEditorAction: "run" });
  await runFile(path);
}

function fail() {
  if (!sessions.size) set({ phase: "inactive", progress: null, sessionName: null });
  else setProgress(null);
  return false;
}

export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? m[3]));
  return out;
}

function adoptCapabilities(s: Session) {
  const caps = s.dap.capabilities;
  const prev = new Map(get().exceptionFilters.map((f) => [f.filter, f.enabled]));
  const saved = savedFilters;
  set({
    capabilities: caps,
    exceptionFilters: (caps.exceptionBreakpointFilters ?? []).map((f) => ({ ...f, enabled: prev.get(f.filter) ?? saved[f.filter] ?? !!f.default })),
  });
}

async function createSession(kind: DebugAdapterKind, config: LaunchConfig, prepared: DebugPrepared, parent: Session | null, target?: string[]): Promise<Session> {
  const host = getPlatform().debug!;
  let session: Session | null = null;
  const early: string[] = [];
  const conn = await host.start(kind, { parent: parent?.conn.id, target }, (e) => {
    if (e.type === "message") {
      if (session) session.dap.handleMessage(e.message);
      else early.push(e.message);
    } else if (e.type === "stderr") {
      log("Debug", e.data.trimEnd());
    } else if (e.type === "exit") {
      if (session) void endSession(session);
    }
  });
  const dap = new DapSession({ send: (m) => conn.send(m) }, kind);
  session = { id: conn.id, name: config.name, kind, dap, conn, prepared, parent, configured: false, bpIds: new Map(), config, ended: false };
  sessions.set(conn.id, session);
  wireEvents(session);
  early.forEach((m) => dap.handleMessage(m));
  return session;
}

async function configureAndLaunch(s: Session, args: Record<string, unknown>, request: "launch" | "attach") {
  const initialized = s.dap.once("initialized", 60_000);
  const launched = request === "launch" ? s.dap.launch(args) : s.dap.attach(args);
  // Some adapters answer launch only after configurationDone; a failed launch must still surface.
  await Promise.race([initialized, launched.then(() => initialized)]);
  await sendAllBreakpoints(s);
  const filters = get().exceptionFilters.filter((f) => f.enabled).map((f) => f.filter);
  if (s.dap.capabilities.exceptionBreakpointFilters?.length) await s.dap.setExceptionBreakpoints(filters).catch(() => {});
  await s.dap.configurationDone();
  s.configured = true;
  await launched;
}

function wireEvents(s: Session) {
  const { dap } = s;
  dap.on("output", (b: OutputEventBody) => {
    if (b.category === "telemetry") return;
    const category = b.category ?? "console";
    appendConsole({ kind: "output", category, text: b.output, ref: b.variablesReference || undefined });
  });
  dap.on("stopped", (b: StoppedEventBody) => void onStopped(s, b));
  dap.on("continued", (b: { threadId?: number; allThreadsContinued?: boolean }) => onContinued(s, b));
  dap.on("thread", () => void refreshThreads(s));
  dap.on("breakpoint", (b: { reason: string; breakpoint: { id?: number; verified: boolean; line?: number; message?: string } }) => {
    const id = b.breakpoint.id != null ? s.bpIds.get(b.breakpoint.id) : undefined;
    if (!id || b.reason === "removed") return;
    updateBreakpoint(id, { verified: b.breakpoint.verified, message: b.breakpoint.message, ...(b.breakpoint.line ? { line: b.breakpoint.line } : {}) }, false);
  });
  dap.on("exited", (b: { exitCode: number }) => appendConsole({ kind: "info", text: `Process exited with code ${b.exitCode}.` }));
  dap.on("terminated", () => void endSession(s));
  dap.on("capabilities", () => adoptCapabilities(s));
  dap.onReverseRequest = async (command, args) => {
    if (command === "runInTerminal") return runInTerminal(s, args as RunInTerminalArguments);
    if (command === "startDebugging") {
      void startChild(s, args as StartDebuggingArguments);
      return {};
    }
    throw new Error(`TMCode does not support '${command}'.`);
  };
}

async function runInTerminal(s: Session, a: RunInTerminalArguments) {
  const host = getPlatform().debug!;
  if (!host.runInTerminal) throw new Error("runInTerminal is not supported here.");
  const handle = await attachDebuggeeRun(`Debug: ${s.name}`, null, (onEvent) => host.runInTerminal!({ args: a.args, cwd: a.cwd, env: a.env }, onEvent));
  void handle;
  return {};
}

async function startChild(parent: Session, a: StartDebuggingArguments) {
  try {
    const child = await createSession(parent.kind, { ...parent.config, name: String(a.configuration.name ?? parent.name) }, parent.prepared, parent);
    await child.dap.initialize(String(a.configuration.type ?? "pwa-node"), { runInTerminal: !!getPlatform().debug?.runInTerminal });
    adoptCapabilities(child);
    await configureAndLaunch(child, a.configuration, a.request);
    if (get().phase === "initializing") set({ phase: "running" });
  } catch (e) {
    appendConsole({ kind: "error", text: `Could not start the child session: ${String((e as Error)?.message ?? e)}` });
  }
}

async function endSession(s: Session) {
  if (s.ended) return;
  s.ended = true;
  sessions.delete(s.id);
  s.dap.close();
  s.conn.stop();
  for (const child of [...sessions.values()].filter((c) => c.parent === s)) void endSession(child);
  // A finished child (js-debug) ends the whole debug session, as in VS Code.
  if (s.parent && !s.parent.ended) {
    try {
      await s.parent.dap.disconnect(true);
    } catch {
      /* already gone */
    }
    void endSession(s.parent);
  }
  if (!sessions.size) {
    set({ phase: "inactive", sessionName: null, threads: [], focus: null, stoppedAt: null, scopes: [], children: {}, progress: null, breakpoints: get().breakpoints.map((b) => ({ ...b, verified: null, message: undefined })) });
    set({ watches: get().watches.map((w) => ({ id: w.id, expression: w.expression })) });
    log("Debug", "Debug session ended");
  } else if (get().focus?.sessionId === s.id) {
    set({ focus: null, stoppedAt: null, scopes: [], threads: get().threads.filter((t) => t.sessionId !== s.id) });
  }
}

// ───────────────────────────── stopping / threads / frames ─────────────────────────────

async function refreshThreads(s: Session) {
  if (s.ended) return;
  const list = await s.dap.threads().catch(() => []);
  const others = get().threads.filter((t) => t.sessionId !== s.id);
  const existing = new Map(get().threads.filter((t) => t.sessionId === s.id).map((t) => [t.id, t]));
  set({ threads: [...others, ...list.map((t) => existing.get(t.id) ?? { id: t.id, name: t.name, sessionId: s.id, stopped: false, reason: null, frames: [] })] });
}

function frameView(s: Session, f: StackFrame): FrameView {
  const path = relPath(s, f.source?.path);
  return { id: f.id, name: f.name, path, sourceName: f.source?.name ?? (f.source?.path ? basename(f.source.path.replace(/\\/g, "/")) : null), line: f.line, column: f.column, subtle: f.presentationHint === "subtle" || f.source?.presentationHint === "deemphasize" };
}

async function onStopped(s: Session, b: StoppedEventBody) {
  if (s.skipEntryPause) {
    s.skipEntryPause = false;
    if (b.reason === "pause" || b.reason === "entry") {
      void s.dap.continue(b.threadId ?? 1).catch(() => {});
      return;
    }
  }
  await refreshThreads(s);
  const threadId = b.threadId ?? get().threads.find((t) => t.sessionId === s.id)?.id ?? 1;
  const frames = (await s.dap.stackTrace(threadId).catch(() => [] as StackFrame[])).map((f) => frameView(s, f));
  const reason = b.reason === "exception" ? "exception" : b.reason;
  set({
    phase: "stopped",
    progress: null,
    threads: get().threads.map((t) => (t.sessionId === s.id && (t.id === threadId || b.allThreadsStopped) ? { ...t, stopped: true, reason: t.id === threadId ? reason : "pause", frames: t.id === threadId ? frames : t.frames } : t)),
    children: {},
  });
  if (b.reason === "exception") {
    let text = b.text ?? b.description ?? "Exception";
    const info = await s.dap.request<{ exceptionId: string; description?: string }>("exceptionInfo", { threadId }).catch(() => null);
    if (info) text = info.description ? `${info.exceptionId}: ${info.description}` : info.exceptionId;
    appendConsole({ kind: "error", text: `Exception has occurred: ${text}` });
  }
  // Focus the top frame in the folder (library frames are shown but not opened).
  const target = frames.find((f) => f.path !== null) ?? frames[0];
  if (target) await selectFrame(s.id, threadId, target, true);
  else set({ focus: { sessionId: s.id, threadId, frameId: 0 }, stoppedAt: null });
}

function onContinued(s: Session, b: { threadId?: number; allThreadsContinued?: boolean }) {
  set({
    phase: [...sessions.values()].some((x) => x !== s && get().threads.some((t) => t.sessionId === x.id && t.stopped)) ? "stopped" : "running",
    threads: get().threads.map((t) => (t.sessionId === s.id && (b.allThreadsContinued !== false || t.id === b.threadId) ? { ...t, stopped: false, reason: null, frames: [] } : t)),
    stoppedAt: get().focus?.sessionId === s.id ? null : get().stoppedAt,
    scopes: get().focus?.sessionId === s.id ? [] : get().scopes,
    children: {},
  });
  set({ watches: get().watches.map((w) => ({ id: w.id, expression: w.expression })) });
}

/** Focuses a frame: opens its source at the line, loads its variables, re-evaluates watches. */
export async function selectFrame(sessionId: number, threadId: number, frame: FrameView, top = false) {
  const s = sessions.get(sessionId);
  if (!s) return;
  const thread = get().threads.find((t) => t.sessionId === sessionId && t.id === threadId);
  const isTop = top || thread?.frames[0]?.id === frame.id;
  set({ focus: { sessionId, threadId, frameId: frame.id }, stoppedAt: frame.path ? { path: frame.path, line: frame.line, column: frame.column, top: isTop } : null, children: {} });
  if (frame.path) revealLocation(frame.path, frame.line, frame.column);
  const scopes = await s.dap.scopes(frame.id).catch(() => []);
  set({ scopes: scopes.map((sc) => ({ name: sc.name, ref: sc.variablesReference, expensive: sc.expensive })) });
  const first = scopes.find((sc) => !sc.expensive);
  if (first) await loadChildren(first.variablesReference);
  await refreshWatches();
}

export function revealLocation(path: string, line: number, column = 1) {
  openFile(path, { pinned: true });
  const go = (n = 0) => {
    const ed = codeEditorFor(workbench.get().activeGroup);
    if (ed?.getModel()?.uri.path === `/${path}`) {
      ed.setPosition({ lineNumber: line, column: Math.max(1, column) });
      ed.revealLineInCenterIfOutsideViewport(line);
    } else if (n < 40) setTimeout(() => go(n + 1), 25);
  };
  go();
}

export async function loadChildren(ref: number) {
  const s = focusedSession();
  if (!s || ref <= 0) return;
  set({ children: { ...get().children, [ref]: "loading" } });
  try {
    const vars = await s.dap.variables(ref);
    set({ children: { ...get().children, [ref]: vars } });
  } catch (e) {
    set({ children: { ...get().children, [ref]: { error: String((e as Error)?.message ?? e) } } });
  }
}

export async function setVariableValue(parentRef: number, v: Variable, value: string) {
  const s = focusedSession();
  if (!s?.dap.capabilities.supportsSetVariable) return;
  try {
    await s.dap.setVariable(parentRef, v.name, value);
    await loadChildren(parentRef);
    await refreshWatches();
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  }
}

// ───────────────────────────── execution control ─────────────────────────────

function focusedThread(): { s: Session; threadId: number } | null {
  const s = focusedSession();
  if (!s) return null;
  const threadId = get().focus?.threadId ?? get().threads.find((t) => t.sessionId === s.id)?.id ?? 1;
  return { s, threadId };
}

async function control(fn: (s: Session, threadId: number) => Promise<unknown>) {
  const t = focusedThread();
  if (!t) return;
  try {
    await fn(t.s, t.threadId);
  } catch (e) {
    notify("error", String((e as Error)?.message ?? e));
  }
}

export const continueExecution = () => control((s, t) => s.dap.continue(t));
export const stepOver = () => control((s, t) => s.dap.next(t));
export const stepInto = () => control((s, t) => s.dap.stepIn(t));
export const stepOut = () => control((s, t) => s.dap.stepOut(t));
export const pauseExecution = () => control((s, t) => s.dap.pause(t));

export async function stopDebugging() {
  if (stopping) return;
  stopping = true;
  try {
    const roots = rootSessions();
    await Promise.all(
      roots.map(async (s) => {
        try {
          if (s.dap.capabilities.supportsTerminateRequest && s.configured) await s.dap.terminate();
          else await s.dap.disconnect(true);
        } catch {
          /* the adapter may already be gone */
        }
        setTimeout(() => void endSession(s), 1500);
      }),
    );
    // Children first, then roots: the process trees are killed by the host.
    for (const s of [...sessions.values()].filter((x) => x.parent)) await endSession(s);
    for (const s of rootSessions()) await endSession(s);
    if (!sessions.size) set({ phase: "inactive", progress: null, sessionName: null, stoppedAt: null });
  } finally {
    stopping = false;
  }
}

export async function restartDebugging() {
  const root = rootSessions()[0];
  // Adapters that can restart in place do (keeps the Run console and breakpoints bound); js-debug's
  // parent/child pair and the rest are stopped and started again, as VS Code does.
  if (root?.configured && root.dap.capabilities.supportsRestartRequest && root.kind !== "node") {
    set({ children: {}, scopes: [], stoppedAt: null });
    try {
      await root.dap.restart();
      return;
    } catch {
      /* fall back to stop + start */
    }
  }
  const config = lastLaunch?.config;
  await stopDebugging();
  if (config) await startDebugging(config);
}

// ───────────────────────────── watch / REPL ─────────────────────────────

let watchSeq = 0;

export async function refreshWatches() {
  const s = focusedSession();
  const frameId = get().focus?.frameId;
  const watches = await Promise.all(
    get().watches.map(async (w): Promise<WatchExpr> => {
      if (!s || get().phase !== "stopped") return { id: w.id, expression: w.expression };
      try {
        const r = await s.dap.evaluate(w.expression, frameId, "watch");
        return { id: w.id, expression: w.expression, result: r.result, type: r.type, ref: r.variablesReference || undefined };
      } catch (e) {
        return { id: w.id, expression: w.expression, error: String((e as Error)?.message ?? e) };
      }
    }),
  );
  set({ watches });
}

export async function addWatch(expression: string) {
  const expr = expression.trim();
  if (!expr) return;
  set({ watches: [...get().watches, { id: ++watchSeq, expression: expr }] });
  persist();
  await refreshWatches();
}

export async function editWatch(id: number, expression: string) {
  const expr = expression.trim();
  if (!expr) return removeWatch(id);
  set({ watches: get().watches.map((w) => (w.id === id ? { id, expression: expr } : w)) });
  persist();
  await refreshWatches();
}

export function removeWatch(id: number) {
  set({ watches: get().watches.filter((w) => w.id !== id) });
  persist();
}

export function removeAllWatches() {
  set({ watches: [] });
  persist();
}

/** Debug Console input: evaluates in the focused frame. */
export async function evaluateInConsole(expression: string) {
  const expr = expression.trim();
  if (!expr) return;
  appendConsole({ kind: "input", text: expr });
  const s = focusedSession();
  if (!s) {
    appendConsole({ kind: "error", text: "No active debug session. Start debugging (F5) to evaluate expressions." });
    return;
  }
  try {
    const r = await s.dap.evaluate(expr, get().focus?.frameId, "repl");
    if (r.result !== "" || r.variablesReference) appendConsole({ kind: "result", text: r.result, ref: r.variablesReference || undefined, type: r.type });
    if (get().phase === "stopped") {
      await refreshWatches();
      const top = get().scopes.find((sc) => !sc.expensive);
      if (top) await loadChildren(top.ref);
    }
  } catch (e) {
    appendConsole({ kind: "error", text: String((e as Error)?.message ?? e) });
  }
}

/** Hover in the editor while stopped. */
export async function evaluateForHover(expression: string) {
  const s = focusedSession();
  if (!s || get().phase !== "stopped") return null;
  try {
    return await s.dap.evaluate(expression, get().focus?.frameId, s.dap.capabilities.supportsEvaluateForHovers ? "hover" : "watch");
  } catch {
    return null;
  }
}

// ───────────────────────────── breakpoints ─────────────────────────────

let bpSeq = 0;
const resendTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function breakpointsFor(path: string) {
  return get().breakpoints.filter((b) => b.path === path);
}

function changed(paths: string[]) {
  persist();
  for (const p of new Set(paths)) {
    const t = resendTimers.get(p);
    if (t) clearTimeout(t);
    resendTimers.set(
      p,
      setTimeout(() => {
        resendTimers.delete(p);
        for (const s of sessions.values()) if (s.configured && !s.ended) void sendBreakpoints(s, p);
      }, 30),
    );
  }
}

export function addBreakpoint(path: string, line: number, opts: Partial<Pick<BreakpointModel, "condition" | "hitCondition" | "logMessage">> = {}) {
  if (!debugAllowed()) return;
  const existing = get().breakpoints.find((b) => b.path === path && b.line === line);
  if (existing) return updateBreakpoint(existing.id, { ...opts, enabled: true });
  set({ breakpoints: [...get().breakpoints, { id: `bp${++bpSeq}`, path, line, enabled: true, verified: null, ...opts }] });
  changed([path]);
}

export function toggleBreakpoint(path: string, line: number) {
  if (!debugAllowed()) return;
  const existing = get().breakpoints.find((b) => b.path === path && b.line === line);
  if (existing) removeBreakpoint(existing.id);
  else addBreakpoint(path, line);
}

export function updateBreakpoint(id: string, patch: Partial<BreakpointModel>, resend = true) {
  const bp = get().breakpoints.find((b) => b.id === id);
  if (!bp) return;
  set({ breakpoints: get().breakpoints.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  if (resend) changed([bp.path]);
  else persist();
}

export function removeBreakpoint(id: string) {
  const bp = get().breakpoints.find((b) => b.id === id);
  if (!bp) return;
  set({ breakpoints: get().breakpoints.filter((b) => b.id !== id) });
  changed([bp.path]);
}

export function removeAllBreakpoints() {
  const paths = get().breakpoints.map((b) => b.path);
  set({ breakpoints: [] });
  changed(paths);
}

export function setAllBreakpointsEnabled(enabled: boolean) {
  set({ breakpoints: get().breakpoints.map((b) => ({ ...b, enabled })) });
  changed(get().breakpoints.map((b) => b.path));
}

export function toggleBreakpointsActive() {
  set({ breakpointsActive: !get().breakpointsActive });
  changed(get().breakpoints.map((b) => b.path));
}

/** Editors report breakpoint lines that moved with edits (decorations track them). */
export function moveBreakpoints(path: string, moves: { id: string; line: number }[]) {
  if (!moves.length) return;
  const byId = new Map(moves.map((m) => [m.id, m.line]));
  const seen = new Set<number>();
  const next: BreakpointModel[] = [];
  for (const b of get().breakpoints) {
    if (b.path !== path) {
      next.push(b);
      continue;
    }
    const line = byId.get(b.id) ?? b.line;
    if (seen.has(line)) continue; // two breakpoints collapsed onto one line
    seen.add(line);
    next.push(line === b.line ? b : { ...b, line });
  }
  set({ breakpoints: next });
  changed([path]);
}

export function setExceptionFilter(filter: string, enabled: boolean) {
  set({ exceptionFilters: get().exceptionFilters.map((f) => (f.filter === filter ? { ...f, enabled } : f)) });
  savedFilters[filter] = enabled;
  persist();
  const filters = get().exceptionFilters.filter((f) => f.enabled).map((f) => f.filter);
  for (const s of sessions.values()) if (s.configured && !s.ended && s.dap.capabilities.exceptionBreakpointFilters?.length) void s.dap.setExceptionBreakpoints(filters).catch(() => {});
}

async function sendBreakpoints(s: Session, path: string) {
  const active = get().breakpointsActive;
  const list = get().breakpoints.filter((b) => b.path === path && b.enabled && active);
  const caps = s.dap.capabilities;
  try {
    const result = await s.dap.setBreakpoints(
      { path: absPath(s, path), name: basename(path) },
      list.map((b) => ({
        line: b.line,
        condition: caps.supportsConditionalBreakpoints ? b.condition || undefined : undefined,
        hitCondition: caps.supportsHitConditionalBreakpoints ? b.hitCondition || undefined : undefined,
        logMessage: caps.supportsLogPoints ? b.logMessage || undefined : undefined,
      })),
    );
    // Only the most specific session (the child, for js-debug) decides how a breakpoint looks.
    const authoritative = ![...sessions.values()].some((x) => x.parent === s && x.configured);
    list.forEach((b, i) => {
      const r = result[i];
      if (!r) return;
      if (r.id != null) s.bpIds.set(r.id, b.id);
      if (authoritative) updateBreakpoint(b.id, { verified: r.verified, message: r.message, ...(r.line && r.line !== b.line ? { line: r.line } : {}) }, false);
    });
  } catch (e) {
    log("Debug", `setBreakpoints ${path}: ${String((e as Error)?.message ?? e)}`, "warn");
  }
}

async function sendAllBreakpoints(s: Session) {
  const paths = [...new Set(get().breakpoints.map((b) => b.path))];
  // Adapters that remember breakpoints per source also need to hear about emptied files.
  await Promise.all(paths.map((p) => sendBreakpoints(s, p)));
}

// ───────────────────────────── persistence ─────────────────────────────

interface Persisted {
  breakpoints: Omit<BreakpointModel, "verified" | "message">[];
  watches: string[];
  selected: string | null;
  filters: Record<string, boolean>;
  breakpointsActive: boolean;
}

let savedFilters: Record<string, boolean> = {};
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let loadedRoot: string | null = null;
const keyFor = (root: string) => `debug:${root}`;

function persist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const root = useWorkbench.getState().workspace?.root;
    if (!root || root !== loadedRoot || root.startsWith("memory://exam")) return;
    const s = get();
    const data: Persisted = {
      breakpoints: s.breakpoints.map(({ verified: _v, message: _m, ...b }) => {
        void _v;
        void _m;
        return b;
      }),
      watches: s.watches.map((w) => w.expression),
      selected: s.selected,
      filters: savedFilters,
      breakpointsActive: s.breakpointsActive,
    };
    void getPlatform().store.set(keyFor(root), data);
  }, 150);
}

async function loadWorkspaceState(root: string | null) {
  if (isDebugging()) await stopDebugging();
  loadedRoot = root;
  savedFilters = {};
  set({ breakpoints: [], watches: [], selected: null, configs: [], launchError: null, breakpointsActive: true });
  if (!root) return;
  const data = await getPlatform()
    .store.get<Persisted>(keyFor(root))
    .catch(() => undefined);
  if (data && loadedRoot === root) {
    savedFilters = data.filters ?? {};
    set({
      breakpoints: (data.breakpoints ?? []).map((b) => ({ ...b, id: `bp${++bpSeq}`, verified: null })),
      watches: (data.watches ?? []).map((expression) => ({ id: ++watchSeq, expression })),
      selected: data.selected ?? null,
      breakpointsActive: data.breakpointsActive ?? true,
    });
  }
  await loadLaunchConfigs();
}

let wired = false;

/** Loads breakpoints, watches and launch.json per folder; stops debugging when an exam starts. */
export function wireDebugServices() {
  if (wired) return;
  wired = true;
  let root = useWorkbench.getState().workspace?.root ?? null;
  void loadWorkspaceState(root);
  useWorkbench.subscribe((s) => {
    const next = s.workspace?.root ?? null;
    if (next !== root) {
      root = next;
      void loadWorkspaceState(next);
    }
  });
  onDocumentChanged((path) => {
    if (path === LAUNCH_FILE && !useWorkbench.getState().dirty[path]) void loadLaunchConfigs();
  });
  useExam.subscribe((s, prev) => {
    if (s.phase !== prev.phase && !debugAllowed() && isDebugging()) void stopDebugging();
  });
  // The host enforces the exam policy too (the desktop refuses adapters in exam folders unless allowed).
  let allowed: boolean | null = null;
  const applyPolicy = () => {
    const next = useWorkbench.getState().policy.debugger === true;
    if (next !== allowed) {
      allowed = next;
      getPlatform().debug?.setExamPolicy?.(next);
    }
    if (!debugAllowed() && isDebugging()) void stopDebugging();
  };
  applyPolicy();
  useWorkbench.subscribe((s, prev) => {
    if (s.policy !== prev.policy) applyPolicy();
  });
  void loadToolchains();
}

/** For the self-test and e2e: the live session count. */
export function sessionCount() {
  return sessions.size;
}
