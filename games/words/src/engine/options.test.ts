/**
 * Options, the module config, the catalog and the start check (words §9.3, §10.1; 02 §2.1
 * rules 7–8).
 */
import type { OptionsContext, ResourceMeta } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { BUILTIN_ID } from "../test-support.js";
import { wordsV1 as words } from "./definition.js";
import { settings } from "./options.js";
import { configSchema } from "./schemas.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

function meta(fields: Partial<ResourceMeta> = {}): ResourceMeta {
  return {
    kind: "dictionary",
    id: BUILTIN_ID,
    version: 3,
    name: "Built-in",
    language: "en",
    alphabet: ALPHABET,
    distribution: "public",
    source: "builtin",
    ...fields,
  };
}

function ctx(config: Record<string, string> = {}, resources = [meta()]): OptionsContext {
  return { config: configSchema.parse(config), resources };
}

describe("module config (09 §1, 02 §2.1 rule 8)", () => {
  it("defaults to every bundled ruleset, classic and the built-in dictionary", () => {
    expect(settings(configSchema.parse({}))).toEqual({
      enabledRulesets: ["classic", "casual"],
      defaultRuleset: "classic",
      defaultDictionary: BUILTIN_ID,
    });
  });

  it("reads a comma-separated ruleset list, ignoring spaces and empty entries", () => {
    expect(settings({ ENABLED_RULESETS: " casual , ,classic", DEFAULT_RULESET: "casual" })).toEqual(
      {
        enabledRulesets: ["casual", "classic"],
        defaultRuleset: "casual",
        defaultDictionary: BUILTIN_ID,
      },
    );
  });

  it("accepts only its own keys", () => {
    expect(configSchema.safeParse({ OTHER: "x" }).success).toBe(false);
    expect(() => settings({ OTHER: "x" })).toThrow();
  });

  it.each([
    [{}, [meta()], { ok: true }],
    [
      { ENABLED_RULESETS: "classic,nope" },
      [meta()],
      { code: "UNKNOWN_RULESET", detail: { key: "ENABLED_RULESETS" } },
    ],
    [
      { ENABLED_RULESETS: "casual" },
      [meta()],
      { code: "UNKNOWN_RULESET", detail: { key: "DEFAULT_RULESET" } },
    ],
    [
      { DEFAULT_RULESET: "nope" },
      [meta()],
      { code: "UNKNOWN_RULESET", detail: { key: "DEFAULT_RULESET" } },
    ],
    [{}, [], { code: "UNKNOWN_DICTIONARY", detail: { key: "DEFAULT_DICTIONARY" } }],
    [
      { DEFAULT_DICTIONARY: "other" },
      [meta()],
      { code: "UNKNOWN_DICTIONARY", detail: { key: "DEFAULT_DICTIONARY" } },
    ],
    [
      {},
      [meta({ language: "fr" })],
      { code: "INCOMPATIBLE_DICTIONARY", detail: { key: "DEFAULT_DICTIONARY" } },
    ],
  ])("checkConfig(%j) → %j", (config, catalog, expected) => {
    expect(words.checkConfig(configSchema.parse(config), catalog)).toEqual(expected);
  });

  it("never echoes a config value in its errors", () => {
    const result = words.checkConfig(configSchema.parse({ DEFAULT_RULESET: "secret-value" }), [
      meta(),
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });
});

describe("resolveOptions (words §10.1)", () => {
  const resolved = (rulesetId: string, dictionaryVersion = 3) => ({
    rulesetId,
    rulesetVersion: 1,
    dictionaryId: BUILTIN_ID,
    dictionaryVersion,
  });

  it.each([
    ["nothing", undefined, resolved("classic")],
    ["null", null, resolved("classic")],
    ["an empty input", {}, resolved("classic")],
    ["a ruleset", { rulesetId: "casual" }, resolved("casual")],
    ["both", { rulesetId: "casual", dictionaryId: BUILTIN_ID }, resolved("casual")],
    ["an undefined field", { rulesetId: undefined }, resolved("classic")],
  ])("fills %s from the defaults, with the latest versions", (_name, input, expected) => {
    expect(words.resolveOptions(input, ctx())).toEqual(expected);
  });

  it("uses the instance defaults from the config", () => {
    const config = { DEFAULT_RULESET: "casual", DEFAULT_DICTIONARY: "mine" };
    expect(words.resolveOptions({}, ctx(config, [meta({ id: "mine", version: 7 })]))).toEqual({
      rulesetId: "casual",
      rulesetVersion: 1,
      dictionaryId: "mine",
      dictionaryVersion: 7,
    });
  });

  it.each([
    ["a number", 42, { code: "OPTIONS_NOT_OBJECT" }],
    ["a string", "classic", { code: "OPTIONS_NOT_OBJECT" }],
    ["an array", ["classic"], { code: "OPTIONS_NOT_OBJECT" }],
    [
      "an unknown key",
      { boardSize: 11 },
      { code: "UNKNOWN_OPTION", detail: { option: "boardSize" } },
    ],
    // Keys that don't look like option names are never echoed back (words §10.3).
    ["an unknown key with markup", { "<b>x</b>": 1 }, { code: "UNKNOWN_OPTION" }],
    ["an unknown key of 65 characters", { ["k".repeat(65)]: 1 }, { code: "UNKNOWN_OPTION" }],
    ["an empty key", { "": 1 }, { code: "UNKNOWN_OPTION" }],
    ["an unknown ruleset", { rulesetId: "nope" }, { code: "UNKNOWN_RULESET" }],
    ["a ruleset id that isn't a string", { rulesetId: 1 }, { code: "UNKNOWN_RULESET" }],
    ["an inherited name", { rulesetId: "constructor" }, { code: "UNKNOWN_RULESET" }],
    ["an unknown dictionary", { dictionaryId: "nope" }, { code: "UNKNOWN_DICTIONARY" }],
  ])("refuses %s", (_name, input, expected) => {
    expect(words.resolveOptions(input, ctx())).toEqual(expected);
  });

  it("refuses a ruleset the operator disabled", () => {
    expect(
      words.resolveOptions({ rulesetId: "casual" }, ctx({ ENABLED_RULESETS: "classic" })),
    ).toEqual({
      code: "UNKNOWN_RULESET",
    });
  });

  it("refuses a dictionary not among the creator's resources, exactly like an unknown one", () => {
    // Someone else's upload is simply absent from ctx.resources (02 §2.1 rule 7).
    expect(words.resolveOptions({ dictionaryId: "u_abc" }, ctx())).toEqual({
      code: "UNKNOWN_DICTIONARY",
    });
  });

  it("refuses an incompatible pair: another language, or a letter with no tile", () => {
    const resources = [
      meta({ id: "fr", language: "fr" }),
      meta({ id: "accents", alphabet: [...ALPHABET, "é"] }),
    ];
    expect(words.resolveOptions({ dictionaryId: "fr" }, ctx({}, resources))).toEqual({
      code: "INCOMPATIBLE_DICTIONARY",
    });
    expect(words.resolveOptions({ dictionaryId: "accents" }, ctx({}, resources))).toEqual({
      code: "INCOMPATIBLE_DICTIONARY",
    });
  });
});

describe("catalog (words §10.1)", () => {
  it("lists the enabled rulesets, the creator's dictionaries with their compatibility, and the defaults", () => {
    const resources = [
      meta(),
      meta({
        id: "fr",
        name: "French",
        language: "fr",
        source: "upload",
        distribution: "serverOnly",
      }),
    ];
    const catalog = words.catalog(ctx({}, resources));
    expect(words.catalogSchema.safeParse(catalog).success).toBe(true);
    expect(catalog).toMatchObject({
      rulesets: [
        {
          id: "classic",
          version: 1,
          name: "Classic",
          boardSize: 15,
          rackSize: 7,
          tileCount: 100,
          bingoBonus: 50,
          players: { min: 2, max: 2 },
        },
        {
          id: "casual",
          version: 1,
          name: "Casual",
          tileCount: 104,
          bingoBonus: 35,
          swapOrder: "returnThenDraw",
        },
      ],
      dictionaries: [
        { id: BUILTIN_ID, version: 3, compatibleRulesets: ["classic", "casual"] },
        {
          id: "fr",
          name: "French",
          source: "upload",
          distribution: "serverOnly",
          compatibleRulesets: [],
        },
      ],
      defaults: { rulesetId: "classic", dictionaryId: BUILTIN_ID },
    });
  });

  it("leaves out disabled and unknown rulesets, and defaults the creator can't use", () => {
    const catalog = words.catalog(
      ctx({ ENABLED_RULESETS: "casual,nope", DEFAULT_RULESET: "classic" }, []),
    );
    expect(catalog).toEqual({
      rulesets: [expect.objectContaining({ id: "casual" })],
      dictionaries: [],
      defaults: { rulesetId: null, dictionaryId: null },
    });
  });
});

describe("players, timeouts and resources (words §10.1)", () => {
  const options = {
    rulesetId: "casual",
    rulesetVersion: 1,
    dictionaryId: "d",
    dictionaryVersion: 2,
  };
  it("takes the player counts from the ruleset", () => {
    expect(words.players(options)).toEqual({ min: 2, max: 2 });
  });
  it("defaults the turn timeout to 14 days", () => {
    expect(words.defaultTurnTimeoutDays(options)).toBe(14);
  });
  it("requests the game's dictionary", () => {
    expect(words.resources(options)).toEqual([{ kind: "dictionary", id: "d", version: 2 }]);
  });
});
