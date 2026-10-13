# MySQL client: kind sql/mysql runs `mysql --table` against the per-run mysql:8.4 sidecar.
# Ubuntu 24.04 ships the 8.0 client, which speaks to 8.4 servers (caching_sha2_password). Catalog path: /usr/bin/mysql.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates coreutils mysql-client \
 && finish
ENV HOME=/box LANG=C.UTF-8 MYSQL_HISTFILE=/dev/null
USER 10001:10001
WORKDIR /box
