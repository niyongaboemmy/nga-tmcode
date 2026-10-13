#!/usr/bin/env bash
# Builds tm-judge's tier-3 runner images (services/judge/images/<id>/Dockerfile) for this host's
# architecture (amd64 or arm64), pulls the pinned database sidecars, checks that every catalog tool
# path exists in its image, and records the digests in $LOCK. Needs network; NOT run by tm-judge.
#
#   bash services/judge/images/build-images.sh                 # all images
#   bash services/judge/images/build-images.sh dotnet-8 node-22 # some
#
# Tags: nga-runner/<id>:$IMAGE_TAG (must match IMAGE_TAG in services/judge/src/containers.ts,
# or set JUDGE_IMAGE_TAG for tm-judge). Pin the base image by digest with
# BASE_IMAGE=ubuntu:24.04@sha256:<digest>.
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-2026.10.1}"
PREFIX="${IMAGE_PREFIX:-nga-runner}"
BASE_IMAGE="${BASE_IMAGE:-ubuntu:24.04}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-postgres:16}"
MYSQL_IMAGE="${MYSQL_IMAGE:-mysql:8.4}"
LOCK="${LOCK:-/opt/tm-judge/images.lock}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ALL="dotnet-8 jdk-21 node-22 python-3.12 go-1.25 rust-stable php-8.3 ruby-3.2 postgres-16 mysql-8.4 flutter-3"

# Catalog tool paths each image must provide (packages/runtimes/src/catalog/runtimes.ts).
declare -A TOOLS=(
  [dotnet-8]="/usr/bin/dotnet"
  [jdk-21]="/usr/lib/jvm/java-21-openjdk-amd64/bin/java /usr/lib/jvm/java-21-openjdk-amd64/bin/javac /opt/maven/bin/mvn /opt/gradle/bin/gradle /opt/kotlinc/bin/kotlinc"
  [node-22]="/opt/node-22/bin/node /opt/node-22/bin/npm /opt/node-22/lib/node_modules/esbuild/bin/esbuild /opt/node-22/lib/node_modules/typescript/bin/tsc"
  [python-3.12]="/usr/bin/python3.12 /opt/uv/uv"
  [go-1.25]="/opt/go/bin/go /opt/go-tools/bin/gotestsum /usr/bin/stdbuf"
  [rust-stable]="/opt/rust/bin/rustc /opt/rust/bin/cargo /usr/bin/stdbuf"
  [php-8.3]="/usr/bin/php8.3 /usr/bin/composer"
  [ruby-3.2]="/usr/bin/ruby3.2 /usr/bin/bundle"
  [postgres-16]="/usr/bin/psql"
  [mysql-8.4]="/usr/bin/mysql"
  [flutter-3]="/opt/flutter/bin/flutter /usr/lib/dart/bin/dart"
)

want="${*:-$ALL}"
echo "== architecture: $(dpkg --print-architecture 2>/dev/null || uname -m); base: $BASE_IMAGE; tag: $IMAGE_TAG"
docker pull -q "$BASE_IMAGE" >/dev/null
failed=""
for id in $want; do
  [ -f "$HERE/$id/Dockerfile" ] || { echo "unknown image $id (one of: $ALL)" >&2; exit 1; }
  echo "== $PREFIX/$id:$IMAGE_TAG"
  if ! docker build -q --build-arg "BASE_IMAGE=$BASE_IMAGE" -t "$PREFIX/$id:$IMAGE_TAG" -f "$HERE/$id/Dockerfile" "$HERE" >/dev/null; then
    echo "   build FAILED (tm-judge lists its kinds as unavailable)" >&2
    failed="$failed $id"
    continue
  fi
  for t in ${TOOLS[$id]}; do
    if ! docker run --rm --network none --read-only --user 10001:10001 --entrypoint /usr/bin/test "$PREFIX/$id:$IMAGE_TAG" -x "$t"; then
      echo "   missing $t" >&2
      failed="$failed $id"
    fi
  done
done

echo "== sidecars"
docker pull -q "$POSTGRES_IMAGE" >/dev/null
docker pull -q "$MYSQL_IMAGE" >/dev/null

# Record what was built (image id + base digest) so an upgrade can be compared or rolled back.
sudo mkdir -p "$(dirname "$LOCK")"
{
  echo "# $(date -u +%FT%TZ) $(dpkg --print-architecture 2>/dev/null || uname -m)"
  echo "base $(docker image inspect --format '{{index .RepoDigests 0}}' "$BASE_IMAGE" 2>/dev/null || echo "$BASE_IMAGE")"
  for i in $POSTGRES_IMAGE $MYSQL_IMAGE; do echo "sidecar $(docker image inspect --format '{{index .RepoDigests 0}}' "$i")"; done
  for id in $want; do docker image inspect --format "image $PREFIX/$id:$IMAGE_TAG {{.Id}}" "$PREFIX/$id:$IMAGE_TAG" 2>/dev/null || true; done
} | sudo tee "$LOCK" >/dev/null
echo "   wrote $LOCK"

if [ -n "$failed" ]; then
  echo "images with problems:$failed" >&2
  exit 1
fi
echo "all images built; tm-judge picks them up within JUDGE_CONTAINER_PROBE_S (300 s) or on restart"
