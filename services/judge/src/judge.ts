import { spawnSync } from "node:child_process";
import { check, checkerProblem, normalizeOutput, type CheckerSpec } from "./checkers.ts";
import { javaMainClass, languageById, LANGUAGES, type Ctx, type Language } from "./languages.ts";
import { restoreSnapshot, type ExecResult, type Limits, type Sandbox } from "./sandbox.ts";

/**
 * Compile once, then run every test (plan §8.3). The judge only executes and
 * compares; scores and points are Task Mentor's business.
 */

export interface SubmissionFile {
  path: string;
  content: string;
}

export interface TestCase {
  id: string;
  input: string;
  /** Omit to just run (status "ok" instead of a verdict). */
  expected_output?: string;
  /** Alias of expected_output (CODE_RUNNER_PLAN §15.1). */
  expected?: string;
  /** Overrides the request's checker for this test. */
  checker?: CheckerSpec;
}

export interface RunLimits {
  time_s: number;
  wall_s: number;
  memory_mb: number;
  output_kb: number;
}

export interface RunRequest {
  language: string;
  files: SubmissionFile[];
  /** Entry file path, e.g. "main.py" or "Main.java". */
  entry: string;
  tests: TestCase[];
  limits?: Partial<RunLimits>;
  /** How stdout is compared with expected_output (default whitespace). */
  checker?: CheckerSpec;
}

export type Verdict =
  | "accepted"
  | "compile-error"
  | "wrong-answer"
  | "ok"
  | "runtime-error"
  | "time-limit"
  | "memory-limit"
  | "output-limit"
  | "package-not-available"
  | "internal-error";

export interface TestResult {
  id: string;
  verdict: Verdict;
  passed: boolean | null;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  time_ms: number;
  memory_kb: number | null;
  /** stdout or stderr was cut (response caps, or the program hit the output limit). */
  truncated: boolean;
}

export interface RunResponse {
  language: string;
  sandbox: "isolate" | "none";
  compile: { ok: boolean; output: string; time_ms: number } | null;
  tests: TestResult[];
}

export { normalizeOutput };

/** Typed HTTP errors (§15.1): 400 INVALID_REQUEST, 409 KIND_UNSUPPORTED, 503 RUNTIME_UNAVAILABLE. */
export class RequestError extends Error {
  status = 400;
  code = "INVALID_REQUEST";
}

export function kindUnsupported(message: string) {
  return Object.assign(new RequestError(message), { status: 409, code: "KIND_UNSUPPORTED" });
}

export function runtimeUnavailable(message: string) {
  return Object.assign(new RequestError(message), { status: 503, code: "RUNTIME_UNAVAILABLE" });
}

const LIMITS = { files: 100, bytes: 1024 * 1024, tests: 60, inputBytes: 256 * 1024 };
/** Projects (kind requests) may carry more files. */
export const PROJECT_LIMITS = { files: 400, bytes: 1536 * 1024 };

/** `strict` (projects): no "." segments and no duplicate paths; the profile path keeps its original rules. */
export function validateFiles(files: SubmissionFile[], max = LIMITS, strict = false) {
  if (!Array.isArray(files) || files.length === 0) throw new RequestError("No files.");
  if (files.length > max.files) throw new RequestError(`At most ${max.files} files.`);
  const total = files.reduce((n, f) => n + Buffer.byteLength(String(f?.content ?? "")), 0);
  if (total > max.bytes) throw new RequestError(`Submission is larger than ${Math.round(max.bytes / 1024 / 1024 * 10) / 10} MB.`);
  const seen = new Set<string>();
  for (const f of files) {
    if (!f || typeof f.path !== "string" || !/^[\w.\-/ @+]+$/.test(f.path) || f.path.startsWith("/") || f.path.split("/").some((p) => !p || p === ".." || (strict && p === "."))) {
      throw new RequestError(`Invalid file path '${f?.path}'.`);
    }
    if (f.content === undefined || f.content === null) f.content = "";
    if (typeof f.content !== "string") throw new RequestError(`File '${f.path}': content must be a string.`);
    if (strict && seen.has(f.path)) throw new RequestError(`File '${f.path}' is listed twice.`);
    seen.add(f.path);
  }
}

export function validateTests(tests: TestCase[], checker: unknown, required: boolean) {
  if (tests === undefined && !required) return;
  if (!Array.isArray(tests) || (required && tests.length === 0)) throw new RequestError("No tests.");
  if (tests.length > LIMITS.tests) throw new RequestError(`At most ${LIMITS.tests} tests.`);
  const problem = checkerProblem(checker);
  if (problem) throw new RequestError(problem);
  for (const t of tests) {
    if (!t || typeof t !== "object") throw new RequestError("Each test must be an object { id, input, expected_output? }.");
    if (Buffer.byteLength(String(t.input ?? "")) > LIMITS.inputBytes) throw new RequestError(`Test ${t.id}: input larger than 256 KB.`);
    const p = checkerProblem(t.checker);
    if (p) throw new RequestError(`Test ${t.id}: ${p}`);
  }
}

/** expected_output, or its alias expected. */
export function expectedOf(t: TestCase): string | undefined {
  return t.expected_output ?? t.expected ?? undefined;
}

export function validate(req: RunRequest): Language {
  const lang = languageById(req.language);
  if (!lang) throw new RequestError(`Unsupported language '${req.language}'.`);
  validateFiles(req.files);
  if (!req.files.some((f) => f.path === req.entry)) throw new RequestError(`Entry '${req.entry}' is not among the files.`);
  validateTests(req.tests, req.checker, true);
  return lang;
}

/** Resolves each language's programs to absolute paths once. */
export function resolvePrograms(): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of new Set(LANGUAGES.flatMap((l) => l.programs))) {
    const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    const path = r.stdout.trim();
    if (r.status === 0 && path.startsWith("/")) found.set(name, path);
  }
  return found;
}

export function languageVersions(programs: Map<string, string>) {
  const out: Record<string, string | null> = {};
  for (const l of LANGUAGES) {
    if (!l.programs.every((p) => programs.has(p))) {
      out[l.id] = null;
      continue;
    }
    const [cmd, ...args] = l.version;
    const r = spawnSync(programs.get(cmd) ?? cmd, args, { encoding: "utf8", timeout: 10_000 });
    out[l.id] = `${r.stdout}${r.stderr}`.split("\n").map((s) => s.trim()).find(Boolean) ?? "unknown";
  }
  return out;
}

/** Response caps: stdout up to the request's output limit (at most 1 MB), stderr and compiler output 64 KB. */
export const STDOUT_CAP_KB = 1024;
export const STDERR_CAP = 64 * 1024;

/** Cuts a string to at most `bytes` UTF-8 bytes (never splitting a character). */
export function capBytes(s: string, bytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(s) <= bytes) return { text: s, cut: false };
  return { text: Buffer.from(s).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/, ""), cut: true };
}

function failedCompile(language: string, kind: RunResponse["sandbox"], compile: NonNullable<RunResponse["compile"]>, tests: TestCase[]): RunResponse {
  const stderr = capBytes(compile.output || "Compilation failed", STDERR_CAP);
  return {
    language,
    sandbox: kind,
    compile,
    tests: tests.map((t) => ({
      id: String(t.id),
      verdict: "compile-error",
      passed: false,
      stdout: "",
      stderr: stderr.text,
      exit_code: null,
      time_ms: 0,
      memory_kb: null,
      truncated: stderr.cut,
    })),
  };
}

/**
 * Transpiles .ts/.mts/.cts files to CommonJS JavaScript with esbuild (a parser
 * only; nothing is executed here). Type errors are not reported, as with
 * Node's own type stripping; syntax errors fail the "compile".
 */
async function transpileTypeScript(files: SubmissionFile[]) {
  const started = Date.now();
  const { transform } = await import("esbuild");
  const out: SubmissionFile[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const m = /\.(c|m)?ts$/.exec(f.path);
    if (!m) continue;
    try {
      const r = await transform(f.content, { loader: "ts", format: "cjs", target: "node20", sourcefile: f.path });
      out.push({ path: f.path.replace(/\.(c|m)?ts$/, `.${m[1] ?? ""}js`), content: r.code });
    } catch (e) {
      const failure = e as { errors?: { text: string; location?: { file: string; line: number; column: number } }[] };
      for (const err of failure.errors ?? [{ text: String(e) }]) {
        errors.push(err.location ? `${err.location.file}:${err.location.line}:${err.location.column + 1}: error: ${err.text}` : err.text);
      }
    }
  }
  return { files: out, errors, timeMs: Date.now() - started };
}

export const VERDICT: Record<ExecResult["status"], Verdict> = {
  ok: "ok",
  "runtime-error": "runtime-error",
  signal: "runtime-error",
  timeout: "time-limit",
  memory: "memory-limit",
  "output-limit": "output-limit",
  internal: "internal-error",
};

export async function judge(sandbox: Sandbox, programs: Map<string, string>, req: RunRequest): Promise<RunResponse> {
  const lang = validate(req);
  const missing = lang.programs.filter((p) => !programs.has(p));
  if (missing.length) throw Object.assign(new RequestError(`The judge has no ${missing.join(", ")} installed.`), { status: 503 });

  const limits: Limits = {
    cpuS: Math.min(req.limits?.time_s ?? 5, 20),
    wallS: Math.min(req.limits?.wall_s ?? 10, 30),
    memoryMb: Math.min(Math.max(req.limits?.memory_mb ?? 256, lang.memoryMb ?? 0), 1024),
    processes: lang.processes ?? 16,
    outputKb: Math.min(req.limits?.output_kb ?? 256, 4096),
  };
  const stem = req.entry.split("/").pop()!.replace(/\.[^.]+$/, "");
  const entrySource = String(req.files.find((f) => f.path === req.entry)?.content ?? "");
  const ctx: Ctx = {
    entry: req.entry,
    entryStem: stem,
    mainClass: javaMainClass(stem, entrySource),
    sources: (ext) => req.files.map((f) => f.path).filter((p) => p.toLowerCase().endsWith(`.${ext}`)),
    bin: (p) => programs.get(p) ?? p,
  };

  const box = await sandbox.acquire();
  try {
    for (const f of req.files) await box.write(f.path, f.content);
    let compile: RunResponse["compile"] = null;
    if (lang.transpile === "typescript") {
      const t = await transpileTypeScript(req.files);
      for (const f of t.files) await box.write(f.path, f.content);
      compile = { ok: t.errors.length === 0, output: t.errors.join("\n"), time_ms: t.timeMs };
      if (!compile.ok) return failedCompile(lang.id, sandbox.kind, compile, req.tests);
    }
    if (lang.compile) {
      const c = await box.exec(lang.compile(ctx), {
        stdin: "",
        limits: { cpuS: 20, wallS: 30, memoryMb: 768, processes: 64, outputKb: 256 },
        env: lang.env,
      });
      compile = { ok: c.status === "ok" && c.exitCode === 0, output: capBytes(`${c.stdout}${c.stderr}`, STDERR_CAP).text, time_ms: c.timeMs };
      if (!compile.ok) return failedCompile(lang.id, sandbox.kind, compile, req.tests);
    }
    // Every test starts from the state right after the compile: files one test
    // writes must not leak into the next. Same box (no extra acquire), emptied
    // and refilled from this snapshot before tests 2..n.
    const snapshot = req.tests.length > 1 ? await box.snapshot() : [];
    const stdoutCap = Math.min(limits.outputKb, STDOUT_CAP_KB) * 1024;
    const tests: TestResult[] = [];
    for (const [i, t] of req.tests.entries()) {
      if (i > 0) {
        await box.reset();
        await restoreSnapshot(box, snapshot);
      }
      const r = await box.exec(lang.run(ctx), { stdin: t.input ?? "", limits, env: lang.env });
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
      tests.push({
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
    return { language: lang.id, sandbox: sandbox.kind, compile, tests };
  } finally {
    await box.dispose();
  }
}
