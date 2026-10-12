#!/usr/bin/env bash
# Fills the read-only dependency cache layers that tm-judge mounts in boxes at
# /caches/<id> (CODE_RUNNER_PLAN §12, §18.2), from the starters' manifests
# (packages/runtimes/starters) plus the allow-lists in deploy/allowlists/.
#
# Needs network. Run it as the deploy user on the runner host (outside any
# sandbox) or on a networked builder and copy $CACHE_ROOT across. Package
# managers run with lifecycle scripts disabled where they allow it.
#
#   bash services/judge/deploy/build-caches.sh               # every layer
#   bash services/judge/deploy/build-caches.sh m2 npm        # some: m2 gradle npm pip cargo go
#
# Each layer is built in $CACHE_ROOT/.staging-<id>, then swapped in; the previous
# one is kept as <id>.prev until the next build. Boxes pick the new layer up on
# their next run (no restart needed unless a layer was empty before: restart
# tm-judge so /v1/catalog reports it).
#
# Layers and how boxes use them (see the catalog in packages/runtimes):
#   m2-school              Maven local repo, used as -Dmaven.repo.local.tail (read-only)
#   gradle-school          GRADLE_RO_DEP_CACHE (a modules-2 folder)
#   npm-school             npm cache (npm install --offline --cache)
#   wheels-school          wheelhouse (uv pip install --offline --find-links)
#   site-packages-school   prebuilt packages on PYTHONPATH (pytest, numpy…)
#   cargo-registry-school  `cargo vendor` folder (crates-io is replaced with it)
#   go-mod-school          GOMODCACHE; boxes use its cache/download as a file:// GOPROXY
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ALLOW="$HERE/allowlists"
CACHE_ROOT="${CACHE_ROOT:-/opt/tm-judge/caches}"
STARTERS="${STARTERS:-$REPO/packages/runtimes/starters}"
MVN="${MVN:-/opt/maven/bin/mvn}"
GRADLE="${GRADLE:-/opt/gradle/bin/gradle}"
NODE_BIN="${NODE_BIN:-/opt/node-22/bin}"
PYTHON="${PYTHON:-/usr/bin/python3.12}"
UV="${UV:-/opt/uv/uv}"
CARGO="${CARGO:-/opt/rust/bin/cargo}"
GO="${GO:-/opt/go/bin/go}"

LAYERS=("$@")
[ ${#LAYERS[@]} -eq 0 ] && LAYERS=(m2 gradle npm pip cargo go)
want() { local x; for x in "${LAYERS[@]}"; do [ "$x" = "$1" ] && return 0; done; return 1; }

work="$(mktemp -d)"
cleanup() { chmod -R u+w "$work" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
mkdir -p "$CACHE_ROOT"
failures=0
warn() { echo "   WARNING: $*" >&2; failures=$((failures + 1)); }

# Starter folders that contain <file> (language/id/<file>).
starters_with() { find "$STARTERS" -mindepth 3 -maxdepth 3 -name "$1" -exec dirname {} \; | sort -u; }
# A writable copy of a starter (or any folder) under $work/<layer>/.
copy_of() { local dst; dst="$work/$1/$(basename "$2")"; rm -rf "$dst"; mkdir -p "$work/$1"; cp -R "$2" "$dst"; echo "$dst"; }
stage() { local s="$CACHE_ROOT/.staging-$1"; chmod -R u+w "$s" 2>/dev/null || true; rm -rf "$s"; mkdir -p "$s"; echo "$s"; }
publish() {
  local id="$1" s="$CACHE_ROOT/.staging-$1"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$s/.built-at"
  chmod -R a+rX "$s"
  if [ -d "$CACHE_ROOT/$id.prev" ]; then chmod -R u+w "$CACHE_ROOT/$id.prev"; rm -rf "$CACHE_ROOT/$id.prev"; fi
  [ -d "$CACHE_ROOT/$id" ] && mv "$CACHE_ROOT/$id" "$CACHE_ROOT/$id.prev"
  mv "$s" "$CACHE_ROOT/$id"
  echo "   $id: $(du -sh "$CACHE_ROOT/$id" | cut -f1)"
}

if want m2; then
  echo "== m2-school (Maven)"
  repo="$(stage m2-school)"
  allow="$work/m2-allow/allowlist"; mkdir -p "$allow"; cp "$ALLOW/maven-pom.xml" "$allow/pom.xml"
  for d in "$allow" $(starters_with pom.xml); do
    p="$(copy_of m2 "$d")"
    echo "   $(basename "$d")"
    # go-offline resolves dependencies and plugins; package + verify (offline) catch the plugins'
    # own runtime dependencies (surefire providers, compiler) that go-offline misses.
    (cd "$p" && "$MVN" -B -q -Dmaven.repo.local="$repo" dependency:go-offline &&
      "$MVN" -B -q -Dmaven.repo.local="$repo" -Dmaven.test.failure.ignore=true package &&
      "$MVN" -B -q -o -Dmaven.repo.local="$repo" -Dmaven.test.failure.ignore=true verify) || warn "maven: $(basename "$d")"
  done
  publish m2-school
fi

if want gradle; then
  echo "== gradle-school (Gradle)"
  gh="$work/gradle-home"
  for d in $(starters_with build.gradle.kts) $(starters_with build.gradle); do
    p="$(copy_of gradle "$d")"
    echo "   $(basename "$d")"
    (cd "$p" && GRADLE_USER_HOME="$gh" "$GRADLE" --no-daemon -q build) || warn "gradle: $(basename "$d")"
  done
  s="$(stage gradle-school)"
  if [ -d "$gh/caches/modules-2" ]; then
    cp -R "$gh/caches/modules-2" "$s/"
    # A read-only dependency cache must not carry Gradle's lock or GC files.
    find "$s" -name '*.lock' -delete
    rm -f "$s/modules-2/gc.properties"
  fi
  publish gradle-school
fi

if want npm; then
  echo "== npm-school (npm)"
  cache="$(stage npm-school)"
  allow="$work/npm-allow/allowlist"; mkdir -p "$allow"; cp "$ALLOW/npm.json" "$allow/package.json"
  for d in "$allow" $(starters_with package.json); do
    p="$(copy_of npm "$d")"
    echo "   $(basename "$d")"
    (cd "$p" && PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" install --cache "$cache" --ignore-scripts --no-audit --no-fund --loglevel=error >/dev/null) || warn "npm: $(basename "$d")"
  done
  PATH="$NODE_BIN:$PATH" "$NODE_BIN/npm" cache verify --cache "$cache" >/dev/null || warn "npm cache verify"
  rm -rf "$cache/_logs"
  publish npm-school
fi

if want pip; then
  echo "== wheels-school + site-packages-school (Python)"
  "$PYTHON" -m venv "$work/pyvenv"
  "$work/pyvenv/bin/pip" install -q --upgrade pip wheel
  reqs="$work/requirements.txt"
  grep -hv '^\s*#' "$ALLOW/python.txt" >"$reqs"
  for d in $(starters_with requirements.txt); do grep -hv '^\s*#' "$d/requirements.txt" >>"$reqs"; echo >>"$reqs"; done
  wheels="$(stage wheels-school)"
  # `pip wheel` also builds wheels for packages published only as sdists, so offline installs never build.
  "$work/pyvenv/bin/pip" wheel -q --wheel-dir "$wheels" -r "$reqs" || warn "pip wheel"
  site="$(stage site-packages-school)"
  grep -hv '^\s*#' "$ALLOW/python.txt" >"$work/site.txt"
  "$UV" pip install -q --python "$PYTHON" --target "$site" --offline --no-index --find-links "$wheels" -r "$work/site.txt" || warn "site-packages"
  find "$site" -name '__pycache__' -type d -prune -exec rm -rf {} +
  publish wheels-school
  publish site-packages-school
fi

if want cargo; then
  echo "== cargo-registry-school (cargo vendor)"
  allow="$work/cargo-allow/allowlist"; mkdir -p "$allow/src"; cp "$ALLOW/cargo.toml" "$allow/Cargo.toml"; echo "" >"$allow/src/lib.rs"
  syncs=()
  for d in $(starters_with Cargo.toml); do
    p="$(copy_of cargo "$d")"
    syncs+=(--sync "$p/Cargo.toml")
  done
  v="$(stage cargo-registry-school)"
  rmdir "$v"
  CARGO_HOME="$work/cargo-home" "$CARGO" vendor --quiet --versioned-dirs --manifest-path "$allow/Cargo.toml" "${syncs[@]}" "$v" >/dev/null || { warn "cargo vendor"; mkdir -p "$v"; }
  publish cargo-registry-school
fi

if want go; then
  echo "== go-mod-school (Go modules)"
  mc="$(stage go-mod-school)"
  export GOMODCACHE="$mc" GOPATH="$work/gopath" GOCACHE="$work/gocache" GOFLAGS=-mod=mod GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org,direct
  for d in $(starters_with go.mod); do
    p="$(copy_of go "$d")"
    echo "   $(basename "$d")"
    (cd "$p" && "$GO" mod download all) || warn "go: $(basename "$d")"
  done
  allow="$work/go-allow"; mkdir -p "$allow"
  (cd "$allow" && "$GO" mod init nga.ac.rw/allowlist >/dev/null 2>&1 &&
    grep -v '^\s*#' "$ALLOW/go.txt" | grep -v '^\s*$' | while read -r m; do "$GO" get "$m" >/dev/null 2>&1 || echo "   WARNING: go get $m" >&2; done &&
    "$GO" mod download all) || warn "go allow-list"
  # The module cache is read-only by design; make it movable for the next rebuild, readable by boxes.
  chmod -R u+w "$mc"
  # Boxes only read cache/download (as a file:// GOPROXY) and extract into their own /tmp: drop the rest.
  find "$mc" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
  find "$mc/cache" -mindepth 1 -maxdepth 1 ! -name download -exec rm -rf {} +
  unset GOMODCACHE GOPATH GOCACHE GOFLAGS GOTOOLCHAIN GOPROXY
  publish go-mod-school
fi

if [ "$failures" -gt 0 ]; then
  echo "Done with $failures warning(s) (see above). Layers were published anyway." >&2
else
  echo "Done. Layers in $CACHE_ROOT; boxes see them at /caches/<id>."
fi
