#!/bin/sh
# Downloads URL to OUT and fails unless its SHA-256 equals EXPECTED (a value committed in this
# repository). Works with curl, wget (busybox included) or Node, whichever the image has; the
# checksum, not the transport, is what makes the download trustworthy.
#
# Usage: fetch-verified.sh URL EXPECTED_SHA256 OUT
set -eu

url="$1"
expected="$2"
out="$3"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 -o "$out" "$url"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$out" "$url"
else
  node -e '
    const [url, out] = process.argv.slice(1);
    fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.arrayBuffer(); })
      .then((b) => require("node:fs").writeFileSync(out, Buffer.from(b)))
      .catch((e) => { console.error(e.message); process.exit(1); });
  ' "$url" "$out"
fi

actual="$(sha256sum "$out" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "fetch-verified: SHA-256 mismatch for $url" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  rm -f "$out"
  exit 1
fi
