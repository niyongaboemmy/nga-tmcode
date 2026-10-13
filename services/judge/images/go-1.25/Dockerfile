# Go 1.25 + gotestsum: kind go/web. Catalog paths: /opt/go/bin/go, /opt/go-tools/bin/gotestsum, /usr/bin/stdbuf.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ARG GO_VERSION=1.25.1
ARG GOTESTSUM_VERSION=v1.12.3
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates curl coreutils python3 gcc libc6-dev \
 && cd /tmp && f="go${GO_VERSION}.linux-${GOARCH}.tar.gz" \
 && fetch "https://go.dev/dl/$f" "$f" \
 && want="$(curl -fsSL 'https://go.dev/dl/?mode=json&include=all' | python3 -c "import json,sys; print(next(x['sha256'] for r in json.load(sys.stdin) for x in r['files'] if x['filename']=='$f'))")" \
 && check_sum sha256 "$f" "$want" \
 && mkdir -p /opt/go && tar -xzf "$f" -C /opt/go --strip-components=1 \
 && GOBIN=/opt/go-tools/bin GOPATH=/tmp/gopath GOCACHE=/tmp/gocache /opt/go/bin/go install "gotest.tools/gotestsum@${GOTESTSUM_VERSION}" \
 && rm -rf /tmp/* \
 && finish
ENV HOME=/box LANG=C.UTF-8 GOTOOLCHAIN=local GOFLAGS=-mod=mod GOCACHE=/tmp/go-build GOMAXPROCS=1
USER 10001:10001
WORKDIR /box
