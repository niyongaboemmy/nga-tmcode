# tm-judge runner host (phase 5, no-cost setup)

A dedicated machine for tm-judge: isolate (tiers 1–2) **and** Docker + gVisor (tier 3: containers, PTY sessions, server previews, per-run databases). It holds no app data and no production credentials except its own token.

| | |
|---|---|
| **Primary target** | Oracle Cloud **Always Free** Ampere A1 (`VM.Standard.A1.Flex`, arm64), up to 4 OCPU / 24 GB, region **eu-stockholm-1** (closest to the app host in AWS eu-north-1). Cost: 0 while it stays inside the Always Free limits. |
| **Link to the app host** | A **WireGuard** tunnel (free, private): app host `10.66.0.1` ↔ runner `10.66.0.2`. tm-judge listens on `10.66.0.2:5010` only. |
| **Public ports on the runner** | `51820/udp` from the app host's public IP, `22/tcp` from your admin IP. Nothing else. |
| **Previews** | Public at `https://<PREVIEW_HOST>/p/<id>/<token>/` on a **separate site** (free: `preview.<app-ip-with-dashes>.sslip.io` or `nga-preview.duckdns.org`), served by the **app host's nginx**, proxied over the tunnel. |
| **Fallback (no new machine)** | The existing shared AWS host keeps running tm-judge with the isolate tiers only (below). |

Nothing here has been run. Every command below is for you to run after approval.

Files: `bootstrap.sh` (the whole host setup), `firewall.sh` (iptables, installed by bootstrap), `user-data.yaml` (cloud-init), `wg0-apphost.conf.example`, `wg0-runner.conf.example`, `nginx-preview.conf.example`.

---

## 1. Oracle Cloud account and region

- **Always Free compute only exists in your tenancy's home region**, and the home region can't be changed later. Pick **Sweden Central (Stockholm), `eu-stockholm-1`** when signing up.
- Always Free limits that matter: Ampere A1 up to **4 OCPU + 24 GB RAM in total**, **200 GB block storage in total** (boot volumes count), 10 TB/month outbound traffic.
- Install the CLI on your computer: `bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"`, then `oci setup config`.

```sh
export C=<tenancy or compartment OCID>
export APP_IP=<app host public IP>          # AWS: the Elastic IP of the MIS/TM/Tupo host
export ADMIN_CIDR=<your public IP>/32
oci iam availability-domain list --compartment-id "$C" --query 'data[].name'
export AD=<one of them, e.g. xxxx:EU-STOCKHOLM-1-AD-1>
```

## 2. Network (VCN, subnet, security list)

```sh
VCN=$(oci network vcn create --compartment-id "$C" --cidr-blocks '["10.20.0.0/16"]' \
  --display-name nga-runner-vcn --dns-label ngarunner --query data.id --raw-output)
IGW=$(oci network internet-gateway create --compartment-id "$C" --vcn-id "$VCN" --is-enabled true \
  --display-name nga-runner-igw --query data.id --raw-output)
RT=$(oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]"

# Ingress: WireGuard from the app host only, SSH from you only, ICMP "fragmentation needed" (path MTU).
SL=$(oci network security-list create --compartment-id "$C" --vcn-id "$VCN" --display-name nga-runner-sl \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' \
  --ingress-security-rules "[
    {\"source\":\"$APP_IP/32\",\"protocol\":\"17\",\"isStateless\":false,\"udpOptions\":{\"destinationPortRange\":{\"min\":51820,\"max\":51820}}},
    {\"source\":\"$ADMIN_CIDR\",\"protocol\":\"6\",\"isStateless\":false,\"tcpOptions\":{\"destinationPortRange\":{\"min\":22,\"max\":22}}},
    {\"source\":\"0.0.0.0/0\",\"protocol\":\"1\",\"isStateless\":false,\"icmpOptions\":{\"type\":3,\"code\":4}}
  ]" --query data.id --raw-output)

SUBNET=$(oci network subnet create --compartment-id "$C" --vcn-id "$VCN" --cidr-block 10.20.1.0/24 \
  --security-list-ids "[\"$SL\"]" --route-table-id "$RT" --display-name nga-runner-subnet --dns-label runner \
  --query data.id --raw-output)
```

Console equivalent: *Networking → Virtual cloud networks → Start VCN Wizard → "Create VCN with Internet Connectivity"*, then in the public subnet's security list delete the default `0.0.0.0/0 TCP 22` rule and add the three ingress rules above.

## 3. The Ubuntu 24.04 aarch64 image

```sh
IMG=$(oci compute image list --compartment-id "$C" --operating-system "Canonical Ubuntu" \
  --operating-system-version "24.04" --shape VM.Standard.A1.Flex \
  --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)
oci compute image get --image-id "$IMG" --query 'data."display-name"'   # expect Canonical-Ubuntu-24.04-aarch64-...
```

## 4. Launch the instance

Edit `user-data.yaml` first: `APP_PUBLIC_IP`, `ADMIN_CIDR` (and `APP_WG_PUBKEY` if you already made the app host's key, step 6).

```sh
oci compute instance launch --compartment-id "$C" --availability-domain "$AD" \
  --display-name nga-runner --shape VM.Standard.A1.Flex --shape-config '{"ocpus":4,"memoryInGBs":24}' \
  --image-id "$IMG" --boot-volume-size-in-gbs 150 \
  --subnet-id "$SUBNET" --assign-public-ip true \
  --ssh-authorized-keys-file ~/.ssh/id_ed25519.pub \
  --user-data-file services/judge/deploy/runner-host/user-data.yaml \
  --instance-options '{"areLegacyImdsEndpointsDisabled":true}' \
  --freeform-tags '{"app":"nga","role":"code-runner","tier":"always-free"}'
```

- 150 GB boot volume leaves 50 GB of the 200 GB free block storage unused (images ≈ 15 GB, caches ≈ 10 GB, toolchains ≈ 8 GB).
- `areLegacyImdsEndpointsDisabled` = metadata service v2 only (the IMDSv2 equivalent). No instance principal / dynamic group is created: the host needs no Oracle API access.
- Boot volumes are encrypted at rest by Oracle-managed keys by default.

**"Out of host capacity".** A1 capacity in a region is often exhausted. The request then fails with `Out of host capacity` and nothing is created (no cost). Options:

1. Retry later or in another availability domain (Stockholm has one AD, so later): a loop is fine.
   ```sh
   until oci compute instance launch ... ; do echo "no capacity, retrying in 5 min"; sleep 300; done
   ```
2. Try a smaller shape first (`{"ocpus":2,"memoryInGBs":12}`) and resize later (*Edit → Shape*), when capacity exists.
3. Upgrading the account to Pay As You Go generally gets A1 capacity much faster. Always Free resources stay free on PAYG, but it needs a card and anything outside the free limits is billed: only do this with a budget alert at 1 USD. That is your decision, not part of this setup.

The bootstrap runs from cloud-init and takes 30–60 min (images and cache layers). Follow it: `ssh ubuntu@<runner IP> sudo tail -f /var/log/tm-judge-bootstrap.log`. Without cloud-init: copy the repo and run `sudo APP_PUBLIC_IP=… ADMIN_CIDR=… bash services/judge/deploy/runner-host/bootstrap.sh`.

## 5. What bootstrap.sh does

1. Base packages, WireGuard, unattended-upgrades.
2. Docker Engine (Docker's apt repo, the host's architecture).
3. gVisor `runsc` (gVisor's apt repo; `GVISOR_DIST=<yyyymmdd>` pins a release), registered in `/etc/docker/daemon.json` as a runtime. **The default runtime stays `runc`**; tm-judge asks for `runsc` per container and refuses `runc` unless `JUDGE_ALLOW_RUNC=1`. Container logs are size-capped; `live-restore` keeps containers across Docker upgrades. All student containers share `tm-judge-containers.slice` (`MemoryMax=16G`).
4. A `judge` system user (in the `docker` group, which is root-equivalent: this host runs nothing else) and a tmpfs at `/var/lib/tm-judge/boxes` (6 GB) for container box folders.
5. `install.sh` with `SKIP_PM2=1`: isolate + cgroup v2 slice (8 GB / 300% CPU here), the isolate-tier toolchains (arm64 builds; the x86-only wave-D tools are skipped and their kinds listed as unavailable), the tm-judge build.
6. `images/build-images.sh` (runner images for the container kinds, pinned sidecars `postgres:16` and `mysql:8.4`) and `build-caches.sh` (offline package layers).
7. WireGuard `wg0` (`10.66.0.2/24`, port 51820).
8. Firewall (`firewall.sh`, a boot-time systemd unit): its own iptables chain first in `INPUT`, so Oracle's image rules (boot volume, metadata) stay as they are. It accepts WireGuard only from `APP_PUBLIC_IP`, SSH only from `ADMIN_CIDR`, `5010/tcp` only from `10.66.0.1` on `wg0`, and drops the rest, including traffic from student containers to the host.
9. `.judge.env` (containers on, `JUDGE_HOST=10.66.0.2`, a generated `JUDGE_PREVIEW_SECRET`) and the `tm-judge` systemd unit (`User=judge`).
10. Journald limits, then a health check on `http://10.66.0.2:5010/v1/health`.

It prints the runner's WireGuard public key at the end.

## 6. Connect the app host (AWS) over WireGuard

On the app host:
```sh
sudo apt-get install -y wireguard
sudo sh -c 'umask 077; wg genkey | tee /etc/wireguard/app.key | wg pubkey > /etc/wireguard/app.pub'
sudo cat /etc/wireguard/app.pub          # → the runner's APP_WG_PUBKEY
sudo cp wg0-apphost.conf.example /etc/wireguard/wg0.conf   # fill in the key, runner public key and runner IP
sudo systemctl enable --now wg-quick@wg0
```
On the runner (if `APP_WG_PUBKEY` was empty at launch): put the key in `/etc/tm-judge/bootstrap.env` and re-run `bootstrap.sh` with `BUILD_IMAGES=0 BUILD_CACHES=0`, or `sudo wg set wg0 peer <app key> allowed-ips 10.66.0.1/32 && sudo wg-quick save wg0`.

- The app host dials out (UDP 51820, `PersistentKeepalive = 25`), so its **AWS security group needs no new inbound rule**; outbound UDP is allowed by default (add an egress rule `udp 51820 → <runner IP>/32` if egress is restricted).
- If the runner's public IP changes (ephemeral IPs survive reboots, not termination), update `Endpoint` on the app host.

Check from the app host:
```sh
ping -c1 10.66.0.2
TOKEN=<JUDGE_TOKEN from the runner's /opt/apps/tm-judge/.judge.env>
curl -s -H "Authorization: Bearer $TOKEN" http://10.66.0.2:5010/v1/health | jq '{features, containers, previews}'
```
`features` should include `containers`, `pty`, `previews` and `databases`.

## 7. The preview host: a separate site (free)

Previews are served from **their own site** (a different registrable domain), so student code never runs on, or next to, Task Mentor's origin.

> **Not `preview.amashuri.com`:** a subdomain is the *same site* as the apps, so `.amashuri.com` cookies (`nga_did`, `nga_inst_*`) and the apps' `SameSite=Lax` cookies would ride along on preview requests and be reachable from student code.

Pick one free name (`PREVIEW_HOST`):
- **sslip.io**, no sign-up: `preview.<app-host-ip-with-dashes>.sslip.io` (e.g. `preview.13-48-1-2.sslip.io`) resolves to the app host's IP by itself.
- **DuckDNS**, free sign-up: e.g. `nga-preview.duckdns.org`, an `A` record pointing at the app host's public IP (set once in the DuckDNS page).

Then, on the app host (the runner exposes no web port):
1. nginx: Task Mentor's template `deploy/nginx-preview.conf.example` (in the Task Mentor repo; same as `nginx-preview.conf.example` here). Replace `PREVIEW_HOST`, copy it to `/etc/nginx/sites-available/preview`, link it into `sites-enabled`, then `sudo nginx -t && sudo systemctl reload nginx`. Only `/p/…` is proxied over the tunnel, with WebSocket upgrades.
2. TLS: `sudo certbot --nginx -d <PREVIEW_HOST>` (Let's Encrypt, free; renews itself). Port 80/443 on the app host must be open, as they already are for the apps.
3. Task Mentor: `JUDGE_PREVIEW_BASE=https://<PREVIEW_HOST>`.

tm-judge also strips `Domain` from the preview's own cookies and scopes them to the preview's path.

## 8. Cut-over

1. Runner healthy over the tunnel (step 6).
2. Task Mentor's server env (GitHub secrets used by its deploy):
   ```
   CODERUNNER_ENGINE=tmjudge
   TMJUDGE_URL=http://10.66.0.2:5010
   TMJUDGE_TOKEN=<runner JUDGE_TOKEN>
   JUDGE_PREVIEW_SECRET=<runner JUDGE_PREVIEW_SECRET, 32+ characters>
   JUDGE_PREVIEW_BASE=https://<PREVIEW_HOST>        # sslip.io or DuckDNS name, never *.amashuri.com
   ```
3. Keep the **old shared-host tm-judge** (pm2, `127.0.0.1:5010`, isolate only) running for one release as the fallback. Note its token.
4. Deploy Task Mentor; run a Python, a Java and a C# question, an interactive session, an Express preview and an `sql/postgres` exercise.
5. **Rollback:** set `TMJUDGE_URL=http://127.0.0.1:5010` and `TMJUDGE_TOKEN=<old token>` back in Task Mentor and redeploy/restart it. Unset `JUDGE_PREVIEW_BASE` to hide previews. The runner can stay up; nothing else depends on it.
6. After a release without rollback: `pm2 delete tm-judge && pm2 save` on the shared host (or keep it as a cold fallback).

## 9. Fallback: the existing shared AWS host (no new machine)

If the Oracle host can't be had, nothing changes on the shared host: tm-judge keeps running the isolate tiers (single files, projects, pipes sessions) as today.

- Tier 3 is **off by default** (`JUDGE_CONTAINERS` unset). `/v1/health` then lists no `containers`/`pty`/`previews`/`databases` features, `containers.reason` says why, and `/v1/catalog` lists container kinds under `unavailable`. Task Mentor hides those features.
- If someone does turn it on there (Docker + gVisor installed by hand, as in bootstrap steps 2–3), keep it small; the box also runs MIS, Task Mentor and Tupo:
  ```
  JUDGE_CONTAINERS=1
  JUDGE_CONTAINER_CONCURRENCY=1
  JUDGE_CONTAINER_CPUS=0.5
  JUDGE_CONTAINER_MEMORY_MB=512
  JUDGE_CONTAINER_CGROUP_PARENT=tm-judge-containers.slice   # with MemoryMax=1G, TasksMax=512
  JUDGE_SESSIONS=2
  JUDGE_PREVIEWS=1
  JUDGE_PREVIEW_MEMORY_MB=384
  ```
  Build only the images you need (`build-images.sh python-3.12 node-22 postgres-16`). JVM, .NET and Flutter builds and the MySQL sidecar (~600 MB) don't fit next to the apps; leave those images unbuilt so their kinds stay unavailable.

## If a budget appears later

The same `bootstrap.sh` works on an AWS `c7i.large`/`t4g.medium` in the app host's VPC; then the tunnel isn't needed (bind `JUDGE_HOST` to the private IP and allow `5010` from the app host's security group only).

## Operations

- Logs: `journalctl -u tm-judge -f`; bootstrap: `/var/log/tm-judge-bootstrap.log`.
- Update tm-judge (install.sh pulls `main` itself): `sudo PATH=/opt/node-22/bin:$PATH SKIP_PM2=1 SKIP_TOOLCHAINS=1 bash /opt/apps/tm-judge/services/judge/deploy/install.sh && sudo chown -R judge:judge /opt/apps/tm-judge && sudo systemctl restart tm-judge`.
- Rebuild images (monthly patch window): `sudo bash /opt/apps/tm-judge/services/judge/images/build-images.sh`; tm-judge notices within 5 minutes. `/opt/tm-judge/images.lock` records what was built.
- Security updates install unattended; Docker and gVisor updates come with them (from their apt repos once added to `Unattended-Upgrade::Origins-Pattern`, or by hand: `apt-get install --only-upgrade docker-ce runsc`).
