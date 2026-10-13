# PostgreSQL 16 client: kind sql/postgres runs psql against the per-run postgres:16 sidecar.
# Catalog path: /usr/bin/psql.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates coreutils postgresql-client-16 \
 && finish
ENV HOME=/box LANG=C.UTF-8 PSQL_HISTORY=/dev/null
USER 10001:10001
WORKDIR /box
