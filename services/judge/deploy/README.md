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
- **Per box:** memory (256 MB, 512 MB for Java), process count, CPU time and output size are limited, and there is no network.
- **All boxes together** (`isolate.slice`): `MemoryMax=1200M`, `CPUQuota=150%`, `TasksMax=512`. Exam bursts queue up instead of taking memory or CPU from the other apps.
- **Concurrency:** 2 jobs (`JUDGE_CONCURRENCY`); further requests queue, and the queue is capped at 100.

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
