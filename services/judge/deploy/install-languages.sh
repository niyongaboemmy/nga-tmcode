#!/usr/bin/env bash
# The code runner's languages beyond the base image: one place that installs a language's
# toolchain where the Runtime Catalog (packages/runtimes) expects it, for every NGA app that
# runs code through tm-judge (Task Mentor, TMCode, the MIS Code Playground).
#
#   bash services/judge/deploy/install-languages.sh                 # every language below
#   bash services/judge/deploy/install-languages.sh php ruby csharp # only these
#
# Languages: go rust php ruby bash csharp kotlin swift.
# Each one installs on its own — a failure is reported and skipped, never the whole run — and
# re-running is cheap (pinned versions are kept when already there). install.sh runs this as
# part of the toolchains step; run on its own, restart the judge afterwards so it sees them:
#   pm2 restart tm-judge          (shared server)   /   systemctl restart tm-judge (runner host)
# GET /v1/catalog then lists the new kinds; anything still missing shows in `unavailable`.
set -uo pipefail

GO_VERSION="${GO_VERSION:-1.25.1}"
RUST_VERSION="${RUST_VERSION:-1.90.0}"
KOTLIN_VERSION="${KOTLIN_VERSION:-2.2.20}"
SWIFT_VERSION="${SWIFT_VERSION:-6.2.1}"
ALL_LANGUAGES="go rust php ruby bash csharp kotlin swift"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) GOARCH=amd64; RUSTARCH=x86_64 ;;
  aarch64) GOARCH=arm64; RUSTARCH=aarch64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 1 ;;
esac
SUDO=""
[ "$(id -u)" = "0" ] || SUDO="sudo"
export DEBIAN_FRONTEND=noninteractive

dl="$(mktemp -d)"
trap 'rm -rf "$dl"' EXIT
fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
# check_sum <algo> <file> <expected>
check_sum() {
  local got
  got="$("${1}sum" "$2" | cut -d' ' -f1)"
  [ "$got" = "$3" ] || { echo "checksum mismatch for $2 ($1): $got != $3" >&2; return 1; }
}
apt_get() { $SUDO apt-get install -y -qq --no-install-recommends "$@" >/dev/null; }
# The packages of a list that this Ubuntu release offers (names differ between releases).
available() {
  local p out=""
  for p in "$@"; do
    if [ -n "$(apt-cache policy "$p" 2>/dev/null | sed -n 's/ *Candidate: //p' | grep -v '(none)')" ]; then out="$out $p"; fi
  done
  echo "$out"
}
# The first package of a list that this release offers.
first_available() {
  local p
  for p in "$@"; do
    if [ -n "$(available "$p")" ]; then echo "$p"; return 0; fi
  done
  return 1
}

lang_go() {                                                         # [go-1.25] /opt/go
  /opt/go/bin/go version 2>/dev/null | grep -q "go${GO_VERSION} " && return 0
  local f="go${GO_VERSION}.linux-${GOARCH}.tar.gz" want
  fetch "https://go.dev/dl/${f}" "$dl/$f" || return 1
  want="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | python3 -c "import json,sys; print(next(x['sha256'] for r in json.load(sys.stdin) for x in r['files'] if x['filename']=='$f'))")" || return 1
  check_sum sha256 "$dl/$f" "$want" || return 1
  $SUDO rm -rf "/opt/go-${GO_VERSION}" && $SUDO mkdir -p "/opt/go-${GO_VERSION}"
  $SUDO tar -xzf "$dl/$f" -C "/opt/go-${GO_VERSION}" --strip-components=1 || return 1
  $SUDO ln -sfn "/opt/go-${GO_VERSION}" /opt/go
}

lang_rust() {                                                       # [rust-stable] /opt/rust
  if [ ! -x "/opt/rustup/toolchains/${RUST_VERSION}-${RUSTARCH}-unknown-linux-gnu/bin/cargo" ]; then
    fetch "https://static.rust-lang.org/rustup/dist/${RUSTARCH}-unknown-linux-gnu/rustup-init" "$dl/rustup-init" || return 1
    fetch "https://static.rust-lang.org/rustup/dist/${RUSTARCH}-unknown-linux-gnu/rustup-init.sha256" "$dl/rustup-init.sha256" || return 1
    check_sum sha256 "$dl/rustup-init" "$(cut -d' ' -f1 "$dl/rustup-init.sha256")" || return 1
    chmod +x "$dl/rustup-init"
    $SUDO mkdir -p /opt/rustup /opt/cargo
    $SUDO env RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo "$dl/rustup-init" -y -q --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" || return 1
  fi
  $SUDO ln -sfn "/opt/rustup/toolchains/${RUST_VERSION}-${RUSTARCH}-unknown-linux-gnu" /opt/rust
}

lang_php() {                                                        # [php-8.3] /usr/bin/php (any PHP 8)
  local extras
  extras="$(available php-mbstring php-xml php-sqlite3 php-intl php-zip composer)"
  # shellcheck disable=SC2086
  apt_get php-cli $extras
}

lang_ruby() { apt_get ruby; }                                       # [ruby-3.2] /usr/bin/ruby (any Ruby 3)

lang_bash() { apt_get bash bats; }                                  # [bash-5] bats: the kind's test step

lang_csharp() {                                                     # [dotnet-10] csc via csharp-build
  if ! command -v dotnet >/dev/null 2>&1 || ! ls -d "$(dirname "$(readlink -f "$(command -v dotnet)")")"/sdk/[0-9]* >/dev/null 2>&1; then
    local sdk
    sdk="$(first_available dotnet-sdk-10.0 dotnet-sdk-9.0 dotnet-sdk-8.0)" || { echo "csharp: this Ubuntu release offers no dotnet-sdk package" >&2; return 1; }
    apt_get "$sdk" || return 1
  fi
  $SUDO install -D -m 0755 "$HERE/bin/csharp-build" /usr/local/lib/nga/csharp-build
}

lang_kotlin() {                                                     # [kotlin-2] /opt/kotlinc (uses jdk-21)
  /opt/kotlinc/bin/kotlinc -version 2>&1 | grep -q "kotlinc-jvm ${KOTLIN_VERSION} " && return 0
  local f="kotlin-compiler-${KOTLIN_VERSION}.zip"
  local base="https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}"
  fetch "$base/$f" "$dl/$f" || return 1
  fetch "$base/$f.sha256" "$dl/$f.sha256" || return 1
  check_sum sha256 "$dl/$f" "$(tr -d '[:space:]' <"$dl/$f.sha256" | cut -c1-64)" || return 1
  rm -rf "$dl/kotlinc" && unzip -q "$dl/$f" -d "$dl" || return 1
  $SUDO rm -rf "/opt/kotlinc-${KOTLIN_VERSION}"
  $SUDO mv "$dl/kotlinc" "/opt/kotlinc-${KOTLIN_VERSION}"
  $SUDO ln -sfn "/opt/kotlinc-${KOTLIN_VERSION}" /opt/kotlinc
}

lang_swift() {                                                      # [swift-6] /opt/swift/usr/bin/swiftc
  [ "$ARCH" = x86_64 ] || [ "$ARCH" = aarch64 ] || return 1
  /opt/swift/usr/bin/swiftc --version 2>/dev/null | grep -q "Swift version ${SWIFT_VERSION} " && return 0
  # What swift.org lists for Ubuntu 24.04 (names that changed since are tried in turn). The
  # 24.04 build is the newest Ubuntu one swift.org publishes and runs on later releases.
  local deps
  deps="$(available binutils gnupg libc6-dev libedit2 libncurses6 libsqlite3-0 libxml2 libxml2-16 libz3-4 libz3-dev tzdata zlib1g-dev unzip libcurl4t64 libcurl4 libgcc-13-dev libstdc++-13-dev libgcc-14-dev libstdc++-14-dev libgcc-15-dev libstdc++-15-dev)"
  # shellcheck disable=SC2086
  apt_get $deps || { echo "swift: couldn't install its system libraries:$deps" >&2; return 1; }
  local suffix="ubuntu24.04" dir="ubuntu2404"
  [ "$ARCH" = aarch64 ] && suffix="ubuntu24.04-aarch64" && dir="ubuntu2404-aarch64"
  local name="swift-${SWIFT_VERSION}-RELEASE-${suffix}"
  local base="https://download.swift.org/swift-${SWIFT_VERSION}-release/${dir}/swift-${SWIFT_VERSION}-RELEASE"
  fetch "$base/$name.tar.gz" "$dl/swift.tar.gz" || return 1
  fetch "$base/$name.tar.gz.sig" "$dl/swift.tar.gz.sig" || return 1
  fetch "https://www.swift.org/keys/all-keys.asc" "$dl/swift-keys.asc" || return 1
  # swift.org serves the key file gzip-compressed without saying so (no Content-Encoding).
  if [ "$(head -c 2 "$dl/swift-keys.asc" | od -An -tx1 | tr -d ' \n')" = "1f8b" ]; then
    gunzip -c "$dl/swift-keys.asc" >"$dl/swift-keys.txt" && mv "$dl/swift-keys.txt" "$dl/swift-keys.asc"
  fi
  local gh
  gh="$(mktemp -d)"
  GNUPGHOME="$gh" gpg --batch --quiet --import "$dl/swift-keys.asc" || { echo "swift: couldn't import swift.org's signing keys" >&2; rm -rf "$gh"; return 1; }
  GNUPGHOME="$gh" gpg --batch --quiet --verify "$dl/swift.tar.gz.sig" "$dl/swift.tar.gz" || { echo "swift: signature check failed" >&2; rm -rf "$gh"; return 1; }
  rm -rf "$gh"
  $SUDO rm -rf "/opt/swift-${SWIFT_VERSION}" && $SUDO mkdir -p "/opt/swift-${SWIFT_VERSION}"
  $SUDO tar -xzf "$dl/swift.tar.gz" -C "/opt/swift-${SWIFT_VERSION}" --strip-components=1 || return 1
  $SUDO ln -sfn "/opt/swift-${SWIFT_VERSION}" /opt/swift
}

wanted="${*:-$ALL_LANGUAGES}"
$SUDO apt-get update -qq || true
ok=""
failed=""
for lang in $wanted; do
  case " $ALL_LANGUAGES " in
    *" $lang "*) ;;
    *) echo "   unknown language '$lang' (known: $ALL_LANGUAGES)" >&2; failed="$failed $lang"; continue ;;
  esac
  echo "   - $lang"
  if "lang_$lang"; then ok="$ok $lang"; else failed="$failed $lang"; echo "   ! $lang was not installed; its kinds stay unavailable" >&2; fi
done
echo "languages installed:${ok:- none}"
[ -z "$failed" ] || echo "languages skipped:$failed"
# Asked for one language and it failed: say so in the exit code (scripts and CI).
[ -z "$failed" ] || [ $# -eq 0 ] || exit 1
exit 0
