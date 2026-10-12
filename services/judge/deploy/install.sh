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
