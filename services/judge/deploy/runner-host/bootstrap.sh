#!/usr/bin/env bash
# Bootstraps the dedicated tm-judge runner host (CODE_RUNNER_PLAN §18.1, phase 5).
# Target: Ubuntu 24.04 on Oracle Cloud Always Free Ampere A1 (arm64); amd64 works too.
# Run as root (cloud-init user-data.yaml does). Idempotent: safe to re-run. NOT run by tm-judge.
#
#   APP_PUBLIC_IP=<app host public IP> ADMIN_CIDR=<your IP>/32 bash bootstrap.sh
#
# Settings come from the environment or /etc/tm-judge/bootstrap.env:
#   APP_PUBLIC_IP        (required) the app host's public IP: the only source allowed to reach WireGuard
#   ADMIN_CIDR           (required) where SSH is allowed from (e.g. 203.0.113.7/32)
#   APP_WG_PUBKEY        the app host's WireGuard public key (empty: add the peer later, see README)
#   WG_RUNNER_ADDR       10.66.0.2   tm-judge listens here, on the tunnel only
#   WG_APP_ADDR          10.66.0.1
#   WG_PORT              51820
#   JUDGE_PORT           5010
#   JUDGE_PREVIEW_SECRET (generated when empty; Task Mentor needs the same value)
#   BOX_TMPFS            6g          tmpfs for container box folders
#   CONTAINERS_MEMORY    16G         cap for ALL student containers together (tm-judge-containers.slice)
#   SLICE_MEMORY/SLICE_CPU  8G / 300%  cap for all isolate boxes together (passed to install.sh)
#   BUILD_IMAGES=1 BUILD_CACHES=1    build the runner images / cache layers (needs network, ~30-60 min)
#   GVISOR_DIST          release     gVisor apt channel (or a dated release, e.g. 20250929, to pin)
#   REPO / BRANCH        https://github.com/niyongaboemmy/nga-tmcode.git / main
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -f /etc/tm-judge/bootstrap.env ] && . /etc/tm-judge/bootstrap.env

: "${APP_PUBLIC_IP:?set APP_PUBLIC_IP (the app host public IP)}"
: "${ADMIN_CIDR:?set ADMIN_CIDR (where SSH is allowed from)}"
APP_WG_PUBKEY="${APP_WG_PUBKEY:-}"
WG_RUNNER_ADDR="${WG_RUNNER_ADDR:-10.66.0.2}"
WG_APP_ADDR="${WG_APP_ADDR:-10.66.0.1}"
WG_PORT="${WG_PORT:-51820}"
JUDGE_PORT="${JUDGE_PORT:-5010}"
BOX_TMPFS="${BOX_TMPFS:-6g}"
CONTAINERS_MEMORY="${CONTAINERS_MEMORY:-16G}"
export SLICE_MEMORY="${SLICE_MEMORY:-8G}" SLICE_CPU="${SLICE_CPU:-300%}"
BUILD_IMAGES="${BUILD_IMAGES:-1}"
BUILD_CACHES="${BUILD_CACHES:-1}"
GVISOR_DIST="${GVISOR_DIST:-release}"
REPO="${REPO:-https://github.com/niyongaboemmy/nga-tmcode.git}"
BRANCH="${BRANCH:-main}"
export APP_DIR="${APP_DIR:-/opt/apps/tm-judge}"
BOXES=/var/lib/tm-judge/boxes
HERE="$(cd "$(dirname "$0")" && pwd)"

. /etc/os-release
[ "$VERSION_ID" = "24.04" ] || echo "WARNING: written for Ubuntu 24.04, this is $PRETTY_NAME" >&2
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in amd64 | arm64) ;; *) echo "unsupported architecture $ARCH" >&2; exit 1 ;; esac
echo "== tm-judge runner host bootstrap ($ARCH, $PRETTY_NAME)"
export DEBIAN_FRONTEND=noninteractive

echo "== 1/10 base packages"
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg git jq openssl wireguard wireguard-tools iptables \
  unattended-upgrades apt-listchanges sudo >/dev/null

echo "== 2/10 Docker Engine (download.docker.com)"
if ! command -v dockerd >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io >/dev/null
fi

echo "== 3/10 gVisor (runsc) as a Docker runtime"
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor --yes -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases $GVISOR_DIST main" >/etc/apt/sources.list.d/gvisor.list
  apt-get update -qq
  apt-get install -y -qq runsc >/dev/null
fi
# All student containers share one cgroup slice with a ceiling (memory, tasks).
cat >/etc/systemd/system/tm-judge-containers.slice <<EOF
[Unit]
Description=tm-judge student containers (tier 3)
[Slice]
MemoryMax=$CONTAINERS_MEMORY
TasksMax=4096
EOF
# runsc registered; the DEFAULT runtime stays runc (tm-judge asks for runsc per container).
mkdir -p /etc/docker
cat >/etc/docker/daemon.json <<'EOF'
{
  "runtimes": { "runsc": { "path": "/usr/bin/runsc" } },
  "default-runtime": "runc",
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "icc": false
}
EOF
systemctl daemon-reload
systemctl enable --now docker >/dev/null
systemctl restart docker
docker info --format '{{json .Runtimes}}' | grep -q runsc || { echo "runsc is not registered with Docker" >&2; exit 1; }
docker run --rm --runtime=runsc --network none hello-world >/dev/null 2>&1 && echo "   runsc works" || echo "   WARNING: runsc smoke test failed (see 'docker run --rm --runtime=runsc hello-world')" >&2

echo "== 4/10 the judge user and the box tmpfs"
id judge >/dev/null 2>&1 || useradd --system --home-dir /var/lib/tm-judge --create-home --shell /usr/sbin/nologin judge
# Docker access = root-equivalent on this host. That is why this host runs nothing else and holds no app data.
usermod -aG docker judge
mkdir -p "$BOXES"
if ! grep -q " $BOXES " /etc/fstab; then
  echo "tmpfs $BOXES tmpfs rw,nosuid,nodev,size=$BOX_TMPFS,mode=0711,uid=$(id -u judge),gid=$(id -g judge) 0 0" >>/etc/fstab
fi
mountpoint -q "$BOXES" || mount "$BOXES"

echo "== 5/10 isolate, toolchains and tm-judge (install.sh, SKIP_PM2=1)"
if [ ! -d "$APP_DIR/.git" ]; then
  mkdir -p "$(dirname "$APP_DIR")"
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
# install.sh installs Node 22 under /opt/node-22; it needs npm on PATH for the build.
PATH="/opt/node-22/bin:$PATH" SKIP_PM2=1 bash "$APP_DIR/services/judge/deploy/install.sh"

echo "== 6/10 runner images and cache layers"
if [ "$BUILD_IMAGES" = 1 ]; then bash "$APP_DIR/services/judge/images/build-images.sh" || echo "   some images failed: their kinds stay unavailable" >&2; fi
if [ "$BUILD_CACHES" = 1 ]; then PATH="/opt/node-22/bin:/opt/go/bin:/opt/rust/bin:$PATH" bash "$APP_DIR/services/judge/deploy/build-caches.sh" || echo "   some cache layers failed" >&2; fi
chown -R judge:judge "$APP_DIR" /opt/tm-judge/caches

echo "== 7/10 WireGuard tunnel to the app host ($WG_RUNNER_ADDR ↔ $WG_APP_ADDR)"
umask 077
[ -f /etc/wireguard/runner.key ] || wg genkey >/etc/wireguard/runner.key
wg pubkey </etc/wireguard/runner.key >/etc/wireguard/runner.pub
umask 022
{
  echo "# tm-judge runner side; generated by bootstrap.sh"
  echo "[Interface]"
  echo "Address = $WG_RUNNER_ADDR/24"
  echo "ListenPort = $WG_PORT"
  echo "PrivateKey = $(cat /etc/wireguard/runner.key)"
  if [ -n "$APP_WG_PUBKEY" ]; then
    echo
    echo "[Peer]"
    echo "# the app host (Task Mentor + nginx); it dials in, so no Endpoint is needed here"
    echo "PublicKey = $APP_WG_PUBKEY"
    echo "AllowedIPs = $WG_APP_ADDR/32"
  fi
} >/etc/wireguard/wg0.conf
chmod 600 /etc/wireguard/wg0.conf
systemctl enable wg-quick@wg0 >/dev/null
systemctl restart wg-quick@wg0

echo "== 8/10 firewall: WireGuard from the app host, SSH from the admin, nothing else"
install -m 0755 "$HERE/firewall.sh" /usr/local/sbin/tm-judge-firewall
cat >/etc/default/tm-judge-firewall <<EOF
APP_PUBLIC_IP=$APP_PUBLIC_IP
ADMIN_CIDR=$ADMIN_CIDR
WG_PORT=$WG_PORT
WG_APP_ADDR=$WG_APP_ADDR
JUDGE_PORT=$JUDGE_PORT
EOF
cat >/etc/systemd/system/tm-judge-firewall.service <<'EOF'
[Unit]
Description=tm-judge runner host firewall (iptables; keeps Oracle's own rules)
After=netfilter-persistent.service
Before=network-online.target wg-quick@wg0.service docker.service
Wants=network-pre.target
[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/default/tm-judge-firewall
ExecStart=/usr/local/sbin/tm-judge-firewall
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now tm-judge-firewall >/dev/null
systemctl restart tm-judge-firewall

echo "== 9/10 tm-judge settings and the systemd unit"
ENVF="$APP_DIR/.judge.env"
setenv() { # setenv KEY VALUE: add or replace a line in .judge.env
  if grep -q "^$1=" "$ENVF"; then sed -i "s|^$1=.*|$1=$2|" "$ENVF"; else echo "$1=$2" >>"$ENVF"; fi
}
secret="$(grep '^JUDGE_PREVIEW_SECRET=' "$ENVF" | cut -d= -f2- || true)"
[ -n "$secret" ] || secret="${JUDGE_PREVIEW_SECRET:-$(openssl rand -hex 32)}"
setenv NODE_ENV production
setenv JUDGE_HOST "$WG_RUNNER_ADDR"
setenv JUDGE_PORT "$JUDGE_PORT"
setenv JUDGE_CONCURRENCY 4
setenv JUDGE_SESSIONS 24
setenv JUDGE_CONTAINERS 1
setenv JUDGE_CONTAINER_RUNTIME runsc
setenv JUDGE_CONTAINER_WORKDIR "$BOXES"
setenv JUDGE_CONTAINER_CONCURRENCY 3
setenv JUDGE_CONTAINER_CPUS 1
setenv JUDGE_CONTAINER_MEMORY_MB 1536
setenv JUDGE_CONTAINER_CGROUP_PARENT tm-judge-containers.slice
setenv JUDGE_PREVIEWS 6
setenv JUDGE_PREVIEW_SECRET "$secret"
chown judge:judge "$ENVF"
chmod 600 "$ENVF"
cat >/etc/systemd/system/tm-judge.service <<EOF
[Unit]
Description=tm-judge (NGA code runner)
After=network-online.target docker.service isolate.service wg-quick@wg0.service tm-judge-firewall.service
Wants=network-online.target
Requires=docker.service wg-quick@wg0.service
[Service]
User=judge
Group=judge
SupplementaryGroups=docker
EnvironmentFile=$ENVF
WorkingDirectory=$APP_DIR/services/judge
ExecStart=/opt/node-22/bin/node $APP_DIR/services/judge/dist/server.mjs
Restart=always
RestartSec=3
LimitNOFILE=65536
# isolate is setuid root, so NoNewPrivileges must stay off; the rest of the system is read-only to the judge.
ProtectHome=yes
ProtectSystem=full
ReadWritePaths=$BOXES /var/local/lib/isolate /tmp
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable tm-judge >/dev/null
systemctl restart tm-judge

echo "== 10/10 unattended security upgrades and log limits"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=1G\nMaxRetentionSec=1month\n' >/etc/systemd/journald.conf.d/tm-judge.conf
systemctl restart systemd-journald

TOKEN="$(grep '^JUDGE_TOKEN=' "$ENVF" | cut -d= -f2)"
for _ in $(seq 1 60); do
  if curl -fsS -H "Authorization: Bearer $TOKEN" "http://$WG_RUNNER_ADDR:$JUDGE_PORT/v1/health" >/tmp/tm-judge-health.json 2>/dev/null; then
    echo "   health: $(jq -c '{features, containers: {usable: .containers.usable, reason: .containers.reason}}' /tmp/tm-judge-health.json)"
    break
  fi
  sleep 2
done

cat <<EOF

== done. Give these to the app host / Task Mentor (see README.md "Connect the app host"):
   runner WireGuard public key : $(cat /etc/wireguard/runner.pub)
   TMJUDGE_URL                 : http://$WG_RUNNER_ADDR:$JUDGE_PORT
   TMJUDGE_TOKEN               : (JUDGE_TOKEN in $ENVF)
   JUDGE_PREVIEW_SECRET        : (in $ENVF; the same value goes into Task Mentor)
EOF
[ -n "$APP_WG_PUBKEY" ] || echo "   NOTE: no APP_WG_PUBKEY yet: add the app host's key (README step 6) and re-run, or 'wg set wg0 peer <key> allowed-ips $WG_APP_ADDR/32'."
