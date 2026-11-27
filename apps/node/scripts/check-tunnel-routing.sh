#!/usr/bin/env bash
# Proves the tunnel compose file's routing on a running stack (docs/deploy.md, "Check it"; 09 §4):
#
#   1. a request that arrives the way the tunnel's does -- from cloudflared's own network
#      namespace, to the origin hostname `app-front:8080`, with CF-Connecting-IP -- succeeds (any
#      2xx status);
#   2. the same request to `app:8080`, the name Docker resolves to the app's `egress` address,
#      is refused with 400 (the mistake the alias exists to prevent);
#   3. a request from the Docker host (its gateway address on `front`) is refused with 400.
#
# Check 3 is sent from a container on the host network, which is the namespace that holds the
# `front` gateway address on both rootful and rootless engines (rootless keeps its container
# networks inside rootlesskit's namespace, where the host's own shell cannot reach them).
#
# Assumptions: paths without spaces (the commands are word-split); a Linux host with a native
# Docker engine (the host-network container reaches the `front` gateway address directly, which
# Docker Desktop's VM does not allow); a status of `000` means the request could not connect at all, and
# is never a pass.
#
# Usage: COMPOSE="docker compose -f apps/node/docker-compose.tunnel.yml --env-file <file>" \
#        PUBLIC_URL=https://<hostname> apps/node/scripts/check-tunnel-routing.sh
# The stack must be up. It posts one sign-in request for an address that doesn't exist, so one
# email attempt is made.
set -euo pipefail

: "${COMPOSE:?set COMPOSE to the docker compose command line (file and --env-file) of the running stack}"
: "${PUBLIC_URL:?set PUBLIC_URL to the origin of the instance}"
APP_FRONT_ADDRESS="${APP_FRONT_ADDRESS:-172.30.99.3}"
PATH_UNDER_TEST="/api/v1/auth/otp/request"
BODY='{"email":"routing-check@example.invalid"}'

tunnel_container="$($COMPOSE ps -q cloudflared)"
app_container="$($COMPOSE ps -q app)"
[ -n "$tunnel_container" ] && [ -n "$app_container" ] || { echo "the stack is not up" >&2; exit 2; }
image="$(docker inspect --format '{{.Config.Image}}' "$app_container")"

# Sends the request from inside the given network namespace (`container:<id>` or `host`) with the
# app image's Node (the tunnel image has no shell or client of its own); prints the HTTP status.
send_from() {
  docker run --rm --network "$1" --entrypoint node \
    -e "TARGET=$2" -e "PUBLIC_URL=$PUBLIC_URL" -e "PATH_UNDER_TEST=$PATH_UNDER_TEST" -e "BODY=$BODY" \
    "$image" -e '
      fetch(process.env.TARGET + process.env.PATH_UNDER_TEST, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: process.env.PUBLIC_URL,
          "cf-connecting-ip": "203.0.113.7",
        },
        body: process.env.BODY,
      }).then((r) => console.log(r.status), (e) => { console.error(String(e)); process.exit(1); });
    '
}

failed=0
# check <description> <400|2xx> <status>
check() {
  local good=0
  case "$2:$3" in
    400:400 | 2xx:2[0-9][0-9]) good=1 ;;
  esac
  if [ "$good" = 1 ]; then
    echo "ok   $1 -> $3 (wanted $2)"
  else
    echo "FAIL $1 -> $3 (wanted $2)"
    failed=1
  fi
}

from_tunnel() { send_from "container:$tunnel_container" "$1"; }
check "cloudflared -> http://app-front:8080 (the tunnel's route)" 2xx "$(from_tunnel http://app-front:8080)"
check "cloudflared -> http://app:8080 (its egress address: must be refused)" 400 "$(from_tunnel http://app:8080)"
# A connection that fails prints nothing; it is reported as 000, which is never a pass.
host_status="$(send_from host "http://$APP_FRONT_ADDRESS:8080" 2>/dev/null || true)"
check "a host-network container (the Docker host) -> http://$APP_FRONT_ADDRESS:8080 (front gateway)" 400 "${host_status:-000}"
exit "$failed"
