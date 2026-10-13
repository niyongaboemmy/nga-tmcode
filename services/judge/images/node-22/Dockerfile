# Node.js 22 + esbuild + tsc: kinds js/express, ts/nest (runtimes node-22, typescript).
# Catalog paths: /opt/node-22/bin/{node,npm}, /opt/node-22/lib/node_modules/{esbuild,typescript}.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ARG NODE_VERSION=22.20.0
ARG ESBUILD_VERSION=0.28.2
ARG TYPESCRIPT_VERSION=5.9.2
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates curl xz-utils coreutils \
 && cd /tmp && f="node-v${NODE_VERSION}-linux-${NODEARCH}.tar.xz" \
 && fetch "https://nodejs.org/dist/v${NODE_VERSION}/$f" "$f" && fetch "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" SHASUMS256.txt \
 && check_sum sha256 "$f" "$(grep " $f\$" SHASUMS256.txt | cut -d' ' -f1)" \
 && mkdir -p "/opt/node-v${NODE_VERSION}" && tar -xJf "$f" -C "/opt/node-v${NODE_VERSION}" --strip-components=1 \
 && ln -s "/opt/node-v${NODE_VERSION}" /opt/node-22 \
 && PATH="/opt/node-22/bin:$PATH" npm install -g --silent --no-audit --no-fund "esbuild@${ESBUILD_VERSION}" "typescript@${TYPESCRIPT_VERSION}" \
 && rm -rf /tmp/* /root/.npm \
 && finish
ENV HOME=/box LANG=C.UTF-8 NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false NEXT_TELEMETRY_DISABLED=1
USER 10001:10001
WORKDIR /box
