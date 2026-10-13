/** C, C++, Go, Rust (§13.1). */
import { entry, kind, MANAGED_RUN, out, sources, testFilter, LIMITS, reportTo } from "./kit";

const C_SRC = "*.c";
const CPP_SRC = ["*.cpp", "*.cc", "*.cxx"];
const NATIVE_MANIFESTS = ["Makefile", "makefile", "CMakeLists.txt"];
const run = (bin: string) => ({ tool: "stdbuf", args: ["-oL", "-eL", out(bin)] });

/** Make and CMake are the same for C and C++. */
function nativeProjects(lang: "c" | "cpp", runtime: string, srcs: string[], label: string) {
  return [
    kind({
      id: `${lang}/make`,
      language: lang,
      label: `${label} – Makefile project`,
      runtime,
      wave: "A",
      detect: { files: ["Makefile|makefile"], anyOf: srcs, priority: 50 },
      entry: { default: lang === "c" ? "src/main.c" : "src/main.cpp", find: "main-decl" },
      steps: {
        build: { tool: "make", args: ["-j2"], runsProjectScripts: true },
        run: { tool: "make", args: ["-s", "--no-print-directory", "run"], runsProjectScripts: true },
        test: { tool: "make", args: ["-s", "--no-print-directory", "test"], runsProjectScripts: true, report: "tap" },
      },
      tier: "isolate-build",
      notes: "The Makefile's default target builds; `make run` runs and `make test` tests (TAP or plain text; exit code decides).",
    }),
    kind({
      id: `${lang}/cmake`,
      language: lang,
      label: `${label} – CMake project`,
      runtime,
      wave: "A",
      detect: { files: ["CMakeLists.txt"], anyOf: srcs, priority: 50 },
      entry: { default: lang === "c" ? "src/main.c" : "src/main.cpp", find: "main-decl" },
      steps: {
        restore: { tool: "cmake", args: ["-S", ".", "-B", "build", "-DCMAKE_BUILD_TYPE=Release", "-DFETCHCONTENT_FULLY_DISCONNECTED=ON"], runsProjectScripts: true },
        build: { tool: "cmake", args: ["--build", "build", "-j2"], runsProjectScripts: true },
        run: run("build/app"),
        // ctest puts a relative --output-junit file in the build folder (--test-dir), so the name is the file's, not its box path.
        test: { tool: "ctest", args: ["--test-dir", "build", "--output-on-failure", "--output-junit", "ctest-junit.xml"], report: "junit", path: "build/ctest-junit.xml" },
      },
      tier: "isolate-build",
      notes: "The program target is called `app` (the starters' convention); unit tests are registered with add_test (GoogleTest via gtest_discover_tests for C++).",
    }),
  ];
}

export const SYSTEMS_KINDS = [
  kind({
    id: "c/single",
    language: "c",
    label: "C – single file",
    runtime: "gcc-13",
    wave: "A",
    detect: { anyOf: [C_SRC], none: NATIVE_MANIFESTS, priority: 10 },
    entry: { default: "main.c", find: "main-decl" },
    steps: {
      build: { tool: "gcc", args: ["-std=c17", "-O2", "-Wall", "-Wextra", sources("c"), "-o", out("main"), "-lm"] },
      run: run("main"),
    },
    tier: "isolate",
  }),
  ...nativeProjects("c", "gcc-13", [C_SRC], "C"),
  kind({
    id: "cpp/single",
    language: "cpp",
    label: "C++ – single file",
    runtime: "gxx-13",
    wave: "A",
    detect: { anyOf: CPP_SRC, none: NATIVE_MANIFESTS, priority: 10 },
    entry: { default: "main.cpp", find: "main-decl" },
    steps: {
      build: { tool: "g++", args: ["-std=c++20", "-O2", "-Wall", "-Wextra", sources(["cpp", "cc", "cxx"]), "-o", out("main")] },
      run: run("main"),
    },
    tier: "isolate",
  }),
  ...nativeProjects("cpp", "gxx-13", CPP_SRC, "C++"),
  kind({
    id: "go/single",
    language: "go",
    label: "Go – single file",
    runtime: "go-1.25",
    wave: "A",
    detect: { anyOf: ["*.go"], none: ["go.mod"], priority: 10 },
    entry: { default: "main.go", find: "main-decl" },
    steps: {
      build: { tool: "go", args: ["build", "-o", out("main"), entry] },
      run: { tool: "stdbuf", args: ["-oL", out("main")] },
    },
    tier: "isolate",
    // go build locks its build cache ("Lock /tmp/go-build/trim.txt: function not implemented" without).
    fileLocks: true,
    limits: { build: { cpu_s: 30, wall_s: 60, memory_mb: 1024, processes: 64 }, run: MANAGED_RUN },
  }),
  kind({
    id: "go/module",
    language: "go",
    label: "Go – module",
    runtime: "go-1.25",
    wave: "A",
    detect: { files: ["go.mod"], priority: 50 },
    entry: { default: "main.go", find: "main-decl" },
    steps: {
      build: { tool: "go", args: ["build", "-o", out("app"), "."] },
      run: { tool: "stdbuf", args: ["-oL", out("app")] },
      test: { tool: "go", args: ["test", "-json", "./...", testFilter], report: "go" },
    },
    tier: "isolate-build",
    caches: ["go-mod-school"],
    // The go command fails ("RLock go.mod: function not implemented") without flock.
    fileLocks: true,
    limits: { ...LIMITS["isolate-build"], run: MANAGED_RUN },
  }),
  kind({
    id: "go/web",
    language: "go",
    label: "Go – web server (net/http, Gin, Echo)",
    runtime: "go-1.25",
    wave: "C",
    detect: { files: ["go.mod"], contains: [{ file: "go.mod|*.go", text: "gin-gonic|labstack/echo|gofiber|\"net/http\"" }], priority: 60 },
    entry: { default: "main.go", find: "main-decl" },
    steps: {
      build: { tool: "go", args: ["build", "-o", out("app"), "."] },
      test: { tool: "gotestsum", args: [reportTo("--junitfile="), "--", "./..."], report: "junit", path: "go-junit.xml" },
      serve: { tool: "stdbuf", args: ["-oL", out("app")], port: 8080, ready: ":8080" },
    },
    tier: "container",
    caches: ["go-mod-school"],
  }),
  kind({
    id: "rust/single",
    language: "rust",
    label: "Rust – single file",
    runtime: "rust-stable",
    wave: "A",
    detect: { anyOf: ["*.rs"], none: ["Cargo.toml"], priority: 10 },
    entry: { default: "main.rs", find: "main-decl" },
    steps: {
      build: { tool: "rustc", args: ["--edition", "2021", "-O", entry, "-o", out("main")] },
      run: { tool: "stdbuf", args: ["-oL", out("main")] },
    },
    tier: "isolate",
    limits: { build: { cpu_s: 30, wall_s: 60, memory_mb: 1024, processes: 64 }, run: { cpu_s: 5, wall_s: 10, memory_mb: 256, processes: 16 } },
  }),
  kind({
    id: "rust/cargo",
    language: "rust",
    label: "Rust – Cargo project",
    runtime: "rust-stable",
    wave: "A",
    detect: { files: ["Cargo.toml"], priority: 50 },
    entry: { default: "src/main.rs", find: "manifest" },
    steps: {
      build: { tool: "cargo", args: ["build", "--offline", "--release", "-j2", "--quiet"], runsProjectScripts: true },
      run: { tool: "cargo", args: ["run", "--offline", "--release", "--quiet"], runsProjectScripts: true },
      test: { tool: "cargo", args: ["test", "--offline", "-j2", testFilter], runsProjectScripts: true, report: "cargo" },
    },
    tier: "isolate-build",
    caches: ["cargo-registry-school", "cargo-target-warm"],
    notes: "build.rs counts as a project script. cargo-nextest (junit) can replace `cargo test` once the image ships it.",
  }),
  kind({
    id: "rust/web",
    language: "rust",
    label: "Rust – web server (axum, actix)",
    runtime: "rust-stable",
    wave: "C",
    detect: { files: ["Cargo.toml"], contains: [{ file: "Cargo.toml", text: "^\\s*(actix-web|axum|rocket|warp|poem)\\s*=" }], priority: 60 },
    entry: { default: "src/main.rs", find: "manifest" },
    steps: {
      build: { tool: "cargo", args: ["build", "--offline", "--release", "-j2"], runsProjectScripts: true },
      test: { tool: "cargo", args: ["test", "--offline", "-j2"], runsProjectScripts: true, report: "cargo" },
      serve: { tool: "cargo", args: ["run", "--offline", "--release"], runsProjectScripts: true, port: 8080, ready: "listening" },
    },
    tier: "container",
    caches: ["cargo-registry-school"],
  }),
];
