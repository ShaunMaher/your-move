#!/bin/sh
# Installs the pinned mise release, verified against the SHA-256 committed below, then the
# requested tools at the versions and checksums in mise.lock (`mise install --locked`). Nothing
# is piped into a shell.
#
# Usage: scripts/ci/install-mise.sh TOOL...
# Then:  export PATH="$MISE_DATA_DIR/bin:$MISE_DATA_DIR/shims:$PATH"
#
# MISE_DATA_DIR must be set; CI points it inside the project directory so it can be cached.
set -eu

# Renovate updates the version; the checksums come from the release's SHASUMS256.txt.
# renovate: datasource=github-releases depName=jdx/mise
MISE_VERSION="v2026.11.12"
MISE_SHA256_X64="4b029e19afc575875a4962dfe5d5e31cc93ab0317242768d0234adec219d3e14"
MISE_SHA256_ARM64="9a125763f8445ea28d2da0e943fe5ad7d81b397d78f173cc07c1cc18ee2bee47"

case "$(uname -m)" in
  x86_64) arch=x64; sha="$MISE_SHA256_X64" ;;
  aarch64 | arm64) arch=arm64; sha="$MISE_SHA256_ARM64" ;;
  *) echo "install-mise: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
bin="$MISE_DATA_DIR/bin"
stamp="$bin/.mise-$MISE_VERSION-$sha"

if [ ! -f "$stamp" ]; then
  tmp="$(mktemp -d)"
  "$here/fetch-verified.sh" \
    "https://github.com/jdx/mise/releases/download/$MISE_VERSION/mise-$MISE_VERSION-linux-$arch.tar.gz" \
    "$sha" "$tmp/mise.tar.gz"
  tar -xzf "$tmp/mise.tar.gz" -C "$tmp"
  mkdir -p "$bin"
  rm -f "$bin"/.mise-*
  cp "$tmp/mise/bin/mise" "$bin/mise"
  touch "$stamp"
  rm -rf "$tmp"
fi

export PATH="$bin:$MISE_DATA_DIR/shims:$PATH"
mise trust --quiet "$root/mise.toml"
mise install --locked "$@"
