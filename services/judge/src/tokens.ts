/**
 * Catalog step arguments → argv (CODE_RUNNER_PLAN §11.2). Every argument is a
 * literal from the catalog or a typed token filled from the request; nothing
 * is ever handed to a shell.
 */
import { IGNORED_PATH, type Step, type Token } from "../../../packages/runtimes/src/index.ts";

export interface TokenContext {
  /** Entry file, project-relative ("src/main.c"). */
  entry: string;
  /** Project file paths (for {sources}). */
  files: string[];
  /** JVM main class (package + class). */
  mainClass: string;
  /** Already-split framework arguments for {test_filter} ([] = all tests). */
  testFilter: string[];
  /** Where the test step writes its report, project-relative. */
  reportPath: string | null;
}

/** "src/main.c" → "main". */
export function entryStem(entry: string) {
  return entry.split("/").pop()!.replace(/\.[^.]+$/, "");
}

/** A build output path as an argument: "./main" (so a bare name is never looked up on PATH). */
export function outPath(p: string) {
  return p.startsWith("/") || p.startsWith("./") ? p : `./${p}`;
}

/** Project files with one of these extensions (no dependency or build folders), sorted. */
export function sourcesWith(files: string[], ext: string | string[]) {
  const exts = (Array.isArray(ext) ? ext : [ext]).map((e) => `.${e.toLowerCase().replace(/^\./, "")}`);
  return files.filter((p) => !IGNORED_PATH.test(p) && exts.some((e) => p.toLowerCase().endsWith(e))).sort();
}

export function renderToken(t: Token, ctx: TokenContext): string[] {
  if (typeof t === "string") return [t];
  if ("entry" in t) return [ctx.entry];
  if ("entry_stem" in t) return [entryStem(ctx.entry)];
  if ("out" in t) return [`${t.prefix ?? ""}${outPath(t.out)}`];
  if ("sources" in t) return sourcesWith(ctx.files, t.sources);
  if ("main_class" in t) return [ctx.mainClass];
  if ("test_filter" in t) return ctx.testFilter;
  if ("report_path" in t) return [`${t.prefix ?? ""}${ctx.reportPath ?? "test-report.xml"}`];
  throw new Error(`Unknown token ${JSON.stringify(t)}`);
}

export function renderArgs(step: Pick<Step, "args">, ctx: TokenContext): string[] {
  return step.args.flatMap((t) => renderToken(t, ctx));
}

/** Characters a test filter may use (class/method names, globs, paths). */
export const TEST_FILTER = /^[\w.*#:/$\- [\]]{1,200}$/;

/**
 * The framework's "only these tests" arguments for a test step's tool.
 * `filter` is a test name or pattern the teacher chose ("CalculatorTest",
 * "test_add", "TestGrades/edge").
 */
export function testFilterArgs(tool: string, filter: string | undefined | null): string[] {
  const f = (filter ?? "").trim();
  if (!f) return [];
  switch (tool) {
    case "mvn":
      return [`-Dtest=${f}`, "-Dsurefire.failIfNoSpecifiedTests=false"];
    case "gradle":
      return ["--tests", f];
    case "go":
    case "gotestsum":
      return ["-run", f];
    case "python3":
      return ["-k", f];
    case "java":
      // JUnit console launcher.
      return [`--include-classname=.*${f.replace(/[^\w.$]/g, "")}.*`];
    case "cargo":
    case "ctest":
    default:
      return tool === "ctest" ? ["-R", f] : [f];
  }
}
