# Flutter 3 (+ its Dart SDK): kind flutter/app (widget tests), runtimes flutter-3 and dart-3.
# Linux arm64 hosts are supported from a git checkout (there is no arm64 release archive), so both
# architectures clone the pinned tag; the first `flutter` run downloads the matching Dart SDK and
# engine artefacts, and a warm-up `flutter test` fetches flutter_tester, so boxes need no network.
# The SDK is read-only at run time, so the tool's lock file is a link to the /tmp tmpfs.
# Catalog paths: /opt/flutter/bin/flutter, /usr/lib/dart/bin/dart (a link into Flutter's Dart SDK).
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ARG FLUTTER_VERSION=3.29.3
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates curl git unzip xz-utils zip coreutils libglu1-mesa \
 && git clone -q --depth 1 --branch "${FLUTTER_VERSION}" https://github.com/flutter/flutter.git /opt/flutter \
 && export PATH="/opt/flutter/bin:$PATH" HOME=/tmp/warm-home \
 && flutter config --no-analytics >/dev/null && flutter --disable-analytics >/dev/null \
 && flutter precache --no-android --no-ios --no-web --no-linux --no-windows --no-macos --no-fuchsia --universal \
 && flutter create -q /tmp/warm && (cd /tmp/warm && flutter test >/dev/null) \
 && ln -s /opt/flutter/bin/cache/dart-sdk /usr/lib/dart \
 && rm -f /opt/flutter/bin/cache/lockfile && ln -s /tmp/flutter-lockfile /opt/flutter/bin/cache/lockfile \
 && git config --system --add safe.directory /opt/flutter \
 && rm -rf /tmp/warm /tmp/warm-home \
 && finish
ENV HOME=/box LANG=C.UTF-8 FLUTTER_SUPPRESS_ANALYTICS=true DART_SUPPRESS_ANALYTICS=true PUB_ENVIRONMENT=nga-runner
USER 10001:10001
WORKDIR /box
