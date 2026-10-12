/**
 * Unit-test results from a kind's test step: its report file(s) or its output,
 * parsed with @nga/runtimes' testing parsers (JUnit XML, TRX, Jest JSON,
 * go test -json, cargo text…), so Task Mentor never parses tool output.
 */
import { testing, type ReportKindId } from "../../../packages/runtimes/src/index.ts";

export type TestResult = testing.TestResult;

/** Reads a box file / lists a box folder (project-relative). */
export interface ReportSource {
  read(path: string): Promise<Buffer | null>;
  list(dir: string): Promise<string[]>;
}

/** Framework names for the response, from the step's tool. */
const FRAMEWORK: Record<string, string> = {
  python3: "pytest",
  mvn: "maven-surefire",
  gradle: "gradle",
  go: "go-test",
  gotestsum: "go-test",
  cargo: "cargo-test",
  ctest: "ctest",
  make: "make",
  npm: "npm-test",
  node: "node-test",
  java: "junit-platform",
  php: "phpunit",
  bundle: "rspec",
  bats: "bats",
  busted: "busted",
  Rscript: "testthat",
  dotnet: "dotnet-test",
  dart: "dart-test",
  swift: "xctest",
};

export function frameworkOf(tool: string, kindId: string) {
  return FRAMEWORK[tool] ?? `${kindId.split("/")[0]}-${tool}`;
}

/** TAP ("ok 1 - name" / "not ok 2 - name # SKIP"); [] when the output isn't TAP. */
export function parseTap(text: string): TestResult[] {
  const out: TestResult[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(not ok|ok)\b\s*(\d+)?\s*(?:-\s*)?(.*?)\s*(?:#\s*(SKIP|TODO)\b(.*))?$/i.exec(lines[i]);
    if (!m) continue;
    const name = m[3] || `test ${m[2] ?? out.length + 1}`;
    const skipped = !!m[4];
    const failed = m[1].toLowerCase() === "not ok" && !(m[4] && m[4].toUpperCase() === "TODO");
    // Indented YAML diagnostics after a failure.
    const details: string[] = [];
    while (failed && i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*(not ok|ok)\b/.test(lines[i + 1])) details.push(lines[++i].trim());
    out.push({
      id: `tap::${name}`,
      name,
      group: "tap",
      file: null,
      line: null,
      status: skipped ? "skipped" : failed ? "failed" : "passed",
      durationMs: null,
      message: failed ? (details.find((d) => /^message:/.test(d))?.replace(/^message:\s*/, "").replace(/^['"]|['"]$/g, "") ?? null) : null,
      details: details.length ? details.join("\n") : null,
    });
  }
  return out;
}

const tail = (s: string, n = 4000) => (s.length > n ? s.slice(-n) : s);

/**
 * Parses a test step's results. `root` is the folder the parsers strip from
 * absolute paths (the box root as the program saw it).
 */
export async function collectResults(
  report: ReportKindId,
  reportPath: string | undefined,
  output: { stdout: string; stderr: string; exitCode: number | null },
  box: ReportSource,
  root: string,
  name: string,
): Promise<TestResult[]> {
  const text = `${output.stdout}\n${output.stderr}`;
  const files = async (): Promise<string[]> => {
    if (!reportPath) return [];
    if (report === "junit-dir") {
      const names = (await box.list(reportPath)).filter((n) => n.endsWith(".xml"));
      const out: string[] = [];
      for (const n of names) {
        const b = await box.read(`${reportPath.replace(/\/+$/, "")}/${n}`);
        if (b) out.push(b.toString("utf8"));
      }
      return out;
    }
    const b = await box.read(reportPath);
    return b ? [b.toString("utf8")] : [];
  };
  const safe = <T>(f: () => T, fallback: T): T => {
    try {
      return f();
    } catch {
      return fallback;
    }
  };
  let results: TestResult[] = [];
  switch (report) {
    case "junit":
    case "junit-dir":
      results = (await files()).flatMap((x) => safe(() => testing.parseJUnit(x, root), []));
      break;
    case "trx":
      results = (await files()).flatMap((x) => safe(() => testing.parseTrx(x, root), []));
      break;
    case "jest":
      results = (await files()).flatMap((x) => safe(() => testing.parseJest(x, root), []));
      break;
    case "rspec":
      results = (await files()).flatMap((x) => safe(() => testing.parseRspec(x, root), []));
      break;
    case "go":
      results = safe(() => testing.parseGoJson(output.stdout, root), []);
      break;
    case "dart":
      results = safe(() => testing.parseDartJson(output.stdout, root), []);
      break;
    case "cargo":
      results = safe(() => testing.parseCargo(text, root), []);
      break;
    case "swift":
      results = safe(() => testing.parseSwift(text, root), []);
      break;
    case "unittest":
      results = safe(() => testing.parseUnittest(text, root), []);
      break;
    case "minitest":
      results = safe(() => testing.parseMinitest(text, root), []);
      break;
    case "tap":
      results = parseTap(output.stdout);
      break;
    default:
      results = [];
  }
  // Tools that only report through their exit code (make test without TAP, "text", "none"): one result.
  if (!results.length && (report === "tap" || report === "text" || report === "none") && output.exitCode !== null) {
    results = [
      {
        id: `${name}::all`,
        name,
        group: name,
        file: null,
        line: null,
        status: output.exitCode === 0 ? "passed" : "failed",
        durationMs: null,
        message: output.exitCode === 0 ? null : `Exit code ${output.exitCode}`,
        details: output.exitCode === 0 ? null : tail(text.trim()),
      },
    ];
  }
  return results;
}
