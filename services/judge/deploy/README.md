# tm-judge deployment

tm-judge runs on the shared NGA server, next to MIS, Task Mentor and Tupo. It listens on `127.0.0.1:5010` only, needs a bearer token, and runs every submission inside an [isolate](https://github.com/ioi/isolate) box with cgroup v2 limits.

## Install or update
```sh
ssh ubuntu@<server>
git clone https://github.com/niyongaboemmy/nga-tmcode.git /tmp/nga-tmcode   # first time only
bash /tmp/nga-tmcode/services/judge/deploy/install.sh                      # later: bash /opt/apps/tm-judge/services/judge/deploy/install.sh
```
The script is idempotent.

## Protecting the other apps
- **Per box:** memory (256 MB, 512 MB for Java; project builds up to 1 GB), process count, CPU time, file size and output size are limited, and there is no network. Toolchains and cache layers are mounted read-only.
- **All boxes together** (`isolate.slice`): `MemoryMax=1200M`, `CPUQuota=150%`, `TasksMax=512`. Exam bursts queue up instead of taking memory or CPU from the other apps.
- **Concurrency:** 2 jobs (`JUDGE_CONCURRENCY`); further requests queue, and the queue is capped at 100.

## Project toolchains and offline caches
`install.sh` also installs the wave-A project toolchains of the Runtime Catalog (`packages/runtimes`): Go → `/opt/go`, Rust (rustup minimal, pinned; `/opt/rust` is the toolchain itself), Maven → `/opt/maven`, Gradle → `/opt/gradle`, Node.js 22 → `/opt/node-22` (+ esbuild, tsc), uv → `/opt/uv`, the JUnit console launcher → `/opt/junit`; gcc/g++ 13, make, cmake, GoogleTest, Python 3.12, SQLite and OpenJDK 21 come from apt. Versions are pinned at the top of the script and every download is checksum-verified. `SKIP_TOOLCHAINS=1` skips this part.

It creates the cache-layer folders under `/opt/tm-judge/caches/<id>` and adds `JUDGE_CACHES` to `.judge.env`. Fill them (needs network, runs package managers outside the sandbox; takes a while and a few GB):
```sh
bash /opt/apps/tm-judge/services/judge/deploy/build-caches.sh          # all layers
bash /opt/apps/tm-judge/services/judge/deploy/build-caches.sh m2 npm   # some: m2 gradle npm pip cargo go
pm2 restart tm-judge                                                     # so /v1/catalog reports newly filled layers
```
Allow-lists live in `deploy/allowlists/`; the starters' own manifests are always included. A dependency outside the layers fails offline with verdict `package-not-available`.

Paths the catalog doesn't know can be overridden in `.judge.env`, e.g. `JUDGE_TOOLCHAINS={"jdk-21":{"java":"/usr/lib/jvm/java-21-openjdk-arm64/bin/java"}}` (otherwise a missing catalog path falls back to `command -v`).

**Memory:** Maven, Gradle and cargo builds get up to 1 GB each. With `JUDGE_CONCURRENCY=2` raise `SLICE_MEMORY` (e.g. `SLICE_MEMORY=2400M bash install.sh`) if the host has room, or run project grading at concurrency 1.

## Connect Task Mentor
Set these in Task Mentor's server environment (GitHub secrets used by its deploy):
```
CODERUNNER_ENGINE=tmjudge
TMJUDGE_URL=http://127.0.0.1:5010
TMJUDGE_TOKEN=<value of JUDGE_TOKEN in /opt/apps/tm-judge/.judge.env>
```

## Check
```sh
pm2 logs tm-judge --lines 50
TOKEN=$(grep JUDGE_TOKEN /opt/apps/tm-judge/.judge.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/v1/health
```
