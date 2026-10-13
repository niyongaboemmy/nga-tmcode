# Rust (rustup minimal, one pinned toolchain): kind rust/web. Catalog paths: /opt/rust/bin/{rustc,cargo}
# (/opt/rust is the toolchain itself: real binaries, no rustup proxies), /usr/bin/stdbuf.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ARG RUST_VERSION=1.90.0
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates curl coreutils gcc libc6-dev \
 && cd /tmp && base="https://static.rust-lang.org/rustup/dist/${RUSTARCH}-unknown-linux-gnu" \
 && fetch "$base/rustup-init" rustup-init && fetch "$base/rustup-init.sha256" rustup-init.sha256 \
 && check_sum sha256 rustup-init "$(cut -d' ' -f1 rustup-init.sha256)" && chmod +x rustup-init \
 && RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo ./rustup-init -y -q --no-modify-path --profile minimal --default-toolchain "${RUST_VERSION}" \
 && ln -s "/opt/rustup/toolchains/${RUST_VERSION}-${RUSTARCH}-unknown-linux-gnu" /opt/rust \
 && rm -rf /tmp/* \
 && finish
ENV HOME=/box LANG=C.UTF-8 CARGO_HOME=/tmp/cargo CARGO_TARGET_DIR=/box/target CARGO_BUILD_JOBS=2
USER 10001:10001
WORKDIR /box
