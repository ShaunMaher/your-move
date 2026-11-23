#!/bin/sh
# Installs the pinned mise release, verified against the SHA-256 committed below, then the
# requested tools at the versions and checksums in mise.lock (`mise install --locked`). Nothing
# is piped into a shell.
#
# Usage: scripts/ci/install-mise.sh TOOL...
# Then:  export PATH="$MISE_DATA_DIR/bin:$MISE_DATA_DIR/shims:$PATH"
#
# MISE_DATA_DIR must be set; CI points it inside the project directory so it can be cached. The
# release archive is kept there too, and its SHA-256 is checked on every run, not only when it is
# downloaded: the binary is always unpacked afresh from a verified archive, so a cached copy that
# was tampered with is never run.
set -eu

# Renovate updates the version (in its own group, renovate.json); the checksums must be updated
# by hand from the release's SHASUMS256.txt, preferring its signed copy (ADR 0003).
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
archive="$MISE_DATA_DIR/downloads/mise-$MISE_VERSION-linux-$arch.tar.gz"

mkdir -p "$MISE_DATA_DIR/downloads" "$bin"
if [ -f "$archive" ] && [ "$(sha256sum "$archive" | cut -d' ' -f1)" = "$sha" ]; then
  echo "install-mise: cached $MISE_VERSION archive verified"
else
  rm -f "$MISE_DATA_DIR"/downloads/mise-*.tar.gz
  "$here/fetch-verified.sh" \
    "https://github.com/jdx/mise/releases/download/$MISE_VERSION/mise-$MISE_VERSION-linux-$arch.tar.gz" \
    "$sha" "$archive"
fi
tmp="$(mktemp -d)"
tar -xzf "$archive" -C "$tmp"
cp "$tmp/mise/bin/mise" "$bin/mise"
rm -rf "$tmp"

export PATH="$bin:$MISE_DATA_DIR/shims:$PATH"
mise trust --quiet "$root/mise.toml"
if ! mise install --locked "$@"; then
  cat >&2 <<'EOF'
install-mise: `mise install --locked` failed. If mise.toml changed (a tool added or bumped) and
mise.lock wasn't refreshed with it, run this in the repository, then commit mise.lock:
    mise lock --platform linux-x64,linux-arm64
EOF
  exit 1
fi
