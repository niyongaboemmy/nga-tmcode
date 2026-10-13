# PHP 8.3 + Composer: kinds php/web, php/laravel. Catalog paths: /usr/bin/php8.3, /usr/bin/composer.
# pdo_pgsql / pdo_mysql for per-run databases.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates coreutils php8.3-cli php8.3-mbstring php8.3-xml php8.3-sqlite3 php8.3-intl php8.3-zip \
      php8.3-pgsql php8.3-mysql php8.3-curl composer unzip \
 && finish
ENV HOME=/box LANG=C.UTF-8 COMPOSER_DISABLE_NETWORK=1 COMPOSER_HOME=/tmp/composer
USER 10001:10001
WORKDIR /box
