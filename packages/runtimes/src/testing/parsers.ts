/**
 * Test results from the reports and output of real test frameworks, into one
 * shape for the Testing view: JUnit XML (pytest, Vitest, node:test, Maven
 * Surefire, Gradle, PHPUnit), Jest JSON, RSpec JSON, `go test -json`, Dart /
 * Flutter JSON, .NET TRX, and the text output of Cargo, Swift (XCTest) and
 * Python unittest / Django. Pure and unit-tested against captured output.
 */

export type ResultStatus = "passed" | "failed" | "skipped" | "error";

export interface TestResult {
  /** Stable across runs: "<group>::<name>". */
  id: string;
  name: string;
  /** File, class, package or describe block. */
  group: string;
  /** Workspace-relative when known. */
  file: string | null;
  line: number | null;
  status: ResultStatus;
  durationMs: number | null;
  message: string | null;
  details: string | null;
}

// ───────────── helpers ─────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeXml(m[3] ?? m[4] ?? "");
  return out;
}

const SOURCE_EXT = "py|js|mjs|cjs|ts|mts|jsx|tsx|java|kt|go|rs|dart|php|rb|cs|swift|c|cc|cpp";

/** Makes an absolute path workspace-relative (and normalises slashes). */
export function relative(path: string, root: string): string {
  let p = path.replace(/\\/g, "/").replace(/^file:\/\//, "");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (r && p.startsWith(`${r}/`)) p = p.slice(r.length + 1);
  else if (r && p.startsWith(`/private${r}/`)) p = p.slice(r.length + 9);
  return p.replace(/^\.\//, "");
}

/** The first "file:line" (or Python's File "x", line N) in a stack that points into the workspace. */
export function locate(input: string | null | undefined, root: string, preferFile?: string | null): { file: string; line: number } | null {
  if (!input) return null;
  const text = input.replace(/file:\/\//g, "");
  const hits: { file: string; line: number }[] = [];
  for (const m of text.matchAll(/File "([^"]+)", line (\d+)/g)) hits.push({ file: m[1], line: Number(m[2]) });
  // .NET: "at Ns.Class.Method() in /ws/CalcTests.cs:line 11".
  for (const m of text.matchAll(/ in (.+?\.(?:cs|fs|vb)):line (\d+)/g)) hits.push({ file: m[1], line: Number(m[2]) });
  for (const m of text.matchAll(new RegExp(`((?:[A-Za-z]:)?[\\w@./\\\\ -]*?[\\w-]+\\.(?:${SOURCE_EXT})):(\\d+)`, "g"))) hits.push({ file: m[1].trim(), line: Number(m[2]) });
  const inside = hits
    .map((h) => ({ file: relative(h.file.replace(/^\(/, ""), root), line: h.line }))
    .filter((h) => !h.file.startsWith("/") && !/node_modules|site-packages|^node:|^internal\//.test(h.file) && !/^[A-Za-z]:/.test(h.file));
  return (preferFile && inside.find((h) => h.file === preferFile)) || inside[0] || null;
}

const result = (r: Omit<TestResult, "id"> & { id?: string }): TestResult => ({ ...r, id: r.id ?? `${r.group}::${r.name}` });

// ───────────── JUnit XML ─────────────

/** pytest --junitxml, vitest --reporter=junit, node --test-reporter=junit, Surefire, Gradle, PHPUnit --log-junit. */
export function parseJUnit(xml: string, root: string): TestResult[] {
  const out: TestResult[] = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const m of xml.matchAll(re)) {
    const a = attrs(m[1]);
    const body = m[3] ?? "";
    const fail = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(body);
    const skipped = /<skipped\b/.test(body);
    const name = a.name ?? "test";
    const cls = a.classname ?? "";
    const fileAttr = a.file ? relative(a.file, root) : null;
    // pytest classname "pkg.test_mod.Class" → test_mod.py; vitest classname is the file.
    const guessFile = fileAttr ?? (/\.(?:[cm]?[jt]sx?|py)$/.test(cls) ? relative(cls, root) : null);
    const fa = fail ? attrs(fail[2]) : {};
    const details = fail ? decodeXml((fail[3] ?? "").trim()) || null : null;
    // PHPUnit has no message attribute; its body starts with "Class::test", then the assertion.
    const bodyLines = (details ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !l.endsWith(`::${name}`));
    const message = fail ? (fa.message ?? bodyLines[0] ?? null) : null;
    const loc = fail ? (javaFrame(details, cls) ?? locate(`${details ?? ""}\n${message ?? ""}`, root, guessFile)) : null;
    out.push(
      result({
        // Gradle names JUnit 5 methods "adds()".
        name: name.includes(" > ") ? name.split(" > ").pop()! : name.replace(/^(\w+)\(\)$/, "$1"),
        group: name.includes(" > ") ? `${guessFile ?? cls} › ${name.split(" > ").slice(0, -1).join(" › ")}` : cls || guessFile || "tests",
        file: loc?.file ?? guessFile ?? (a.line ? null : null),
        line: loc?.line ?? (a.line ? Number(a.line) : null),
        status: fail ? (fail[1] === "error" ? "error" : "failed") : skipped ? "skipped" : "passed",
        durationMs: a.time ? Math.round(Number(a.time) * 1000) : null,
        message,
        details,
      }),
    );
  }
  return out;
}

/**
 * JVM stacks (Surefire, Gradle): the frame of the test class itself, not the
 * assertion library's. Stack frames only name the file, so the path follows
 * the Maven/Gradle layout: src/test/<lang>/<package>/<File>.
 */
function javaFrame(details: string | null, cls: string): { file: string; line: number } | null {
  if (!details || !/^[\w$.]+\.[A-Z][\w$]*$/.test(cls)) return null;
  const esc = cls.replace(/[.$]/g, "\\$&");
  const m = new RegExp(`at ${esc}(?:\\$[\\w$]+)?\\.[\\w$<>]+\\(([\\w$]+\\.(java|kt|groovy|scala)):(\\d+)\\)`).exec(details);
  if (!m) return null;
  const pkg = cls.split(".").slice(0, -1).join("/");
  const lang = m[2] === "kt" ? "kotlin" : m[2];
  return { file: `src/test/${lang}/${pkg ? `${pkg}/` : ""}${m[1]}`, line: Number(m[3]) };
}

// ───────────── .NET TRX ─────────────

export function parseTrx(xml: string, root: string): TestResult[] {
  const out: TestResult[] = [];
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const a = attrs(m[1]);
    const body = m[3] ?? "";
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(body)?.[1];
    const stack = /<StackTrace>([\s\S]*?)<\/StackTrace>/.exec(body)?.[1];
    const full = a.testName ?? "test";
    const dot = full.lastIndexOf(".");
    const loc = locate(stack ? decodeXml(stack) : null, root);
    const dur = /(\d+):(\d+):([\d.]+)/.exec(a.duration ?? "");
    out.push(
      result({
        name: dot > 0 ? full.slice(dot + 1) : full,
        group: dot > 0 ? full.slice(0, dot) : "tests",
        file: loc?.file ?? null,
        line: loc?.line ?? null,
        status: a.outcome === "Passed" ? "passed" : a.outcome === "NotExecuted" ? "skipped" : "failed",
        durationMs: dur ? Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000) : null,
        message: message ? decodeXml(message).trim() : null,
        details: stack ? decodeXml(stack).trim() : null,
      }),
    );
  }
  return out;
}

// ───────────── Jest / RSpec JSON ─────────────

interface JestJson {
  testResults: { name: string; message?: string; assertionResults: { ancestorTitles: string[]; title: string; status: string; duration?: number | null; failureMessages: string[]; location?: { line: number } | null }[] }[];
}

export function parseJest(json: string, root: string): TestResult[] {
  const d = JSON.parse(json) as JestJson;
  const out: TestResult[] = [];
  for (const file of d.testResults ?? []) {
    const rel = relative(file.name, root);
    if (!file.assertionResults?.length && file.message) {
      out.push(result({ name: "(file failed to run)", group: rel, file: rel, line: null, status: "error", durationMs: null, message: file.message.split("\n").find((l) => l.trim()) ?? null, details: file.message }));
    }
    for (const t of file.assertionResults ?? []) {
      const details = t.failureMessages?.join("\n").trim() || null;
      const loc = locate(details, root, rel);
      out.push(
        result({
          name: t.title,
          group: [rel, ...t.ancestorTitles].join(" › "),
          file: rel,
          line: t.location?.line ?? loc?.line ?? null,
          status: t.status === "passed" ? "passed" : t.status === "pending" || t.status === "skipped" || t.status === "todo" ? "skipped" : "failed",
          durationMs: t.duration ?? null,
          message: details?.split("\n").find((l) => l.trim()) ?? null,
          details,
        }),
      );
    }
  }
  return out;
}

interface RspecJson {
  examples: { full_description: string; description: string; status: string; file_path: string; line_number: number; run_time: number; exception?: { class: string; message: string; backtrace: string[] } }[];
}

export function parseRspec(json: string, root: string): TestResult[] {
  const d = JSON.parse(json) as RspecJson;
  return (d.examples ?? []).map((e) => {
    const file = relative(e.file_path, root);
    const group = e.full_description.endsWith(e.description) ? e.full_description.slice(0, -e.description.length).trim() : file;
    const details = e.exception ? `${e.exception.class}: ${e.exception.message}\n${(e.exception.backtrace ?? []).join("\n")}` : null;
    const loc = locate(details, root, file);
    return result({
      name: e.description,
      group: `${file} › ${group}`,
      file,
      line: loc?.line ?? e.line_number,
      status: e.status === "passed" ? "passed" : e.status === "pending" ? "skipped" : "failed",
      durationMs: Math.round(e.run_time * 1000),
      message: e.exception ? e.exception.message.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join(" · ").slice(0, 300) : null,
      details,
    });
  });
}

// ───────────── go test -json ─────────────

export function parseGoJson(jsonl: string, root: string): TestResult[] {
  const tests = new Map<string, { pkg: string; name: string; output: string[]; status?: ResultStatus; elapsed?: number }>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: { Action: string; Package?: string; Test?: string; Output?: string; Elapsed?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e.Test || !e.Package) continue;
    const key = `${e.Package}::${e.Test}`;
    const t = tests.get(key) ?? { pkg: e.Package, name: e.Test, output: [] };
    tests.set(key, t);
    if (e.Action === "output" && e.Output) t.output.push(e.Output);
    if (e.Action === "pass" || e.Action === "fail" || e.Action === "skip") {
      t.status = e.Action === "pass" ? "passed" : e.Action === "skip" ? "skipped" : "failed";
      t.elapsed = e.Elapsed;
    }
  }
  return [...tests.values()]
    .filter((t) => t.status)
    .map((t) => {
      const text = t.output.filter((o) => !/^(=== RUN|--- (PASS|FAIL|SKIP)|PASS|FAIL|ok\s)/.test(o.trim())).join("").trim();
      const loc = /^\s*([\w./-]+\.go):(\d+):/m.exec(text);
      return result({
        name: t.name,
        group: t.pkg,
        file: loc ? relative(loc[1], root) : null,
        line: loc ? Number(loc[2]) : null,
        status: t.status!,
        durationMs: t.elapsed != null ? Math.round(t.elapsed * 1000) : null,
        message: t.status === "failed" ? (text.split("\n").find((l) => l.trim())?.trim().replace(/^[\w./-]+\.go:\d+:\s*/, "") ?? "failed") : null,
        details: t.status === "failed" ? text || null : null,
      });
    });
}

// ───────────── Dart / Flutter JSON ─────────────

export function parseDartJson(jsonl: string, root: string): TestResult[] {
  const suites = new Map<number, string>();
  const tests = new Map<number, { name: string; suite: number; line: number | null; url: string | null; start: number; errors: string[]; stacks: string[]; result?: string; hidden?: boolean; skipped?: boolean; end?: number }>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "suite") suites.set(e.suite.id, e.suite.path);
    else if (e.type === "testStart") tests.set(e.test.id, { name: e.test.name, suite: e.test.suiteID, line: e.test.root_line ?? e.test.line ?? null, url: e.test.root_url ?? e.test.url ?? null, start: e.time, errors: [], stacks: [] });
    else if (e.type === "error") {
      const t = tests.get(e.testID);
      if (t) {
        t.errors.push(String(e.error));
        t.stacks.push(String(e.stackTrace ?? ""));
      }
    } else if (e.type === "testDone") {
      const t = tests.get(e.testID);
      if (t) Object.assign(t, { result: e.result, hidden: e.hidden, skipped: e.skipped, end: e.time });
    }
  }
  return [...tests.values()]
    .filter((t) => t.result && !t.hidden && !/^loading /.test(t.name))
    .map((t) => {
      const suitePath = suites.get(t.suite);
      const file = suitePath ? relative(suitePath, root) : t.url ? relative(t.url, root) : null;
      const details = t.errors.length ? `${t.errors.join("\n")}\n${t.stacks.join("\n")}`.trim() : null;
      const stackLoc = /([\w./-]+\.dart) (\d+):\d+/.exec(t.stacks.join("\n"));
      return result({
        name: t.name,
        group: file ?? "tests",
        file,
        line: stackLoc && (!file || relative(stackLoc[1], root) === file) ? Number(stackLoc[2]) : t.line,
        status: t.skipped ? "skipped" : t.result === "success" ? "passed" : t.result === "error" ? "error" : "failed",
        durationMs: t.end != null ? t.end - t.start : null,
        message: t.errors[0]?.split("\n").filter((l) => l.trim()).join(" · ").slice(0, 300) ?? null,
        details,
      });
    });
}

// ───────────── text outputs ─────────────

/** `cargo test`: "test path ... ok|FAILED|ignored" lines and "---- name stdout ----" failure blocks. */
export function parseCargo(text: string, root: string): TestResult[] {
  const blocks = new Map<string, string>();
  for (const m of text.matchAll(/---- (\S+) stdout ----\n([\s\S]*?)(?=\n---- \S+ stdout ----|\n\nfailures:|\ntest result:|$)/g)) blocks.set(m[1], m[2].trim());
  const out: TestResult[] = [];
  for (const m of text.matchAll(/^test (\S+) \.\.\. (ok|FAILED|ignored)/gm)) {
    const full = m[1];
    const idx = full.lastIndexOf("::");
    const details = blocks.get(full) ?? null;
    const loc = /panicked at ([^:\s]+\.rs):(\d+):\d+/.exec(details ?? "");
    out.push(
      result({
        name: idx >= 0 ? full.slice(idx + 2) : full,
        group: idx >= 0 ? full.slice(0, idx) : "tests",
        file: loc ? relative(loc[1], root) : null,
        line: loc ? Number(loc[2]) : null,
        status: m[2] === "ok" ? "passed" : m[2] === "ignored" ? "skipped" : "failed",
        durationMs: null,
        message: details ? details.split("\n").filter((l) => l.trim() && !/^thread '.*' .*panicked at/.test(l) && !/^note:/.test(l)).slice(0, 3).join(" · ") || "failed" : null,
        details,
      }),
    );
  }
  return out;
}

/** `swift test` (XCTest): "Test Case '-[Mod.Class testX]' passed (0.001 seconds)." + "path:line: error: -[…] : message". */
export function parseSwift(text: string, root: string): TestResult[] {
  const errors = new Map<string, { file: string; line: number; message: string }[]>();
  for (const m of text.matchAll(/^(.+\.swift):(\d+): error: (?:-\[)?([\w.]+)[ .]([\w]+)\]? : (.*)$/gm)) {
    const key = `${m[3]}.${m[4]}`;
    errors.set(key, [...(errors.get(key) ?? []), { file: relative(m[1], root), line: Number(m[2]), message: m[5] }]);
  }
  const out: TestResult[] = [];
  for (const m of text.matchAll(/^Test Case '(?:-\[)?([\w.]+)[ .]([\w]+)\]?' (passed|failed|skipped) \(([\d.]+) seconds\)/gm)) {
    const key = `${m[1]}.${m[2]}`;
    const errs = errors.get(key) ?? [];
    out.push(
      result({
        name: m[2],
        group: m[1],
        file: errs[0]?.file ?? null,
        line: errs[0]?.line ?? null,
        status: m[3] as ResultStatus,
        durationMs: Math.round(Number(m[4]) * 1000),
        message: errs[0]?.message ?? null,
        details: errs.length ? errs.map((e) => `${e.file}:${e.line}: ${e.message}`).join("\n") : null,
      }),
    );
  }
  return out;
}

/** Python unittest / Django (`-v 2`): "test_x (mod.Class.test_x) ... ok" and FAIL/ERROR blocks. */
export function parseUnittest(text: string, root: string): TestResult[] {
  const blocks = new Map<string, string>();
  for (const m of text.matchAll(/^(?:FAIL|ERROR): (\w+) \(([\w.]+)\)[^\n]*\n-{20,}\n([\s\S]*?)(?=\n={20,}|\n-{20,}\nRan |(?![\s\S]))/gm)) blocks.set(`${m[2]}::${m[1]}`, m[3].trim());
  const out: TestResult[] = [];
  for (const m of text.matchAll(/^(\w+) \(([\w.]+)\)(?:\n[^\n]*)?\s\.\.\.\s(ok|FAIL|ERROR|skipped[^\n]*)$/gm)) {
    const cls = m[2].endsWith(`.${m[1]}`) ? m[2].slice(0, -m[1].length - 1) : m[2];
    const details = blocks.get(`${m[2]}::${m[1]}`) ?? blocks.get(`${cls}::${m[1]}`) ?? null;
    const loc = locate(details, root);
    out.push(
      result({
        name: m[1],
        group: cls,
        file: loc?.file ?? null,
        line: loc?.line ?? null,
        status: m[3] === "ok" ? "passed" : m[3] === "FAIL" ? "failed" : m[3] === "ERROR" ? "error" : "skipped",
        durationMs: null,
        message: details ? details.trim().split("\n").pop()!.trim() : null,
        details,
      }),
    );
  }
  return out;
}

// ───────────── minitest (bin/rails test -v) ─────────────

/** `CalcTest#test_adds = 0.00 s = .` lines, with the Failure:/Error: blocks that follow them. */
export function parseMinitest(text: string, root: string): TestResult[] {
  const t = text.replace(/\r/g, "");
  const out: TestResult[] = [];
  for (const m of t.matchAll(/^(\S+)#(\S+) = ([\d.]+) s = ([.FESN])$/gm)) {
    const [, group, name, secs, mark] = m;
    const status = mark === "." ? "passed" : mark === "F" ? "failed" : mark === "E" ? "error" : "skipped";
    let message: string | null = null;
    let details: string | null = null;
    let file: string | null = null;
    let line: number | null = null;
    if (status === "failed" || status === "error") {
      const esc = `${group}#${name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const block = new RegExp(`^(?:Failure|Error):\\n${esc}(?: \\[([^\\]]+):(\\d+)\\])?:\\n([\\s\\S]*?)(?:\\n\\nbin/rails test ([^:\\s]+):(\\d+)|\\n\\n(?=\\S+#\\S+ = )|\\n\\nFinished|(?![\\s\\S]))`, "m").exec(t);
      if (block) {
        details = block[3].trim();
        message = details.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 3).join(" · ").slice(0, 300);
        const loc = block[1] ? { file: relative(block[1], root), line: Number(block[2]) } : locate(details, root, block[4] ? relative(block[4], root) : null);
        file = loc?.file ?? (block[4] ? relative(block[4], root) : null);
        line = loc?.line ?? (block[5] ? Number(block[5]) : null);
      }
    }
    out.push(result({ name, group, file, line, status, durationMs: Math.round(Number(secs) * 1000), message, details }));
  }
  return out;
}

export function summarize(results: TestResult[]) {
  const s = { total: results.length, passed: 0, failed: 0, skipped: 0, error: 0 };
  for (const r of results) s[r.status]++;
  return s;
}
