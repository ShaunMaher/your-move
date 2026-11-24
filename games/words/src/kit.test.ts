import { runKit } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { configSchema } from "./engine/schemas.js";
import { manifest } from "./manifest.js";
import { realDictionary } from "./test-support.js";

describe("the generic test kit (02 §6)", () => {
  it("passes the words engine under every ruleset in fast mode, with its own hooks", () => {
    // The option inputs (one per ruleset) and the kit word list come from the engine's hooks,
    // exactly as `pnpm games:verify` plays them.
    const report = runKit(engines, { mode: "fast", manifest });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  }, 300_000);

  it("passes it with the full built-in word list too, as many games as fast mode plays", async () => {
    const { meta, resources } = await realDictionary();
    const report = runKit(engines, {
      mode: "fast",
      manifest,
      context: { config: configSchema.parse({}), resources: [meta] },
      resources,
    });
    expect(report.failures).toEqual([]);
  }, 300_000);
});
