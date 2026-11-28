/**
 * Game configuration at startup (docs/spec/02-game-framework.md §2.1 rule 8, 09 §1): each module
 * gets only its own `GAMES_<TYPE>_*` keys, parsed by its strict schema, and `checkConfig` against
 * the enabled dictionaries; any refusal stops startup naming the key, never its value.
 */
import { GameConfigError, ResourceConfigError } from "@your-move/server";
import { describe, expect, it } from "vitest";

import { gameHarness } from "./games-support.js";

const SECRET_LOOKING = "value-that-must-not-be-echoed";

function refusal(env: Record<string, string>): Error {
  try {
    gameHarness(env).close();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("the configuration was accepted");
}

describe("game configuration at startup", () => {
  it("refuses an unknown key for a module's strict schema, naming the key only", () => {
    const error = refusal({ GAMES_WORDS_COLOUR: SECRET_LOOKING });
    expect(error).toBeInstanceOf(GameConfigError);
    expect(error.message).toContain("GAMES_WORDS_");
    expect(error.message).not.toContain(SECRET_LOOKING);
  });

  it("refuses a default dictionary checkConfig can't find, naming the key", () => {
    const error = refusal({ GAMES_WORDS_DEFAULT_DICTIONARY: SECRET_LOOKING });
    expect(error).toBeInstanceOf(GameConfigError);
    expect(error.message).toContain("GAMES_WORDS_DEFAULT_DICTIONARY");
    expect(error.message).toContain("UNKNOWN_DICTIONARY");
    expect(error.message).not.toContain(SECRET_LOOKING);
  });

  it("refuses an enabled-rulesets list naming a ruleset that doesn't exist", () => {
    const error = refusal({ GAMES_WORDS_ENABLED_RULESETS: "classic,nope" });
    expect(error.message).toContain("GAMES_WORDS_ENABLED_RULESETS");
  });

  it("refuses DICTIONARIES_ENABLED naming a dictionary this build doesn't have", () => {
    const error = refusal({ DICTIONARIES_ENABLED: "enable,missing" });
    expect(error).toBeInstanceOf(ResourceConfigError);
    expect(error.message).toContain("DICTIONARIES_ENABLED");
  });

  it("accepts a module's own valid keys", () => {
    gameHarness({ GAMES_WORDS_DEFAULT_RULESET: "casual" }).close();
  });
});
