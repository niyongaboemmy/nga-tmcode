// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FolderSnapshot } from "../run/projectKind";
import { detectSuites, fromDir, isTestFile, setShellOs, suiteForFile, testAt, testDeclarations } from "./frameworks";

const folder = (dir: string, files: string[], read: Record<string, string> = {}, dirs: string[] = []): FolderSnapshot => ({ dir, files, dirs, read });
const pkg = (o: object) => JSON.stringify(o);

describe("detectSuites", () => {
  it("finds one suite per framework, root first", () => {
    const suites = detectSuites([
      folder("client", ["package.json"], { "package.json": pkg({ devDependencies: { vitest: "^2" } }) }),
      folder("", ["requirements.txt", "test_calc.py"], { "requirements.txt": "flask\npytest\n" }),
      folder("server", ["pom.xml", "mvnw"]),
    ]);
    expect(suites.map((s) => [s.framework, s.dir, s.label])).toEqual([
      ["pytest", "", "pytest"],
      ["vitest", "client", "Vitest · client"],
      ["maven", "server", "Maven (JUnit) · server"],
    ]);
  });

  it("prefers Vitest over Jest, Jest over node:test", () => {
    const fw = (p: object, files = ["package.json"]) => detectSuites([folder("", files, { "package.json": pkg(p) })]).map((s) => s.framework);
    expect(fw({ devDependencies: { vitest: "1", jest: "1" } })).toEqual(["vitest"]);
    expect(fw({ dependencies: { "react-scripts": "5" } })).toEqual(["jest"]);
    expect(fw({ scripts: { test: "node --test" } })).toEqual(["node"]);
    expect(fw({}, ["package.json", "calc.test.mjs"])).toEqual(["node"]);
    expect(fw({ dependencies: { express: "4" } })).toEqual([]);
  });

  it("Django, Flutter vs Dart, Laravel vs PHPUnit, RSpec, .NET, Swift, Go, Cargo, Gradle", () => {
    const fw = (files: string[], read: Record<string, string> = {}, dirs: string[] = []) => detectSuites([folder("", files, read, dirs)]).map((s) => s.framework);
    expect(fw(["manage.py", "requirements.txt"], { "requirements.txt": "django\npytest" })).toEqual(["django"]);
    expect(fw(["pubspec.yaml"], { "pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n" })).toEqual(["flutter"]);
    expect(fw(["pubspec.yaml"], { "pubspec.yaml": "name: app\n" })).toEqual(["dart"]);
    expect(fw(["artisan", "composer.json"], { "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' })).toEqual(["laravel"]);
    expect(fw(["composer.json"], { "composer.json": '{"require-dev":{"phpunit/phpunit":"^11"}}' })).toEqual(["phpunit"]);
    expect(fw(["Gemfile"], { Gemfile: "gem 'rspec'" })).toEqual(["rspec"]);
    expect(fw(["App.Tests.csproj"], { "App.Tests.csproj": '<PackageReference Include="xunit" />' })).toEqual(["dotnet"]);
    expect(fw(["App.csproj"], { "App.csproj": "<Project Sdk=\"Microsoft.NET.Sdk.Web\" />" })).toEqual([]);
    expect(fw(["Package.swift"])).toEqual(["swift"]);
    expect(fw(["go.mod"])).toEqual(["go"]);
    expect(fw(["Cargo.toml"])).toEqual(["cargo"]);
    expect(fw(["build.gradle.kts", "gradlew"])).toEqual(["gradle"]);
  });
});

describe("commands", () => {
  const one = (f: FolderSnapshot) => detectSuites([f])[0];

  it("pytest: report, one file, one test (from a sub-folder)", () => {
    const s = one(folder("api", ["pyproject.toml"], { "pyproject.toml": "[tool.pytest.ini_options]" }));
    expect(s.report).toEqual({ kind: "junit", path: ".tmcode/test-results/pytest.xml" });
    expect(s.command()).toBe("python3 -m pytest -p no:cacheprovider -q --junitxml=../.tmcode/test-results/pytest.xml");
    expect(s.command({ file: "api/tests/test_x.py", test: { name: "test_add", group: "" } })).toBe(
      "python3 -m pytest -p no:cacheprovider -q --junitxml=../.tmcode/test-results/pytest.xml tests/test_x.py::test_add",
    );
  });

  it("pytest: a test in a class, and a test without its file", () => {
    const s = one(folder("", ["test_a.py"]));
    expect(s.command({ file: "test_a.py", test: { name: "test_m", group: "test_a.TestMore" } })).toMatch(/ test_a\.py::TestMore::test_m$/);
    expect(s.command({ test: { name: "test_m", group: "" } })).toMatch(/ -k test_m$/);
  });

  it("vitest / jest / node:test", () => {
    const vitest = one(folder("", ["package.json"], { "package.json": pkg({ devDependencies: { vitest: "1" } }) }));
    expect(vitest.command({ file: "src/a.test.ts", test: { name: "adds two", group: "" } })).toBe(
      "npx vitest run --reporter=default --reporter=junit --outputFile.junit=.tmcode/test-results/vitest.xml src/a.test.ts -t 'adds two'",
    );
    const jest = one(folder("", ["package.json"], { "package.json": pkg({ devDependencies: { jest: "1" } }) }));
    expect(jest.command()).toBe("npx jest --ci --json --outputFile=.tmcode/test-results/jest.json");
    const node = one(folder("", ["package.json"], { "package.json": pkg({ scripts: { test: "node --test" } }) }));
    expect(node.command()).toContain("--test-reporter=junit --test-reporter-destination=.tmcode/test-results/node.xml");
  });

  it("Maven / Gradle select a class or a method", () => {
    const mvn = one(folder("", ["pom.xml"]));
    expect(mvn.report).toEqual({ kind: "junit-dir", path: "target/surefire-reports" });
    expect(mvn.command({ test: { name: "adds", group: "com.example.CalcTest" } })).toContain("-Dtest=CalcTest#adds");
    expect(mvn.command({ file: "src/test/java/com/example/CalcTest.java" })).toContain("-Dtest=CalcTest");
    const gradle = one(folder("svc", ["build.gradle", "gradlew"]));
    expect(gradle.report.path).toBe("svc/build/test-results/test");
    expect(gradle.command({ test: { name: "adds", group: "com.example.CalcTest" } })).toBe("./gradlew test --console=plain --tests com.example.CalcTest.adds");
  });

  it("go, cargo, dart, dotnet, swift, rspec, laravel", () => {
    expect(one(folder("", ["go.mod"])).command({ file: "pkg/calc/calc_test.go", test: { name: "TestAdd", group: "" } })).toBe("go test -json ./pkg/calc -run '^TestAdd$'");
    expect(one(folder("", ["go.mod"])).command({ file: "calc_test.go", test: { name: "TestAdd", group: "" } })).toBe("go test -json . -run '^TestAdd$'");
    expect(one(folder("", ["Cargo.toml"])).command({ test: { name: "adds", group: "tests" } })).toBe("cargo test tests::adds");
    expect(one(folder("", ["pubspec.yaml"], { "pubspec.yaml": "sdk: flutter" })).command({ file: "test/w_test.dart" })).toBe("flutter test --machine test/w_test.dart");
    const dotnet = one(folder("", ["T.csproj"], { "T.csproj": "Microsoft.NET.Test.Sdk" }));
    expect(dotnet.command()).toBe('dotnet test --logger "trx;LogFileName=dotnet.trx" --results-directory .tmcode/test-results');
    expect(one(folder("", ["Package.swift"])).command({ test: { name: "testAdds", group: "CalcTests.CalcTests" } })).toBe("swift test --filter CalcTests/testAdds");
    expect(one(folder("", ["Gemfile"], { Gemfile: "rspec" })).command({ file: "spec/c_spec.rb" })).toBe("bundle exec rspec --format progress --format json --out .tmcode/test-results/rspec.json spec/c_spec.rb");
    expect(one(folder("", ["artisan"])).command()).toBe("php artisan test --log-junit .tmcode/test-results/phpunit.xml");
  });
});

describe("files and declarations", () => {
  it("fromDir and suiteForFile", () => {
    expect(fromDir("", "a/b.py")).toBe("a/b.py");
    expect(fromDir("api", "api/t.py")).toBe("t.py");
    expect(fromDir("a/b", ".tmcode/x")).toBe("../../.tmcode/x");
    const suites = detectSuites([folder("", ["go.mod"]), folder("web", ["package.json"], { "package.json": pkg({ devDependencies: { vitest: "1" } }) })]);
    expect(suiteForFile(suites, "web/src/a.test.ts")?.framework).toBe("vitest");
    expect(suiteForFile(suites, "calc_test.go")?.framework).toBe("go");
  });

  it("isTestFile", () => {
    for (const f of ["test_calc.py", "calc_test.go", "src/a.test.ts", "a.spec.jsx", "src/test/java/CalcTest.java", "CalcTests.swift", "spec/c_spec.rb", "tests/Feature/UserTest.php", "test/w_test.dart"]) expect(isTestFile(f), f).toBe(true);
    for (const f of ["calc.py", "main.go", "src/App.tsx", "Calc.java"]) expect(isTestFile(f), f).toBe(false);
  });

  it("finds test declarations per language", () => {
    expect(testDeclarations("def helper():\n  pass\ndef test_add():\n  assert 1\nclass T:\n    def test_m(self): ...", "t.py")).toEqual([
      { line: 3, name: "test_add" },
      { line: 6, name: "test_m" },
    ]);
    expect(testDeclarations("describe('calc', () => {\n  it('adds', () => {});\n  test(\"subtracts\", () => {});\n});", "a.test.ts").map((d) => d.name)).toEqual(["adds", "subtracts"]);
    expect(testDeclarations("#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {}\n    fn helper() {}\n}", "lib.rs")).toEqual([{ line: 4, name: "adds" }]);
    expect(testDeclarations("class CalcTest {\n  @Test\n  void adds() {}\n  void helper() {}\n}", "CalcTest.java")).toEqual([{ line: 3, name: "adds" }]);
    expect(testDeclarations("public class T {\n  [Fact]\n  public void Adds() {}\n}", "T.cs")).toEqual([{ line: 3, name: "Adds" }]);
    expect(testDeclarations("func TestAdd(t *testing.T) {}\nfunc helper() {}", "a_test.go")).toEqual([{ line: 1, name: "TestAdd" }]);
    expect(testDeclarations("  public function test_it_adds(): void {}\n  public function helper() {}", "CalcTest.php")).toEqual([{ line: 1, name: "test_it_adds" }]);
    expect(testDeclarations("RSpec.describe Calc do\n  it 'adds' do\n  end\nend", "c_spec.rb")).toEqual([{ line: 2, name: "adds" }]);
  });

  it("Python runs in the project's virtual environment", () => {
    const s = detectSuites([folder("", ["test_a.py"], {}, [".venv"])])[0];
    expect(s.command()).toMatch(/^\.venv\/bin\/python -m pytest /);
    setShellOs("windows");
    expect(s.command()).toMatch(/^\.venv\\Scripts\\python -m pytest /);
    expect(detectSuites([folder("", ["manage.py"])])[0].command()).toBe("python manage.py test -v 2");
    setShellOs("mac");
  });

  it("quotes for the shell the command runs in", () => {
    const s = detectSuites([folder("", ["package.json"], { "package.json": pkg({ devDependencies: { jest: "1" } }) })])[0];
    expect(s.command({ test: { name: "it's $HOME", group: "" } })).toContain(`-t 'it'\\''s $HOME'`);
    setShellOs("windows");
    expect(s.command({ test: { name: 'say "hi"', group: "" } })).toContain(`-t "say ""hi"""`);
    setShellOs("mac");
  });

  it("testAt: the test the cursor is in", () => {
    const src = "import x\n\ndef test_a():\n    assert 1\n\ndef test_b():\n    assert 2\n";
    expect(testAt(src, 1, "t.py")).toBeNull();
    expect(testAt(src, 4, "t.py")).toBe("test_a");
    expect(testAt(src, 7, "t.py")).toBe("test_b");
  });
});
