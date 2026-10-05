#!/usr/bin/env bash
# Installs or updates tm-judge on the shared NGA server (Ubuntu, cgroup v2, pm2).
# Idempotent: safe to re-run for updates. Run as the deploy user (sudo needed).
#
#   bash services/judge/deploy/install.sh
#
# What it does:
#   1. language runtimes + isolate build deps (apt)
#   2. builds ioi/isolate (setuid sandbox) and starts isolate.service (cgroup keeper)
#   3. caps ALL judge boxes together (isolate.slice) so student code can never
#      starve MIS, Task Mentor or Tupo on this shared box
#   4. clones/updates nga-tmcode into /opt/apps/tm-judge, creates the token once
#   5. (re)starts the pm2 process "tm-judge" on 127.0.0.1:5010
set -euo pipefail

ISOLATE_VERSION="${ISOLATE_VERSION:-v2.7}"
APP_DIR="${APP_DIR:-/opt/apps/tm-judge}"
REPO="${REPO:-https://github.com/niyongaboemmy/nga-tmcode.git}"
SLICE_MEMORY="${SLICE_MEMORY:-1200M}"
SLICE_CPU="${SLICE_CPU:-150%}"

# Update the code first and re-run the updated copy of this script (bash reads
# scripts incrementally, so updating the file under a running bash is unsafe).
if [ "${TM_JUDGE_REEXEC:-}" != "1" ] && [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin main
  git -C "$APP_DIR" reset -q --hard origin/main
  TM_JUDGE_REEXEC=1 exec bash "$APP_DIR/services/judge/deploy/install.sh" "$@"
fi

echo "== 1/5 packages"
sudo apt-get update -qq
sudo apt-get install -y -qq --no-install-recommends \
  build-essential pkg-config git libcap-dev libsystemd-dev libseccomp-dev \
  python3 gcc g++ openjdk-21-jdk-headless >/dev/null

echo "== 2/5 isolate ${ISOLATE_VERSION}"
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

echo "== 3/5 cgroup limits for all sandboxes together"
sudo mkdir -p /etc/systemd/system/isolate.slice.d
printf '[Slice]\nMemoryMax=%s\nCPUQuota=%s\nTasksMax=512\n' "$SLICE_MEMORY" "$SLICE_CPU" |
  sudo tee /etc/systemd/system/isolate.slice.d/tm-judge.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now isolate.service >/dev/null
sudo systemctl restart isolate.service
isolate-check-environment || echo "(isolate-check-environment warnings above are advisory)"

echo "== 4/5 code"
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

echo "   building"
(cd "$APP_DIR/services/judge" && npm install --no-save --no-package-lock --workspaces=false --omit=dev --no-audit --no-fund --silent && node scripts/build.mjs --log-level=warning)

echo "== 5/5 pm2"
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
