import { describe, expect, it } from "vitest";

import { CLIENT_API_PLANNED } from "./client.js";
import { z } from "./schema.js";

describe("SDK subpaths", () => {
  it("/schema re-exports Zod", () => {
    expect(z.string().safeParse("x").success).toBe(true);
  });

  it("/client is a placeholder until M1", () => {
    expect(CLIENT_API_PLANNED).toBe(true);
  });
});
