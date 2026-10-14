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
      // Not run directly: listing it mounts /opt/junit in the box (java/single unit tests);
      // tm-judge counts only executable tools, so install.sh installs it 0755.
      junit: "/opt/junit/junit-platform-console-standalone.jar",
    },
    // Gradle's own home is per run (/tmp); dependencies come from the read-only cache layer gradle-school.
    env: { ...BOX_ENV, JAVA_TOOL_OPTIONS: "-XX:+UseSerialGC -Xss16m -Dfile.encoding=UTF-8", GRADLE_USER_HOME: "/tmp/gradle-home", GRADLE_RO_DEP_CACHE: "/caches/gradle-school" },
  },
  {
    id: "python-3.12",
    // The id stays (cache layers and images use it); the interpreter is the system's Python 3
    // (3.12 on Ubuntu 24.04, 3.14 on 26.04, which has no python3.12 package).
    label: "Python 3 (pytest, uv)",
    install: { apt: ["python3", "python3-venv"], script: "install-uv-and-site-packages.sh" },
    version: ["python3", "--version"],
    tools: { python3: "/usr/bin/python3", uv: "/opt/uv/uv" },
    // .pydeps: packages a restore step installed from the wheelhouse; site-packages-school: the prebuilt shared layer (pytest, numpy…).
    env: { ...BOX_ENV, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1", MPLBACKEND: "Agg", OPENBLAS_NUM_THREADS: "1", PYTHONPATH: "/box/.pydeps:/caches/site-packages-school" },
  },
  {
    id: "node-22",
    label: "Node.js 22 LTS",
    install: { script: "install-node-22.sh" },
    version: ["node", "--version"],
    tools: { node: "/opt/node-22/bin/node", npm: "/opt/node-22/bin/npm" },
    env: { ...BOX_ENV, NODE_OPTIONS: "--max-old-space-size=256", npm_config_update_notifier: "false", NO_UPDATE_NOTIFIER: "1", npm_config_cache: "/tmp/.npm", npm_config_logs_max: "0", npm_config_audit: "false", npm_config_fund: "false" },
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
    // Modules come from the read-only cache layer go-mod-school used as a file proxy (a GOMODCACHE's cache/download), else nowhere.
    env: { ...BOX_ENV, GOCACHE: "/tmp/go-build", GOPATH: "/tmp/go", GOMODCACHE: "/tmp/go-mod", GOPROXY: "file:///caches/go-mod-school/cache/download,off", GOSUMDB: "off", GOTOOLCHAIN: "local", GOFLAGS: "-mod=mod -modcacherw", GOMAXPROCS: "1", CGO_ENABLED: "0" },
  },
  {
    id: "rust-stable",
    label: "Rust stable (rustup, pin)",
    install: { script: "install-rustup.sh" },
    version: ["rustc", "--version"],
    tools: { rustc: "/opt/rust/bin/rustc", cargo: "/opt/rust/bin/cargo", ...STDBUF },
    // CARGO_HOME is per run; crates come from the cache layer cargo-registry-school (a `cargo vendor` folder the runner
    // points crates-io at). The target folder stays in the project so build outputs carry over to the run boxes.
    env: { ...BOX_ENV, CARGO_HOME: "/tmp/cargo-home", CARGO_TARGET_DIR: "/box/target", CARGO_NET_OFFLINE: "true", CARGO_TERM_COLOR: "never", CARGO_INCREMENTAL: "0" },
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
  // C# on the isolate tier (CODE_RUNNER_PLAN §13.3): Roslyn's csc from the .NET SDK through the
  // csharp-build wrapper (deploy/bin/csharp-build), not MSBuild — a single-file program builds in
  // ~2 s and a few hundred MB. Any SDK ≥ 8 works; Ubuntu 26.04 ships dotnet-sdk-10.0.
  { id: "dotnet-10", label: ".NET SDK (csc, single files)", install: { apt: ["dotnet-sdk-10.0"], script: "install-languages.sh#csharp" }, version: ["dotnet", "--version"], tools: { dotnet: "/usr/bin/dotnet", "csharp-build": "/usr/local/lib/nga/csharp-build" }, env: { ...BOX_ENV, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_gcServer: "0", DOTNET_GCHeapHardLimit: "0x10000000", DOTNET_TieredPGO: "0", DOTNET_TC_QuickJitForLoops: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1" } },
  { id: "dotnet-8", label: ".NET 8 SDK", install: { apt: ["dotnet-sdk-8.0"] }, version: ["dotnet", "--version"], tools: { dotnet: "/usr/bin/dotnet" }, env: { ...BOX_ENV, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1", DOTNET_gcServer: "0", MSBUILDDISABLENODEREUSE: "1", NUGET_PACKAGES: "/caches/nuget" } },
  { id: "php-8.3", label: "PHP 8.3 (Composer)", install: { apt: ["php8.3-cli", "php8.3-mbstring", "php8.3-xml", "php8.3-sqlite3", "php8.3-intl", "php8.3-zip", "composer"] }, version: ["php", "--version"], tools: { php: "/usr/bin/php8.3", composer: "/usr/bin/composer" }, env: { ...BOX_ENV, COMPOSER_DISABLE_NETWORK: "1" } },
  { id: "ruby-3.2", label: "Ruby 3.2 (Bundler)", install: { apt: ["ruby3.2", "bundler"] }, version: ["ruby", "--version"], tools: { ruby: "/usr/bin/ruby3.2", bundle: "/usr/bin/bundle" }, env: { ...BOX_ENV, GEM_HOME: "/caches/gems" } },
  { id: "lua-5.4", label: "Lua 5.4", install: { apt: ["lua5.4", "luarocks"] }, version: ["lua5.4", "-v"], tools: { lua: "/usr/bin/lua5.4", busted: "/usr/local/bin/busted" }, env: BOX_ENV },
  { id: "bash-5", label: "Bash 5.2 (bats)", install: { apt: ["bash", "bats", "shellcheck"] }, version: ["bash", "--version"], tools: { bash: "/usr/bin/bash", bats: "/usr/bin/bats", shellcheck: "/usr/bin/shellcheck" }, env: BOX_ENV },
  { id: "r-4", label: "R 4.3 (testthat)", install: { apt: ["r-base"] }, version: ["Rscript", "--version"], tools: { Rscript: "/usr/bin/Rscript" }, env: BOX_ENV },
  { id: "julia-1", label: "Julia 1.11 (pin)", install: { script: "install-julia.sh" }, version: ["julia", "--version"], tools: { julia: "/opt/julia/bin/julia" }, env: { ...BOX_ENV, JULIA_PKG_OFFLINE: "true", JULIA_DEPOT_PATH: "/tmp/depot:/caches/julia" } },
  { id: "ghc-9.4", label: "GHC 9.4 (cabal)", install: { apt: ["ghc", "cabal-install", "libghc-hspec-dev"] }, version: ["ghc", "--version"], tools: { ghc: "/usr/bin/ghc", cabal: "/usr/bin/cabal", ...STDBUF }, env: BOX_ENV },
  { id: "elixir-1.18", label: "Elixir 1.18 (OTP 27)", install: { script: "install-erlang-elixir.sh" }, version: ["elixir", "--version"], tools: { elixir: "/opt/elixir/bin/elixir", mix: "/opt/elixir/bin/mix" }, env: { ...BOX_ENV, HEX_OFFLINE: "1", ERL_FLAGS: "+S 1 -start_epmd false" } },
  // Arduino (AVR): arduino-cli with the arduino:avr core and common libraries (Servo, LiquidCrystal,
  // LiquidCrystal I2C) under /opt/arduino, read-only in the box; arduino-build is the kind's wrapper.
  { id: "arduino-avr", label: "Arduino AVR (arduino-cli, Uno)", install: { script: "install-languages.sh#arduino" }, version: ["arduino-cli", "version"], tools: { "arduino-cli": "/opt/arduino/bin/arduino-cli", "arduino-build": "/usr/local/lib/nga/arduino-build" }, env: { ...BOX_ENV, ARDUINO_CONFIG: "/opt/arduino/arduino-cli.yaml" } },
  { id: "swift-6", label: "Swift 6 (pin)", install: { script: "install-swift.sh" }, version: ["swift", "--version"], tools: { swift: "/opt/swift/usr/bin/swift", swiftc: "/opt/swift/usr/bin/swiftc", ...STDBUF }, env: BOX_ENV },
  { id: "dart-3", label: "Dart 3", install: { script: "install-dart.sh" }, version: ["dart", "--version"], tools: { dart: "/usr/lib/dart/bin/dart" }, env: { ...BOX_ENV, PUB_CACHE: "/caches/pub" } },
  { id: "flutter-3", label: "Flutter 3 (container only)", install: { script: "install-flutter.sh" }, version: ["flutter", "--version"], tools: { flutter: "/opt/flutter/bin/flutter" }, env: { ...BOX_ENV, PUB_CACHE: "/caches/pub" }, uses: ["dart-3"] },
  // Tier 3 clients (images nga-runner/postgres-16, nga-runner/mysql-8.4); the servers are per-run sidecars.
  { id: "postgres-16", label: "PostgreSQL 16 (per-run sidecar)", install: { apt: ["postgresql-client-16"] }, version: ["psql", "--version"], tools: { psql: "/usr/bin/psql" }, env: BOX_ENV },
  { id: "mysql-8.4", label: "MySQL 8.4 (per-run sidecar)", install: { apt: ["mysql-client"] }, version: ["mysql", "--version"], tools: { mysql: "/usr/bin/mysql" }, env: BOX_ENV },  // ── wave D (phase 7): apt packages from Ubuntu 24.04 where they are recent enough, else pinned tarballs.
  // services/judge/deploy/install.sh installs each one on its own (INSTALL_WAVE_D=1); a failed one is skipped and
  // tm-judge reports its kinds in /v1/catalog `unavailable`.
  { id: "zig-0.14", label: "Zig 0.14 (pin)", install: { script: "install.sh#zig" }, version: ["zig", "version"], tools: { zig: "/opt/zig/zig", ...STDBUF }, env: { ...BOX_ENV, ZIG_GLOBAL_CACHE_DIR: "/tmp/zig-cache", ZIG_LOCAL_CACHE_DIR: "/tmp/zig-local" } },
  { id: "nim-2", label: "Nim 2.2 (pin)", install: { script: "install.sh#nim" }, version: ["nim", "--version"], tools: { nim: "/opt/nim/bin/nim", nimble: "/opt/nim/bin/nimble", ...STDBUF }, env: { ...BOX_ENV, NIMBLE_DIR: "/caches/nimble-school" } },
  // Unbuffered preconnected units: interactive runs see each line as it is written.
  { id: "gfortran-13", label: "GFortran 13 (fpm)", install: { apt: ["gfortran-13"], script: "install.sh#fortran (fpm release binary)" }, version: ["gfortran", "--version"], tools: { gfortran: "/usr/bin/gfortran-13", fpm: "/usr/local/bin/fpm", ...STDBUF }, env: { ...BOX_ENV, GFORTRAN_UNBUFFERED_PRECONNECTED: "y" } },
  { id: "fpc-3.2", label: "Free Pascal 3.2.2", install: { apt: ["fp-compiler-3.2.2", "fp-units-rtl-3.2.2", "fp-units-base-3.2.2", "fp-units-fcl-3.2.2"] }, version: ["fpc", "-iV"], tools: { fpc: "/usr/bin/fpc", ...STDBUF }, env: BOX_ENV },
  { id: "gnucobol-3", label: "GnuCOBOL 3.1", install: { apt: ["gnucobol3"] }, version: ["cobc", "--version"], tools: { cobc: "/usr/bin/cobc", ...STDBUF }, env: BOX_ENV },
  // nasm-link: a two-line wrapper install.sh writes (nasm -f elf64, then gcc -no-pie so programs can call printf/scanf).
  { id: "nasm-2", label: "NASM 2.16 (x86-64, linked with gcc)", install: { apt: ["nasm", "binutils", "gcc-13"], script: "install.sh#asm (writes the nasm-link wrapper)" }, version: ["nasm", "-v"], tools: { nasm: "/usr/bin/nasm", "nasm-link": "/usr/local/lib/nga/nasm-link", ...STDBUF }, env: BOX_ENV },
  { id: "ldc-1", label: "LDC (D compiler, dub)", install: { apt: ["ldc", "dub"] }, version: ["ldc2", "--version"], tools: { ldc2: "/usr/bin/ldc2", dub: "/usr/bin/dub", ...STDBUF }, env: { ...BOX_ENV, DUB_HOME: "/tmp/dub" } },
  { id: "crystal-1", label: "Crystal 1.14 (pin)", install: { script: "install.sh#crystal" }, version: ["crystal", "--version"], tools: { crystal: "/opt/crystal/bin/crystal", shards: "/opt/crystal/bin/shards", ...STDBUF }, env: { ...BOX_ENV, CRYSTAL_CACHE_DIR: "/tmp/crystal-cache" } },
  { id: "v-0.4", label: "V 0.4 (pin)", install: { script: "install.sh#v" }, version: ["v", "version"], tools: { v: "/opt/v/v", ...STDBUF }, env: { ...BOX_ENV, VMODULES: "/tmp/vmodules", VCACHE: "/tmp/vcache", VTMP: "/tmp", VFLAGS: "-cc gcc" } },
  { id: "gnat-13", label: "GNAT 13 (Ada 2012)", install: { apt: ["gnat-13"] }, version: ["gnatmake", "--version"], tools: { gnatmake: "/usr/bin/gnatmake-13", ...STDBUF }, env: BOX_ENV },
  { id: "gobjc-13", label: "GCC 13 Objective-C (GNUstep Base)", install: { apt: ["gobjc-13", "libgnustep-base-dev"] }, version: ["gcc", "--version"], tools: { gcc: "/usr/bin/gcc-13", ...STDBUF }, env: BOX_ENV, requires: [{ name: "cc1obj (gobjc-13)", tool: "gcc", args: ["-print-prog-name=cc1obj"] }, { name: "libgnustep-base (libgnustep-base-dev)", tool: "gcc", args: ["-print-file-name=libgnustep-base.so"] }] },
  { id: "groovy-4", label: "Apache Groovy 4 (on JDK 21, pin)", install: { script: "install.sh#groovy" }, version: ["groovy", "--version"], tools: { groovy: "/opt/groovy/bin/groovy", java: "/usr/lib/jvm/java-21-openjdk-amd64/bin/java", gradle: "/opt/gradle/bin/gradle" }, env: { ...BOX_ENV, JAVA_HOME: "/usr/lib/jvm/java-21-openjdk-amd64", JAVA_OPTS: "-Xmx256m -XX:+UseSerialGC -XX:TieredStopAtLevel=1", GRADLE_USER_HOME: "/tmp/gradle-home", GRADLE_RO_DEP_CACHE: "/caches/gradle-school" }, uses: ["jdk-21"] },
  // Babashka runs single files with no JVM start-up; the Clojure CLI handles deps.edn projects (deps from the m2 cache layer).
  { id: "clojure-1.12", label: "Clojure 1.12 (Babashka + Clojure CLI, pin)", install: { script: "install.sh#clojure" }, version: ["bb", "--version"], tools: { bb: "/usr/local/bin/bb", clojure: "/usr/local/bin/clojure", java: "/usr/lib/jvm/java-21-openjdk-amd64/bin/java" }, env: { ...BOX_ENV, JAVA_HOME: "/usr/lib/jvm/java-21-openjdk-amd64", CLJ_CONFIG: "/tmp/clj-config", CLJ_CACHE: "/tmp/clj-cache", BABASHKA_PRELOADS: "" }, uses: ["jdk-21"] },
  { id: "pwsh-7.4", label: "PowerShell 7.4 LTS (Pester, pin)", install: { script: "install.sh#pwsh" }, version: ["pwsh", "--version"], tools: { pwsh: "/opt/microsoft/powershell/7/pwsh" }, env: { ...BOX_ENV, POWERSHELL_TELEMETRY_OPTOUT: "1", POWERSHELL_UPDATECHECK: "Off", DOTNET_gcServer: "0", DOTNET_CLI_TELEMETRY_OPTOUT: "1" } },
  { id: "perl-5.38", label: "Perl 5.38 (prove)", install: { apt: ["perl"] }, version: ["perl", "--version"], tools: { perl: "/usr/bin/perl", prove: "/usr/bin/prove" }, env: BOX_ENV },
  { id: "tcl-8.6", label: "Tcl 8.6 (tcltest)", install: { apt: ["tcl8.6"] }, version: ["tclsh8.6"], tools: { tclsh: "/usr/bin/tclsh8.6" }, env: BOX_ENV },
  { id: "octave-8", label: "GNU Octave 8.4", install: { apt: ["octave"] }, version: ["octave-cli", "--version"], tools: { "octave-cli": "/usr/bin/octave-cli" }, env: { ...BOX_ENV, OPENBLAS_NUM_THREADS: "1" } },
  { id: "ocaml-4.14", label: "OCaml 4.14 (dune, alcotest)", install: { apt: ["ocaml-nox", "ocaml-findlib", "ocaml-dune", "libalcotest-ocaml-dev"] }, version: ["ocamlopt", "-version"], tools: { ocamlfind: "/usr/bin/ocamlfind", ocamlopt: "/usr/bin/ocamlopt", dune: "/usr/bin/dune", ...STDBUF }, env: { ...BOX_ENV, OCAMLRUNPARAM: "b" } },
  { id: "erlang-27", label: "Erlang/OTP 27 (rebar3)", install: { apt: ["erlang-nox", "erlang-dev"], script: "install.sh#erlang (OTP 27 from ppa:rabbitmq/rabbitmq-erlang, rebar3 release binary)" }, version: ["erl", "-noshell", "-eval", "io:format(\"~s~n\", [erlang:system_info(otp_release)]), halt()."], tools: { escript: "/usr/bin/escript", erl: "/usr/bin/erl", erlc: "/usr/bin/erlc", rebar3: "/usr/local/bin/rebar3" }, env: { ...BOX_ENV, ERL_FLAGS: "+S 1 -start_epmd false", REBAR_CACHE_DIR: "/tmp/rebar3" } },
  { id: "gleam-1", label: "Gleam 1.x on Erlang/OTP 27 (pin)", install: { script: "install.sh#gleam" }, version: ["gleam", "--version"], tools: { gleam: "/opt/gleam/gleam" }, env: { ...BOX_ENV, ERL_FLAGS: "+S 1 -start_epmd false", HEX_OFFLINE: "1" }, uses: ["erlang-27"] },
  { id: "racket-8", label: "Racket 8.10 (rackunit)", install: { apt: ["racket"] }, version: ["racket", "--version"], tools: { racket: "/usr/bin/racket", raco: "/usr/bin/raco" }, env: { ...BOX_ENV, PLTUSERHOME: "/tmp/racket" } },
  { id: "guile-3", label: "GNU Guile 3.0 (Scheme)", install: { apt: ["guile-3.0"] }, version: ["guile", "--version"], tools: { guile: "/usr/bin/guile-3.0" }, env: { ...BOX_ENV, GUILE_AUTO_COMPILE: "0" } },
  { id: "sbcl-2", label: "SBCL 2.2 (Common Lisp)", install: { apt: ["sbcl"] }, version: ["sbcl", "--version"], tools: { sbcl: "/usr/bin/sbcl" }, env: BOX_ENV },
  { id: "swipl-9", label: "SWI-Prolog 9.0 (plunit)", install: { apt: ["swi-prolog-nox"] }, version: ["swipl", "--version"], tools: { swipl: "/usr/bin/swipl" }, env: BOX_ENV },
  { id: "iverilog-12", label: "Icarus Verilog 12", install: { apt: ["iverilog"] }, version: ["iverilog", "-V"], tools: { iverilog: "/usr/bin/iverilog", vvp: "/usr/bin/vvp" }, env: BOX_ENV },
  { id: "ghdl-4", label: "GHDL 4 (VHDL-2008)", install: { apt: ["ghdl"] }, version: ["ghdl", "--version"], tools: { ghdl: "/usr/bin/ghdl" }, env: BOX_ENV },
];
