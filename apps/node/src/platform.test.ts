import {
  createJsonLogger,
  detachedRepositories,
  NO_DICTIONARIES,
  parseConfig,
} from "@your-move/server";
import { describe, expect, it } from "vitest";

import { createNodePlatform, PROXY_CHECK_WINDOW } from "./platform.js";

function platform(trustProxy: "false" | "xff") {
  const lines: Record<string, unknown>[] = [];
  const now = (): Date => new Date(0);
  const config = parseConfig(
    {
      PUBLIC_URL: "https://play.example.org",
      APP_SECRET: btoa("platform-tests-only-0123456789abcdef"),
      EMAIL_PROVIDER: "resend",
      EMAIL_API_KEY: "unused",
      EMAIL_FROM: "no-reply@example.org",
      OPERATOR_CONTACT: "ops@example.org",
    },
    { runtime: "node", installedGames: [] },
  );
  const result = createNodePlatform({
    repos: detachedRepositories(),
    config,
    nodeConfig: { trustProxy, trustProxyHops: 1, trustProxyPeers: ["127.0.0.0/8"] },
    log: createJsonLogger({
      level: "debug",
      now,
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    now,
    dictionaries: NO_DICTIONARIES,
  });
  const from = (address: string) =>
    result.clientIp(new Request("http://x/"), { incoming: { socket: { remoteAddress: address } } });
  const warnings = () =>
    lines.filter((line) => line["level"] === "warn" && "recentAddresses" in line);
  return { from, warnings };
}

describe("TRUST_PROXY=false misconfiguration warning (08 §4.1)", () => {
  it("warns once when every recent client is private or loopback", () => {
    const { from, warnings } = platform("false");
    for (let i = 0; i < PROXY_CHECK_WINDOW * 2; i++)
      from(i % 2 === 0 ? "172.18.0.2" : "::ffff:10.0.0.3");
    expect(warnings()).toHaveLength(1);
  });

  it("stays quiet when public clients arrive", () => {
    const { from, warnings } = platform("false");
    for (let i = 0; i < PROXY_CHECK_WINDOW * 2; i++)
      from(i % 10 === 0 ? "203.0.113.5" : "192.168.1.9");
    expect(warnings()).toHaveLength(0);
  });

  it("doesn't apply behind a configured proxy", () => {
    const { from, warnings } = platform("xff");
    for (let i = 0; i < PROXY_CHECK_WINDOW * 2; i++) from("127.0.0.1");
    expect(warnings()).toHaveLength(0);
  });
});
