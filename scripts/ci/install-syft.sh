#!/bin/sh
# Installs syft into DIR from the URL and SHA-256 recorded in mise.lock, for images without mise
# or Node (the kaniko build job after `--cleanup`, which has busybox only). Scripts are run with
# `sh`, because `--cleanup` also removes /bin, so a `#!/bin/sh` line finds no interpreter.
#
# Usage: install-syft.sh DIR
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
case "$(uname -m)" in
  x86_64) platform=linux-x64 ;;
  aarch64 | arm64) platform=linux-arm64 ;;
  *) echo "install-syft: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# The [tools.syft."platforms.<platform>"] table of mise.lock: its checksum and url lines.
entry="$(awk -v section="[tools.syft.\"platforms.$platform\"]" '
  $0 == section { inside = 1; next }
  /^\[/ { inside = 0 }
  inside && /^(checksum|url) = / { print }
' "$here/../../mise.lock")"
url="$(printf '%s\n' "$entry" | sed -n 's/^url = "\(.*\)"$/\1/p')"
sha="$(printf '%s\n' "$entry" | sed -n 's/^checksum = "sha256:\(.*\)"$/\1/p')"
if [ -z "$url" ] || [ -z "$sha" ]; then
  echo "install-syft: no syft entry for $platform in mise.lock" >&2
  exit 1
fi

mkdir -p "$1"
sh "$here/fetch-verified.sh" "$url" "$sha" "$1/syft.tar.gz"
tar -xzf "$1/syft.tar.gz" -C "$1" syft
rm -f "$1/syft.tar.gz"
