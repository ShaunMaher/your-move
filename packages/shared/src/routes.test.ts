import { RESERVED_ERROR_CODES } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import {
  acceptInvitationRoute,
  API_V1,
  cancelGameRoute,
  ClientConfigSchema,
  configRoute,
  createGameRoute,
  declineGameRoute,
  ERROR_CODES,
  ERROR_STATUS,
  ErrorResponseSchema,
  HealthResponseSchema,
  healthRoute,
  markSeenRoute,
  previewRoute,
  resignGameRoute,
  startGameRoute,
  submitActionRoute,
} from "./index.js";

describe("route definitions", () => {
  it("live under /api/v1", () => {
    for (const route of [healthRoute, configRoute]) {
      expect(route.path.startsWith(`${API_V1}/`)).toBe(true);
      expect(route.method).toBe("get");
    }
  });
});

describe("schemas reject unknown fields (.strict())", () => {
  it.each([
    [HealthResponseSchema, { ok: true }, { ok: true, version: "1.0.0" }],
    [
      ErrorResponseSchema,
      { error: { code: "NOT_FOUND", message: "Not found." } },
      { error: { code: "NOT_FOUND", message: "Not found.", stack: "…" } },
    ],
    [
      ClientConfigSchema,
      {
        appName: "A",
        appShortName: "A",
        operatorContact: "ops@example.org",
        minAge: 13,
        uploadsEnabled: true,
      },
      {
        appName: "A",
        appShortName: "A",
        operatorContact: "ops@example.org",
        minAge: 13,
        uploadsEnabled: true,
        appSecret: "x",
      },
    ],
  ] as const)("%#", (schema, valid, withExtra) => {
    expect(schema.safeParse(valid).success).toBe(true);
    expect(schema.safeParse(withExtra).success).toBe(false);
  });

  it("only accepts ok: true for health", () => {
    expect(HealthResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe("the framework error table (05 §Errors)", () => {
  it("holds exactly the codes the SDK reserves, each with its status", () => {
    expect([...ERROR_CODES].sort()).toEqual([...RESERVED_ERROR_CODES].sort());
    expect(ERROR_STATUS.NOT_YOUR_TURN).toBe(409);
    expect(ERROR_STATUS.ONBOARDING_REQUIRED).toBe(403);
    expect(ERROR_STATUS.UPLOADS_FULL).toBe(503);
  });
});

describe("the game routes' documented errors (A2 review P-11)", () => {
  const writes = [
    createGameRoute,
    submitActionRoute,
    previewRoute,
    startGameRoute,
    acceptInvitationRoute,
    declineGameRoute,
    resignGameRoute,
    cancelGameRoute,
    markSeenRoute,
  ];

  it("documents 429 on every rate-limited write", () => {
    for (const route of writes) {
      expect(Object.keys(route.responses), route.path).toContain("429");
    }
  });

  it("names GAME_UNAVAILABLE wherever an orphaned game is refused", () => {
    for (const route of writes.filter(
      (route) => route !== createGameRoute && route !== markSeenRoute,
    )) {
      const conflict = (route.responses as Record<string, { description: string } | undefined>)[
        "409"
      ];
      expect(conflict?.description, route.path).toContain("GAME_UNAVAILABLE");
    }
  });
});
