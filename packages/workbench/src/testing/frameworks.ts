/**
 * Which test frameworks a workspace uses (from the same folder scan as the Run
 * hub), and the command that runs all of them, one file or one test with
 * machine-readable results. Pure and unit-tested.
 */
import type { FolderSnapshot } from "../run/projectKind";

export type Framework =
  | "pytest"
  | "unittest"
  | "django"
  | "vitest"
  | "jest"
  | "node"
  | "maven"
  | "gradle"
  | "go"
  | "cargo"
  | "dart"
  | "flutter"
  | "phpunit"
  | "laravel"
  | "rspec"
  | "rails"
  | "dotnet"
  | "swift";

export type ReportKind = "junit" | "junit-dir" | "jest" | "rspec" | "trx" | "go" | "dart" | "cargo" | "swift" | "unittest" | "minitest" | "none";

export interface Scope {
  /** Workspace-relative file. */
  file?: string;
  /** One test: its name and group as the results report them. */
  test?: { name: string; group: string };
}

export interface TestSuite {
  id: string;
  framework: Framework;
  /** "pytest", "Vitest · client". */
  label: string;
  icon: string;
  /** Workspace-relative folder the command runs in. */
  dir: string;
  report: { kind: ReportKind; /** Workspace-relative file or folder; absent = parse the output. */ path?: string };
  /** Shown when the framework isn't installed. */
  install?: string;
  /** The command line for a scope (runs in `dir`). */
  command(scope?: Scope): string;
}

/** Reports land in .tmcode/test-results (never uploaded with a Task Mentor project). */
export const RESULTS_DIR = ".tmcode/test-results";

let windows = false;
/** Commands run in `cmd /C` on Windows and `$SHELL -lc` elsewhere: quote for that shell. */
export function setShellOs(os: string) {
  windows = os === "windows";
}
const q = (s: string) => (/^[\w./:@#=,+-]+$/.test(s) ? s : windows ? `"${s.replace(/"/g, '""')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
const at = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
/** A workspace path as seen from `dir`. */
export const fromDir = (dir: string, path: string) => {
  if (!dir) return path;
  if (path === dir) return ".";
  if (path.startsWith(`${dir}/`)) return path.slice(dir.length + 1);
  return `${"../".repeat(dir.split("/").length)}${path}`;
};
const where = (dir: string) => (dir ? ` · ${dir}` : "");

interface Pkg {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** `test "adds two"` defines test_adds_two (ActiveSupport::TestCase). */
const minitestName = (name: string) => (/^test_/.test(name) ? name : `test_${name.replace(/\s+/g, "_")}`);

function suitesIn(f: FolderSnapshot): TestSuite[] {
  const out: TestSuite[] = [];
  const has = (n: string) => f.files.includes(n);
  const id = (fw: Framework) => `${fw}:${f.dir}`;
  const out_ = (name: string) => fromDir(f.dir, `${RESULTS_DIR}/${name}`);
  const resultPath = (name: string) => `${RESULTS_DIR}/${name}`;
  const scopedFile = (s?: Scope) => (s?.file ? fromDir(f.dir, s.file) : null);

  // JavaScript / TypeScript
  if (has("package.json")) {
    let pkg: Pkg = {};
    try {
      pkg = JSON.parse(f.read["package.json"] ?? "{}") as Pkg;
    } catch {
      /* unreadable package.json */
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const testScript = pkg.scripts?.test ?? "";
    if ("vitest" in deps || /\bvitest\b/.test(testScript)) {
      out.push({
        id: id("vitest"),
        framework: "vitest",
        label: `Vitest${where(f.dir)}`,
        icon: "beaker",
        dir: f.dir,
        report: { kind: "junit", path: resultPath("vitest.xml") },
        install: "npm install -D vitest",
        command: (s) => ["npx vitest run --reporter=default --reporter=junit", `--outputFile.junit=${out_("vitest.xml")}`, scopedFile(s), s?.test ? `-t ${q(s.test.name)}` : null].filter(Boolean).join(" "),
      });
    } else if ("jest" in deps || /\bjest\b/.test(testScript) || "react-scripts" in deps) {
      out.push({
        id: id("jest"),
        framework: "jest",
        label: `Jest${where(f.dir)}`,
        icon: "beaker",
        dir: f.dir,
        report: { kind: "jest", path: resultPath("jest.json") },
        install: "npm install -D jest",
        command: (s) => ["npx jest --ci --json", `--outputFile=${out_("jest.json")}`, scopedFile(s), s?.test ? `-t ${q(s.test.name)}` : null].filter(Boolean).join(" "),
      });
    } else if (/node\s+--test/.test(testScript) || f.files.some((n) => /\.test\.[cm]?js$/.test(n))) {
      out.push({
        id: id("node"),
        framework: "node",
        label: `node:test${where(f.dir)}`,
        icon: "beaker",
        dir: f.dir,
        report: { kind: "junit", path: resultPath("node.xml") },
        command: (s) =>
          ["node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit", `--test-reporter-destination=${out_("node.xml")}`, s?.test ? `--test-name-pattern=${q(s.test.name)}` : null, scopedFile(s)].filter(Boolean).join(" "),
      });
    }
  }

  // Python
  // The project's own virtual environment first (like VS Code's interpreter pick); macOS has no bare `python`.
  const venv = [".venv", "venv"].find((d) => f.dirs.includes(d));
  const py = () => (venv ? (windows ? `${venv}\\Scripts\\python` : `${venv}/bin/python`) : windows ? "python" : "python3");
  const pyText = ["requirements.txt", "pyproject.toml", "Pipfile"].map((n) => f.read[n] ?? "").join("\n");
  // A tests/ folder alone isn't Python (PHPUnit and Laravel use one too).
  const pyTests = f.files.some((n) => /^test_.*\.py$|_test\.py$/.test(n)) || (f.dirs.includes("tests") && (!!pyText.trim() || f.files.some((n) => n.endsWith(".py"))));
  if (has("manage.py")) {
    out.push({
      id: id("django"),
      framework: "django",
      label: `Django tests${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "unittest" },
      command: (s) => [`${py()} manage.py test -v 2`, s?.test ? `${s.test.group}.${s.test.name}` : null].filter(Boolean).join(" "),
    });
  } else if (/\bpytest\b/i.test(pyText) || pyTests) {
    out.push({
      id: id("pytest"),
      framework: "pytest",
      label: `pytest${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "junit", path: resultPath("pytest.xml") },
      install: "python3 -m pip install pytest",
      command: (s) => {
        // A test is its node id (file::Class::test): -k would also match test_add_wrong for test_add.
        const cls = s?.test?.group.split(".").pop() ?? "";
        const node = s?.test && s.file ? `${scopedFile(s)}::${/^[A-Z]/.test(cls) ? `${cls}::` : ""}${s.test.name}` : null;
        return [`${py()} -m pytest -p no:cacheprovider -q`, `--junitxml=${out_("pytest.xml")}`, node ? q(node) : scopedFile(s), s?.test && !node ? `-k ${q(s.test.name)}` : null].filter(Boolean).join(" ");
      },
    });
  }

  // JVM
  if (has("pom.xml")) {
    const mvn = has("mvnw") ? "./mvnw" : "mvn";
    out.push({
      id: id("maven"),
      framework: "maven",
      label: `Maven (JUnit)${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "junit-dir", path: at(f.dir, "target/surefire-reports") },
      command: (s) => [`${mvn} -q test -DfailIfNoTests=false -Dsurefire.failIfNoSpecifiedTests=false`, s?.test ? `-Dtest=${q(`${s.test.group.split(".").pop()}#${s.test.name}`)}` : s?.file ? `-Dtest=${q(s.file.split("/").pop()!.replace(/\.(java|kt)$/, ""))}` : null].filter(Boolean).join(" "),
    });
  } else if (has("build.gradle") || has("build.gradle.kts")) {
    const gradle = has("gradlew") ? "./gradlew" : "gradle";
    out.push({
      id: id("gradle"),
      framework: "gradle",
      label: `Gradle (JUnit)${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "junit-dir", path: at(f.dir, "build/test-results/test") },
      command: (s) => [`${gradle} test --console=plain`, s?.test ? `--tests ${q(`${s.test.group}.${s.test.name}`)}` : s?.file ? `--tests ${q(`*${s.file.split("/").pop()!.replace(/\.(java|kt)$/, "")}`)}` : null].filter(Boolean).join(" "),
    });
  }

  if (has("go.mod")) {
    out.push({
      id: id("go"),
      framework: "go",
      label: `go test${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "go" },
      command: (s) => ["go test -json", s?.file ? (fromDir(f.dir, s.file).includes("/") ? `./${fromDir(f.dir, s.file).replace(/\/[^/]+$/, "")}` : ".") : "./...", s?.test ? `-run ${q(`^${s.test.name}$`)}` : null].filter(Boolean).join(" "),
    });
  }
  if (has("Cargo.toml")) {
    out.push({ id: id("cargo"), framework: "cargo", label: `cargo test${where(f.dir)}`, icon: "beaker", dir: f.dir, report: { kind: "cargo" }, command: (s) => ["cargo test", s?.test ? q(`${s.test.group}::${s.test.name}`) : null].filter(Boolean).join(" ") });
  }
  if (has("pubspec.yaml")) {
    const flutter = /sdk:\s*flutter/.test(f.read["pubspec.yaml"] ?? "");
    out.push({
      id: id(flutter ? "flutter" : "dart"),
      framework: flutter ? "flutter" : "dart",
      label: `${flutter ? "flutter test" : "dart test"}${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "dart" },
      command: (s) => [flutter ? "flutter test --machine" : "dart test --reporter json", scopedFile(s), s?.test ? `--plain-name ${q(s.test.name)}` : null].filter(Boolean).join(" "),
    });
  }

  // PHP
  if (has("artisan")) {
    out.push({ id: id("laravel"), framework: "laravel", label: `Laravel tests${where(f.dir)}`, icon: "beaker", dir: f.dir, report: { kind: "junit", path: resultPath("phpunit.xml") }, command: (s) => ["php artisan test", `--log-junit ${out_("phpunit.xml")}`, scopedFile(s), s?.test ? `--filter ${q(s.test.name)}` : null].filter(Boolean).join(" ") });
  } else if (/phpunit/.test(f.read["composer.json"] ?? "")) {
    out.push({ id: id("phpunit"), framework: "phpunit", label: `PHPUnit${where(f.dir)}`, icon: "beaker", dir: f.dir, report: { kind: "junit", path: resultPath("phpunit.xml") }, install: "composer require --dev phpunit/phpunit", command: (s) => ["vendor/bin/phpunit", `--log-junit ${out_("phpunit.xml")}`, s?.test ? `--filter ${q(s.test.name)}` : null, scopedFile(s)].filter(Boolean).join(" ") });
  }

  // Ruby
  const gems = f.read["Gemfile"] ?? "";
  if (/rspec/.test(gems) || f.dirs.includes("spec")) {
    out.push({ id: id("rspec"), framework: "rspec", label: `RSpec${where(f.dir)}`, icon: "beaker", dir: f.dir, report: { kind: "rspec", path: resultPath("rspec.json") }, install: "bundle add rspec --group test", command: (s) => [has("Gemfile") ? "bundle exec rspec" : "rspec", "--format progress --format json", `--out ${out_("rspec.json")}`, scopedFile(s), s?.test ? `-e ${q(s.test.name)}` : null].filter(Boolean).join(" ") });
  } else if (/\brails\b/.test(gems)) {
    out.push({ id: id("rails"), framework: "rails", label: `Rails tests${where(f.dir)}`, icon: "beaker", dir: f.dir, report: { kind: "minitest" }, command: (s) => ["bin/rails test -v", scopedFile(s), s?.test ? `-n ${q(minitestName(s.test.name))}` : null].filter(Boolean).join(" ") });
  }

  // .NET
  const csproj = f.files.filter((n) => /\.(cs|fs)proj$/.test(n));
  if (csproj.some((n) => /Test\.Sdk|xunit|nunit|MSTest/i.test(f.read[n] ?? "")) || (has(f.files.find((n) => n.endsWith(".sln")) ?? "") && f.dirs.some((d) => /test/i.test(d)))) {
    out.push({
      id: id("dotnet"),
      framework: "dotnet",
      label: `dotnet test${where(f.dir)}`,
      icon: "beaker",
      dir: f.dir,
      report: { kind: "trx", path: resultPath("dotnet.trx") },
      command: (s) => [`dotnet test --logger "trx;LogFileName=dotnet.trx" --results-directory ${fromDir(f.dir, RESULTS_DIR)}`, s?.test ? `--filter ${q(`FullyQualifiedName~${s.test.group}.${s.test.name}`)}` : null].filter(Boolean).join(" "),
    });
  }

  if (has("Package.swift")) {
    out.push({ id: id("swift"), framework: "swift", label: `swift test${where(f.dir)}`, icon: "beaker", dir: f.dir, report: { kind: "swift" }, command: (s) => ["swift test", s?.test ? `--filter ${q(`${s.test.group.split(".").pop()}/${s.test.name}`)}` : null].filter(Boolean).join(" ") });
  }
  return out;
}

/** Every test suite of the workspace (root first, then sub-folders). */
export function detectSuites(folders: FolderSnapshot[]): TestSuite[] {
  return folders.flatMap(suitesIn).sort((a, b) => a.dir.split("/").length - b.dir.split("/").length || a.dir.localeCompare(b.dir));
}

/** Which suite owns a file (the deepest folder containing it). */
export function suiteForFile(suites: TestSuite[], file: string): TestSuite | null {
  return [...suites].filter((s) => !s.dir || file === s.dir || file.startsWith(`${s.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;
}

/** The test declared at or above a 1-based line (null outside any test). */
export function testAt(source: string, line: number, path: string): string | null {
  const before = testDeclarations(source, path).filter((d) => d.line <= line + 1);
  return before.at(-1)?.name ?? null;
}

/** Files that hold tests by the usual naming conventions. */
export function isTestFile(path: string) {
  return /(^|\/)(test_[^/]*\.py|[^/]*_test\.(py|go|dart)|[^/]*[.-](test|spec)\.[cm]?[jt]sx?|[^/]*Tests?\.(java|kt|cs|swift|php)|[^/]*_spec\.rb|[^/]*_test\.rb)$/.test(path) || /(^|\/)(tests?|spec|__tests__)\/[^/]+\.\w+$/.test(path);
}

/** The test declarations of a file (1-based lines), for the Run Test lenses. */
export function testDeclarations(source: string, path: string): { line: number; name: string }[] {
  const lines = source.split("\n");
  const out: { line: number; name: string }[] = [];
  const ext = path.replace(/^.*\./, "");
  let annotated = false; // @Test / #[test] / [Fact] seen on the lines before
  lines.forEach((l, i) => {
    let m: RegExpExecArray | null = null;
    switch (ext) {
      case "py":
        m = /^\s*(?:async\s+)?def (test\w*)\s*\(/.exec(l);
        break;
      case "js":
      case "jsx":
      case "ts":
      case "tsx":
      case "mjs":
      case "cjs":
      case "mts":
      case "cts":
      case "dart":
        m = /^\s*(?:it|test)\s*\(\s*(["'`])((?:(?!\1).)+)\1/.exec(l);
        if (m) m = Object.assign([m[0], m[2]], { index: m.index, input: m.input }) as RegExpExecArray;
        break;
      case "go":
        m = /^func (Test\w+)\s*\(\s*\w+ \*testing\.T/.exec(l);
        break;
      case "rs":
        if (/^\s*#\[(tokio::)?test\]/.test(l)) annotated = true;
        else if (annotated && (m = /^\s*(?:pub\s+)?(?:async\s+)?fn (\w+)/.exec(l))) annotated = false;
        break;
      case "java":
      case "kt":
      case "cs":
        if (/^\s*(@(Test|ParameterizedTest|RepeatedTest)\b|\[(Fact|Theory|Test|TestMethod|TestCase)\b)/.test(l)) annotated = true;
        else if (annotated && (m = /(?:void|fun|Task|async\s+Task)\s+(\w+)\s*\(/.exec(l))) annotated = false;
        break;
      case "swift":
        m = /^\s*func (test\w*)\s*\(/.exec(l);
        break;
      case "php":
        if (/@test\b|#\[Test\]/.test(l)) annotated = true;
        m = /^\s*public function (\w+)\s*\(/.exec(l);
        if (m && !annotated && !/^test/.test(m[1])) m = null;
        if (m) annotated = false;
        break;
      case "rb":
        m = /^\s*(?:it|test|specify)\s+(["'])((?:(?!\1).)+)\1/.exec(l);
        if (m) m = Object.assign([m[0], m[2]], { index: m.index, input: m.input }) as RegExpExecArray;
        break;
    }
    if (m) out.push({ line: i + 1, name: m[1] });
  });
  return out;
}
