/**
 * Toolchains, pinned. Paths are inside the runner image (Ubuntu 24.04, §13 and
 * §18.2); versions marked "pin" are confirmed when the image is built.
 */
import type { RuntimeDef } from "../schema";

const STDBUF = { stdbuf: "/usr/bin/stdbuf" };
const BOX_ENV = { HOME: "/box", TMPDIR: "/tmp", XDG_CACHE_HOME: "/tmp/.cache", LANG: "C.UTF-8" };

export const RUNTIMES: RuntimeDef[] = [
  // ── wave A ──
  {
    id: "gcc-13",
    label: "GCC 13 (C17)",
    install: { apt: ["gcc-13", "make", "cmake", "libcmocka-dev"] },
    version: ["gcc", "--version"],
    tools: { gcc: "/usr/bin/gcc-13", make: "/usr/bin/make", cmake: "/usr/bin/cmake", ctest: "/usr/bin/ctest", ...STDBUF },
    env: BOX_ENV,
  },
  {
    id: "gxx-13",
    label: "G++ 13 (C++20)",
    install: { apt: ["g++-13", "make", "cmake", "libgtest-dev", "catch2"] },
    version: ["g++", "--version"],
    tools: { "g++": "/usr/bin/g++-13", make: "/usr/bin/make", cmake: "/usr/bin/cmake", ctest: "/usr/bin/ctest", ...STDBUF },
    env: BOX_ENV,
  },
  {
    id: "jdk-21",
    label: "OpenJDK 21 (Maven 3.9, Gradle 8)",
    install: { apt: ["openjdk-21-jdk-headless"], script: "install-maven-gradle-junit.sh" },
    version: ["java", "-version"],
    tools: {
      java: "/usr/lib/jvm/java-21-openjdk-amd64/bin/java",
      javac: "/usr/lib/jvm/java-21-openjdk-amd64/bin/javac",
      mvn: "/opt/maven/bin/mvn",
      gradle: "/opt/gradle/bin/gradle",
    },
    env: { ...BOX_ENV, JAVA_TOOL_OPTIONS: "-XX:+UseSerialGC -Xss16m -Dfile.encoding=UTF-8" },
  },
  {
    id: "python-3.12",
    label: "Python 3.12 (pytest, uv)",
    install: { apt: ["python3.12", "python3.12-venv"], script: "install-uv-and-site-packages.sh" },
    version: ["python3", "--version"],
    tools: { python3: "/usr/bin/python3.12", uv: "/opt/uv/uv" },
    env: { ...BOX_ENV, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", MPLBACKEND: "Agg", OPENBLAS_NUM_THREADS: "1" },
  },
  {
    id: "node-22",
    label: "Node.js 22 LTS",
    install: { script: "install-node-22.sh" },
    version: ["node", "--version"],
    tools: { node: "/opt/node-22/bin/node", npm: "/opt/node-22/bin/npm" },
    env: { ...BOX_ENV, NODE_OPTIONS: "--max-old-space-size=256", npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1" },
  },
  {
    id: "typescript",
    label: "TypeScript (Node.js 22 + esbuild)",
    install: { script: "install-node-22.sh" },
    version: ["esbuild", "--version"],
    tools: {
      node: "/opt/node-22/bin/node",
      npm: "/opt/node-22/bin/npm",
      esbuild: "/opt/node-22/lib/node_modules/esbuild/bin/esbuild",
      tsc: "/opt/node-22/lib/node_modules/typescript/bin/tsc",
    },
    env: { ...BOX_ENV, NODE_OPTIONS: "--max-old-space-size=256" },
    uses: ["node-22"],
  },
  {
    id: "go-1.25",
    label: "Go 1.25 (pin)",
    install: { script: "install-go.sh" },
    version: ["go", "version"],
    tools: { go: "/opt/go/bin/go", gotestsum: "/opt/go-tools/bin/gotestsum", ...STDBUF },
    env: { ...BOX_ENV, GOCACHE: "/tmp/go-build", GOPATH: "/tmp/go", GOMODCACHE: "/caches/go-mod", GOPROXY: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod", GOMAXPROCS: "1", CGO_ENABLED: "0" },
  },
  {
    id: "rust-stable",
    label: "Rust stable (rustup, pin)",
    install: { script: "install-rustup.sh" },
    version: ["rustc", "--version"],
    tools: { rustc: "/opt/rust/bin/rustc", cargo: "/opt/rust/bin/cargo", ...STDBUF },
    env: { ...BOX_ENV, CARGO_HOME: "/caches/cargo", CARGO_TARGET_DIR: "/tmp/target", CARGO_NET_OFFLINE: "true", CARGO_TERM_COLOR: "never" },
  },
  {
    id: "sqlite-3",
    label: "SQLite 3.45",
    install: { apt: ["sqlite3"] },
    version: ["sqlite3", "--version"],
    tools: { sqlite3: "/usr/bin/sqlite3" },
    env: BOX_ENV,
  },
  {
    id: "browser",
    label: "The browser (TMCode Preview, Web Workers)",
    install: {},
    version: [],
    tools: {},
  },
  // ── waves B–C (data only until their images exist) ──
  { id: "kotlin-2", label: "Kotlin 2 (on JDK 21)", install: { script: "install-kotlinc.sh" }, version: ["kotlinc", "-version"], tools: { kotlinc: "/opt/kotlinc/bin/kotlinc", java: "/usr/lib/jvm/java-21-openjdk-amd64/bin/java", gradle: "/opt/gradle/bin/gradle" }, env: BOX_ENV, uses: ["jdk-21"] },
  { id: "scala-3", label: "Scala 3 (scala-cli, sbt)", install: { script: "install-coursier-scala.sh" }, version: ["scala-cli", "version"], tools: { "scala-cli": "/opt/coursier/bin/scala-cli", sbt: "/opt/coursier/bin/sbt" }, env: BOX_ENV, uses: ["jdk-21"] },
  { id: "dotnet-8", label: ".NET 8 SDK", install: { apt: ["dotnet-sdk-8.0"] }, version: ["dotnet", "--version"], tools: { dotnet: "/usr/bin/dotnet" }, env: { ...BOX_ENV, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_gcServer: "0", MSBUILDDISABLENODEREUSE: "1", NUGET_PACKAGES: "/caches/nuget" } },
  { id: "php-8.3", label: "PHP 8.3 (Composer)", install: { apt: ["php8.3-cli", "php8.3-mbstring", "php8.3-xml", "php8.3-sqlite3", "php8.3-intl", "php8.3-zip", "composer"] }, version: ["php", "--version"], tools: { php: "/usr/bin/php8.3", composer: "/usr/bin/composer" }, env: { ...BOX_ENV, COMPOSER_DISABLE_NETWORK: "1" } },
  { id: "ruby-3.2", label: "Ruby 3.2 (Bundler)", install: { apt: ["ruby3.2", "bundler"] }, version: ["ruby", "--version"], tools: { ruby: "/usr/bin/ruby3.2", bundle: "/usr/bin/bundle" }, env: { ...BOX_ENV, GEM_HOME: "/caches/gems" } },
  { id: "lua-5.4", label: "Lua 5.4", install: { apt: ["lua5.4", "luarocks"] }, version: ["lua5.4", "-v"], tools: { lua: "/usr/bin/lua5.4", busted: "/usr/local/bin/busted" }, env: BOX_ENV },
  { id: "bash-5", label: "Bash 5.2 (bats)", install: { apt: ["bash", "bats", "shellcheck"] }, version: ["bash", "--version"], tools: { bash: "/usr/bin/bash", bats: "/usr/bin/bats", shellcheck: "/usr/bin/shellcheck" }, env: BOX_ENV },
  { id: "r-4", label: "R 4.3 (testthat)", install: { apt: ["r-base"] }, version: ["Rscript", "--version"], tools: { Rscript: "/usr/bin/Rscript" }, env: BOX_ENV },
  { id: "julia-1", label: "Julia 1.11 (pin)", install: { script: "install-julia.sh" }, version: ["julia", "--version"], tools: { julia: "/opt/julia/bin/julia" }, env: { ...BOX_ENV, JULIA_PKG_OFFLINE: "true", JULIA_DEPOT_PATH: "/tmp/depot:/caches/julia" } },
  { id: "ghc-9.4", label: "GHC 9.4 (cabal)", install: { apt: ["ghc", "cabal-install", "libghc-hspec-dev"] }, version: ["ghc", "--version"], tools: { ghc: "/usr/bin/ghc", cabal: "/usr/bin/cabal", ...STDBUF }, env: BOX_ENV },
  { id: "elixir-1.18", label: "Elixir 1.18 (OTP 27)", install: { script: "install-erlang-elixir.sh" }, version: ["elixir", "--version"], tools: { elixir: "/opt/elixir/bin/elixir", mix: "/opt/elixir/bin/mix" }, env: { ...BOX_ENV, HEX_OFFLINE: "1", ERL_FLAGS: "+S 1 -start_epmd false" } },
  { id: "swift-6", label: "Swift 6 (pin)", install: { script: "install-swift.sh" }, version: ["swift", "--version"], tools: { swift: "/opt/swift/usr/bin/swift", swiftc: "/opt/swift/usr/bin/swiftc", ...STDBUF }, env: BOX_ENV },
  { id: "dart-3", label: "Dart 3", install: { script: "install-dart.sh" }, version: ["dart", "--version"], tools: { dart: "/usr/lib/dart/bin/dart" }, env: { ...BOX_ENV, PUB_CACHE: "/caches/pub" } },
  { id: "flutter-3", label: "Flutter 3 (container only)", install: { script: "install-flutter.sh" }, version: ["flutter", "--version"], tools: { flutter: "/opt/flutter/bin/flutter" }, env: { ...BOX_ENV, PUB_CACHE: "/caches/pub" }, uses: ["dart-3"] },
  { id: "postgres-16", label: "PostgreSQL 16 (runner cluster)", install: { apt: ["postgresql-client-16"] }, version: ["psql", "--version"], tools: { psql: "/usr/bin/psql" }, env: BOX_ENV },
  { id: "mariadb-10.11", label: "MariaDB 10.11 (runner instance)", install: { apt: ["mariadb-client"] }, version: ["mariadb", "--version"], tools: { mariadb: "/usr/bin/mariadb" }, env: BOX_ENV },
];
