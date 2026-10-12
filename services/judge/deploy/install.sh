#!/usr/bin/env bash
# Installs or updates tm-judge on the shared NGA server (Ubuntu, cgroup v2, pm2).
# Idempotent: safe to re-run for updates. Run as the deploy user (sudo needed).
#
#   bash services/judge/deploy/install.sh
#
# What it does:
#   1. language runtimes + isolate build deps (apt)
#   2. wave-A project toolchains (Runtime Catalog, CODE_RUNNER_PLAN §13, §18.2):
#      Go, Rust (rustup, minimal), Maven, Gradle, Node.js 22 (+ esbuild, tsc),
#      uv, the JUnit console launcher; pinned versions, checksums verified
#   3. builds ioi/isolate (setuid sandbox) and starts isolate.service (cgroup keeper)
#   4. caps ALL judge boxes together (isolate.slice) so student code can never
#      starve MIS, Task Mentor or Tupo on this shared box
#   5. clones/updates nga-tmcode into /opt/apps/tm-judge, creates the token once,
#      creates the cache-layer folders and points JUDGE_CACHES at them
#   6. (re)starts the pm2 process "tm-judge" on 127.0.0.1:5010
# Cache layers are filled separately (needs network): deploy/build-caches.sh.
# Skip the toolchains with SKIP_TOOLCHAINS=1 (e.g. a quick code update).
# Wave D (the long tail, CODE_RUNNER_PLAN phase 7) is opt-in: INSTALL_WAVE_D=1 installs every
# wave D toolchain, WAVE_D="perl tcl prolog" only those. Each language installs on its own; a
# failure skips that language (its kinds then show in /v1/catalog `unavailable`), never the install.
set -euo pipefail

ISOLATE_VERSION="${ISOLATE_VERSION:-v2.7}"
APP_DIR="${APP_DIR:-/opt/apps/tm-judge}"
REPO="${REPO:-https://github.com/niyongaboemmy/nga-tmcode.git}"
SLICE_MEMORY="${SLICE_MEMORY:-1200M}"
SLICE_CPU="${SLICE_CPU:-150%}"
CACHE_ROOT="${CACHE_ROOT:-/opt/tm-judge/caches}"
# Pinned toolchains (bump deliberately; the catalog's runtime ids name the major line).
GO_VERSION="${GO_VERSION:-1.25.1}"
RUST_VERSION="${RUST_VERSION:-1.90.0}"
MAVEN_VERSION="${MAVEN_VERSION:-3.9.11}"
GRADLE_VERSION="${GRADLE_VERSION:-8.14.3}"
NODE_VERSION="${NODE_VERSION:-22.20.0}"
UV_VERSION="${UV_VERSION:-0.8.22}"
JUNIT_CONSOLE_VERSION="${JUNIT_CONSOLE_VERSION:-1.11.3}"
ESBUILD_VERSION="${ESBUILD_VERSION:-0.28.2}"
TYPESCRIPT_VERSION="${TYPESCRIPT_VERSION:-5.9.2}"
# Wave D pins (tarballs; apt packages come from Ubuntu 24.04). Confirm each when the image is built.
ZIG_VERSION="${ZIG_VERSION:-0.14.0}"
NIM_VERSION="${NIM_VERSION:-2.2.0}"
FPM_VERSION="${FPM_VERSION:-0.10.1}"
CRYSTAL_VERSION="${CRYSTAL_VERSION:-1.14.0}"
V_VERSION="${V_VERSION:-0.4.8}"
GROOVY_VERSION="${GROOVY_VERSION:-4.0.24}"
BABASHKA_VERSION="${BABASHKA_VERSION:-1.12.196}"
CLOJURE_CLI_VERSION="${CLOJURE_CLI_VERSION:-1.12.0.1530}"
PWSH_VERSION="${PWSH_VERSION:-7.4.6}"
PESTER_VERSION="${PESTER_VERSION:-5.6.1}"
REBAR3_VERSION="${REBAR3_VERSION:-3.24.0}"
GLEAM_VERSION="${GLEAM_VERSION:-1.6.3}"

# Update the code first and re-run the updated copy of this script (bash reads
# scripts incrementally, so updating the file under a running bash is unsafe).
if [ "${TM_JUDGE_REEXEC:-}" != "1" ] && [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin main
  git -C "$APP_DIR" reset -q --hard origin/main
  TM_JUDGE_REEXEC=1 exec bash "$APP_DIR/services/judge/deploy/install.sh" "$@"
fi

echo "== 1/6 packages"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends \
  build-essential pkg-config git libcap-dev libsystemd-dev libseccomp-dev \
  curl ca-certificates unzip xz-utils coreutils \
  python3 python3.12 python3.12-venv gcc-13 g++-13 make cmake libgtest-dev libcmocka-dev \
  sqlite3 openjdk-21-jdk-headless >/dev/null

echo "== 2/6 project toolchains"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) GOARCH=amd64; NODEARCH=x64; RUSTARCH=x86_64 ;;
  aarch64) GOARCH=arm64; NODEARCH=arm64; RUSTARCH=aarch64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 1 ;;
esac
dl="$(mktemp -d)"
trap 'rm -rf "$dl"' EXIT
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
# sha <algo> <file> <expected>
check_sum() {
  local got
  got="$("${1}sum" "$2" | cut -d' ' -f1)"
  if [ "$got" != "$3" ]; then echo "checksum mismatch for $2 ($1): $got != $3" >&2; exit 1; fi
}

if [ "${SKIP_TOOLCHAINS:-}" != "1" ]; then
  # Go (official tarball; checksum from go.dev's release list).
  if ! /opt/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} "; then
    f="go${GO_VERSION}.linux-${GOARCH}.tar.gz"
    fetch "https://go.dev/dl/${f}" "$dl/$f"
    want="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | python3 -c "import json,sys; print(next(x['sha256'] for r in json.load(sys.stdin) for x in r['files'] if x['filename']=='$f'))")"
    check_sum sha256 "$dl/$f" "$want"
    sudo rm -rf "/opt/go-${GO_VERSION}" && sudo mkdir -p "/opt/go-${GO_VERSION}"
    sudo tar -xzf "$dl/$f" -C "/opt/go-${GO_VERSION}" --strip-components=1
    sudo ln -sfn "/opt/go-${GO_VERSION}" /opt/go
  fi

  # Rust: rustup with the minimal profile, one pinned toolchain; /opt/rust = the
  # toolchain itself (real cargo/rustc binaries, no rustup proxies inside boxes).
  if [ ! -x "/opt/rustup/toolchains/${RUST_VERSION}-${RUSTARCH}-unknown-linux-gnu/bin/cargo" ]; then
    fetch "https://static.rust-lang.org/rustup/dist/${RUSTARCH}-unknown-linux-gnu/rustup-init" "$dl/rustup-init"
    fetch "https://static.rust-lang.org/rustup/dist/${RUSTARCH}-unknown-linux-gnu/rustup-init.sha256" "$dl/rustup-init.sha256"
    check_sum sha256 "$dl/rustup-init" "$(cut -d' ' -f1 "$dl/rustup-init.sha256")"
    chmod +x "$dl/rustup-init"
    sudo mkdir -p /opt/rustup /opt/cargo
    sudo RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo "$dl/rustup-init" -y -q --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION"
  fi
  sudo ln -sfn "/opt/rustup/toolchains/${RUST_VERSION}-${RUSTARCH}-unknown-linux-gnu" /opt/rust

  # Maven (Apache archive, sha512).
  if ! /opt/maven/bin/mvn -v 2>/dev/null | grep -q "Apache Maven ${MAVEN_VERSION}"; then
    f="apache-maven-${MAVEN_VERSION}-bin.tar.gz"
    base="https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries"
    fetch "$base/$f" "$dl/$f"
    fetch "$base/$f.sha512" "$dl/$f.sha512"
    check_sum sha512 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha512")"
    sudo rm -rf "/opt/maven-${MAVEN_VERSION}" && sudo mkdir -p "/opt/maven-${MAVEN_VERSION}"
    sudo tar -xzf "$dl/$f" -C "/opt/maven-${MAVEN_VERSION}" --strip-components=1
    sudo ln -sfn "/opt/maven-${MAVEN_VERSION}" /opt/maven
  fi

  # Gradle (services.gradle.org, sha256).
  if [ ! -x "/opt/gradle-${GRADLE_VERSION}/bin/gradle" ]; then
    f="gradle-${GRADLE_VERSION}-bin.zip"
    fetch "https://services.gradle.org/distributions/$f" "$dl/$f"
    fetch "https://services.gradle.org/distributions/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(tr -d '[:space:]' <"$dl/$f.sha256")"
    sudo rm -rf "/opt/gradle-${GRADLE_VERSION}"
    sudo unzip -q "$dl/$f" -d /opt
    sudo ln -sfn "/opt/gradle-${GRADLE_VERSION}" /opt/gradle
  fi

  # Node.js 22 (nodejs.org tarball, SHASUMS256) + esbuild and tsc for TypeScript kinds.
  if ! /opt/node-22/bin/node --version 2>/dev/null | grep -q "v${NODE_VERSION}"; then
    f="node-v${NODE_VERSION}-linux-${NODEARCH}.tar.xz"
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/$f" "$dl/$f"
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$dl/SHASUMS256.txt"
    check_sum sha256 "$dl/$f" "$(grep " $f\$" "$dl/SHASUMS256.txt" | cut -d' ' -f1)"
    sudo rm -rf "/opt/node-v${NODE_VERSION}" && sudo mkdir -p "/opt/node-v${NODE_VERSION}"
    sudo tar -xJf "$dl/$f" -C "/opt/node-v${NODE_VERSION}" --strip-components=1
    sudo ln -sfn "/opt/node-v${NODE_VERSION}" /opt/node-22
  fi
  sudo env PATH="/opt/node-22/bin:$PATH" /opt/node-22/bin/npm install -g --silent --no-audit --no-fund \
    "esbuild@${ESBUILD_VERSION}" "typescript@${TYPESCRIPT_VERSION}" >/dev/null

  # uv (GitHub release, sha256) for Python project restores from the wheelhouse.
  if ! /opt/uv/uv --version 2>/dev/null | grep -q "uv ${UV_VERSION}"; then
    f="uv-${RUSTARCH}-unknown-linux-gnu.tar.gz"
    fetch "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/$f" "$dl/$f"
    fetch "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha256")"
    sudo mkdir -p /opt/uv
    sudo tar -xzf "$dl/$f" -C /opt/uv --strip-components=1
  fi

  # JUnit console launcher (java/single unit tests; Maven Central sha1).
  jar="/opt/junit/junit-platform-console-standalone.jar"
  if [ ! -f "/opt/junit/.v${JUNIT_CONSOLE_VERSION}" ]; then
    u="https://repo1.maven.org/maven2/org/junit/platform/junit-platform-console-standalone/${JUNIT_CONSOLE_VERSION}/junit-platform-console-standalone-${JUNIT_CONSOLE_VERSION}.jar"
    fetch "$u" "$dl/junit.jar"
    fetch "$u.sha1" "$dl/junit.jar.sha1"
    check_sum sha1 "$dl/junit.jar" "$(cut -d' ' -f1 "$dl/junit.jar.sha1")"
    sudo mkdir -p /opt/junit
    sudo install -m 0644 "$dl/junit.jar" "$jar"
    sudo touch "/opt/junit/.v${JUNIT_CONSOLE_VERSION}"
  fi

  # ── Wave D: one function per language (catalog runtime in brackets). Each runs in its own
  # subshell with `set -e`, so the first failing command ends that language only.
  apt_d() { sudo apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }
  install_d_perl() { apt_d perl; }                                                  # [perl-5.38]
  install_d_tcl() { apt_d tcl8.6; }                                                 # [tcl-8.6]
  install_d_pascal() { apt_d fp-compiler-3.2.2 fp-units-rtl-3.2.2 fp-units-base-3.2.2 fp-units-fcl-3.2.2; }  # [fpc-3.2]
  install_d_cobol() { apt_d gnucobol3; }                                            # [gnucobol-3]
  install_d_d() { apt_d ldc dub; }                                                  # [ldc-1]
  install_d_ada() { apt_d gnat-13; }                                                # [gnat-13]
  install_d_objc() { apt_d gobjc-13 libgnustep-base-dev; }                          # [gobjc-13]
  install_d_ocaml() { apt_d ocaml-nox ocaml-findlib ocaml-dune libalcotest-ocaml-dev; }  # [ocaml-4.14]
  install_d_racket() { apt_d racket; }                                              # [racket-8]
  install_d_scheme() { apt_d guile-3.0; }                                           # [guile-3]
  install_d_lisp() { apt_d sbcl; }                                                  # [sbcl-2]
  install_d_prolog() { apt_d swi-prolog-nox; }                                      # [swipl-9]
  install_d_octave() { apt_d octave; }                                              # [octave-8]
  install_d_verilog() { apt_d iverilog; }                                           # [iverilog-12]
  install_d_vhdl() { apt_d ghdl; }                                                  # [ghdl-4]
  install_d_fortran() {                                                             # [gfortran-13]
    apt_d gfortran-13
    [ "$ARCH" = x86_64 ] || return 0 # fpm publishes x86-64 Linux binaries only
    local f="fpm-${FPM_VERSION}-linux-x86_64"
    fetch "https://github.com/fortran-lang/fpm/releases/download/v${FPM_VERSION}/$f" "$dl/$f"
    fetch "https://github.com/fortran-lang/fpm/releases/download/v${FPM_VERSION}/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha256")"
    sudo install -m 0755 "$dl/$f" /usr/local/bin/fpm
  }
  install_d_asm() {                                                                 # [nasm-2]
    apt_d nasm binutils gcc-13
    sudo mkdir -p /usr/local/lib/nga
    printf '%s\n' '#!/bin/sh' \
      '# nasm-link <file.asm> <output>: x86-64 ELF, linked with the C library (programs start at main).' \
      'set -e' '/usr/bin/nasm -f elf64 -o "$2.o" "$1"' 'exec /usr/bin/gcc-13 -no-pie -o "$2" "$2.o"' |
      sudo tee /usr/local/lib/nga/nasm-link >/dev/null
    sudo chmod 0755 /usr/local/lib/nga/nasm-link
  }
  install_d_zig() {                                                                 # [zig-0.14]
    local meta url sum
    meta="$(curl -fsSL https://ziglang.org/download/index.json)"
    url="$(printf '%s' "$meta" | python3 -c "import json,sys; print(json.load(sys.stdin)['${ZIG_VERSION}']['${RUSTARCH}-linux']['tarball'])")"
    sum="$(printf '%s' "$meta" | python3 -c "import json,sys; print(json.load(sys.stdin)['${ZIG_VERSION}']['${RUSTARCH}-linux']['shasum'])")"
    fetch "$url" "$dl/zig.tar.xz"
    check_sum sha256 "$dl/zig.tar.xz" "$sum"
    sudo rm -rf "/opt/zig-${ZIG_VERSION}" && sudo mkdir -p "/opt/zig-${ZIG_VERSION}"
    sudo tar -xJf "$dl/zig.tar.xz" -C "/opt/zig-${ZIG_VERSION}" --strip-components=1
    sudo ln -sfn "/opt/zig-${ZIG_VERSION}" /opt/zig
  }
  install_d_nim() {                                                                 # [nim-2]
    [ "$ARCH" = x86_64 ] || { echo "nim: no prebuilt $ARCH tarball" >&2; return 1; }
    local f="nim-${NIM_VERSION}-linux_x64.tar.xz"
    fetch "https://nim-lang.org/download/$f" "$dl/$f"
    fetch "https://nim-lang.org/download/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha256")"
    sudo rm -rf "/opt/nim-${NIM_VERSION}" && sudo mkdir -p "/opt/nim-${NIM_VERSION}"
    sudo tar -xJf "$dl/$f" -C "/opt/nim-${NIM_VERSION}" --strip-components=1
    sudo ln -sfn "/opt/nim-${NIM_VERSION}" /opt/nim
  }
  install_d_crystal() {                                                             # [crystal-1]
    [ "$ARCH" = x86_64 ] || { echo "crystal: no prebuilt $ARCH tarball" >&2; return 1; }
    apt_d gcc pkg-config libpcre2-dev libevent-dev libgc-dev libssl-dev zlib1g-dev libyaml-dev
    local f="crystal-${CRYSTAL_VERSION}-1-linux-x86_64.tar.gz"
    fetch "https://github.com/crystal-lang/crystal/releases/download/${CRYSTAL_VERSION}/$f" "$dl/$f"
    sudo rm -rf "/opt/crystal-${CRYSTAL_VERSION}" && sudo mkdir -p "/opt/crystal-${CRYSTAL_VERSION}"
    sudo tar -xzf "$dl/$f" -C "/opt/crystal-${CRYSTAL_VERSION}" --strip-components=1
    sudo ln -sfn "/opt/crystal-${CRYSTAL_VERSION}" /opt/crystal
  }
  install_d_v() {                                                                   # [v-0.4]
    [ "$ARCH" = x86_64 ] || { echo "v: no prebuilt $ARCH zip" >&2; return 1; }
    fetch "https://github.com/vlang/v/releases/download/${V_VERSION}/v_linux.zip" "$dl/v.zip"
    sudo rm -rf "/opt/v-${V_VERSION}" && sudo mkdir -p "/opt/v-${V_VERSION}"
    sudo unzip -q "$dl/v.zip" -d "$dl/v-unzip"
    sudo cp -a "$dl/v-unzip/v/." "/opt/v-${V_VERSION}/"
    sudo ln -sfn "/opt/v-${V_VERSION}" /opt/v
    /opt/v/v version
  }
  install_d_groovy() {                                                              # [groovy-4], needs jdk-21
    local f="apache-groovy-binary-${GROOVY_VERSION}.zip"
    local base="https://archive.apache.org/dist/groovy/${GROOVY_VERSION}/distribution"
    fetch "$base/$f" "$dl/$f"
    fetch "$base/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha256")"
    sudo rm -rf "/opt/groovy-${GROOVY_VERSION}"
    sudo unzip -q "$dl/$f" -d /opt
    sudo ln -sfn "/opt/groovy-${GROOVY_VERSION}" /opt/groovy
  }
  install_d_clojure() {                                                             # [clojure-1.12], needs jdk-21
    local f="babashka-${BABASHKA_VERSION}-linux-${GOARCH}-static.tar.gz"
    [ "$GOARCH" = amd64 ] || f="babashka-${BABASHKA_VERSION}-linux-aarch64-static.tar.gz"
    fetch "https://github.com/babashka/babashka/releases/download/v${BABASHKA_VERSION}/$f" "$dl/$f"
    fetch "https://github.com/babashka/babashka/releases/download/v${BABASHKA_VERSION}/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha256")"
    tar -xzf "$dl/$f" -C "$dl"
    sudo install -m 0755 "$dl/bb" /usr/local/bin/bb
    apt_d rlwrap
    fetch "https://download.clojure.org/install/linux-install-${CLOJURE_CLI_VERSION}.sh" "$dl/clojure-install.sh"
    sudo bash "$dl/clojure-install.sh" --prefix /usr/local >/dev/null
  }
  install_d_pwsh() {                                                                # [pwsh-7.4]
    apt_d libicu74
    local f="powershell-${PWSH_VERSION}-linux-${NODEARCH}.tar.gz"
    fetch "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/$f" "$dl/$f"
    sudo rm -rf /opt/microsoft/powershell/7 && sudo mkdir -p /opt/microsoft/powershell/7
    sudo tar -xzf "$dl/$f" -C /opt/microsoft/powershell/7
    sudo chmod 0755 /opt/microsoft/powershell/7/pwsh
    sudo /opt/microsoft/powershell/7/pwsh -NoLogo -NoProfile -NonInteractive -Command \
      "Set-PSRepository PSGallery -InstallationPolicy Trusted; Install-Module Pester -RequiredVersion ${PESTER_VERSION} -Scope AllUsers -Force -SkipPublisherCheck"
  }
  install_d_erlang() {                                                              # [erlang-27]
    apt_d software-properties-common
    sudo add-apt-repository -y ppa:rabbitmq/rabbitmq-erlang >/dev/null
    sudo apt-get update -qq
    apt_d erlang-nox erlang-dev
    fetch "https://github.com/erlang/rebar3/releases/download/${REBAR3_VERSION}/rebar3" "$dl/rebar3"
    sudo install -m 0755 "$dl/rebar3" /usr/local/bin/rebar3
  }
  install_d_gleam() {                                                               # [gleam-1], needs erlang
    command -v erl >/dev/null || install_d_erlang
    local f="gleam-v${GLEAM_VERSION}-${RUSTARCH}-unknown-linux-musl.tar.gz"
    fetch "https://github.com/gleam-lang/gleam/releases/download/v${GLEAM_VERSION}/$f" "$dl/$f"
    fetch "https://github.com/gleam-lang/gleam/releases/download/v${GLEAM_VERSION}/$f.sha256" "$dl/$f.sha256"
    check_sum sha256 "$dl/$f" "$(cut -d' ' -f1 "$dl/$f.sha256")"
    sudo mkdir -p /opt/gleam
    sudo tar -xzf "$dl/$f" -C /opt/gleam
  }

  WAVE_D_ALL="perl tcl pascal cobol d ada objc ocaml racket scheme lisp prolog octave verilog vhdl fortran asm zig nim crystal v groovy clojure pwsh erlang gleam"
  if [ "${INSTALL_WAVE_D:-}" = "1" ] || [ -n "${WAVE_D:-}" ]; then
    echo "   wave D toolchains"
    wave_d_failed=""
    for lang in ${WAVE_D:-$WAVE_D_ALL}; do
      if ! declare -F "install_d_$lang" >/dev/null; then
        echo "   wave D: unknown language $lang (one of: $WAVE_D_ALL)" >&2
        continue
      fi
      # Not in an if/|| context, so `set -e` inside the subshell really stops at the first error.
      set +e
      (set -e; "install_d_$lang")
      rc=$?
      set -e
      if [ "$rc" -eq 0 ]; then echo "   wave D $lang: ok"; else echo "   wave D $lang: FAILED, skipped" >&2; wave_d_failed="$wave_d_failed $lang"; fi
    done
    for d in /opt/zig/ /opt/nim/ /opt/crystal/ /opt/v/ /opt/groovy/ /opt/gleam /opt/microsoft/powershell/7; do
      if [ -e "$d" ]; then sudo chmod -R a+rX "$d"; fi
    done
    [ -z "$wave_d_failed" ] || echo "   wave D not installed:$wave_d_failed (tm-judge lists their kinds as unavailable; F# and VB come with the .NET 8 SDK, wave C)" >&2
  fi

  # Everything under /opt is read by the sandbox user: world-readable, root-owned.
  sudo chmod -R a+rX /opt/go/ /opt/rustup/toolchains /opt/maven/ /opt/gradle/ /opt/node-22/ /opt/uv /opt/junit
  for t in /opt/go/bin/go /opt/rust/bin/cargo /opt/maven/bin/mvn /opt/gradle/bin/gradle /opt/node-22/bin/node /opt/uv/uv; do
    printf '   %-28s %s\n' "$t" "$("$t" --version 2>&1 | head -1 || echo MISSING)"
  done
fi

echo "== 3/6 isolate ${ISOLATE_VERSION}"
if ! command -v isolate >/dev/null || ! isolate --version 2>&1 | grep -q "${ISOLATE_VERSION#v}"; then
  tmp="$(mktemp -d)"
  git clone -q --depth 1 --branch "$ISOLATE_VERSION" https://github.com/ioi/isolate "$tmp/isolate"
  make -s -C "$tmp/isolate" isolate isolate-cg-keeper
  sudo make -s -C "$tmp/isolate" install
  rm -rf "$tmp"
fi

# isolate maps every box to a uid/gid from the "isolate" user's subordinate ranges.
if ! getent passwd isolate >/dev/null; then
  sudo adduser --quiet --disabled-login --home /nonexistent --no-create-home --shell /bin/false --comment "" isolate
fi
grep -q '^isolate:' /etc/subuid || sudo usermod --add-subuids 1000000-1065535 isolate
grep -q '^isolate:' /etc/subgid || sudo usermod --add-subgids 1000000-1065535 isolate

echo "== 4/6 cgroup limits for all sandboxes together"
# Project builds (Maven, Gradle, cargo) take up to 1 GB each: with JUDGE_CONCURRENCY=2
# raise SLICE_MEMORY (e.g. 2400M) if the host has room, or keep concurrency at 1 for builds.
sudo mkdir -p /etc/systemd/system/isolate.slice.d
printf '[Slice]\nMemoryMax=%s\nCPUQuota=%s\nTasksMax=512\n' "$SLICE_MEMORY" "$SLICE_CPU" |
  sudo tee /etc/systemd/system/isolate.slice.d/tm-judge.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now isolate.service >/dev/null
sudo systemctl restart isolate.service
isolate-check-environment || echo "(isolate-check-environment warnings above are advisory)"

echo "== 5/6 code"
if [ ! -d "$APP_DIR/.git" ]; then
  sudo mkdir -p "$APP_DIR"
  sudo chown "$(id -u):$(id -g)" "$APP_DIR"
  git clone -q "$REPO" "$APP_DIR"
fi
if [ ! -f "$APP_DIR/.judge.env" ]; then
  umask 077
  printf 'JUDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" >"$APP_DIR/.judge.env"
  echo "   created $APP_DIR/.judge.env (give this token to Task Mentor as TMJUDGE_TOKEN)"
fi

# Read-only dependency cache layers (filled by deploy/build-caches.sh), mounted in boxes at /caches/<id>.
CACHE_IDS="m2-school gradle-school npm-school wheels-school site-packages-school cargo-registry-school go-mod-school"
sudo mkdir -p "$CACHE_ROOT"
for id in $CACHE_IDS; do sudo mkdir -p "$CACHE_ROOT/$id"; done
sudo chown -R "$(id -u):$(id -g)" "$CACHE_ROOT"
chmod -R a+rX "$CACHE_ROOT"
if ! grep -q '^JUDGE_CACHES=' "$APP_DIR/.judge.env"; then
  json="{"
  for id in $CACHE_IDS; do json="$json\"$id\":\"$CACHE_ROOT/$id\","; done
  printf 'JUDGE_CACHES=%s}\n' "${json%,}" >>"$APP_DIR/.judge.env"
  echo "   JUDGE_CACHES → $CACHE_ROOT/<id> (run deploy/build-caches.sh to fill them)"
fi

echo "   building"
(cd "$APP_DIR/services/judge" && npm install --no-save --no-package-lock --workspaces=false --omit=dev --no-audit --no-fund --silent && node scripts/build.mjs --log-level=warning)

echo "== 6/6 pm2"
# delete + start (not reload): a reload keeps an old script path.
pm2 delete tm-judge >/dev/null 2>&1 || true
pm2 start "$APP_DIR/services/judge/deploy/ecosystem.config.cjs" >/dev/null
pm2 save >/dev/null
TOKEN="$(grep '^JUDGE_TOKEN=' "$APP_DIR/.judge.env" | cut -d= -f2)"
for _ in $(seq 1 30); do
  if curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/v1/health; then
    echo
    echo "tm-judge ready"
    exit 0
  fi
  sleep 1
done
echo "tm-judge did not become healthy; see: pm2 logs tm-judge" >&2
exit 1
