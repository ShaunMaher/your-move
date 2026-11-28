/**
 * The routing check's three requests (docs/deploy.md, "Check it"), with a stub `docker` on the
 * path, so no engine is needed. The real run is `tunnel-stack.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/check-tunnel-routing.sh", import.meta.url));
// The stubs must be executable, and CI's TMPDIR is /dev/shm, which Docker mounts noexec (126 on
// every stub). So they live in the package's own ignored cache directory instead.
const STUB_ROOT = fileURLToPath(new URL("../node_modules/.cache/", import.meta.url));

// `docker run` answers 202 for the tunnel's route and 400 for the service name; `docker info`
// lists STUB_SECURITY_OPTIONS (one entry per line); the host's curl answers STUB_HOST_STATUS and
// records its argv, as does nsenter (which then runs what follows the pid).
const DOCKER = `#!/bin/sh
case "$1" in
  compose) echo container-id ;;
  inspect) echo image ;;
  info) printf '%s\\n' $STUB_SECURITY_OPTIONS ;;
  run) case "$*" in *TARGET=http://app-front:8080*) echo 202 ;; *) echo 400 ;; esac ;;
esac
`;
const CURL = `#!/bin/sh
echo "curl" >> "$STUB_LOG"
[ -n "$STUB_HOST_STATUS" ] || exit 7
printf '%s' "$STUB_HOST_STATUS"
`;
const NSENTER = `#!/bin/sh
echo "nsenter $*" >> "$STUB_LOG"
[ -z "$STUB_NSENTER_REFUSES" ] || exit 1
while [ "$1" != "-t" ]; do shift; done
shift 2
exec "$@"
`;

const ROOTFUL = "name=seccomp,profile=builtin name=cgroupns";
const ROOTLESS = "name=seccomp,profile=builtin name=rootless name=cgroupns";

describe("check-tunnel-routing.sh", () => {
  let dir = "";

  beforeAll(() => {
    mkdirSync(STUB_ROOT, { recursive: true });
    dir = mkdtempSync(join(STUB_ROOT, "routing-script-"));
    mkdirSync(join(dir, "bin"));
    for (const [name, body] of Object.entries({ docker: DOCKER, curl: CURL, nsenter: NSENTER })) {
      writeFileSync(join(dir, "bin", name), body);
      chmodSync(join(dir, "bin", name), 0o755);
    }
    mkdirSync(join(dir, "dockerd-rootless"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(options: {
    security: string;
    host: string;
    pid?: string | null;
    nsenterRefuses?: boolean;
  }) {
    const log = join(dir, "log");
    const pidFile = join(dir, "dockerd-rootless", "child_pid");
    writeFileSync(log, "");
    rmSync(pidFile, { force: true });
    if (options.pid !== null) writeFileSync(pidFile, `${options.pid ?? "4242"}\n`);
    const result = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        // The stubs shadow the real commands; bash and the like come from the system.
        PATH: [join(dir, "bin"), "/usr/bin", "/bin"].join(delimiter),
        COMPOSE: "docker compose",
        PUBLIC_URL: "https://play.example.org",
        XDG_RUNTIME_DIR: dir,
        STUB_SECURITY_OPTIONS: options.security,
        STUB_HOST_STATUS: options.host,
        STUB_NSENTER_REFUSES: options.nsenterRefuses === true ? "1" : "",
        STUB_LOG: log,
      },
    });
    return {
      status: result.status,
      out: result.stdout,
      calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
    };
  }

  describe("rootful", () => {
    it("sends check 3 from the host and passes on 400", () => {
      const result = run({ security: ROOTFUL, host: "400" });
      expect(result.status).toBe(0);
      expect(result.out).toMatch(/ok .*Docker host \(front gateway\) -> the app -> 400/u);
      expect(result.calls).toEqual(["curl"]);
    });

    it("fails on 000, and on 200", () => {
      for (const host of ["000", "200", ""]) {
        const result = run({ security: ROOTFUL, host });
        expect(result.status).toBe(1);
        expect(result.out).toMatch(/FAIL .*Docker host/u);
      }
    });

    it("is not fooled by a security option that merely contains the word rootless", () => {
      const result = run({
        security: "name=seccomp,profile=/x/rootless.json name=cgroupns",
        host: "400",
      });
      expect(result.status).toBe(0);
      expect(result.calls).toEqual(["curl"]);
      expect(result.out).not.toContain("rootlesskit");
    });
  });

  describe("rootless", () => {
    it("sends check 3 through nsenter into rootlesskit's namespace and passes on 400", () => {
      const result = run({ security: ROOTLESS, host: "400" });
      expect(result.status).toBe(0);
      expect(result.out).toMatch(/ok .*Docker host.*via rootlesskit's namespace\) -> 400/u);
      expect(result.calls).toHaveLength(2);
      expect(result.calls[0]).toMatch(/^nsenter -U --preserve-credentials -n -t 4242 curl /u);
      expect(result.calls[1]).toBe("curl");
    });

    it.each(["000", "200"])("fails when the request answers %s", (host) => {
      const result = run({ security: ROOTLESS, host });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/FAIL .*via rootlesskit's namespace/u);
    });

    it("fails, never skips, when nsenter cannot enter the namespace", () => {
      const result = run({ security: ROOTLESS, host: "400", nsenterRefuses: true });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/FAIL .*via rootlesskit's namespace\) -> 000/u);
      expect(result.out).not.toContain("skip");
    });

    it.each([
      ["missing", null],
      ["not a pid", "abc"],
      ["zero", "0"],
    ])("fails with a hint when the pid file is %s", (_name, pid) => {
      const result = run({ security: ROOTLESS, host: "400", pid });
      expect(result.status).toBe(1);
      expect(result.out).toMatch(/FAIL .*child_pid.*nsenter -U/u);
      expect(result.calls).toEqual([]);
    });
  });
});
