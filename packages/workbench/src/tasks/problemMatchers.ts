/**
 * VS Code's problem matchers: a task's output turned into Problems. Built-in
 * matchers by name ("$tsc", "$gcc", "$eslint-stylish", "$msCompile", "$go",
 * "$javac", "$python"), and the custom ones tasks.json may define (one
 * pattern or several, `loop`, `fileLocation`, a `background` begin/end).
 * Pure: unit-tested; the runner publishes the results as markers.
 */

export interface ProblemPattern {
  regexp: string;
  file?: number;
  location?: number;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity?: number;
  code?: number;
  message?: number;
  /** The last pattern repeats for every following line it matches (eslint-stylish). */
  loop?: boolean;
}

export interface ProblemMatcher {
  owner: string;
  source?: string;
  /** "relative" (to the task's folder, the default), "absolute", "autoDetect". */
  fileLocation?: "relative" | "absolute" | "autoDetect";
  severity?: "error" | "warning" | "info";
  pattern: ProblemPattern[];
  /** Background (watch) tasks: a run of the watcher starts and ends at these lines. */
  background?: { beginsPattern?: string; endsPattern?: string; activeAtBeginning?: boolean };
}

export interface MatchedProblem {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
  source: string;
  fileLocation: "relative" | "absolute" | "autoDetect";
}

const one = (p: ProblemPattern): ProblemPattern[] => [p];

export const BUILTIN_MATCHERS: Record<string, ProblemMatcher> = {
  // src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.
  tsc: { owner: "typescript", source: "ts", pattern: one({ regexp: "^([^\\s].*)[\\(:](\\d+)[,:](\\d+)(?:\\):\\s+|\\s+-\\s+)(error|warning|info)\\s+TS(\\d+)\\s*:\\s*(.*)$", file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 }) },
  "tsc-watch": {
    owner: "typescript",
    source: "ts",
    pattern: one({ regexp: "^([^\\s].*)[\\(:](\\d+)[,:](\\d+)(?:\\):\\s+|\\s+-\\s+)(error|warning|info)\\s+TS(\\d+)\\s*:\\s*(.*)$", file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 }),
    background: { activeAtBeginning: true, beginsPattern: "Starting (?:incremental )?compilation", endsPattern: "Found \\d+ errors?\\. Watching for file changes\\." },
  },
  // main.c:12:5: error: expected ';' before 'return'
  gcc: { owner: "cpp", source: "gcc", fileLocation: "autoDetect", pattern: one({ regexp: "^(.*?):(\\d+):(\\d*):?\\s+(?:fatal\\s+)?(warning|error):\\s+(.*)$", file: 1, line: 2, column: 3, severity: 4, message: 5 }) },
  // /path/file.js
  //   3:10  error  'x' is not defined  no-undef
  "eslint-stylish": {
    owner: "eslint",
    source: "eslint",
    fileLocation: "absolute",
    pattern: [
      { regexp: "^((?:[A-Za-z]:)?[^:\\s].*)$", file: 1 },
      { regexp: "^\\s+(\\d+):(\\d+)\\s+(error|warning|info)\\s+(.+?)(?:\\s\\s+(.*))?$", line: 1, column: 2, severity: 3, message: 4, code: 5, loop: true },
    ],
  },
  // C:\src\Program.cs(10,5): error CS0103: The name 'x' does not exist [C:\src\app.csproj]
  msCompile: { owner: "msCompile", source: "msCompile", fileLocation: "absolute", pattern: one({ regexp: "^\\s*(?:\\s*\\d+>)?(\\S.*?)(?:\\((\\d+|\\d+,\\d+|\\d+,\\d+,\\d+,\\d+)\\))?\\s*:\\s+(?:(\\S+)\\s+)?((?:fatal +)?error|warning|info)\\s+(\\w+\\d+)?\\s*:\\s*(.*)$", file: 1, location: 2, severity: 4, code: 5, message: 6 }) },
  // ./main.go:5:2: undefined: x
  go: { owner: "go", source: "go", pattern: one({ regexp: "^\\s*(\\S+\\.go):(\\d+):(?:(\\d+):)?\\s+(.*)$", file: 1, line: 2, column: 3, message: 4 }), severity: "error" },
  // Main.java:7: error: cannot find symbol
  javac: { owner: "java", source: "javac", pattern: one({ regexp: "^(.+?\\.java):(\\d+):\\s+(error|warning):\\s+(.*)$", file: 1, line: 2, severity: 3, message: 4 }) },
  //   File "main.py", line 4  … NameError: name 'x' is not defined (the frame line is enough to point at it)
  python: { owner: "python", source: "python", pattern: one({ regexp: '^\\s*File "(.+?)", line (\\d+)', file: 1, line: 2 }), severity: "error" },
};

export function severityOf(raw: string | undefined, fallback: MatchedProblem["severity"]): MatchedProblem["severity"] {
  const s = (raw ?? "").toLowerCase();
  if (/error/.test(s)) return "error";
  if (/warn/.test(s)) return "warning";
  if (/info|note|hint/.test(s)) return "info";
  return fallback;
}

/** A matcher from tasks.json: a "$name", or an object (possibly `base`d on a built-in). */
export function resolveMatcher(spec: unknown): ProblemMatcher | null {
  if (typeof spec === "string") return BUILTIN_MATCHERS[spec.replace(/^\$/, "")] ?? null;
  if (!spec || typeof spec !== "object") return null;
  const raw = spec as Record<string, unknown>;
  const base = typeof raw.base === "string" ? BUILTIN_MATCHERS[raw.base.replace(/^\$/, "")] : undefined;
  const pattern = raw.pattern === undefined ? base?.pattern : Array.isArray(raw.pattern) ? (raw.pattern as ProblemPattern[]) : typeof raw.pattern === "string" ? BUILTIN_MATCHERS[raw.pattern.replace(/^\$/, "")]?.pattern : [raw.pattern as ProblemPattern];
  if (!pattern?.length || pattern.some((p) => !p || typeof p.regexp !== "string")) return null;
  const loc = Array.isArray(raw.fileLocation) ? raw.fileLocation[0] : raw.fileLocation;
  const bg = raw.background as ProblemMatcher["background"] | undefined;
  return {
    owner: typeof raw.owner === "string" ? raw.owner : (base?.owner ?? "task"),
    source: typeof raw.source === "string" ? raw.source : base?.source,
    fileLocation: loc === "absolute" || loc === "autoDetect" || loc === "relative" ? loc : (base?.fileLocation ?? "relative"),
    severity: raw.severity === "warning" || raw.severity === "info" || raw.severity === "error" ? raw.severity : base?.severity,
    pattern,
    background: bg ?? base?.background,
  };
}

/** All matchers a task names (`problemMatcher`: one, or a list). */
export function resolveMatchers(spec: unknown): ProblemMatcher[] {
  const list = Array.isArray(spec) ? spec : spec === undefined ? [] : [spec];
  return list.map(resolveMatcher).filter((m): m is ProblemMatcher => !!m);
}

function compile(p: ProblemPattern): RegExp | null {
  try {
    return new RegExp(p.regexp);
  } catch {
    return null;
  }
}

/** "12" or "12,5" or "12,5,12,9" (a `location` group). */
function location(raw: string | undefined) {
  const n = (raw ?? "").split(",").map(Number);
  return { line: n[0] || 1, column: n[1] || 1, endLine: n[2], endColumn: n[3] };
}

/** Problems a matcher finds in some output. */
export function matchProblems(output: string, matcher: ProblemMatcher): MatchedProblem[] {
  const patterns = matcher.pattern.map(compile);
  if (patterns.some((p) => !p)) return [];
  // Colours, and the shell's own marks (OSC sequences such as shell integration's 633) are not output.
  const lines = output
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/);
  const out: MatchedProblem[] = [];
  const fallback = matcher.severity ?? "error";
  const make = (data: Record<string, string | undefined>) => {
    const loc = data.location !== undefined ? location(data.location) : { line: Number(data.line) || 1, column: Number(data.column) || 1, endLine: data.endLine ? Number(data.endLine) : undefined, endColumn: data.endColumn ? Number(data.endColumn) : undefined };
    if (!data.file) return;
    out.push({
      file: data.file,
      ...loc,
      severity: severityOf(data.severity, fallback),
      message: (data.message ?? "").trim() || "(no message)",
      code: data.code,
      source: matcher.source ?? matcher.owner,
      fileLocation: matcher.fileLocation ?? "relative",
    });
  };
  const capture = (p: ProblemPattern, m: RegExpExecArray, into: Record<string, string | undefined>) => {
    for (const k of ["file", "location", "line", "column", "endLine", "endColumn", "severity", "code", "message"] as const) {
      const idx = p[k];
      if (typeof idx === "number" && m[idx] !== undefined) into[k] = m[idx];
    }
  };
  if (patterns.length === 1) {
    for (const l of lines) {
      const m = patterns[0]!.exec(l);
      if (!m) continue;
      const data: Record<string, string | undefined> = {};
      capture(matcher.pattern[0], m, data);
      make(data);
    }
    return out;
  }
  // Several patterns: each must match the next line in turn; a looping last one repeats.
  const last = matcher.pattern.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const data: Record<string, string | undefined> = {};
    let j = i;
    let ok = true;
    for (let k = 0; k < last; k++, j++) {
      const m = j < lines.length ? patterns[k]!.exec(lines[j]) : null;
      if (!m) {
        ok = false;
        break;
      }
      capture(matcher.pattern[k], m, data);
    }
    if (!ok) continue;
    let matched = false;
    while (j < lines.length) {
      const m = patterns[last]!.exec(lines[j]);
      if (!m) break;
      const row = { ...data };
      capture(matcher.pattern[last], m, row);
      make(row);
      matched = true;
      j++;
      if (!matcher.pattern[last].loop) break;
    }
    if (matched) i = j - 1;
  }
  return out;
}

/** Background matchers: did this output start or finish one run of the watcher? */
export function backgroundState(output: string, matcher: ProblemMatcher): "begin" | "end" | null {
  const bg = matcher.background;
  if (!bg) return null;
  const test = (p?: string) => {
    try {
      return !!p && new RegExp(p, "m").test(output);
    } catch {
      return false;
    }
  };
  if (test(bg.endsPattern)) return "end";
  if (test(bg.beginsPattern)) return "begin";
  return null;
}
