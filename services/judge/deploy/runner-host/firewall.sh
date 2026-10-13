#!/usr/bin/env bash
# tm-judge runner host firewall (run by tm-judge-firewall.service at boot; idempotent).
# Inbound: WireGuard only from the app host's public IP, SSH only from ADMIN_CIDR, tm-judge
# only from the app host inside the tunnel; everything else dropped, including traffic from
# student containers to the host. Uses its own chain jumped to first, so Oracle's own rules
# (which protect the boot volume and metadata service) stay untouched, and Docker's chains too.
set -euo pipefail
: "${APP_PUBLIC_IP:?}" "${ADMIN_CIDR:?}"
WG_PORT="${WG_PORT:-51820}"
WG_APP_ADDR="${WG_APP_ADDR:-10.66.0.1}"
JUDGE_PORT="${JUDGE_PORT:-5010}"

for ipt in iptables ip6tables; do
  $ipt -N TMJ-IN 2>/dev/null || $ipt -F TMJ-IN
  $ipt -A TMJ-IN -i lo -j ACCEPT
  $ipt -A TMJ-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  if [ "$ipt" = iptables ]; then
    $ipt -A TMJ-IN -p icmp -j ACCEPT
    $ipt -A TMJ-IN -p udp --dport "$WG_PORT" -s "$APP_PUBLIC_IP" -j ACCEPT
    $ipt -A TMJ-IN -p tcp --dport 22 -s "$ADMIN_CIDR" -j ACCEPT
    $ipt -A TMJ-IN -i wg0 -s "$WG_APP_ADDR" -p tcp --dport "$JUDGE_PORT" -j ACCEPT
  else
    $ipt -A TMJ-IN -p ipv6-icmp -j ACCEPT
  fi
  $ipt -A TMJ-IN -j DROP
  $ipt -C INPUT -j TMJ-IN 2>/dev/null || $ipt -I INPUT 1 -j TMJ-IN
done
echo "tm-judge firewall: WireGuard ${WG_PORT}/udp from $APP_PUBLIC_IP, SSH from $ADMIN_CIDR, ${JUDGE_PORT}/tcp from $WG_APP_ADDR on wg0"
