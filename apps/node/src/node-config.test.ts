import { ConfigError } from "@your-move/server";
import { describe, expect, it } from "vitest";

import { DEFAULT_TRUST_PROXY_PEERS, isCidr, parseNodeConfig } from "./node-config.js";

describe("parseNodeConfig", () => {
  it("applies the documented defaults", () => {
    expect(parseNodeConfig({})).toEqual({
      port: 8080,
      databasePath: "/data/app.sqlite",
      blobDir: "/data/blobs",
      trustProxy: "false",
      trustProxyHops: 1,
      trustProxyPeers: [...DEFAULT_TRUST_PROXY_PEERS],
      trustProxyPeersDefaulted: true,
      allowOrphanGames: false,
    });
  });

  it("reads every variable", () => {
    expect(
      parseNodeConfig({
        PORT: "3000",
        DATABASE_PATH: "/tmp/db.sqlite",
        BLOB_DIR: "/tmp/blobs",
        TRUST_PROXY: "xff",
        TRUST_PROXY_HOPS: "2",
        TRUST_PROXY_PEERS: "172.30.99.0/28, 127.0.0.1/32",
        ALLOW_ORPHAN_GAMES: "true",
      }),
    ).toEqual({
      port: 3000,
      databasePath: "/tmp/db.sqlite",
      blobDir: "/tmp/blobs",
      trustProxy: "xff",
      trustProxyHops: 2,
      trustProxyPeers: ["172.30.99.0/28", "127.0.0.1/32"],
      trustProxyPeersDefaulted: false,
      allowOrphanGames: true,
    });
  });

  it.each([
    [{ PORT: "0" }, "PORT: must be a port number"],
    [{ PORT: "65536" }, "PORT: must be a port number"],
    [{ PORT: "http" }, "PORT: must be a port number"],
    [{ TRUST_PROXY: "true" }, "TRUST_PROXY: must be false, xff or cloudflare"],
    [{ TRUST_PROXY_HOPS: "0" }, "TRUST_PROXY_HOPS: must be a whole number"],
    [{ TRUST_PROXY_PEERS: "10.0.0.0" }, "TRUST_PROXY_PEERS: must be a comma-separated list"],
    [{ ALLOW_ORPHAN_GAMES: "yes" }, "ALLOW_ORPHAN_GAMES: must be true or false"],
  ])("rejects %j", (env, expected) => {
    expect(() => parseNodeConfig(env)).toThrow(ConfigError);
    expect(() => parseNodeConfig(env)).toThrow(expected);
  });
});

describe("isCidr", () => {
  it.each([
    ["10.0.0.0/8", true],
    ["172.30.99.0/28", true],
    ["::1/128", true],
    ["fc00::/7", true],
    ["10.0.0.0/33", false],
    ["::1/129", false],
    ["10.0.0.0", false],
    ["10.0.0/8", false],
    ["10.0.0.0/8/8", false],
    ["example.org/8", false],
    ["10.0.0.0/-1", false],
  ])("%s → %s", (value, expected) => {
    expect(isCidr(value)).toBe(expected);
  });
});
