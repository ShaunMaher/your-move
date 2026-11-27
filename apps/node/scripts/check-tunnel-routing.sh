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
# Check 3 is sent from the host with curl. Rootless Docker keeps its container networks inside
# rootlesskit's network namespace, which the host's own shell cannot reach, so there the same curl
# runs through `nsenter -U --preserve-credentials -n -t <pid>`, the pid being rootlesskit's child
# (`$XDG_RUNTIME_DIR/dockerd-rootless/child_pid`). A `--network host` container is no substitute: on
# rootless it sees the real host's interfaces. Nothing is skipped: if the namespace cannot be
# entered, check 3 fails.
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

# NSENTER_BIN is test-only: a single word naming the nsenter binary (default `nsenter`).
NSENTER_BIN="${NSENTER_BIN:-nsenter}"

# Succeeds when the engine lists the exact security option `name=rootless` (not a substring of
# another entry, such as a seccomp profile path).
is_rootless() {
  docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null | grep -qx 'name=rootless'
}

# Prints the status of the request to the app's `front` address, sent by `curl` run with the given
# command prefix (none on the host); prints 000 when it cannot connect.
host_request() {
  local status
  status="$("$@" curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --request POST --header 'content-type: application/json' --header "origin: $PUBLIC_URL" \
    --header 'cf-connecting-ip: 203.0.113.7' --data "$BODY" \
    "http://$APP_FRONT_ADDRESS:8080$PATH_UNDER_TEST" 2>/dev/null || true)"
  echo "${status:-000}"
}

description="the Docker host (front gateway) -> the app"
if is_rootless; then
  description="$description (via rootlesskit's namespace)"
  pid_file="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/dockerd-rootless/child_pid"
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    # An nsenter that cannot enter the namespace makes curl never run: that prints 000.
    check "$description" 400 "$(host_request "$NSENTER_BIN" -U --preserve-credentials -n -t "$pid")"
  else
    echo "FAIL $description -> 000 (wanted 400): $pid_file is missing or not a pid;" \
      "enter the namespace by hand: nsenter -U --preserve-credentials -n -t <rootlesskit child pid> curl ..."
    failed=1
  fi
else
  check "$description" 400 "$(host_request)"
fi
exit "$failed"
