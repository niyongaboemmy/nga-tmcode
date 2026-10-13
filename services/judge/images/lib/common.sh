# Shared by the runner images' RUN steps (sourced, POSIX sh). Multi-arch: amd64 and arm64
# (the Oracle Ampere A1 runner host is arm64). Every download is checksum-verified.
set -eu
ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  amd64) GOARCH=amd64; NODEARCH=x64; RUSTARCH=x86_64 ;;
  arm64) GOARCH=arm64; NODEARCH=arm64; RUSTARCH=aarch64 ;;
  *) echo "unsupported architecture $ARCH" >&2; exit 1 ;;
esac
export DEBIAN_FRONTEND=noninteractive

fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }

# check_sum <sha256|sha512|sha1> <file> <expected>
check_sum() {
  got="$("${1}sum" "$2" | cut -d' ' -f1)"
  if [ "$got" != "$3" ]; then echo "checksum mismatch for $2 ($1): $got != $3" >&2; exit 1; fi
}

apt_install() {
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "$@" >/dev/null
  rm -rf /var/lib/apt/lists/*
}

# The catalog names the amd64 JDK folder; on arm64 that path is a link to the real one.
jdk_alias() {
  if [ "$ARCH" != amd64 ] && [ ! -e /usr/lib/jvm/java-21-openjdk-amd64 ]; then
    ln -s "java-21-openjdk-$ARCH" /usr/lib/jvm/java-21-openjdk-amd64
  fi
}

# Mount points for the judge (the root file system is read-only at run time) and a
# readable, root-owned toolchain tree.
finish() {
  mkdir -p /box /caches
  chmod 0755 /box /caches
  [ ! -d /opt ] || chmod -R a+rX /opt
}
