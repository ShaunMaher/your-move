/**
 * The routing check's three requests (docs/deploy.md, "Check it"), with a stub `docker` on the
 * path, so no engine is needed. The real run is `tunnel-stack.test.ts`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/check-tunnel-routing.sh", import.meta.url));

// Records every `docker run` argv, one line each. The tunnel's route answers 202, the service name
// 400, and a host-network container whatever STUB_HOST_STATUS says (empty: it could not connect).
const DOCKER = `#!/bin/sh
case "$1" in
  compose) echo container-id ;;
  inspect) echo image ;;
  run)
    echo "$*" >> "$STUB_LOG"
    case "$*" in
      *"--network host"*) [ -n "$STUB_HOST_STATUS" ] || exit 1; echo "$STUB_HOST_STATUS" ;;
      *TARGET=http://app-front:8080*) echo 202 ;;
      *) echo 400 ;;
    esac ;;
esac
`;

describe("check-tunnel-routing.sh", () => {
  let dir = "";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "routing-script-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "docker"), DOCKER);
    chmodSync(join(dir, "bin", "docker"), 0o755);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(hostStatus: string) {
    const log = join(dir, "log");
    writeFileSync(log, "");
    const result = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        // The stub shadows the real docker; bash and the like come from the system.
        PATH: [join(dir, "bin"), "/usr/bin", "/bin"].join(delimiter),
        COMPOSE: "docker compose",
        PUBLIC_URL: "https://play.example.org",
        STUB_HOST_STATUS: hostStatus,
        STUB_LOG: log,
      },
    });
    return { status: result.status, out: result.stdout, calls: readFileSync(log, "utf8") };
  }

  it("passes when the host-network request is refused with 400", () => {
    const result = run("400");
    expect(result.status).toBe(0);
    expect(result.out).toMatch(/ok .*host-network container.* -> 400/u);
    expect(result.out).not.toContain("skip");
  });

  it("sends the host request from a container on the host network to the front address", () => {
    const hostCalls = run("400")
      .calls.split("\n")
      .filter((line) => line.includes("--network host"));
    expect(hostCalls).toHaveLength(1);
    expect(hostCalls[0]).toContain("TARGET=http://172.30.99.3:8080");
    expect(hostCalls[0]).toContain("--entrypoint node");
  });

  it.each([
    ["it is let through", "200"],
    ["it cannot connect", "000"],
    ["the container fails and prints nothing", ""],
  ])("fails when the host request is not refused: %s", (_name, status) => {
    const result = run(status);
    expect(result.status).toBe(1);
    expect(result.out).toMatch(/FAIL .*host-network container/u);
  });
});
