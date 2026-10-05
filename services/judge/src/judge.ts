import { spawnSync } from "node:child_process";
import { languageById, LANGUAGES, type Ctx, type Language } from "./languages.ts";
import type { ExecResult, Limits, Sandbox } from "./sandbox.ts";

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
}

export interface RunRequest {
  language: string;
  files: SubmissionFile[];
  /** Entry file path, e.g. "main.py" or "Main.java". */
  entry: string;
  tests: TestCase[];
  limits?: Partial<{ time_s: number; wall_s: number; memory_mb: number; output_kb: number }>;
}

export type Verdict =
  | "accepted"
  | "wrong-answer"
  | "ok"
  | "runtime-error"
  | "time-limit"
  | "memory-limit"
  | "output-limit"
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
}

export interface RunResponse {
  language: string;
  sandbox: "isolate" | "none";
  compile: { ok: boolean; output: string; time_ms: number } | null;
  tests: TestResult[];
}

/** Same rule as @tmcode/protocol `normalizeOutput` (asserted in tests). */
export function normalizeOutput(s: string | null | undefined): string {
  return (s ?? "").replace(/\r\n/g, "\n").trimEnd();
}

export class RequestError extends Error {
  status = 400;
}

const LIMITS = { files: 100, bytes: 1024 * 1024, tests: 60, inputBytes: 256 * 1024 };

export function validate(req: RunRequest): Language {
  const lang = languageById(req.language);
  if (!lang) throw new RequestError(`Unsupported language '${req.language}'.`);
  if (!Array.isArray(req.files) || req.files.length === 0) throw new RequestError("No files.");
  if (req.files.length > LIMITS.files) throw new RequestError(`At most ${LIMITS.files} files.`);
  const total = req.files.reduce((n, f) => n + Buffer.byteLength(String(f.content ?? "")), 0);
  if (total > LIMITS.bytes) throw new RequestError("Submission is larger than 1 MB.");
  for (const f of req.files) {
    if (typeof f.path !== "string" || !/^[\w.\-/ ]+$/.test(f.path) || f.path.startsWith("/") || f.path.split("/").some((p) => !p || p === "..")) {
      throw new RequestError(`Invalid file path '${f.path}'.`);
    }
  }
  if (!req.files.some((f) => f.path === req.entry)) throw new RequestError(`Entry '${req.entry}' is not among the files.`);
  if (!Array.isArray(req.tests) || req.tests.length === 0) throw new RequestError("No tests.");
  if (req.tests.length > LIMITS.tests) throw new RequestError(`At most ${LIMITS.tests} tests.`);
  for (const t of req.tests) {
    if (Buffer.byteLength(String(t.input ?? "")) > LIMITS.inputBytes) throw new RequestError(`Test ${t.id}: input larger than 256 KB.`);
  }
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

function failedCompile(language: string, kind: RunResponse["sandbox"], compile: NonNullable<RunResponse["compile"]>, tests: TestCase[]): RunResponse {
  return {
    language,
    sandbox: kind,
    compile,
    tests: tests.map((t) => ({ id: t.id, verdict: "runtime-error", passed: false, stdout: "", stderr: "Compilation failed", exit_code: null, time_ms: 0, memory_kb: null })),
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

const VERDICT: Record<ExecResult["status"], Verdict> = {
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
  const ctx: Ctx = {
    entry: req.entry,
    entryStem: stem,
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
      compile = { ok: c.status === "ok" && c.exitCode === 0, output: `${c.stdout}${c.stderr}`.slice(0, 64 * 1024), time_ms: c.timeMs };
      if (!compile.ok) return failedCompile(lang.id, sandbox.kind, compile, req.tests);
    }
    const tests: TestResult[] = [];
    for (const t of req.tests) {
      const r = await box.exec(lang.run(ctx), { stdin: t.input ?? "", limits, env: lang.env });
      let verdict = VERDICT[r.status];
      if (verdict === "ok" && r.exitCode !== 0) verdict = "runtime-error";
      let passed: boolean | null = null;
      if (t.expected_output !== undefined) {
        passed = verdict === "ok" && normalizeOutput(r.stdout) === normalizeOutput(t.expected_output);
        if (verdict === "ok") verdict = passed ? "accepted" : "wrong-answer";
        else passed = false;
      }
      tests.push({
        id: String(t.id),
        verdict,
        passed,
        stdout: r.stdout.slice(0, 64 * 1024),
        stderr: r.stderr.slice(0, 8 * 1024),
        exit_code: r.exitCode,
        time_ms: r.timeMs,
        memory_kb: r.memoryKb,
      });
    }
    return { language: lang.id, sandbox: sandbox.kind, compile, tests };
  } finally {
    await box.dispose();
  }
}
