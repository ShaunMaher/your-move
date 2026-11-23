import { describe, expect, it } from "vitest";

import {
  API_V1,
  ClientConfigSchema,
  configRoute,
  ErrorResponseSchema,
  HealthResponseSchema,
  healthRoute,
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
