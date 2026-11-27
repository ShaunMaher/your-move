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
# Rootless Docker keeps its container networks inside rootlesskit's network namespace, so the host
# itself cannot reach the `front` gateway at all (a stricter result than the check wants). There,
# check 3 is sent from inside that namespace (`nsenter` on the daemon's pid in
# `$XDG_RUNTIME_DIR/docker.pid`); if that is not possible it is reported as skipped, and the script
# exits 0 only when checks 1 and 2 passed.
#
# Assumptions: paths without spaces (the commands are word-split); a Linux host with a native
# Docker engine (the host check reaches the `front` gateway address directly, which Docker
# Desktop's VM does not allow); a status of `000` means the request could not connect at all, and
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
NSENTER="${NSENTER:-nsenter}"
PATH_UNDER_TEST="/api/v1/auth/otp/request"
BODY='{"email":"routing-check@example.invalid"}'

tunnel_container="$($COMPOSE ps -q cloudflared)"
app_container="$($COMPOSE ps -q app)"
[ -n "$tunnel_container" ] && [ -n "$app_container" ] || { echo "the stack is not up" >&2; exit 2; }
image="$(docker inspect --format '{{.Config.Image}}' "$app_container")"

# Sends the request from inside cloudflared's network namespace with the app image's Node (the
# tunnel image has no shell or client of its own); prints the HTTP status.
from_tunnel() {
  docker run --rm --network "container:$tunnel_container" --entrypoint node \
    -e "TARGET=$1" -e "PUBLIC_URL=$PUBLIC_URL" -e "PATH_UNDER_TEST=$PATH_UNDER_TEST" -e "BODY=$BODY" \
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

check "cloudflared -> http://app-front:8080 (the tunnel's route)" 2xx "$(from_tunnel http://app-front:8080)"
check "cloudflared -> http://app:8080 (its egress address: must be refused)" 400 "$(from_tunnel http://app:8080)"

# Succeeds when the Docker engine is rootless.
is_rootless() {
  case "$(docker info --format '{{.SecurityOptions}}' 2>/dev/null || true)" in
    *rootless*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints the status of the host-style request to the app's `front` address. Arguments are the
# command prefix that runs curl (empty on the host, `nsenter ...` on rootless).
host_request() {
  "$@" curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --request POST --header 'content-type: application/json' --header "origin: $PUBLIC_URL" \
    --header 'cf-connecting-ip: 203.0.113.7' --data "$BODY" \
    "http://$APP_FRONT_ADDRESS:8080$PATH_UNDER_TEST" || true
}

description="the Docker host (front gateway) -> the app"
if is_rootless; then
  pid_file="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.pid"
  enter=("$NSENTER" --user --preserve-credentials --net --target "$(cat "$pid_file" 2>/dev/null || true)")
  # Entering a namespace can be refused (no nsenter, no pid file, a restricted kernel): that is a
  # skip, never a failure, and never a pass.
  if [ -r "$pid_file" ] && command -v "$NSENTER" >/dev/null 2>&1 && "${enter[@]}" true >/dev/null 2>&1; then
    check "$description (from rootlesskit's namespace)" 400 "$(host_request "${enter[@]}")"
  else
    echo "skip $description: skipped on rootless: the host cannot reach container networks (stricter)"
  fi
else
  check "$description" 400 "$(host_request)"
fi
exit "$failed"
