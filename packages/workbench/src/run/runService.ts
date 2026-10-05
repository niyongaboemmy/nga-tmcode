import { profileById, profileForPath } from "@tmcode/profiles";
import type { Profile } from "@tmcode/protocol";
import { ensureDocument, saveAll } from "../monaco/documents";
import { monaco } from "../monaco/setup";
import type { RunEvent, RunHandle, RunRequest } from "../platform/types";
import { getPlatform, log, notify, openEditorInput, setRunState, showPanel, useWorkbench } from "../state/store";
import { basename, dirname, extname, join } from "../util/paths";
import { parseDiagnostics, toWorkspacePath } from "./diagnostics";

export type RunTarget =
  | { kind: "program"; profile: Profile; entry: string }
  | { kind: "preview"; profile: Profile; root: string; entry: string };

const MARKER_OWNER = "tmcode-run";

async function hasFile(dir: string, name: string) {
  const cached = useWorkbench.getState().dirs[dir];
  const list = cached ?? (await getPlatform().fs.readDir(dir).catch(() => []));
  return list.some((e) => e.kind === "file" && e.name.toLowerCase() === name);
}

/** The nearest folder at or above `dir` that holds an index.html (a web project root). */
async function webRootFor(dir: string): Promise<string | null> {
  let d: string | null = dir;
  while (d !== null) {
    if (await hasFile(d, "index.html")) return d;
    d = d === "" ? null : dirname(d);
  }
  return null;
}

/** Works out what "Run" means for a file: run a program, or open a web preview. */
export async function targetFor(path: string): Promise<RunTarget | null> {
  const ext = extname(path);
  const web = profileById("web")!;
  if (ext === "html" || ext === "htm") return { kind: "preview", profile: web, root: dirname(path), entry: basename(path) };
  if (ext === "jsx" || ext === "tsx") {
    const root = await webRootFor(dirname(path));
    return root === null ? null : { kind: "preview", profile: profileById("react")!, root, entry: "index.html" };
  }
  if (ext === "css" || ext === "js") {
    const root = await webRootFor(dirname(path));
    // A script beside a web page belongs to the page; a lone .js file is a Node program.
    if (root !== null) return { kind: "preview", profile: web, root, entry: "index.html" };
    if (ext === "css") return null;
  }
  const profile = profileForPath(path);
  if (!profile?.local) return null;
  return { kind: "program", profile, entry: path };
}

// ───────────── run output (replayed to the Run panel when it mounts) ─────────────

export type ConsoleEvent = RunEvent | { type: "clear" } | { type: "info"; text: string };
const listeners = new Set<(e: ConsoleEvent) => void>();
const transcript: ConsoleEvent[] = [];

function emit(e: ConsoleEvent) {
  if (e.type === "clear") transcript.length = 0;
  else transcript.push(e);
  if (transcript.length > 5000) transcript.splice(0, transcript.length - 5000);
  listeners.forEach((l) => l(e));
}

export function clearConsole() {
  emit({ type: "clear" });
}

export function onConsole(l: (e: ConsoleEvent) => void) {
  transcript.forEach(l);
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ───────────── diagnostics → editor markers ─────────────

export function clearRunMarkers() {
  for (const m of monaco.editor.getModels()) monaco.editor.setModelMarkers(m, MARKER_OWNER, []);
}

async function showDiagnostics(output: string, entry: string) {
  const ws = useWorkbench.getState().workspace;
  if (!ws) return 0;
  const byFile = new Map<string, monaco.editor.IMarkerData[]>();
  for (const d of parseDiagnostics(output)) {
    const path = toWorkspacePath(d.file, ws.root, dirname(entry));
    if (path === null) continue;
    const list = byFile.get(path) ?? [];
    list.push({
      severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: d.message,
      source: d.source,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.line,
      endColumn: d.column + 1 < 2 ? 1000 : d.column + 1,
    });
    byFile.set(path, list);
  }
  for (const [path, markers] of byFile) {
    const model = await ensureDocument(path).catch(() => null);
    if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  }
  return byFile.size;
}

// ───────────── running ─────────────

let current: RunHandle | null = null;
const runStarted = new Set<(entry: string) => void>();
/** Exams snapshot exactly the code that was run. */
export function onRunStarted(l: (entry: string) => void) {
  runStarted.add(l);
  return () => {
    runStarted.delete(l);
  };
}
let consoleSize = { cols: 100, rows: 24 };

/** The Run console reports its size so interactive programs wrap at the right column. */
export function setConsoleSize(cols: number, rows: number) {
  consoleSize = { cols, rows };
}

export function isRunning() {
  return useWorkbench.getState().run.status !== "idle";
}

export function stopRun() {
  current?.kill();
}

export function sendRunInput(data: string) {
  current?.input(data);
}

/** Starts a request and resolves with its exit event (used by the test runner too). */
export function startRun(req: RunRequest, onEvent: (e: RunEvent) => void): Promise<{ handle: RunHandle; done: Promise<Extract<RunEvent, { type: "exit" }>> }> {
  const runner = getPlatform().runner;
  if (!runner) return Promise.reject(new Error("Running code is not available here. Use the TMCode desktop app."));
  let resolveDone!: (e: Extract<RunEvent, { type: "exit" }>) => void;
  const done = new Promise<Extract<RunEvent, { type: "exit" }>>((r) => (resolveDone = r));
  return runner
    .start(req, (e) => {
      onEvent(e);
      // A failed build ends the run as well.
      if (e.type === "exit" && (e.phase === "run" || e.code !== 0)) resolveDone(e);
    })
    .then((handle) => ({ handle, done }));
}

export async function runFile(path: string) {
  await saveAll();
  const target = await targetFor(path);
  if (!target) {
    notify("info", `TMCode doesn't know how to run '${basename(path)}'. Open a .py, .js, .ts, .c, .cpp, .java or .html file.`);
    return;
  }
  if (target.kind === "preview") {
    openPreview(target.root, target.entry, target.profile.preview ?? "static");
    return;
  }
  const runner = getPlatform().runner;
  if (!runner) {
    notify("warning", `${target.profile.label} programs run in the TMCode desktop app.`);
    return;
  }
  if (current) {
    current.kill();
    current = null;
  }
  const local = target.profile.local!;
  runStarted.forEach((l) => l(target.entry));
  clearRunMarkers();
  emit({ type: "clear" });
  showPanel("run");
  const label = `${target.profile.label}: ${basename(target.entry)}`;
  setRunState({ status: local.build.length ? "building" : "running", entry: target.entry, label, lastExit: null });
  if (!runner.interactive) {
    emit({ type: "info", text: "Running in the browser: the program gets no keyboard input. Use the Testing view to run it with input, or the TMCode desktop app for interactive programs." });
  }
  log("Run", `Run ${target.entry} (${target.profile.id})`);

  let buildOut = "";
  let runTail = "";
  let phase: "build" | "run" = local.build.length ? "build" : "run";
  try {
    const { handle, done } = await startRun(
      {
        entry: target.entry,
        build: local.build,
        run: local.run,
        mode: runner.interactive ? "pty" : "pipe",
        stdin: "",
        timeout_ms: runner.interactive ? undefined : target.profile.limits.wall_s * 1000,
        output_limit_kb: target.profile.limits.output_kb,
        cols: consoleSize.cols,
        rows: consoleSize.rows,
      },
      (e) => {
        emit(e);
        if (e.type === "step") {
          phase = e.phase;
          if (e.phase === "run") setRunState({ status: "running" });
        } else if (e.type === "stdout" || e.type === "stderr") {
          if (phase === "build") buildOut += e.data;
          else runTail = (runTail + e.data).slice(-20000);
        } else if (e.type === "error") {
          notify("error", e.message);
        }
      },
    );
    current = handle;
    const exit = await done;
    if (current === handle) current = null;
    setRunState({ status: "idle", lastExit: { code: exit.code, timed_out: exit.timed_out, killed: exit.killed, duration_ms: exit.duration_ms } });
    if (exit.phase === "build" && exit.code !== 0) {
      const files = await showDiagnostics(buildOut, target.entry);
      if (files) showPanel("problems");
    } else if (exit.code !== 0 && !exit.killed) {
      await showDiagnostics(runTail.replace(/\x1b\[[0-9;]*m/g, ""), target.entry);
    }
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    emit({ type: "error", message });
    setRunState({ status: "idle" });
    notify("error", message, message.includes("could not find")
      ? [{ label: "Refresh Toolchains", run: () => void refreshToolchains() }]
      : undefined);
  }
}

export async function refreshToolchains() {
  const runner = getPlatform().runner;
  if (!runner) return [];
  const list = await runner.detect(true);
  emit({ type: "info", text: `Toolchains: ${list.map((t) => `${t.tool} → ${t.version}`).join(", ") || "none found"}` });
  log("Toolchains", list.map((t) => `${t.tool}: ${t.path} (${t.version})`).join("; ") || "none found");
  notify("info", list.length ? `Found ${list.length} toolchain${list.length > 1 ? "s" : ""}: ${list.map((t) => t.tool).join(", ")}.` : "No compilers or interpreters were found.");
  return list;
}

/**
 * One preview column, like VS Code's Live Preview: a new preview replaces the
 * one already showing (in its group); otherwise it opens to the side.
 */
export function openPreview(root: string, entry: string, profile: "static" | "bundle-react") {
  const input = { kind: "preview" as const, id: `preview:${join(root, entry)}`, root, entry, profile, preview: false as const };
  const { groups } = useWorkbench.getState();
  const host = groups.find((g) => g.editors.some((e) => e.kind === "preview"));
  if (!host) return openEditorInput(input, { toSide: true });
  const old = host.editors.find((e) => e.kind === "preview")!;
  useWorkbench.setState({
    groups: groups.map((g) =>
      g === host
        ? { ...g, editors: g.editors.some((e) => e.id === input.id) ? g.editors : g.editors.map((e) => (e === old ? input : e)), activeId: input.id }
        : g,
    ),
  });
}
