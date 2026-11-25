/**
 * The tunnel compose stack, run for real (docs/deploy.md, "Check it"): proves that a request
 * arriving the way the tunnel's does -- from `cloudflared`'s network namespace, to the documented
 * origin `app-front:8080` -- gets past the trusted-peer check, that the service name does not, and
 * that the Docker host does not (A5-S-1, A5-S-2).
 *
 * Needs a local Docker engine and the app image, so it runs only when `TUNNEL_STACK_IMAGE` names
 * one (a locally built `docker build -f apps/node/Dockerfile .`); CI's tests do not have Docker.
 * `cloudflared` is replaced by a stand-in with the same networks and pinned address, so nothing
 * contacts Cloudflare, and Google's hosts resolve to loopback, so nothing contacts Google.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const image = process.env["TUNNEL_STACK_IMAGE"];
const COMPOSE_FILE = fileURLToPath(new URL("../docker-compose.tunnel.yml", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/check-tunnel-routing.sh", import.meta.url));
const PROJECT = "ym-tunnel-routing-test";
const PUBLIC_URL = "https://play.example.org";
const BUDGET_MS = 180_000;

describe.skipIf(image === undefined)("the tunnel stack, running", () => {
  let dir = "";
  let compose: string[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tunnel-stack-"));
    const secrets = join(dir, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    for (const name of [
      "app_secret",
      "gmail_client_id",
      "gmail_client_secret",
      "gmail_refresh_token",
      "tunnel_token",
    ]) {
      const file = join(secrets, name);
      writeFileSync(
        file,
        name === "app_secret" ? btoa("tunnel-stack-test-0123456789abcdef") : "dummy",
      );
      chmodSync(file, 0o444);
    }
    writeFileSync(
      join(dir, "env"),
      [
        `APP_IMAGE=${image ?? ""}`,
        `SECRETS_DIR=${secrets}`,
        `PUBLIC_URL=${PUBLIC_URL}`,
        "OPERATOR_CONTACT=ops@example.org",
        `EMAIL_FROM='"Example Games" <no-reply@example.org>'`,
        "GMAIL_SENDER=no-reply@example.org",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "override.yml"),
      [
        "services:",
        "  app:",
        "    extra_hosts: ['oauth2.googleapis.com:127.0.0.1', 'gmail.googleapis.com:127.0.0.1']",
        "  cloudflared:",
        `    image: ${image ?? ""}`,
        '    entrypoint: ["sleep", "100000"]',
        "    command: !reset []",
        "    healthcheck: !reset {}",
        "    secrets: !reset []",
        "",
      ].join("\n"),
    );
    compose = [
      "compose",
      "-p",
      PROJECT,
      "-f",
      COMPOSE_FILE,
      "-f",
      join(dir, "override.yml"),
      "--env-file",
      join(dir, "env"),
    ];
    execFileSync("docker", [...compose, "up", "-d", "--wait", "app"], { stdio: "pipe" });
    execFileSync("docker", [...compose, "up", "-d"], { stdio: "pipe" });
  }, BUDGET_MS);

  afterAll(() => {
    if (compose.length > 0) {
      execFileSync("docker", [...compose, "down", "-v", "--remove-orphans"], { stdio: "pipe" });
    }
    rmSync(dir, { recursive: true, force: true });
  }, BUDGET_MS);

  it(
    "lets the tunnel's route through, refuses the service name and the host",
    () => {
      const output = execFileSync("bash", [SCRIPT], {
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSE: `docker ${compose.join(" ")}`,
          PUBLIC_URL,
        },
      });
      expect(output).toMatch(/ok .*app-front:8080.* -> 202/u);
      expect(output).toMatch(/ok .*http:\/\/app:8080.* -> 400/u);
      expect(output).toMatch(/ok .*Docker host.* -> 400/u);
      expect(output).not.toContain("FAIL");
    },
    BUDGET_MS,
  );
});
