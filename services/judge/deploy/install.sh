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

echo "== 3/5 cgroup limits for all sandboxes together"
sudo mkdir -p /etc/systemd/system/isolate.slice.d
printf '[Slice]\nMemoryMax=%s\nCPUQuota=%s\nTasksMax=512\n' "$SLICE_MEMORY" "$SLICE_CPU" |
  sudo tee /etc/systemd/system/isolate.slice.d/tm-judge.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now isolate.service >/dev/null
sudo systemctl restart isolate.service
isolate-check-environment || echo "(isolate-check-environment warnings above are advisory)"

echo "== 4/5 code"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch -q origin main
  git -C "$APP_DIR" reset -q --hard origin/main
else
  sudo mkdir -p "$APP_DIR"
  sudo chown "$(id -u):$(id -g)" "$APP_DIR"
  git clone -q "$REPO" "$APP_DIR"
fi
if [ ! -f "$APP_DIR/.judge.env" ]; then
  umask 077
  printf 'JUDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" >"$APP_DIR/.judge.env"
  echo "   created $APP_DIR/.judge.env (give this token to Task Mentor as TMJUDGE_TOKEN)"
fi

echo "== 5/5 pm2"
pm2 startOrReload "$APP_DIR/services/judge/deploy/ecosystem.config.cjs" --update-env
pm2 save >/dev/null
sleep 2
TOKEN="$(grep '^JUDGE_TOKEN=' "$APP_DIR/.judge.env" | cut -d= -f2)"
curl -fsS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:5010/v1/health && echo
echo "tm-judge ready"
