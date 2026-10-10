import { monaco } from "./setup";
import { getPlatform, log, onEntryDeleted, onEntryRenamed, onWorkspaceChanged, useWorkbench } from "../state/store";
import { beginActivity } from "../state/activity";
import { getDocument, onDocumentSaved, uriFor } from "./documents";
import { onExternalChanges } from "./external";
import { createBudget, isModuleSource, listSources, loadProjectConfig, orderByPreference, planSources, toServiceOptions, type ProjectConfig, type SourcePlan } from "./tsProject";

/**
 * Gives the TypeScript/JavaScript service the project's files that are not
 * open (review V3), as Monaco "extra libs" keyed by the files' own URIs, so
 * `import { x } from "./utils"` resolves, Go to Definition reaches unopened
 * files, and Find References / Rename cover the whole project. The open
 * files' models always win over these copies (Monaco's worker reads models
 * first). Kept in sync with saves, outside changes, renames and deletes.
 */

const CHANNEL = "IntelliSense";

interface Lib {
  size: number;
  ts: monaco.IDisposable;
  js: monaco.IDisposable;
}

const libs = new Map<string, Lib>();
let generation = 0;
let config: ProjectConfig | null = null;
let plan: SourcePlan | null = null;
let budget = createBudget();
let baseline: { ts: Record<string, unknown>; js: Record<string, unknown> } | null = null;
let wired = false;

const ts = () => monaco.typescript;

function addLib(path: string, text: string) {
  const key = uriFor(path).toString();
  const old = libs.get(path);
  if (old) budget.release(old.size);
  if (!budget.take(text.length)) {
    if (old) dropLib(path, false);
    return false;
  }
  // Same key again replaces the earlier copy (Monaco bumps its version).
  libs.set(path, { size: text.length, ts: ts().typescriptDefaults.addExtraLib(text, key), js: ts().javascriptDefaults.addExtraLib(text, key) });
  return true;
}

function dropLib(path: string, release = true) {
  const lib = libs.get(path);
  if (!lib) return;
  if (release) budget.release(lib.size);
  lib.ts.dispose();
  lib.js.dispose();
  libs.delete(path);
}

function clearLibs() {
  for (const p of [...libs.keys()]) dropLib(p, false);
  budget = createBudget();
}

function applyCompilerOptions(cfg: ProjectConfig) {
  const d = ts();
  baseline ??= { ts: d.typescriptDefaults.getCompilerOptions() as Record<string, unknown>, js: d.javascriptDefaults.getCompilerOptions() as Record<string, unknown> };
  const nextTs = toServiceOptions(cfg, baseline.ts);
  const nextJs = cfg.kind ? { ...nextTs, checkJs: nextTs.checkJs === true } : { ...baseline.js };
  // Setting options restarts the worker: only when they changed.
  if (JSON.stringify(nextTs) !== JSON.stringify(d.typescriptDefaults.getCompilerOptions())) d.typescriptDefaults.setCompilerOptions(nextTs as monaco.typescript.CompilerOptions);
  if (JSON.stringify(nextJs) !== JSON.stringify(d.javascriptDefaults.getCompilerOptions())) d.javascriptDefaults.setCompilerOptions(nextJs as monaco.typescript.CompilerOptions);
}

function openPaths() {
  const out: string[] = [];
  for (const g of useWorkbench.getState().groups) for (const e of g.editors) if (e.kind === "file") out.push(e.path);
  return out;
}

const read = (path: string) =>
  getPlatform()
    .fs.readFile(path)
    .catch(() => null);

/** Reads the project config and its files again (folder opened, tsconfig changed). */
export async function loadWorkspaceSources(): Promise<void> {
  wire();
  const ws = useWorkbench.getState().workspace;
  const gen = ++generation;
  clearLibs();
  config = null;
  plan = null;
  if (!ws) return;
  const end = beginActivity("Loading the project for IntelliSense…");
  const started = performance.now();
  try {
    const cfg = await loadProjectConfig(read);
    if (gen !== generation) return;
    for (const w of cfg.warnings) log(CHANNEL, w, "warn");
    applyCompilerOptions(cfg);
    const p = planSources(cfg);
    const candidates = orderByPreference(await listSources((d) => getPlatform().fs.readDir(d), p), openPaths());
    if (gen !== generation) return;
    // Read in small parallel batches; add everything in one go (one update of the worker).
    const texts: { path: string; text: string }[] = [];
    const sizer = createBudget();
    for (let i = 0; i < candidates.length && !sizer.full(); i += 16) {
      const batch = await Promise.all(candidates.slice(i, i + 16).map(async (path) => ({ path, text: await read(path) })));
      if (gen !== generation) return;
      for (const { path, text } of batch) {
        if (text === null || (p.modulesOnly && !isModuleSource(text))) continue;
        if (sizer.take(text.length)) texts.push({ path, text });
      }
    }
    config = cfg;
    plan = p;
    for (const { path, text } of texts) addLib(path, text);
    const mb = (budget.used.bytes / 1024 / 1024).toFixed(1);
    const source = cfg.configPath ? `using ${cfg.configPath}` : "no tsconfig.json or jsconfig.json";
    log(CHANNEL, `Loaded ${libs.size} project files (${mb} MB, ${source}) in ${Math.round(performance.now() - started)} ms.`);
    if (sizer.used.skipped || sizer.full()) log(CHANNEL, `The project is large: files past the first 2,000 (or 20 MB) are not known to IntelliSense until you open them.`, "warn");
  } finally {
    end();
  }
}

/** One file changed on disk (saved, written outside TMCode): update its copy. */
async function refresh(path: string) {
  if (!plan) return;
  if (/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(path)) {
    scheduleReload();
    return;
  }
  if (!plan.accepts(path)) return;
  const gen = generation;
  const text = getDocument(path)?.getValue() ?? (await read(path));
  if (gen !== generation) return;
  if (text === null) {
    dropLib(path);
    return;
  }
  if (plan.modulesOnly && !isModuleSource(text)) {
    dropLib(path);
    return;
  }
  addLib(path, text);
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void loadWorkspaceSources().catch(() => {}), 600);
}

function wire() {
  if (wired) return;
  wired = true;
  onDocumentSaved((path) => void refresh(path));
  onExternalChanges((paths) => {
    for (const p of paths) void refresh(p);
  });
  onEntryDeleted((path) => {
    for (const p of [...libs.keys()]) if (p === path || p.startsWith(`${path}/`)) dropLib(p);
  });
  onEntryRenamed((from, to) => {
    const moved = [...libs.keys()].filter((p) => p === from || p.startsWith(`${from}/`));
    for (const p of moved) dropLib(p);
    if (moved.length > 1 || !/\.[a-z]+$/i.test(to)) scheduleReload();
    else void refresh(to);
  });
  onWorkspaceChanged(() => {
    generation++;
    clearLibs();
    config = null;
    plan = null;
  });
}

/** For tests and the developer self-check: what the service was given. */
export function workspaceSourcesState() {
  return { files: [...libs.keys()].sort(), bytes: budget.used.bytes, config: config?.configPath ?? null };
}
