/**
 * The routing check's rootless handling (docs/deploy.md, "Check it"), with stub `docker`, `curl`
 * and `nsenter` commands on the path, so no engine is needed. The real run is `tunnel-stack.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/check-tunnel-routing.sh", import.meta.url));

// `docker run` prints 202 for the tunnel's route and 400 for the service name.
const DOCKER = `#!/bin/sh
case "$1" in
  compose) echo container-id ;;
  inspect) echo image ;;
  info) echo "$STUB_SECURITY_OPTIONS" ;;
  run) case "$*" in *TARGET=http://app-front:8080*) echo 202 ;; *) echo 400 ;; esac ;;
esac
`;
const CURL = `#!/bin/sh
echo "$STUB_HOST_STATUS"
`;
// Stands in for entering rootlesskit's namespace: runs the rest, or refuses like a restricted kernel.
const NSENTER = `#!/bin/sh
while [ "$1" != "--target" ]; do shift; done
[ -z "$STUB_NSENTER_REFUSES" ] || exit 1
shift 2
exec "$@"
`;

describe("check-tunnel-routing.sh on rootless and rootful Docker", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "routing-script-"));
    mkdirSync(join(dir, "bin"));
    for (const [name, body] of Object.entries({ docker: DOCKER, curl: CURL, nsenter: NSENTER })) {
      writeFileSync(join(dir, "bin", name), body);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    writeFileSync(join(dir, "docker.pid"), "4242\n");
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(options: {
    security: string;
    host: string;
    nsenter?: boolean;
    pid?: boolean;
    refuse?: boolean;
  }) {
    const result = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        // The stubs shadow the real commands; bash, cat, id and the like come from the system.
        PATH: [join(dir, "bin"), "/usr/bin", "/bin"].join(delimiter),
        COMPOSE: "docker compose",
        NSENTER: options.nsenter === false ? "no-such-nsenter" : "nsenter",
        PUBLIC_URL: "https://play.example.org",
        XDG_RUNTIME_DIR: options.pid === false ? join(dir, "none") : dir,
        STUB_SECURITY_OPTIONS: options.security,
        STUB_HOST_STATUS: options.host,
        STUB_NSENTER_REFUSES: options.refuse === true ? "1" : "",
      },
    });
    return { status: result.status, out: result.stdout };
  }

  it("checks from the host on rootful Docker, and fails when the host is not refused", () => {
    const good = run({ security: "[name=seccomp,profile=builtin]", host: "400" });
    expect(good.status).toBe(0);
    expect(good.out).toMatch(/ok .*Docker host.* -> 400/u);
    const bad = run({ security: "[name=seccomp,profile=builtin]", host: "000" });
    expect(bad.status).toBe(1);
    expect(bad.out).toMatch(/FAIL .*Docker host.* -> 000/u);
  });

  it("checks from rootlesskit's namespace on rootless Docker", () => {
    const result = run({ security: "[name=seccomp name=rootless]", host: "400" });
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/ok .*Docker host.*rootlesskit.* -> 400/u);
  });

  it.each([
    ["nsenter is missing", { nsenter: false }],
    ["the daemon's pid file is missing", { pid: false }],
    ["the kernel refuses the namespace", { refuse: true }],
  ])("skips check 3 and still passes when %s", (_name, options) => {
    const result = run({ security: "[name=rootless]", host: "000", ...options });
    expect(result.status).toBe(0);
    expect(result.out).toContain("skipped on rootless: the host cannot reach container networks");
    expect(result.out).not.toContain("FAIL");
  });
});
