import { runKit } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

/** The option sets the kit plays: the defaults and the corners of both ranges (02 §6). */
const optionInputs = [
  {},
  { handSize: 3, lives: 1 },
  { handSize: 4, lives: 2 },
  { handSize: 5, lives: 3 },
  { handSize: 6, lives: 1 },
];

describe("the generic test kit (02 §6)", () => {
  it("passes the example at 2, 3 and 4 players in fast mode", () => {
    const report = runKit(engines, { mode: "fast", manifest, optionInputs });
    expect(report.failures).toEqual([]);
    expect(report.games).toBeGreaterThanOrEqual(300);
  });
});
