/**
 * Acceptance tests for the Cloudflare Tunnel deployment (docs/spec/09-operations.md §4, 08 §4.1,
 * 10 M4): what `docker-compose.tunnel.yml` declares, checked as data, and what the app does with
 * the proxy settings it declares. The image and the running stack are checked by hand (docs/deploy.md).
 */
import { readFileSync } from "node:fs";

import { parseConfig, SECRET_VARIABLES } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { resolveSecretFiles } from "./env.js";
import { parseNodeConfig } from "./node-config.js";
import { createHarness, type Harness, PROD_ENV } from "./test-harness.js";

const FILE = new URL("../docker-compose.tunnel.yml", import.meta.url);
const text = readFileSync(FILE, "utf8");

interface Service {
  image: string;
  environment?: Record<string, string>;
  secrets?: string[];
  networks?: Record<string, { aliases?: string[]; ipv4_address?: string } | null>;
  logging?: { driver?: string; options?: Record<string, string> };
  pids_limit?: number;
  mem_limit?: string;
  ports?: unknown;
  expose?: unknown;
  network_mode?: string;
  read_only?: boolean;
  cap_drop?: string[];
  volumes?: string[];
  command?: string;
}
const compose = parse(text) as {
  services: Record<string, Service>;
  networks: Record<string, { internal?: boolean; ipam?: { config: { subnet: string }[] } }>;
  secrets: Record<string, { file: string }>;
};
const app = compose.services["app"]!;
const tunnel = compose.services["cloudflared"]!;
const SUBNET = "172.30.99.0/28";
const TUNNEL_ADDRESS = "172.30.99.2";
const ORIGIN_HOST = "app-front";

describe("docker-compose.tunnel.yml (09 §4)", () => {
  it("is exactly the app and cloudflared", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["app", "cloudflared"]);
  });

  it("publishes no port and uses no host network", () => {
    expect(text).not.toMatch(/^\s*ports:/mu);
    for (const service of [app, tunnel]) {
      expect(service.ports).toBeUndefined();
      expect(service.network_mode).toBeUndefined();
    }
  });

  it("keeps the app's port on an internal `front` network with a pinned subnet", () => {
    expect(compose.networks["front"]?.internal).toBe(true);
    expect(compose.networks["front"]?.ipam?.config).toEqual([{ subnet: SUBNET }]);
    expect(compose.networks["egress"]?.internal).not.toBe(true);
    // Both reach each other over `front`; both go out over `egress` (Gmail; the tunnel).
    expect(Object.keys(app.networks ?? {}).sort()).toEqual(["egress", "front"]);
    expect(Object.keys(tunnel.networks ?? {}).sort()).toEqual(["egress", "front"]);
    expect(Object.keys(compose.networks).sort()).toEqual(["egress", "front"]);
  });

  it("gives the app a front-only alias and pins both addresses on `front` (A5-S-1, A5-S-2)", () => {
    // The tunnel's origin is the alias, which Docker resolves only on `front`; the service name
    // `app` also resolves on `egress`, a peer outside TRUST_PROXY_PEERS.
    expect(app.networks?.["front"]?.aliases).toEqual([ORIGIN_HOST]);
    expect(app.networks?.["egress"]?.aliases).toBeUndefined();
    expect(tunnel.networks?.["front"]?.aliases).toBeUndefined();
    expect(tunnel.networks?.["front"]?.ipv4_address).toBe(TUNNEL_ADDRESS);
    expect(app.networks?.["front"]?.ipv4_address).toBe("172.30.99.3");
    for (const service of [app, tunnel]) {
      expect(service.networks?.["egress"]?.ipv4_address).toBeUndefined();
      const address = service.networks?.["front"]?.ipv4_address ?? "";
      expect(address.startsWith("172.30.99.")).toBe(true);
    }
    // The documented origin is exactly that alias, in the file's comments and in the docs.
    const deploy = readFileSync(new URL("../../../docs/deploy.md", import.meta.url), "utf8");
    for (const document of [text, deploy]) {
      expect(document).toContain(`http://${ORIGIN_HOST}:8080`);
    }
    expect(deploy).not.toMatch(/URL `app:8080`/u);
  });

  it("trusts exactly cloudflared's pinned address plus loopback, behind Cloudflare (A5-S-2)", () => {
    expect(app.environment?.["TRUST_PROXY"]).toBe("cloudflare");
    expect(app.environment?.["TRUST_PROXY_PEERS"]?.split(",").sort()).toEqual(
      [`${TUNNEL_ADDRESS}/32`, "127.0.0.0/8", "::1/128"].sort(),
    );
  });

  it("bounds both containers' logs, processes and memory (A5-S-10)", () => {
    for (const service of [app, tunnel]) {
      expect(service.logging?.driver).toBe("json-file");
      expect(service.logging?.options?.["max-size"]).toMatch(/^\d+m$/u);
      expect(Number(service.logging?.options?.["max-file"])).toBeGreaterThan(0);
      expect(service.pids_limit).toBeGreaterThan(0);
      expect(service.mem_limit).toMatch(/^\d+m$/u);
    }
  });

  it("gives every secret as a file mounted as a Docker secret, and none in the environment", () => {
    const mounted = new Set(app.secrets);
    for (const [name, value] of Object.entries(app.environment ?? {})) {
      expect(SECRET_VARIABLES as readonly string[]).not.toContain(name);
      if (!name.endsWith("_FILE")) continue;
      expect(SECRET_VARIABLES as readonly string[]).toContain(name.slice(0, -"_FILE".length));
      const secret = /^\/run\/secrets\/(\w+)$/u.exec(value)?.[1];
      expect(secret).toBeDefined();
      expect(mounted.has(secret ?? "")).toBe(true);
    }
    expect(tunnel.secrets).toEqual(["tunnel_token"]);
    expect(tunnel.command).toContain("--token-file /run/secrets/tunnel_token");
    expect(text).not.toMatch(/TUNNEL_TOKEN\s*:/u);
    // Every declared secret comes from a file under SECRETS_DIR, and every mount is declared.
    for (const [name, secret] of Object.entries(compose.secrets)) {
      expect(secret.file).toMatch(new RegExp(`^\\$\\{SECRETS_DIR(:\\?[^}]*)?\\}/${name}$`, "u"));
    }
    expect([...mounted, ...(tunnel.secrets ?? [])].sort()).toEqual(
      Object.keys(compose.secrets).sort(),
    );
  });

  it("runs the app by a digest the operator supplies, and pins cloudflared by digest", () => {
    expect(app.image).toMatch(/^\$\{APP_IMAGE:\?/u);
    expect(tunnel.image).toMatch(/^cloudflare\/cloudflared:\d[\d.]*@sha256:[0-9a-f]{64}$/u);
  });

  it("hardens both containers and keeps the data on named volumes", () => {
    for (const service of [app, tunnel]) {
      expect(service.read_only).toBe(true);
      expect(service.cap_drop).toEqual(["ALL"]);
    }
    expect(app.volumes).toEqual(["data:/data", "blobs:/data/blobs"]);
  });

  it("the environment it declares is a valid configuration that starts with the gmail provider", () => {
    const provided: Record<string, string> = {
      APP_IMAGE: "unused",
      PUBLIC_URL: "https://play.example.org",
      OPERATOR_CONTACT: "ops@example.org",
      EMAIL_FROM: '"Example Games" <no-reply@example.org>',
      GMAIL_SENDER: "no-reply@example.org",
    };
    const env: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(app.environment ?? {})) {
      env[name] = value.replaceAll(/\$\{(\w+)(?::[-?][^}]*)?\}/gu, (_all, variable: string) =>
        variable in provided ? (provided[variable] ?? "") : "",
      );
    }
    const files: Record<string, string> = {
      "/run/secrets/app_secret": btoa("compose-test-only-0123456789abcdef"),
      "/run/secrets/gmail_client_id": "fake-client-id",
      "/run/secrets/gmail_client_secret": "fake-client-secret",
      "/run/secrets/gmail_refresh_token": "fake-refresh-token\n",
    };
    const resolved = resolveSecretFiles(env, (path) => {
      const content = files[path];
      if (content === undefined) throw new Error("no such secret");
      return content;
    });
    const config = parseConfig(resolved, { runtime: "node", installedGames: [] });
    expect(config.email.provider).toBe("gmail");
    const node = parseNodeConfig(resolved);
    expect(node).toMatchObject({ trustProxy: "cloudflare", trustProxyPeersDefaulted: false });
  });
});

describe("the proxy settings it declares (08 §4.1)", () => {
  let h: Harness;
  beforeEach(() => {
    const node = parseNodeConfig({
      TRUST_PROXY: app.environment?.["TRUST_PROXY"],
      TRUST_PROXY_PEERS: app.environment?.["TRUST_PROXY_PEERS"],
    });
    h = createHarness(PROD_ENV, { nodeConfig: node });
  });
  afterEach(() => {
    h.close();
  });

  const otp = (email: string, headers: Record<string, string>, peer: string) =>
    h.request("POST", "/api/v1/auth/otp/request", { email }, { ip: null, headers, peer });

  it("answers a request from cloudflared on the front network", async () => {
    const response = await otp(
      "a@example.org",
      { "CF-Connecting-IP": "203.0.113.7" },
      "172.30.99.2",
    );
    expect(response.status).toBe(202);
  });

  it.each([
    "198.51.100.1",
    "172.30.98.2",
    "172.30.99.16",
    // The Docker host's own address on `front` (the bridge gateway) and the app itself.
    "172.30.99.1",
    "172.30.99.3",
    "172.30.99.4",
    "10.0.0.5",
    "192.168.1.9",
    "::ffff:8.8.8.8",
  ])("answers 400 to any peer but cloudflared: %s", async (peer) => {
    const response = await otp("a@example.org", { "CF-Connecting-IP": "203.0.113.7" }, peer);
    expect(response.status).toBe(400);
  });

  it("takes the client address from CF-Connecting-IP only, never X-Forwarded-For", async () => {
    const forged = await otp("a@example.org", { "X-Forwarded-For": "203.0.113.7" }, "172.30.99.2");
    expect(forged.status).toBe(400);
    const missing = await otp("a@example.org", {}, "172.30.99.2");
    expect(missing.status).toBe(400);
  });

  it("answers the container's own health check without CF-Connecting-IP, from any peer", async () => {
    for (const peer of ["127.0.0.1", "::1", "172.30.99.2", "198.51.100.1"]) {
      const response = await h.request("GET", "/api/health", undefined, { ip: null, peer });
      expect(response.status).toBe(200);
    }
  });
});
