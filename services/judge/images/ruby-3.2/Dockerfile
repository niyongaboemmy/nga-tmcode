# Ruby 3.2 + Bundler: kinds ruby/sinatra, ruby/rails. Catalog paths: /usr/bin/ruby3.2, /usr/bin/bundle.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates coreutils ruby3.2 ruby-bundler libsqlite3-0 libpq5 \
 && { [ -e /usr/bin/bundle ] || ln -s bundle3.2 /usr/bin/bundle; } \
 && finish
ENV HOME=/box LANG=C.UTF-8 BUNDLE_DISABLE_SHARED_GEMS=1 BUNDLE_FROZEN=false GEM_SPEC_CACHE=/tmp/gem-spec
USER 10001:10001
WORKDIR /box
