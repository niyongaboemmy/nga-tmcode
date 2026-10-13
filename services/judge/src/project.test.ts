import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { kindById } from "../../../packages/runtimes/src/index.ts";
import { check, checkerProblem } from "./checkers.ts";
import { resolvePrograms, type RunResponse } from "./judge.ts";
import { missingPackage } from "./packages.ts";
import { cacheFiles, missingModule, resolveProject, runLimits, stepArgv, type ProjectRequest, type ProjectResponse } from "./project.ts";
import { isProjectRequest, run, type JudgeEnv } from "./run.ts";
import { IsolateSandbox, LocalSandbox, localPath, restoreSnapshot, type Sandbox } from "./sandbox.ts";
import { renderArgs, testFilterArgs, type TokenContext } from "./tokens.ts";
import { availability, catalogView, detectView, resolveToolchains, runtimeChain } from "./toolchains.ts";
import { parseTap } from "./unit.ts";

/**
 * Catalog projects (build → unit tests → fresh I/O runs) against the local
 * toolchains. A case is skipped when its toolchain (or cache) isn't installed
 * on this machine; CI on Linux runs them inside isolate with
 * JUDGE_TEST_SANDBOX=isolate.
 */
const useIsolate = process.env.JUDGE_TEST_SANDBOX === "isolate";
const sandbox: Sandbox = useIsolate ? new IsolateSandbox(process.env.ISOLATE_BIN ?? "isolate", 2, 10) : new LocalSandbox();

const ROOT = join(import.meta.dirname, "../../..");
const STARTERS = join(ROOT, "packages/runtimes/starters");

/** Homebrew's cargo is often broken on macOS: prefer rustup's real toolchain binaries. */
function rustOverrides(): Record<string, string> {
  // A real install (deploy/install-languages.sh) wins: the box can't read the user's home.
  if (existsSync("/opt/rust/bin/rustc")) return {};
  const dir = join(homedir(), ".rustup/toolchains");
  if (!existsSync(dir)) return {};
  const tc = readdirSync(dir).find((d) => d.startsWith("stable"));
  if (!tc) return {};
  const bin = join(dir, tc, "bin");
  return existsSync(join(bin, "cargo")) ? { cargo: join(bin, "cargo"), rustc: join(bin, "rustc") } : {};
}

/** A pytest install made for these tests: python3 -m venv .cache/pyvenv && .cache/pyvenv/bin/pip install pytest. */
function venvSitePackages(): string | null {
  const lib = join(ROOT, ".cache/pyvenv/lib");
  if (!existsSync(lib)) return null;
  const py = readdirSync(lib).find((d) => d.startsWith("python3"));
  const site = py ? join(lib, py, "site-packages") : null;
  return site && existsSync(join(site, "pytest")) ? site : null;
}

/**
 * The m2 cache layer: JUDGE_TEST_M2, else .cache/m2 (fill it once, online:
 * `mvn -B -Dmaven.repo.local=$PWD/.cache/m2 package` in a copy of the
 * java-maven-junit starter), else ~/.m2/repository when it has the plugins.
 */
const M2 =
  process.env.JUDGE_TEST_M2 ??
  [join(ROOT, ".cache/m2"), join(homedir(), ".m2/repository")].find((d) => existsSync(join(d, "org/apache/maven/plugins/maven-jar-plugin"))) ??
  join(ROOT, ".cache/m2");
const SITE = venvSitePackages();
const caches: Record<string, string> = {};
if (existsSync(M2)) caches["m2-school"] = M2;
if (SITE) caches["site-packages-school"] = SITE;
/** npm cache layer: `npm cache add ms@2.1.3 --cache .cache/npm` (online, once). */
const NPM_CACHE = join(ROOT, ".cache/npm");
if (existsSync(NPM_CACHE)) caches["npm-school"] = NPM_CACHE;
/** Layers made by deploy/build-caches.sh with CACHE_ROOT=.cache/layers (online, once). */
const LAYERS = process.env.JUDGE_TEST_LAYERS ?? join(ROOT, ".cache/layers");
for (const id of ["go-mod-school", "cargo-registry-school", "wheels-school", "gradle-school"]) if (existsSync(join(LAYERS, id))) caches[id] = join(LAYERS, id);
const tc = resolveToolchains({ overrides: { "rust-stable": rustOverrides() }, caches });
const tcNoCaches = resolveToolchains({ overrides: { "rust-stable": rustOverrides() } });
const env: JudgeEnv = { programs: resolvePrograms(), toolchains: tc };
/**
 * Whether this machine can run a kind. Under isolate, toolchains in the user's
 * home (rustup on CI runners) aren't readable by the box user: those are skipped.
 */
const can = (kind: string) => {
  const k = kindById(kind)!;
  if (!availability(tc, k).available) return false;
  if (!useIsolate) return true;
  const home = homedir();
  return runtimeChain(tc, k.runtime).every((rt) => Object.values(rt.tools).every((p) => !p || !p.startsWith(`${home}/`)));
};

function starter(language: string, id: string) {
  const dir = join(STARTERS, language, id);
  const files: { path: string; content: string }[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const full = join(d, n);
      if (statSync(full).isDirectory()) walk(full);
      else if (n !== "starter.json" && n !== "README.md" && n !== ".gitignore") files.push({ path: relative(dir, full), content: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return files;
}

const project = (req: ProjectRequest, e: JudgeEnv = env) => run(sandbox, e, req) as Promise<ProjectResponse>;

// ───────────── pure parts ─────────────

describe("token substitution", () => {
  const ctx: TokenContext = {
    entry: "src/app/Main.java",
    files: ["src/app/Main.java", "src/app/Util.java", "README.md", "node_modules/x/y.java", "a.c", "b.C"],
    mainClass: "app.Main",
    testFilter: ["-Dtest=CalcTest"],
    reportPath: "reports/junit.xml",
  };
  it("fills every token type", () => {
    expect(renderArgs({ args: ["-o", { out: "main" }, { out: "main.mjs", prefix: "--outfile=" }] }, ctx)).toEqual(["-o", "./main", "--outfile=./main.mjs"]);
    expect(renderArgs({ args: [{ sources: "java" }] }, ctx)).toEqual(["src/app/Main.java", "src/app/Util.java"]);
    expect(renderArgs({ args: [{ sources: ["c"] }] }, ctx)).toEqual(["a.c", "b.C"]);
    expect(renderArgs({ args: [{ entry: true }, { entry_stem: true }, { main_class: true }] }, ctx)).toEqual(["src/app/Main.java", "Main", "app.Main"]);
    expect(renderArgs({ args: ["test", { test_filter: true }, { report_path: true }, { report_path: true, prefix: "--junitxml=" }] }, ctx)).toEqual([
      "test",
      "-Dtest=CalcTest",
      "reports/junit.xml",
      "--junitxml=reports/junit.xml",
    ]);
    expect(renderArgs({ args: ["x", { test_filter: true }] }, { ...ctx, testFilter: [] })).toEqual(["x"]);
  });
  it("maps a test filter to each framework's flag", () => {
    expect(testFilterArgs("mvn", "CalcTest")).toEqual(["-Dtest=CalcTest", "-Dsurefire.failIfNoSpecifiedTests=false"]);
    expect(testFilterArgs("go", "TestAdd")).toEqual(["-run", "TestAdd"]);
    expect(testFilterArgs("python3", "test_add")).toEqual(["-k", "test_add"]);
    expect(testFilterArgs("gradle", "a.B")).toEqual(["--tests", "a.B"]);
    expect(testFilterArgs("cargo", "adds")).toEqual(["adds"]);
    expect(testFilterArgs("mvn", "")).toEqual([]);
  });
  it("resolves logical tools to absolute paths and never runs a shell string", () => {
    const k = kindById("c/single")!;
    const argv = stepArgv(tc, k, k.steps.build!, { ...ctx, entry: "main.c", files: ["main.c", "util.c"] });
    if (can("c/single")) {
      expect(argv[0].startsWith("/")).toBe(true);
      expect(argv.slice(1)).toEqual(["-std=c17", "-O2", "-Wall", "-Wextra", "main.c", "util.c", "-o", "./main", "-lm"]);
    }
  });
  it("lets JUDGE_TOOLCHAINS point a tool elsewhere", () => {
    const t = resolveToolchains({ overrides: { "gcc-13": { gcc: "/bin/sh" } }, lookup: false });
    expect(t.runtimes.get("gcc-13")!.tools.gcc).toBe("/bin/sh");
    expect(t.runtimes.get("gcc-13")!.tools.make === null || t.runtimes.get("gcc-13")!.tools.make!.startsWith("/")).toBe(true);
    expect(() => resolveToolchains({ overrides: "{nope" })).toThrow(/JUDGE_TOOLCHAINS/);
  });
});

describe("local sandbox paths", () => {
  it("maps /box, /tmp and mounted caches, nothing else", () => {
    const mounts = [{ inside: "/caches/m2-school", host: "/h/m2" }];
    expect(localPath("/box", "/B", "/T", mounts)).toBe("/B");
    expect(localPath("/box/.pydeps:/caches/m2-school", "/B", "/T", mounts)).toBe("/B/.pydeps:/h/m2");
    expect(localPath("-Dmaven.repo.local=/tmp/m2", "/B", "/T", mounts)).toBe("-Dmaven.repo.local=/T/m2");
    expect(localPath("file:///caches/m2-school/x,off", "/B", "/T", mounts)).toBe("file:///h/m2/x,off");
    expect(localPath("/private/tmp/x", "/B", "/T", mounts)).toBe("/private/tmp/x");
    expect(localPath("/caches/other", "/B", "/T", mounts)).toBe("/caches/other");
  });
  it("snapshots keep timestamps and in-box symlinks, and drop links that leave the box", async () => {
    const box = await sandbox.acquire();
    try {
      await box.write("node_modules/tool/cli.js", "x", 0o755, Date.UTC(2020, 0, 1));
      await box.link("node_modules/.bin/tool", "../tool/cli.js");
      await expect(box.link("escape", "../../etc/passwd")).rejects.toThrow(/outside/);
      const snap = await box.snapshot();
      await box.reset();
      expect(await box.read("node_modules/.bin/tool")).toBeNull();
      await restoreSnapshot(box, snap);
      expect((await box.read("node_modules/.bin/tool"))?.toString()).toBe("x");
      const again = await box.snapshot();
      expect(again.find((f) => f.path === "node_modules/tool/cli.js")?.mtimeMs).toBe(Date.UTC(2020, 0, 1));
      expect(again.find((f) => f.path === "node_modules/.bin/tool")?.link).toBe("../tool/cli.js");
    } finally {
      await box.dispose();
    }
  });
  it("writes a cargo source replacement only when the registry layer is mounted", () => {
    const k = kindById("rust/cargo")!;
    const box = { visible: (p: string) => p };
    expect(cacheFiles(k, [], box, [])).toEqual([]);
    const files = cacheFiles(k, [{ inside: "/caches/cargo-registry-school", host: "/x" }], box, []);
    expect(files[0].path).toBe(".cargo/config.toml");
    expect(files[0].content).toContain('directory = "/caches/cargo-registry-school"');
  });
});

describe("checkers", () => {
  it("whitespace (default) ignores CRLF and trailing whitespace only", () => {
    expect(check(undefined, "5\n", "5")).toBe(true);
    expect(check(undefined, "a b\n", "a b  \r\n\n")).toBe(true);
    expect(check(undefined, "a b", "a  b")).toBe(false);
  });
  it("exact compares bytes (line endings aside)", () => {
    expect(check({ type: "exact" }, "5\n", "5\r\n")).toBe(true);
    expect(check({ type: "exact" }, "5\n", "5")).toBe(false);
  });
  it("token ignores all whitespace layout", () => {
    expect(check({ type: "token" }, "1 2 3\n", "1\n2   3")).toBe(true);
    expect(check({ type: "token" }, "1 2 3", "1 2")).toBe(false);
  });
  it("float allows an absolute or relative tolerance", () => {
    expect(check({ type: "float" }, "3.14159265 ok", "3.1415927 ok")).toBe(true);
    expect(check({ type: "float" }, "3.14159", "3.15")).toBe(false);
    expect(check({ type: "float", tolerance: 0.01 }, "3.14159", "3.15")).toBe(true);
    expect(check({ type: "float" }, "1e9", "1000000000.5")).toBe(true); // relative
    expect(check({ type: "float" }, "x 1", "y 1")).toBe(false);
    expect(check({ type: "float" }, "nan inf", "NaN Infinity")).toBe(true);
  });
  it("unordered compares lines as a multiset", () => {
    expect(check({ type: "unordered" }, "a\nb\nb\n", "b\na\nb")).toBe(true);
    expect(check({ type: "unordered" }, "a\nb\nb\n", "b\na\na")).toBe(false);
  });
  it("validates checker specs", () => {
    expect(checkerProblem({ type: "float", tolerance: 0.1 })).toBeNull();
    expect(checkerProblem({ type: "regex" })).toMatch(/Unknown checker/);
    expect(checkerProblem({ type: "float", tolerance: -1 })).toMatch(/tolerance/);
  });
});

describe("package-not-available detection", () => {
  const cases: [string, string, string | null][] = [
    [
      "[ERROR] Failed to execute goal on project app: Could not resolve dependencies for project rw.ac.nga:app:jar:1.0.0: Cannot access central (https://repo.maven.apache.org/maven2) in offline mode and the artifact com.google.code.gson:gson:jar:2.11.0 has not been downloaded from it before. -> [Help 1]",
      "maven",
      "com.google.code.gson:gson:jar:2.11.0",
    ],
    [
      "[ERROR] Plugin org.apache.maven.plugins:maven-resources-plugin:3.3.1 or one of its dependencies could not be resolved: Cannot access central in offline mode",
      "maven",
      "org.apache.maven.plugins:maven-resources-plugin:3.3.1",
    ],
    ["npm error code ENOTCACHED\nnpm error request to https://registry.npmjs.org/express failed: cache mode is 'only-if-cached' but no cached response is available.", "npm", "express"],
    ["npm ERR! code ENOTFOUND\nnpm ERR! errno ENOTFOUND\nnpm ERR! network request to https://registry.npmjs.org/@types%2fnode failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org", "npm", "@types/node"],
    ["ERROR: Could not find a version that satisfies the requirement flask-socketio (from versions: none)\nERROR: No matching distribution found for flask-socketio", "pip", "flask-socketio"],
    ["  × No solution found when resolving dependencies:\n  ╰─▶ Because flask-socketio was not found in the provided package locations and you require flask-socketio, we can conclude that your requirements are unsatisfiable.", "pip", "flask-socketio"],
    ["error: no matching package named `serde` found\nlocation searched: registry `crates-io`\nrequired by package `temperature v0.1.0 (/box)`", "cargo", "serde"],
    ["error: failed to get `rand` as a dependency of package `dice v0.1.0 (/box)`\n\nCaused by:\n  attempting to make an HTTP request, but --offline was specified", "cargo", "rand"],
    ["main.go:4:2: cannot find module providing package github.com/gin-gonic/gin: module lookup disabled by GOPROXY=off", "go", "github.com/gin-gonic/gin"],
    ["go: github.com/stretchr/testify@v1.9.0: module lookup disabled by GOPROXY=off", "go", "github.com/stretchr/testify"],
    ["Could not resolve all files for configuration ':compileClasspath'.\n   > No cached version of com.google.guava:guava:33.0.0-jre available for offline mode.", "gradle", "com.google.guava:guava:33.0.0-jre"],
  ];
  it.each(cases)("recognises %#", (text, manager, pkg) => {
    expect(missingPackage(text)).toEqual({ manager, package: pkg });
  });
  it("leaves ordinary compile errors alone", () => {
    expect(missingPackage("main.c:3:5: error: expected ';' before 'return'")).toBeNull();
    expect(missingPackage("[ERROR] COMPILATION ERROR : App.java:[5,9] cannot find symbol")).toBeNull();
    expect(missingPackage("ModuleNotFoundError: No module named 'helpers'")).toBeNull();
  });
});

describe("TAP", () => {
  it("parses ok / not ok / skip lines", () => {
    const r = parseTap("TAP version 13\n1..3\nok 1 - adds\nnot ok 2 - removes\n  ---\n  message: 'expected 1'\n  ...\nok 3 - later # SKIP not yet\n");
    expect(r.map((t) => [t.name, t.status])).toEqual([
      ["adds", "passed"],
      ["removes", "failed"],
      ["later", "skipped"],
    ]);
    expect(r[1].message).toBe("expected 1");
    expect(parseTap("all good\n")).toEqual([]);
  });
});

describe("requests and the catalog view", () => {
  it("keeps profile requests on the original path", () => {
    expect(isProjectRequest({ language: "python-3" })).toBe(false);
    expect(isProjectRequest({ language: "python-3", actions: ["test"] })).toBe(true);
    expect(isProjectRequest({ kind: "java/maven" })).toBe(true);
    expect(isProjectRequest({ language: "java" })).toBe(true);
    expect(isProjectRequest({})).toBe(true);
  });
  it("refuses unknown kinds, kinds this tier can't run, and bad actions", () => {
    const files = [{ path: "main.c", content: "int main(){}" }];
    expect(() => resolveProject(tc, { kind: "snobol/x", files })).toThrow(/Unknown project kind/);
    expect(() => resolveProject(tc, { kind: "java/spring-boot", files: [{ path: "pom.xml", content: "" }] })).toThrow(/containers are off/);
    expect(() => resolveProject(tc, { kind: "c/single", files, actions: ["deploy" as never] })).toThrow(/actions/);
    expect(() => resolveProject(tc, { kind: "c/single", files, actions: ["test"] })).toThrow(/no unit-test step/);
    expect(() => resolveProject(tc, { kind: "c/single", files, test_filter: "x; rm -rf /" })).toThrow(/test_filter/);
    expect(() => resolveProject(tc, { kind: "c/single", files, tests: [{ id: "1", input: "", checker: { type: "nope" as never } }] })).toThrow(/Unknown checker/);
    expect(() => resolveProject(tc, { files: [{ path: "notes.txt", content: "" }] })).toThrow(/Could not tell/);
    expect(() => resolveProject(tc, { language: "snobol", files })).toThrow(/Unsupported language/);
  });
  it("detects the kind and entry, and defaults the actions", () => {
    if (!can("c/single")) return;
    const r = resolveProject(tc, { files: [{ path: "src/main.c", content: "int main(void){return 0;}" }], tests: [{ id: "1", input: "" }] });
    expect([r.kind.id, r.entry, r.actions]).toEqual(["c/single", "src/main.c", ["build", "run"]]);
    const m = resolveProject(tc, { files: [{ path: "go.mod", content: "module x\n" }, { path: "main.go", content: "package main\nfunc main(){}" }] });
    expect([m.kind.id, m.actions]).toEqual(["go/module", ["build", "test"]]);
  });
  it("caps run limits but keeps the kind's floors", () => {
    const l = runLimits(kindById("java/maven")!, { time_s: 999, memory_mb: 64 });
    expect(l.cpuS).toBe(20);
    expect(l.memoryMb).toBe(512);
    expect(l.processes).toBe(64);
  });
  it("serves only the kinds whose tools are installed", () => {
    const view = catalogView(tc);
    expect(view.version).toMatch(/^\d{4}\.\d+\.\d+$/);
    for (const k of view.kinds) expect(["isolate", "isolate-build"]).toContain(k.tier);
    expect(view.kinds.some((k) => k.id === "web/static")).toBe(false);
    expect(view.unavailable.find((u) => u.id === "java/spring-boot")?.reason).toMatch(/container/);
    const none = catalogView(resolveToolchains({ lookup: false, overrides: { "*": {} } }));
    expect(none.kinds.every((k) => k.steps && availability(tc, kindById(k.id)!).available)).toBe(true);
  });
  it("ranks detected kinds with entries", () => {
    const d = detectView(tc, [
      { path: "pom.xml" },
      { path: "src/main/java/rw/App.java", content: "package rw;\npublic class App { public static void main(String[] a) {} }" },
      { path: "src/test/java/rw/AppTest.java", content: "class AppTest {}" },
    ]);
    expect(d.kinds[0].kind).toBe("java/maven");
    expect(d.kinds[0].entry).toBe("src/main/java/rw/App.java");
    expect(d.kinds[0].actions).toEqual(["build", "run", "test"]);
  });
});

// ───────────── real runs ─────────────

describe.runIf(env.programs.has("python3"))("backward compatibility", () => {
  it("still answers the original language request shape", async () => {
    const r = (await run(sandbox, env, {
      language: "python-3",
      entry: "main.py",
      files: [{ path: "main.py", content: "a, b = map(int, input().split())\nprint(a + b)\n" }],
      tests: [
        { id: "t1", input: "2 3\n", expected_output: "5\n" },
        { id: "t2", input: "2 3\n", expected_output: "6\n" },
      ],
    })) as RunResponse;
    expect(Object.keys(r).sort()).toEqual(["compile", "language", "sandbox", "tests"]);
    expect(r.language).toBe("python-3");
    expect(r.tests.map((t) => t.verdict)).toEqual(["accepted", "wrong-answer"]);
  });
  it("applies a checker on the original path too", async () => {
    const r = (await run(sandbox, env, {
      language: "python-3",
      entry: "main.py",
      files: [{ path: "main.py", content: "print(22/7)\n" }],
      tests: [{ id: "t", input: "", expected_output: "3.142857" }],
      checker: { type: "float", tolerance: 1e-5 },
    })) as RunResponse;
    expect(r.tests[0].verdict).toBe("accepted");
  });
});

describe.runIf(can("c/single"))("c/single from the catalog", () => {
  it("builds once, runs each test fresh and applies per-test checkers", async () => {
    const r = await project({
      kind: "c/single",
      files: [{ path: "main.c", content: '#include <stdio.h>\n#include <unistd.h>\nint main(void){ if (access("leak", 0) == 0) { puts("leaked"); return 0; } FILE *f = fopen("leak", "w"); fclose(f); double a, b; if (scanf("%lf %lf", &a, &b) != 2) return 1; printf("%.6f\\n", a / b); return 0; }\n' }],
      tests: [
        { id: "exact", input: "1 3", expected_output: "0.333333\n" },
        { id: "float", input: "1 3", expected_output: "0.3333333333", checker: { type: "float", tolerance: 1e-5 } },
        { id: "wrong", input: "1 3", expected_output: "0.5" },
        { id: "crash", input: "", expected_output: "x" },
      ],
    });
    expect(r.kind).toBe("c/single");
    expect(r.compile?.ok).toBe(true);
    expect(r.tests.map((t) => [t.id, t.verdict])).toEqual([
      ["exact", "accepted"],
      ["float", "accepted"],
      ["wrong", "wrong-answer"],
      ["crash", "runtime-error"],
    ]);
  });
  it("reports compile errors for every test", async () => {
    const r = await project({ kind: "c/single", files: [{ path: "main.c", content: "int main(void) { return x; }\n" }], tests: [{ id: "1", input: "" }] });
    expect(r.compile?.ok).toBe(false);
    expect(r.tests[0].verdict).toBe("compile-error");
    expect(r.tests[0].stderr).toMatch(/x/);
  });
});

describe.runIf(can("c/make"))("c/make (starter c-structs-make)", () => {
  it("builds with make, runs `make run` and tests with `make test`", async () => {
    const r = await project({ kind: "c/make", files: starter("c", "c-structs-make"), actions: ["build", "run", "test"], tests: [{ id: "1", input: "" }, { id: "2", input: "" }] });
    expect(r.compile?.ok).toBe(true);
    expect(r.tests.map((t) => t.verdict)).toEqual(["ok", "ok"]);
    expect(r.tests[0].stdout.length).toBeGreaterThan(0);
    expect(r.unit?.verdict).toBe("passed");
    expect(r.unit?.total).toBeGreaterThanOrEqual(1);
  });
});

describe.runIf(can("cpp/cmake"))("cpp/cmake (starter cpp-cmake-gtest)", () => {
  it("configures, builds and runs ctest", async () => {
    const r = await project({ kind: "cpp/cmake", files: starter("cpp", "cpp-cmake-gtest"), actions: ["build", "test"] });
    expect(r.compile?.ok, r.compile?.output).toBe(true);
    expect(r.unit?.framework).toBe("ctest");
    expect(r.unit?.total, JSON.stringify({ steps: r.steps, unit: r.unit })).toBeGreaterThan(0);
  });
});

// The JUnit console launcher is installed by install.sh (and by CI's isolate job).
describe.runIf(can("java/single") && existsSync("/opt/junit/junit-platform-console-standalone.jar"))("java/single with JUnit 5 (starter java-junit)", () => {
  it("compiles the program and its tests with javac, then runs JUnit", async () => {
    const r = await project({ kind: "java/single", files: starter("java", "java-junit"), actions: ["build", "test"] });
    expect(r.compile?.ok, r.compile?.output).toBe(true);
    expect(r.unit?.framework, JSON.stringify({ steps: r.steps, unit: r.unit })).toBeTruthy();
    expect(r.unit?.verdict, r.unit?.output).toBe("passed");
    expect(r.unit?.total).toBe(4);
  });
});

describe.runIf(!!SITE && can("python/project"))("python/project with pytest (site-packages cache layer)", () => {
  it("runs pytest and returns per-test results", async () => {
    const r = await project({ files: starter("python", "python-pytest"), actions: ["test"] });
    expect(r.kind).toBe("python/project");
    expect(r.unit?.framework).toBe("pytest");
    expect(r.unit?.verdict).toBe("passed");
    expect(r.unit?.total).toBeGreaterThan(0);
    expect(r.unit?.passed).toBe(r.unit?.total);
    expect(r.unit?.tests[0]).toMatchObject({ status: "passed" });
    expect(typeof r.unit?.tests[0].name).toBe("string");
  });
  it("reports failing tests with their messages", async () => {
    const files = [...starter("python", "python-pytest"), { path: "tests/test_extra.py", content: "def test_broken():\n    assert 1 + 1 == 3, 'maths'\n" }];
    const r = await project({ files, actions: ["test"] });
    expect(r.unit?.verdict).toBe("failed");
    const broken = r.unit!.tests.find((t) => t.name === "test_broken")!;
    expect(broken.status).toBe("failed");
    expect(`${broken.message} ${broken.details}`).toMatch(/maths|assert/);
  });
  it("filters tests with test_filter", async () => {
    const all = await project({ files: starter("python", "python-pytest"), actions: ["test"] });
    const first = all.unit!.tests[0].name;
    const one = await project({ files: starter("python", "python-pytest"), actions: ["test"], test_filter: first });
    expect(one.unit?.total).toBe(1);
  });
  it("ignores a report file the submission brings along", async () => {
    const fake = '<testsuite tests="1"><testcase classname="x" name="fake"/></testsuite>';
    const files = [...starter("python", "python-pytest").filter((f) => f.path !== "tests/test_cart.py"), { path: "pytest-junit.xml", content: fake }, { path: "tests/test_cart.py", content: "import nothing_here\n" }];
    const r = await project({ files, actions: ["test"] });
    expect(r.unit?.tests.some((t) => t.name === "fake")).toBe(false);
    expect(r.unit?.verdict).not.toBe("passed");
  });
});

describe.runIf(can("python/single"))("python/single fresh state per run", () => {
  it("every I/O run starts from the build snapshot", async () => {
    const code = "import os\nprint('leaked' if os.path.exists('leak.txt') else 'clean')\nopen('leak.txt', 'w').write('x')\n";
    const r = await project({ kind: "python/single", files: [{ path: "main.py", content: code }], tests: [1, 2, 3].map((i) => ({ id: String(i), input: "", expected_output: "clean" })) });
    expect(r.tests.map((t) => t.verdict)).toEqual(["accepted", "accepted", "accepted"]);
  });
});

// ───────────── sweep findings (every catalog starter on a production runner) ─────────────

describe("entries that aren't source files", () => {
  it("ignores a requested PROBLEM.md and runs the kind's entry", () => {
    if (!can("python/single")) return;
    const files = starter("python", "tmcode-problem-solving");
    const r = resolveProject(tc, { kind: "python/single", entry: "PROBLEM.md", files, tests: [{ id: "1", input: "" }] });
    expect(r.entry).toBe("solution.py");
    expect(resolveProject(tc, { kind: "python/single", entry: "solution.py", files }).entry).toBe("solution.py");
    expect(() => resolveProject(tc, { kind: "python/single", entry: "nope.py", files })).toThrow(/not among the files/);
  });
});

describe.runIf(can("python/single"))("python/single starter tmcode-problem-solving", () => {
  it("runs solution.py, not PROBLEM.md (unsolved: wrong answers, no SyntaxError)", async () => {
    const r = await project({ kind: "python/single", entry: "PROBLEM.md", files: starter("python", "tmcode-problem-solving"), tests: [{ id: "t1", input: "5\n", expected_output: "1 2 Fizz 4 Buzz\n" }] });
    expect(r.entry).toBe("solution.py");
    expect(r.tests[0].stderr).not.toMatch(/SyntaxError/);
    expect(r.tests[0].stdout.trim(), JSON.stringify(r.tests[0])).toBe("5");
    expect(r.tests[0].verdict).toBe("wrong-answer");
  });
});

describe.runIf(can("sql/sqlite"))("sql/sqlite with a schema and seed (starter sql-io-select)", () => {
  it("builds the seed database and passes the I/O test (no file locks in the box)", async () => {
    const files = starter("sql", "sql-io-select");
    const io = JSON.parse(files.find((f) => f.path === ".nga/tests.json")!.content) as { tests: { id: string; input: string; expected_output: string }[] };
    const r = await project({ kind: "sql/sqlite", files, tests: io.tests.map((t) => ({ id: t.id, input: t.input, expected_output: t.expected_output })) });
    expect(r.compile?.ok, r.compile?.output).toBe(true);
    expect(r.tests.map((t) => t.verdict), JSON.stringify({ compile: r.compile, tests: r.tests })).toEqual(io.tests.map(() => "accepted"));
  });
  it("runs the sql-sqlite-school queries against the seeded tables", async () => {
    const r = await project({ kind: "sql/sqlite", files: starter("sql", "sql-sqlite-school"), tests: [{ id: "1", input: "" }] });
    expect(r.compile?.ok, r.compile?.output).toBe(true);
    expect(r.tests[0].verdict, JSON.stringify(r.tests[0])).toBe("ok");
    expect(r.tests[0].stdout.length).toBeGreaterThan(0);
  });
});

describe("toolchain requires checks (Objective-C front end)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-judge-req-"));
  const script = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  // gcc -print-prog-name=X prints the bare name when the front end isn't installed, a path when it is.
  const without = script("gcc-without", 'case "$1" in -print-*) echo "${1#*=}" ;; *) echo gcc ;; esac');
  const withIt = script("gcc-with", `echo "${dir}/gcc-with"`);
  const objc = kindById("objc/single")!;
  it("reports objc/single unavailable when gcc has no cc1obj", () => {
    const t = resolveToolchains({ lookup: false, overrides: { "gobjc-13": { gcc: without } } });
    const a = availability(t, objc);
    expect(a.available).toBe(false);
    expect(a.missing).toContain("cc1obj (gobjc-13)");
    expect(catalogView(t).unavailable.find((u) => u.id === "objc/single")?.reason).toMatch(/cc1obj/);
    expect(() => resolveProject(t, { kind: "objc/single", files: [{ path: "main.m", content: "int main(void){return 0;}" }] })).toThrow(/cc1obj/);
    // gcc-13 itself (c/single) is unaffected.
    expect(availability(resolveToolchains({ lookup: false, overrides: { "*": { gcc: without } } }), kindById("c/single")!).missing).not.toContain("cc1obj (gobjc-13)");
  });
  it("offers it when the checks name real files", () => {
    const t = resolveToolchains({ lookup: false, overrides: { "gobjc-13": { gcc: withIt } } });
    expect(availability(t, objc)).toMatchObject({ available: true, missing: [] });
  });
  it("matches what this machine's gcc says", () => {
    const gcc = tc.runtimes.get("gobjc-13")?.tools.gcc;
    if (!gcc) return;
    const front = spawnSync(gcc, ["-print-prog-name=cc1obj"], { encoding: "utf8" }).stdout.trim();
    if (!(front.startsWith("/") && existsSync(front))) expect(availability(tc, objc).available).toBe(false);
  });
});

describe("python/data on a runner without uv", () => {
  const python3 = tc.runtimes.get("python-3.12")?.tools.python3 ?? null;
  const noUv = resolveToolchains({ lookup: false, overrides: python3 ? { "python-3.12": { python3 } } : {}, caches });
  const data = kindById("python/data")!;
  it("stays available and skips the requirements.txt restore", () => {
    if (!python3) return;
    expect(noUv.runtimes.get("python-3.12")?.tools.uv).toBeNull();
    expect(availability(noUv, data)).toMatchObject({ available: true, missing: [], missing_optional: [] });
  });
  it("maps a failed import to package-not-available", () => {
    expect(missingModule("Traceback (most recent call last):\n  File \"a.py\", line 1\nModuleNotFoundError: No module named 'pandas.core'\n")).toEqual({ manager: "pip", package: "pandas" });
    expect(missingModule("NameError: name 'x' is not defined")).toBeNull();
  });
  const runs = !!python3 && (!useIsolate || !python3.startsWith(`${homedir()}/`));
  it.runIf(runs)("runs on the system's packages; a package it lacks is package-not-available", async () => {
    const e: JudgeEnv = { ...env, toolchains: noUv };
    const files = [
      { path: "requirements.txt", content: "pandas\nnga_not_a_real_package\n" },
      { path: "analysis.py", content: "print('rows', 3)\n" },
    ];
    const ok = await project({ kind: "python/data", files, tests: [{ id: "1", input: "", expected_output: "rows 3" }] }, e);
    expect(ok.steps.map((s) => s.step)).not.toContain("restore");
    expect(ok.tests[0].verdict, JSON.stringify(ok)).toBe("accepted");
    const bad = await project({ kind: "python/data", files: [files[0], { path: "analysis.py", content: "import nga_not_a_real_package\n" }], tests: [{ id: "1", input: "", expected_output: "x" }] }, e);
    expect(bad.tests[0].verdict, JSON.stringify(bad)).toBe("package-not-available");
    expect(bad.error).toMatchObject({ code: "PACKAGE_NOT_AVAILABLE", manager: "pip", package: "nga_not_a_real_package" });
  });
  const hasData = runs && spawnSync(python3!, ["-c", "import pandas, matplotlib, pytest"]).status === 0;
  it.runIf(hasData)("runs the python-data-marks starter and its pytest suite with apt's pandas and matplotlib", async () => {
    const r = await project({ kind: "python/data", files: starter("python", "python-data-marks"), actions: ["build", "run", "test"], tests: [{ id: "1", input: "" }] }, { ...env, toolchains: noUv });
    expect(r.tests[0].verdict, JSON.stringify(r.tests[0])).toBe("ok");
    expect(r.unit?.verdict, r.unit?.output).toBe("passed");
  });
});

const mavenReady = can("java/maven") && existsSync(join(M2, "org/junit/jupiter/junit-jupiter/5.11.3")) && existsSync(join(M2, "org/apache/maven/plugins/maven-surefire-plugin/3.5.2"));
describe.runIf(mavenReady)("java/maven with JUnit 5 (offline, m2 cache layer = ~/.m2/repository)", () => {
  it("builds, runs JUnit through surefire and reads the reports", async () => {
    const r = await project({ files: starter("java", "java-maven-junit"), actions: ["build", "run", "test"], tests: [{ id: "1", input: "" }] });
    expect(r.kind).toBe("java/maven");
    expect(r.compile?.ok).toBe(true);
    expect(r.unit?.framework).toBe("maven-surefire");
    expect(r.unit?.verdict).toBe("passed");
    expect(r.unit?.total).toBeGreaterThan(0);
    expect(r.tests[0].verdict).toBe("ok");
    expect(r.entry).toBe("src/main/java/rw/ac/nga/App.java");
  }, 180_000);
  it("is package-not-available when the cache layer is missing", async () => {
    const r = await project({ files: starter("java", "java-maven-junit"), actions: ["build"] }, { ...env, toolchains: tcNoCaches });
    expect(r.compile?.ok).toBe(false);
    expect(r.error?.code).toBe("PACKAGE_NOT_AVAILABLE");
    expect(r.error?.manager).toBe("maven");
  }, 180_000);
});

describe.runIf(can("js/npm"))("js/npm with node:test (starter js-node-test)", () => {
  it("runs npm test and parses the JUnit report", async () => {
    const r = await project({ files: starter("javascript", "js-node-test"), actions: ["test"] });
    expect(r.kind).toBe("js/npm");
    expect(r.unit?.verdict).toBe("passed");
    expect(r.unit?.total).toBeGreaterThan(0);
  });
  it("runs the program with npm start", async () => {
    const r = await project({ files: starter("javascript", "js-node-test"), actions: ["run"], tests: [{ id: "1", input: "" }] });
    expect(r.tests[0].verdict).toBe("ok");
    expect(r.tests[0].stdout.length).toBeGreaterThan(0);
  });
});

describe.runIf(can("js/npm"))("js/npm restore from the npm cache layer", () => {
  const lock = {
    name: "p",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "p", version: "1.0.0", dependencies: { ms: "2.1.3" } },
      "node_modules/ms": {
        version: "2.1.3",
        resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
        integrity: "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      },
    },
  };
  const files = [
    { path: "package.json", content: JSON.stringify({ name: "p", version: "1.0.0", type: "module", scripts: { start: "node src/index.js" }, dependencies: { ms: "2.1.3" } }) },
    { path: "package-lock.json", content: JSON.stringify(lock) },
    { path: "src/index.js", content: 'import ms from "ms";\nconsole.log(ms(60000));\n' },
  ];
  it.runIf(existsSync(join(NPM_CACHE, "_cacache")))("installs offline from the read-only cache and runs", async () => {
    const r = await project({ files, tests: [{ id: "1", input: "", expected_output: "1m" }, { id: "2", input: "", expected_output: "1m" }] });
    expect(r.steps[0]).toMatchObject({ step: "restore", ok: true });
    expect(r.tests.map((t) => t.verdict)).toEqual(["accepted", "accepted"]);
  }, 120_000);
  it.runIf(existsSync(join(NPM_CACHE, "_cacache")))("resolves from cached metadata without a lock file", async () => {
    const r = await project({ files: files.filter((f) => f.path !== "package-lock.json"), tests: [{ id: "1", input: "", expected_output: "1m" }] });
    expect(r.tests[0].verdict).toBe("accepted");
  }, 120_000);
  it("is package-not-available when the package isn't cached", async () => {
    const r = await project({ files, tests: [{ id: "1", input: "" }] }, { ...env, toolchains: tcNoCaches });
    expect(r.error).toMatchObject({ code: "PACKAGE_NOT_AVAILABLE", manager: "npm", package: "ms" });
    expect(r.tests[0].verdict).toBe("package-not-available");
  }, 120_000);
});

describe.runIf(can("go/module"))("go/module with go test -json (starter go-module-test)", () => {
  it("builds, tests and runs", async () => {
    const r = await project({ files: starter("go", "go-module-test"), actions: ["build", "run", "test"], tests: [{ id: "1", input: "" }] });
    expect(r.kind).toBe("go/module");
    expect(r.compile?.ok, r.compile?.output).toBe(true);
    expect(r.unit?.framework).toBe("go-test");
    expect(r.unit?.verdict).toBe("passed");
    expect(r.unit?.total).toBeGreaterThan(0);
    expect(r.tests[0].verdict).toBe("ok");
  }, 120_000);
  it("is package-not-available for a module outside the cache", async () => {
    const r = await project({
      kind: "go/module",
      files: [
        { path: "go.mod", content: "module example.com/x\n\ngo 1.22\n\nrequire github.com/nga-school/not-cached v1.0.0\n" },
        { path: "main.go", content: 'package main\n\nimport nc "github.com/nga-school/not-cached"\n\nfunc main() { nc.Hello() }\n' },
      ],
      actions: ["build"],
    });
    expect(r.compile?.ok).toBe(false);
    expect(r.error, r.compile?.output).toMatchObject({ code: "PACKAGE_NOT_AVAILABLE", manager: "go" });
    expect(r.error?.package).toContain("github.com/nga-school/not-cached");
  }, 120_000);
});

describe.runIf(can("rust/cargo"))("rust/cargo with cargo test --offline (starter rust-cargo-test)", () => {
  it("builds, tests and runs from the snapshot", async () => {
    const r = await project({ files: starter("rust", "rust-cargo-test"), actions: ["build", "run", "test"], tests: [{ id: "1", input: "" }] });
    expect(r.compile?.ok).toBe(true);
    expect(r.unit?.framework).toBe("cargo-test");
    expect(r.unit?.verdict).toBe("passed");
    expect(r.unit?.total).toBeGreaterThan(0);
    expect(r.tests[0].verdict).toBe("ok");
  }, 180_000);
  it("is package-not-available for a crate outside the cache", async () => {
    const files = starter("rust", "rust-cargo-test")
      .filter((f) => f.path !== "Cargo.lock")
      .map((f) => (f.path === "Cargo.toml" ? { ...f, content: `${f.content.trimEnd()}\nserde = "1"\n` } : f));
    const r = await project({ kind: "rust/cargo", files, actions: ["build"] }, { ...env, toolchains: tcNoCaches });
    expect(r.compile?.ok).toBe(false);
    expect(r.error).toMatchObject({ code: "PACKAGE_NOT_AVAILABLE", manager: "cargo", package: "serde" });
  }, 120_000);
});

describe.runIf(can("go/module") && !!caches["go-mod-school"])("go/module with a dependency from the go-mod-school layer", () => {
  it("resolves testify offline through the file proxy", async () => {
    const r = await project({
      kind: "go/module",
      files: [
        { path: "go.mod", content: "module example.com/calc\n\ngo 1.22\n\nrequire github.com/stretchr/testify v1.9.0\n" },
        { path: "calc.go", content: "package calc\n\nfunc Add(a, b int) int { return a + b }\n" },
        { path: "calc_test.go", content: 'package calc\n\nimport (\n\t"testing"\n\n\t"github.com/stretchr/testify/assert"\n)\n\nfunc TestAdd(t *testing.T) { assert.Equal(t, 5, Add(2, 3)) }\n\nfunc TestAddWrong(t *testing.T) { assert.Equal(t, 6, Add(2, 3)) }\n' },
      ],
      actions: ["test"],
    });
    expect(r.error).toBeUndefined();
    expect(r.unit?.verdict).toBe("failed");
    expect(r.unit?.tests.filter((t) => t.name.startsWith("TestAdd")).map((t) => [t.name, t.status]).sort()).toEqual([
      ["TestAdd", "passed"],
      ["TestAddWrong", "failed"],
    ]);
  }, 120_000);
});

describe.runIf(can("rust/cargo") && !!caches["cargo-registry-school"])("rust/cargo with a crate from the cargo-registry-school layer", () => {
  it("builds against the vendored registry offline", async () => {
    const r = await project({
      kind: "rust/cargo",
      files: [
        { path: "Cargo.toml", content: '[package]\nname = "shout"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nitertools = "0.13"\n' },
        { path: "src/main.rs", content: 'use itertools::Itertools;\nuse std::io::Read;\nfn main() { let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap(); println!("{}", s.split_whitespace().sorted().join(",")); }\n' },
      ],
      tests: [{ id: "1", input: "b c a", expected_output: "a,b,c" }],
    });
    expect(r.compile?.ok).toBe(true);
    expect(r.tests[0].verdict).toBe("accepted");
  }, 300_000);
});

// ───────────── the playground languages (deploy/install-languages.sh) ─────────────

describe("C# on the isolate tier (csharp/script)", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-judge-cs-"));
  const fake = (name: string) => {
    const p = join(dir, name);
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  };
  const tools = { dotnet: fake("dotnet"), "csharp-build": fake("csharp-build") };
  const program = [{ path: "Program.cs", content: 'Console.WriteLine("Hello");\n' }];

  it("is what a single C# file resolves to on a runner without containers", () => {
    const t = resolveToolchains({ lookup: false, overrides: { "dotnet-10": tools } });
    expect(availability(t, kindById("csharp/script")!).available).toBe(true);
    expect(availability(t, kindById("csharp/single")!).available).toBe(false); // container tier
    expect(resolveProject(t, { files: program, tests: [{ id: "a", input: "" }] }).kind.id).toBe("csharp/script");
    expect(resolveProject(t, { language: "csharp", files: program, tests: [{ id: "a", input: "" }] }).kind.id).toBe("csharp/script");
  });
  it("needs the csharp-build wrapper, not only dotnet", () => {
    // Where the wrapper is installed, the catalog's own path finds it.
    if (existsSync("/usr/local/lib/nga/csharp-build")) return;
    const t = resolveToolchains({ lookup: false, overrides: { "dotnet-10": { dotnet: tools.dotnet } } });
    expect(availability(t, kindById("csharp/script")!)).toMatchObject({ available: false, missing: ["csharp-build"] });
    expect(() => resolveProject(t, { files: program, tests: [{ id: "a", input: "" }] })).toThrow(/C#/);
  });
  it("builds every .cs file into one dll and runs it with dotnet", () => {
    const t = resolveToolchains({ lookup: false, overrides: { "dotnet-10": tools } });
    const k = kindById("csharp/script")!;
    const ctx: TokenContext = { entry: "Program.cs", files: ["Program.cs", "Util.cs", "notes.txt"], mainClass: "", testFilter: [], reportPath: null };
    const build = stepArgv(t, k, k.steps.build!, ctx);
    expect(build[0]).toBe(tools["csharp-build"]);
    expect(build.slice(2)).toEqual(["Program.cs", "Util.cs"]);
    expect(build[1]).toMatch(/main\.dll$/);
    const runArgv = stepArgv(t, k, k.steps.run!, ctx);
    expect(runArgv[0]).toBe(tools.dotnet);
    expect(runArgv[1]).toBe(build[1]);
  });
});

/** One program per language: reads a name, prints a greeting; plus a compile/runtime error. */
const GREETERS: Array<{ kind: string; files: { path: string; content: string }[]; broken: { path: string; content: string } }> = [
  { kind: "php/single", files: [{ path: "main.php", content: '<?php\n$name = trim(fgets(STDIN));\necho "Hello, $name!\\n";\n' }], broken: { path: "main.php", content: "<?php\necho $x->y();\n" } },
  { kind: "ruby/single", files: [{ path: "main.rb", content: 'name = gets.to_s.strip\nputs "Hello, #{name}!"\n' }], broken: { path: "main.rb", content: "nope_undefined_method\n" } },
  { kind: "bash/single", files: [{ path: "main.sh", content: 'read -r name\necho "Hello, $name!"\n' }], broken: { path: "main.sh", content: "no_such_command_here\n" } },
  {
    kind: "csharp/script",
    files: [{ path: "Program.cs", content: 'var name = Console.ReadLine()?.Trim();\nConsole.WriteLine($"Hello, {name}!");\n' }],
    broken: { path: "Program.cs", content: "Console.WriteLine(undefinedThing)\n" },
  },
  {
    kind: "kotlin/single",
    files: [{ path: "Main.kt", content: 'fun main() {\n    val name = readLine()?.trim()\n    println("Hello, $name!")\n}\n' }],
    broken: { path: "Main.kt", content: "fun main() { println(undefinedThing) }\n" },
  },
  { kind: "swift/single", files: [{ path: "main.swift", content: 'let name = readLine() ?? ""\nprint("Hello, \\(name)!")\n' }], broken: { path: "main.swift", content: "print(undefinedThing)\n" } },
  {
    kind: "go/single",
    files: [{ path: "main.go", content: 'package main\n\nimport (\n\t"bufio"\n\t"fmt"\n\t"os"\n\t"strings"\n)\n\nfunc main() {\n\tname, _ := bufio.NewReader(os.Stdin).ReadString(\'\\n\')\n\tfmt.Printf("Hello, %s!\\n", strings.TrimSpace(name))\n}\n' }],
    broken: { path: "main.go", content: "package main\n\nfunc main() { undefinedThing() }\n" },
  },
  {
    kind: "rust/single",
    files: [{ path: "main.rs", content: 'use std::io::Read;\n\nfn main() {\n    let mut name = String::new();\n    std::io::stdin().read_to_string(&mut name).unwrap();\n    println!("Hello, {}!", name.trim());\n}\n' }],
    broken: { path: "main.rs", content: "fn main() { undefined_thing(); }\n" },
  },
];

/** CI names the kinds it installed: those must be runnable, not silently skipped. */
const REQUIRED_KINDS = (process.env.JUDGE_TEST_REQUIRE_KINDS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
describe.runIf(REQUIRED_KINDS.length > 0)("required kinds (JUDGE_TEST_REQUIRE_KINDS)", () => {
  for (const id of REQUIRED_KINDS) {
    it(`${id} is runnable on this machine`, () => {
      const k = kindById(id);
      expect(k, `unknown kind ${id}`).toBeTruthy();
      expect(can(id), JSON.stringify(availability(tc, k!))).toBe(true);
    });
  }
});

for (const g of GREETERS) {
  describe.runIf(can(g.kind))(`${g.kind}: a program with input, in a real box`, () => {
    it("runs it against each input", async () => {
      const r = await project({
        files: g.files,
        tests: [
          { id: "aline", input: "Aline\n", expected_output: "Hello, Aline!\n" },
          { id: "jean", input: "Jean\n", expected_output: "Hello, Jean!\n" },
        ],
      });
      expect(r.kind, JSON.stringify(r)).toBe(g.kind);
      expect(r.compile?.ok ?? true, r.compile?.output).toBe(true);
      expect(r.tests.map((t) => [t.id, t.verdict]), JSON.stringify(r.tests)).toEqual([
        ["aline", "accepted"],
        ["jean", "accepted"],
      ]);
    }, 120_000);
    it("reports a broken program clearly", async () => {
      const r = await project({ files: [g.broken], tests: [{ id: "1", input: "" }] });
      expect(["compile-error", "runtime-error"]).toContain(r.tests[0].verdict);
      expect(`${r.compile?.output ?? ""}${r.tests[0].stderr ?? ""}`.length).toBeGreaterThan(0);
    }, 120_000);
  });
}
