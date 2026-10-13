/**
 * Projects described by the Runtime Catalog (CODE_RUNNER_PLAN §11, §12, §15):
 * a kind's restore → build steps run once in a build box with the kind's build
 * limits; the result is snapshotted; the test step (unit tests) runs on top of
 * the build; every I/O run then starts from the snapshot in a clean box.
 *
 * Tools come from the kind's runtime `tools` map (absolute paths), arguments
 * from the catalog plus typed tokens: no shell, no user-supplied commands.
 */
import { detect, entryFor, javaMainClass as catalogMainClass, kindById, languageByKey, type KindDef, type Limits as KindLimits, type Step, type TestStep } from "../../../packages/runtimes/src/index.ts";
import { check, type CheckerSpec } from "./checkers.ts";
import {
  capBytes,
  expectedOf,
  kindUnsupported,
  PROJECT_LIMITS,
  RequestError,
  runtimeUnavailable,
  STDERR_CAP,
  STDOUT_CAP_KB,
  validateFiles,
  validateTests,
  VERDICT,
  type RunLimits,
  type SubmissionFile,
  type TestCase,
  type TestResult,
  type Verdict,
} from "./judge.ts";
import { javaMainClass, languageById } from "./languages.ts";
import { missingPackage, missingPackageMessage, type MissingPackage } from "./packages.ts";
import { restoreSnapshot, toolMounts, type Box, type ExecResult, type Limits, type Mount, type Sandbox } from "./sandbox.ts";
import { entryStem, renderArgs, renderToken, TEST_FILTER, testFilterArgs, type TokenContext } from "./tokens.ts";
import { availability, CATALOG_VERSION, containerCapable, OPTIONAL_TOOLS, runtimeChain, servicesReason, toolPath, type StepName, type Toolchains } from "./toolchains.ts";
import { containerToolchains, imageFor, type ContainerSandbox } from "./containers.ts";
import { parseServices, ServiceError, startService, type ServiceHandle, type ServiceName } from "./services.ts";
import { collectResults, frameworkOf, type TestResult as UnitTestResult } from "./unit.ts";

export type Action = "build" | "run" | "test";
const ACTIONS: Action[] = ["build", "run", "test"];

export interface ProjectRequest {
  /** Catalog kind ("java/maven"); detected from the files when absent. */
  kind?: string;
  /** A catalog language key ("java") narrows detection; a TMCode profile id ("python-3") maps to its single-file kind. */
  language?: string;
  files: SubmissionFile[];
  /** Entry file; found from the kind (manifest / main declaration) when absent. */
  entry?: string;
  /** I/O tests for "run". */
  tests?: TestCase[];
  /** Default: ["build", "run"] with tests, else ["build", "test"] (or ["build", "run"] when the kind has no test step). */
  actions?: Action[];
  /** Overrides for the run step (capped). */
  limits?: Partial<RunLimits>;
  checker?: CheckerSpec;
  /** Only these unit tests (framework syntax: a class, method or pattern). */
  test_filter?: string;
  /** Database sidecars (tier 3): ["postgres"] or ["mysql"]; the kind's own `services` are always added. */
  services?: string[];
}

export interface StepReport {
  step: StepName;
  ok: boolean;
  status: ExecResult["status"];
  exit_code: number | null;
  time_ms: number;
}

export type UnitVerdict = "passed" | "failed" | "error" | "time-limit" | "memory-limit" | "package-not-available" | "internal-error";

export interface UnitResult {
  framework: string;
  report: string;
  /** passed: every test passed and the step exited 0; failed: some test failed; otherwise why there are no results. */
  verdict: UnitVerdict;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Tests that errored (JUnit <error>, crashed before asserting). */
  errors: number;
  exit_code: number | null;
  time_ms: number;
  /** The step's output (compiler errors, framework summary), 64 KB max. */
  output: string;
  truncated: boolean;
  tests: UnitTestResult[];
}

export interface ProjectResponse {
  kind: string;
  language: string;
  entry: string | null;
  sandbox: "isolate" | "none" | "container";
  catalog_version: string;
  /** Database sidecars this run had (tier 3). */
  services?: ServiceName[];
  actions: Action[];
  /** Restore + build output (null when the kind has neither). */
  compile: { ok: boolean; output: string; time_ms: number } | null;
  steps: StepReport[];
  tests: TestResult[];
  unit: UnitResult | null;
  error?: { code: "PACKAGE_NOT_AVAILABLE"; manager: string; package: string | null; message: string };
}

/** A TMCode profile request (`language: "python-3"`, no kind). */
export function isProfileRequest(r: { kind?: unknown; language?: unknown }) {
  return (r.kind === undefined || r.kind === null) && typeof r.language === "string" && !!languageById(r.language);
}

/** TMCode profile ids (legacy `language`) → their single-file kinds. */
export const PROFILE_KINDS: Record<string, string> = {
  "python-3": "python/single",
  "node-22": "js/single",
  typescript: "ts/single",
  c17: "c/single",
  cpp17: "cpp/single",
  "java-21": "java/single",
};

const DEFAULT_RUN: KindLimits = { cpu_s: 5, wall_s: 10, memory_mb: 256, processes: 16 };
const DEFAULT_BUILD: KindLimits = { cpu_s: 60, wall_s: 120, memory_mb: 1024, processes: 128, disk_mb: 1024 };
/** Whole request (all steps and runs together), seconds. */
export const DEFAULT_BUDGET_S = 120;

interface Resolved {
  kind: KindDef;
  entry: string | null;
  actions: Action[];
  tests: TestCase[];
  /** Database sidecars (the kind's plus the request's). */
  services: ServiceName[];
  /** Runs in tier 3: a container kind, or a kind that asked for a database. */
  container: boolean;
}

export interface ResolveOptions {
  /** Run in a container even when the kind's tier is isolate (PTY sessions). */
  container?: "pty";
}

export function resolveProject(tc: Toolchains, req: ProjectRequest, opts: ResolveOptions = {}): Resolved {
  validateFiles(req.files, { ...PROJECT_LIMITS, tests: 60, inputBytes: 256 * 1024 }, true);
  const paths = req.files.map((f) => f.path);
  const read = (p: string) => req.files.find((f) => f.path === p)?.content ?? null;

  let kind: KindDef | null = null;
  if (req.kind !== undefined) {
    if (typeof req.kind !== "string") throw new RequestError("kind must be a string.");
    kind = kindById(req.kind);
    if (!kind) throw kindUnsupported(`Unknown project kind '${req.kind}'.`);
  } else if (req.language && PROFILE_KINDS[req.language]) {
    kind = kindById(PROFILE_KINDS[req.language])!;
  } else {
    const language = req.language;
    if (language !== undefined && language !== null && (typeof language !== "string" || !languageByKey(language))) throw new RequestError(`Unsupported language '${language}'.`);
    const ranked = detect(paths, read).filter((d) => !language || d.language === language);
    const candidates = ranked.map((d) => kindById(d.kind)!).filter((k) => availability(tc, k).available || (!!opts.container && containerCapable(tc, k)));
    // A run needs a run step: a framework kind without one (Spring Boot: serve/test) yields to its build tool's kind.
    const wantRun = (req.actions ?? []).includes("run") || (!req.actions && !!req.tests?.length);
    const usable = (wantRun && candidates.find((k) => k.steps.run)) || candidates[0];
    if (!usable) throw kindUnsupported(ranked.length ? `This runner can't run ${ranked[0].label} projects.` : "Could not tell what kind of project this is (no known build file or source files).");
    kind = usable;
  }
  return resolveFor(tc, kind, req, paths, read, opts);
}

function resolveFor(tc: Toolchains, kind: KindDef, req: ProjectRequest, paths: string[], read: (p: string) => string | null, opts: ResolveOptions): Resolved {
  const services = [...new Set([...(kind.services ?? []), ...parseServices(req.services)])];
  if (services.length > 1) throw new RequestError("At most one database service per run.");
  const container = kind.tier === "container" || services.length > 0 || !!opts.container;
  if (kind.tier !== "container" && container) {
    // A database needs a network, a terminal needs Docker's TTY: the kind runs in a container instead of isolate.
    if (!containerCapable(tc, kind)) {
      const why = `${kind.label}: ${opts.container === "pty" ? "a terminal needs" : "databases need"} the container tier with an image for ${kind.runtime}, which this runner doesn't have.`;
      throw Object.assign(kindUnsupported(why), opts.container === "pty" ? { code: "PTY_UNAVAILABLE" } : {});
    }
    const why = servicesReason(tc, services);
    if (why) throw kindUnsupported(`${kind.label}: ${why}.`);
  } else {
    const a = availability(tc, kind);
    if (a.reason) throw kindUnsupported(`${kind.label}: ${a.reason}.`);
    if (!a.available) throw runtimeUnavailable(`The runner has no ${a.missing.join(", ")} installed (${kind.runtime}).`);
  }

  const tests = req.tests ?? [];
  validateTests(tests, req.checker, false);

  let actions: Action[];
  if (req.actions !== undefined) {
    if (!Array.isArray(req.actions) || !req.actions.length || req.actions.some((x) => !ACTIONS.includes(x))) throw new RequestError(`actions must be a non-empty list of ${ACTIONS.join(", ")}.`);
    actions = ACTIONS.filter((x) => req.actions!.includes(x));
  } else if (tests.length) actions = ["build", "run"];
  else actions = kind.steps.test ? ["build", "test"] : ["build", "run"];
  if (actions.includes("run") && !kind.steps.run) throw kindUnsupported(`${kind.label} has no run step (try actions ["build", "test"]).`);
  if (actions.includes("test") && !kind.steps.test) throw kindUnsupported(`${kind.label} has no unit-test step.`);
  if (req.test_filter !== undefined && req.test_filter !== null && (typeof req.test_filter !== "string" || (req.test_filter && !TEST_FILTER.test(req.test_filter)))) {
    throw new RequestError("test_filter may only contain letters, digits and . * # : / $ - [ ] spaces.");
  }

  let entry: string | null = null;
  if (req.entry !== undefined && req.entry !== null && req.entry !== "") {
    if (!paths.includes(req.entry)) throw new RequestError(`Entry '${req.entry}' is not among the files.`);
    entry = req.entry;
  } else entry = entryFor(kind, paths, read);
  const needsEntry = (s: Step | undefined) => !!s && [...s.args, ...(s.stdin ? [s.stdin] : [])].some((t) => typeof t === "object" && ("entry" in t || "entry_stem" in t || "main_class" in t));
  if (!entry && actions.some((x) => (x === "run" ? needsEntry(kind.steps.run) : x === "build" ? needsEntry(kind.steps.build) : needsEntry(kind.steps.test)))) {
    throw new RequestError(`No entry file found for ${kind.label}; pass "entry".`);
  }
  return { kind, entry, actions, tests, services, container };
}

/** Kind limits for a step, with the tier's defaults filled in. */
function kindLimits(kind: KindDef, step: StepName | "serve"): KindLimits {
  const fallback = step === "run" ? DEFAULT_RUN : DEFAULT_BUILD;
  return { ...fallback, ...(kind.limits[step] ?? {}) };
}

export function buildLimits(kind: KindDef, step: StepName | "serve"): Limits {
  const l = kindLimits(kind, step);
  return {
    cpuS: l.cpu_s!,
    wallS: l.wall_s ?? l.cpu_s! * 2,
    memoryMb: l.memory_mb!,
    processes: l.processes ?? 128,
    // Build tools can be chatty; test steps print reports (go test -json, cargo).
    outputKb: l.output_kb ?? (step === "test" ? 8192 : 4096),
    fileKb: (l.disk_mb ?? 1024) * 1024,
  };
}

/** The run step's limits: the kind's, adjusted by the request within caps (the kind's own values are floors for memory). */
export function runLimits(kind: KindDef, req: Partial<RunLimits> | undefined): Limits {
  const k = kindLimits(kind, "run");
  const cpuCap = Math.max(k.cpu_s ?? 0, 20);
  const wallCap = Math.max(k.wall_s ?? 0, 30);
  const memCap = Math.max(k.memory_mb ?? 0, 1024);
  return {
    cpuS: Math.min(req?.time_s ?? k.cpu_s ?? 5, cpuCap),
    wallS: Math.min(req?.wall_s ?? k.wall_s ?? 10, wallCap),
    memoryMb: Math.min(Math.max(req?.memory_mb ?? k.memory_mb ?? 256, k.memory_mb ?? 0), memCap),
    processes: k.processes ?? 16,
    outputKb: Math.min(req?.output_kb ?? k.output_kb ?? 256, 4096),
    // Project runs (make run, cargo run) may touch build files.
    fileKb: kind.tier === "isolate-build" ? 64 * 1024 : undefined,
  };
}

/** Everything a box needs for this kind: PATH, env, toolchain folders, cache mounts. */
export function boxSetup(tc: Toolchains, kind: KindDef) {
  const chain = runtimeChain(tc, kind.runtime);
  const toolPaths = chain.flatMap((rt) => Object.values(rt.tools)).filter((p): p is string => !!p);
  const binDirs = [...new Set(toolPaths.map((p) => p.slice(0, p.lastIndexOf("/"))))].filter((d) => d && !["/usr/bin", "/bin", "/usr/local/bin"].includes(d));
  const env: Record<string, string> = {};
  for (const rt of [...chain].reverse()) Object.assign(env, rt.def.env ?? {});
  env.PATH = [...binDirs, "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  env.NO_COLOR = "1";
  const mounts: Mount[] = kind.caches.filter((c) => tc.caches.has(c)).map((c) => ({ inside: `/caches/${c}`, host: tc.caches.get(c)! }));
  const dirs = [...new Set(toolPaths.flatMap((p) => toolMounts(p)))];
  return { env, mounts, dirs, fileLocks: !!kind.fileLocks };
}

/** argv for a step: the resolved tool + rendered tokens. An optional wrapper (stdbuf) that isn't installed is dropped. */
export function stepArgv(tc: Toolchains, kind: KindDef, step: Step, ctx: TokenContext): string[] {
  const args = renderArgs(step, ctx);
  const bin = toolPath(tc, kind.runtime, step.tool);
  if (bin) return [bin, ...args];
  if (OPTIONAL_TOOLS.has(step.tool)) {
    const i = args.findIndex((a) => !a.startsWith("-"));
    if (i >= 0) return args.slice(i);
  }
  throw runtimeUnavailable(`The runner has no ${step.tool} installed (${kind.runtime}).`);
}

/** Files the judge adds for a mounted cache layer (Cargo: point crates.io at the vendored folder). */
export function cacheFiles(kind: KindDef, mounts: Mount[], box: Pick<Box, "visible">, files: SubmissionFile[]): SubmissionFile[] {
  const out: SubmissionFile[] = [];
  const cargo = mounts.find((m) => m.inside.startsWith("/caches/cargo-registry"));
  if (cargo && kind.runtime.startsWith("rust") && !files.some((f) => f.path === ".cargo/config.toml" || f.path === ".cargo/config")) {
    out.push({
      path: ".cargo/config.toml",
      content: `# Added by tm-judge: crates come from the school's offline registry.\n[source.crates-io]\nreplace-with = "nga-school"\n\n[source.nga-school]\ndirectory = "${box.visible(cargo.inside)}"\n\n[net]\noffline = true\n`,
    });
  }
  return out;
}

export function mainClassOf(entry: string | null, files: SubmissionFile[]) {
  if (!entry) return "";
  const src = files.find((f) => f.path === entry)?.content ?? "";
  // Java: comments/annotations-aware (judge); Kotlin: MainKt naming (catalog).
  return entry.endsWith(".java") ? javaMainClass(entryStem(entry), src) : catalogMainClass(entry, src);
}

const ok = (r: ExecResult) => r.status === "ok" && r.exitCode === 0;

/** The JVM announces JAVA_TOOL_OPTIONS on every start; that line is ours, not the program's. */
const JVM_NOTICE = /^Picked up (?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS): .*(?:\r?\n|$)/gm;
export function quiet(r: ExecResult): ExecResult {
  return r.stderr.includes("Picked up ") ? { ...r, stderr: r.stderr.replace(JVM_NOTICE, "") } : r;
}

export function stepFailureText(name: StepName, r: ExecResult, limits: Limits) {
  const out = `${r.stdout}${r.stdout && r.stderr ? "\n" : ""}${r.stderr}`.trim();
  const why =
    r.status === "timeout"
      ? `The ${name} step was stopped: time limit (${limits.wallS} s).`
      : r.status === "memory"
        ? `The ${name} step was stopped: memory limit (${limits.memoryMb} MB).`
        : r.status === "output-limit"
          ? `The ${name} step printed too much output.`
          : r.status === "internal"
            ? `The ${name} step could not run: ${r.message ?? "sandbox error"}.`
            : "";
  return [out, why].filter(Boolean).join("\n");
}

export interface ProjectEnv {
  toolchains: Toolchains;
  /** Seconds for the whole request (default 120). */
  budgetS?: number;
  /** Tier 3, when this runner has it. */
  containers?: ContainerSandbox;
}

/** Where a resolved project runs: isolate (or the dev sandbox), or a container from its runtime's image. */
export function placement(sandbox: Sandbox, env: Pick<ProjectEnv, "toolchains" | "containers">, r: Pick<Resolved, "kind" | "container">) {
  if (!r.container) return { sandbox, toolchains: env.toolchains, image: undefined as string | undefined };
  const image = imageFor(env.toolchains.containers, r.kind.runtime);
  if (!env.containers || !image) throw runtimeUnavailable(`The runner's container tier is not available for ${r.kind.label}.`);
  return { sandbox: env.containers as Sandbox, toolchains: containerToolchains(env.toolchains), image };
}

/** Starts a run's database sidecar; a failure becomes the run's compile output. */
export async function startServices(env: Pick<ProjectEnv, "containers">, services: ServiceName[], files: SubmissionFile[], network?: string): Promise<ServiceHandle | null> {
  if (!services.length) return null;
  if (!env.containers) throw runtimeUnavailable("Databases need the runner's container tier.");
  return startService(env.containers.docker, env.containers.cfg, services[0], files, { network });
}

export async function runProject(sandbox: Sandbox, env: ProjectEnv, req: ProjectRequest): Promise<ProjectResponse> {
  const resolved = resolveProject(env.toolchains, req);
  const { kind, entry, actions, tests, services } = resolved;
  const where = placement(sandbox, env, resolved);
  const tc = where.toolchains;
  const setup = boxSetup(tc, kind);
  const testStep = kind.steps.test as TestStep | undefined;
  const reportPath = testStep?.path ?? (testStep?.args.some((t) => typeof t === "object" && "report_path" in t) ? "test-report.xml" : null);
  const ctx: TokenContext = {
    entry: entry ?? "",
    files: req.files.map((f) => f.path),
    mainClass: mainClassOf(entry, req.files),
    testFilter: testStep ? testFilterArgs(testStep.tool, req.test_filter) : [],
    reportPath,
  };
  const deadline = Date.now() + (env.budgetS ?? DEFAULT_BUDGET_S) * 1000;
  const within = (l: Limits): Limits | null => {
    const left = (deadline - Date.now()) / 1000;
    if (left < 1) return null;
    const wallS = Math.min(l.wallS, Math.floor(left));
    return { ...l, wallS, cpuS: Math.min(l.cpuS, wallS) };
  };
  const overBudget = (): ExecResult => ({ status: "timeout", exitCode: null, stdout: "", stderr: `Stopped: the request used its whole time budget (${env.budgetS ?? DEFAULT_BUDGET_S} s).`, timeMs: 0, memoryKb: null, message: "budget" });
  const exists = (p: string) => req.files.some((f) => f.path === p);
  const runsHere = (s: Step | undefined): s is Step => !!s && (!s.when || s.when.exists.every(exists));
  let db: ServiceHandle | null = null;
  const stepEnv = (s: Step) => ({ ...setup.env, ...(db?.env ?? {}), ...(s.env ?? {}) });

  const response: ProjectResponse = {
    kind: kind.id,
    language: kind.language,
    entry,
    sandbox: where.sandbox.kind,
    catalog_version: CATALOG_VERSION,
    ...(services.length ? { services } : {}),
    actions,
    compile: null,
    steps: [],
    tests: [],
    unit: null,
  };
  const ioTests: TestCase[] = actions.includes("run") ? (tests.length ? tests : [{ id: "run", input: "" }]) : [];
  const fail = (verdict: Verdict, text: string): TestResult[] => {
    const stderr = capBytes(text, STDERR_CAP);
    return ioTests.map((t) => ({ id: String(t.id), verdict, passed: false, stdout: "", stderr: stderr.text, exit_code: null, time_ms: 0, memory_kb: null, truncated: stderr.cut }));
  };
  const serviceFailed = (e: ServiceError) => {
    const output = capBytes([e.message, e.output].filter(Boolean).join("\n"), STDERR_CAP).text;
    response.compile = { ok: false, output, time_ms: 0 };
    response.tests = fail("compile-error", output);
    if (actions.includes("test") && testStep) response.unit = emptyUnit(kind, testStep, "error", null, output);
    return response;
  };
  try {
    db = await startServices(env, services, req.files);
    await db?.fresh();
  } catch (e) {
    await db?.dispose();
    if (e instanceof ServiceError) return serviceFailed(e);
    throw e;
  }

  let box: Box;
  try {
    box = await where.sandbox.acquire({ mounts: setup.mounts, dirs: setup.dirs, fileLocks: setup.fileLocks, image: where.image, network: db?.network });
  } catch (e) {
    await db?.dispose();
    throw e;
  }
  // A report the submission brought along must never count as results.
  const isReport = (p: string) => !!reportPath && (p === reportPath || p.startsWith(`${reportPath.replace(/\/+$/, "")}/`));
  const writeProject = async () => {
    for (const f of req.files) if (!isReport(f.path)) await box.write(f.path, f.content);
    for (const f of cacheFiles(kind, setup.mounts, box, req.files)) await box.write(f.path, f.content);
  };
  const exec = async (s: Step, limits: Limits, stdin: string): Promise<ExecResult> => {
    const l = within(limits);
    if (!l) return overBudget();
    return quiet(await box.exec(stepArgv(tc, kind, s, ctx), { stdin, limits: l, env: stepEnv(s), cwd: s.cwd }));
  };

  const setMissing = (m: MissingPackage) => {
    response.error = { code: "PACKAGE_NOT_AVAILABLE", manager: m.manager, package: m.package, message: missingPackageMessage(m) };
  };

  try {
    await writeProject();

    // ── build box: restore → build ──
    const buildSteps: StepName[] = ["restore", ...(actions.includes("build") || actions.includes("run") ? (["build"] as StepName[]) : [])];
    let compileOut = "";
    let compileMs = 0;
    for (const name of buildSteps) {
      const s = kind.steps[name] as Step | undefined;
      if (!runsHere(s)) continue;
      const limits = buildLimits(kind, name);
      const r = await exec(s, limits, "");
      response.steps.push({ step: name, ok: ok(r), status: r.status, exit_code: r.exitCode, time_ms: r.timeMs });
      compileMs += r.timeMs;
      const text = stepFailureText(name, r, limits);
      if (!ok(r)) {
        const output = capBytes([compileOut, text].filter(Boolean).join("\n"), STDERR_CAP).text;
        response.compile = { ok: false, output: output || `The ${name} step failed.`, time_ms: compileMs };
        const missing = missingPackage(`${r.stdout}\n${r.stderr}`);
        if (missing) setMissing(missing);
        response.tests = fail(missing ? "package-not-available" : "compile-error", response.error?.message ? `${response.error.message}\n\n${output}` : output);
        if (actions.includes("test")) response.unit = emptyUnit(kind, testStep!, missing ? "package-not-available" : r.status === "internal" ? "internal-error" : "error", r, response.compile.output);
        return response;
      }
      compileOut = [compileOut, `${r.stdout}${r.stderr}`.trim()].filter(Boolean).join("\n");
      response.compile = { ok: true, output: capBytes(compileOut, STDERR_CAP).text, time_ms: compileMs };
    }

    // Every run starts from this state (sources + build outputs).
    const snapshot = ioTests.length ? await box.snapshot() : [];
    let dirty = false;

    // ── unit tests, on top of the build ──
    if (actions.includes("test") && testStep) {
      const limits = buildLimits(kind, "test");
      const r = await exec(testStep, limits, "");
      dirty = true;
      response.steps.push({ step: "test", ok: ok(r), status: r.status, exit_code: r.exitCode, time_ms: r.timeMs });
      const results = await collectResults(testStep.report, reportPath ?? undefined, r, box, box.visible("/box"), `${testStep.tool} ${kind.steps.test!.args.filter((a) => typeof a === "string").slice(0, 2).join(" ")}`.trim());
      response.unit = unitFrom(kind, testStep, r, results, limits);
      if (response.unit.verdict === "package-not-available") {
        const m = missingPackage(`${r.stdout}\n${r.stderr}`);
        if (m) setMissing(m);
      }
    }

    // ── I/O runs, each in a clean box ──
    if (ioTests.length) {
      const run = kind.steps.run!;
      const limits = runLimits(kind, req.limits);
      const stdoutCap = Math.min(limits.outputKb, STDOUT_CAP_KB) * 1024;
      const fixedStdin = run.stdin ? renderToken(run.stdin, ctx)[0] : null;
      for (const t of ioTests) {
        if (dirty) {
          await box.reset();
          await restoreSnapshot(box, snapshot);
          // Fresh state includes the database.
          try {
            await db?.fresh();
          } catch (e) {
            if (!(e instanceof ServiceError)) throw e;
            response.tests.push({ ...fail("internal-error", e.message)[0], id: String(t.id) });
            continue;
          }
        }
        dirty = true;
        let stdin = String(t.input ?? "");
        if (fixedStdin) stdin = (await box.read(fixedStdin))?.toString("utf8") ?? "";
        const r = await exec(run, limits, stdin);
        let verdict = VERDICT[r.status];
        if (verdict === "ok" && r.exitCode !== 0) verdict = "runtime-error";
        let passed: boolean | null = null;
        const expected = expectedOf(t);
        if (expected !== undefined) {
          passed = verdict === "ok" && check(t.checker ?? req.checker, expected, r.stdout);
          if (verdict === "ok") verdict = passed ? "accepted" : "wrong-answer";
          else passed = false;
        }
        const stdout = capBytes(r.stdout, stdoutCap);
        const stderr = capBytes(r.stderr, STDERR_CAP);
        response.tests.push({
          id: String(t.id),
          verdict,
          passed,
          stdout: stdout.text,
          stderr: stderr.text,
          exit_code: r.exitCode,
          time_ms: r.timeMs,
          memory_kb: r.memoryKb,
          truncated: stdout.cut || stderr.cut || !!r.stderrTruncated || r.status === "output-limit",
        });
      }
    }
    return response;
  } finally {
    await box.dispose();
    await db?.dispose();
  }
}


function emptyUnit(kind: KindDef, step: TestStep, verdict: UnitVerdict, r: ExecResult | null, output: string): UnitResult {
  return {
    framework: frameworkOf(step.tool, kind.id),
    report: step.report,
    verdict,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    exit_code: r?.exitCode ?? null,
    time_ms: 0,
    output: capBytes(output, STDERR_CAP).text,
    truncated: Buffer.byteLength(output) > STDERR_CAP,
    tests: [],
  };
}

export function unitFrom(kind: KindDef, step: TestStep, r: ExecResult, results: UnitTestResult[], limits: Limits): UnitResult {
  const counts = { total: results.length, passed: 0, failed: 0, skipped: 0, error: 0 };
  for (const t of results) counts[t.status]++;
  const text = stepFailureText("test", r, limits);
  const out = capBytes(text, STDERR_CAP);
  let verdict: UnitVerdict;
  if (results.length) verdict = counts.failed + counts.error > 0 ? "failed" : ok(r) ? "passed" : r.status === "timeout" ? "time-limit" : r.status === "memory" ? "memory-limit" : "failed";
  else if (missingPackage(`${r.stdout}\n${r.stderr}`)) verdict = "package-not-available";
  else if (r.status === "timeout") verdict = "time-limit";
  else if (r.status === "memory") verdict = "memory-limit";
  else if (r.status === "internal") verdict = "internal-error";
  else verdict = "error";
  return {
    framework: frameworkOf(step.tool, kind.id),
    report: step.report,
    verdict,
    total: counts.total,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    errors: counts.error,
    exit_code: r.exitCode,
    time_ms: r.timeMs,
    output: out.text,
    truncated: out.cut || !!r.stderrTruncated || r.status === "output-limit",
    tests: results,
  };
}

