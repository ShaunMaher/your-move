/** Node passes its own onboarding-claim budget to the core (09 §3; alpha A17 review R2-7). */
import { fileURLToPath } from "node:url";

import * as server from "@your-move/server";
import { describe, expect, it, vi } from "vitest";

const { createApp } = vi.hoisted(() => ({ createApp: vi.fn() }));
vi.mock("@your-move/server", async (importOriginal) => {
  const actual = await importOriginal<typeof server>();
  createApp.mockImplementation(actual.createApp);
  return { ...actual, createApp };
});

const { nodeDictionaries } = await import("./dictionaries.js");
const { createNodePlatform } = await import("./platform.js");
const { createNodeApp, NODE_ONBOARDING_CLAIMS } = await import("./server.js");

const DICTIONARIES = fileURLToPath(
  new URL("../../../packages/dictionary/generated/served", import.meta.url),
);

describe("createNodeApp", () => {
  it("claims at most 50 email-invite seats when onboarding completes", () => {
    const now = (): Date => new Date(0);
    const config = server.parseConfig(
      {
        PUBLIC_URL: "https://play.example.org",
        APP_SECRET: btoa("0123456789abcdef0123456789abcdef"),
        EMAIL_PROVIDER: "smtp",
        SMTP_URL: "smtp://mail.example.org",
        EMAIL_FROM: "no-reply@example.org",
        OPERATOR_CONTACT: "ops@example.org",
      },
      { runtime: "node", installedGames: [] },
    );
    createNodeApp({
      platform: createNodePlatform({
        repos: server.detachedRepositories(),
        config,
        nodeConfig: { trustProxy: "false", trustProxyHops: 1, trustProxyPeers: [] },
        now,
        log: server.createJsonLogger({ level: "error", now, sink: () => undefined }),
        dictionaries: nodeDictionaries(DICTIONARIES),
      }),
      games: [],
      staticRoot: DICTIONARIES,
      dictionariesRoot: DICTIONARIES,
    });
    expect(NODE_ONBOARDING_CLAIMS).toBe(50);
    expect(createApp).toHaveBeenCalledWith(expect.objectContaining({ onboardingClaims: 50 }));
  });
});
