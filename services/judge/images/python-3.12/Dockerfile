# Python 3.12 + uv: kinds python/flask, python/fastapi, python/django (and PTY/database runs of python/*).
# Catalog paths: /usr/bin/python3 (the python3 package links it to 3.12 here), /opt/uv/uv.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ARG UV_VERSION=0.8.22
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates curl coreutils python3 python3.12 python3.12-venv libpq5 \
 && cd /tmp && f="uv-${RUSTARCH}-unknown-linux-gnu.tar.gz" && base="https://github.com/astral-sh/uv/releases/download/${UV_VERSION}" \
 && fetch "$base/$f" "$f" && fetch "$base/$f.sha256" "$f.sha256" && check_sum sha256 "$f" "$(cut -d' ' -f1 "$f.sha256")" \
 && mkdir -p /opt/uv && tar -xzf "$f" -C /opt/uv --strip-components=1 \
 && rm -rf /tmp/* \
 && finish
ENV HOME=/box LANG=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 PIP_NO_INDEX=1 UV_OFFLINE=1
USER 10001:10001
WORKDIR /box
