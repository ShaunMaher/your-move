/**
 * Creating a game: the module config, options, the catalog and the seat-count check
 * (docs/spec/games/words.md §10.1, 02 §2 "Creating a game", §2.1 rules 7–8). These run in the
 * framework at create time (or at startup, for `checkConfig`) and are never replayed.
 */
import {
  OK,
  type GameError,
  type ModuleConfig,
  type Ok,
  type OptionsContext,
  type ResourceCatalog,
} from "@your-move/sdk";

import { isCompatible } from "./compatibility.js";
import { latestRuleset, RULESETS } from "./rulesets/index.js";
import { totalTiles, type Ruleset } from "./rulesets/schema.js";
import {
  configSchema,
  DEFAULT_DICTIONARY,
  DEFAULT_RULESET,
  ERROR_CODES,
  type Catalog,
  type Options,
} from "./schemas.js";
import { rulesetOf } from "./state.js";

/** The module config with the instance defaults applied (09 §1). */
export interface Settings {
  /** Ruleset ids offered for new games, in registry order unless the config lists them. */
  readonly enabledRulesets: readonly string[];
  readonly defaultRuleset: string;
  readonly defaultDictionary: string;
}

/**
 * Reads the parsed module config (02 §2.1 rule 8). The framework passes the value `configSchema`
 * parsed; anything else is a framework bug and throws.
 */
export function settings(config: ModuleConfig): Settings {
  const parsed = configSchema.parse(config);
  const listed = parsed.ENABLED_RULESETS?.split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return {
    enabledRulesets: listed ?? [...RULESETS.keys()],
    defaultRuleset: parsed.DEFAULT_RULESET ?? DEFAULT_RULESET,
    defaultDictionary: parsed.DEFAULT_DICTIONARY ?? DEFAULT_DICTIONARY,
  };
}

/** The latest version of an enabled ruleset, or undefined. */
function enabledRuleset(id: string, enabled: readonly string[]): Ruleset | undefined {
  return enabled.includes(id) ? latestRuleset(id) : undefined;
}

/**
 * Startup cross-checks (02 §2.1 rule 8): every enabled ruleset exists, the default ruleset is
 * enabled, and the default dictionary is enabled and compatible with it. Errors name the key,
 * never its value.
 */
export function checkConfig(config: ModuleConfig, catalog: ResourceCatalog): Ok | GameError {
  const { enabledRulesets, defaultRuleset, defaultDictionary } = settings(config);
  if (enabledRulesets.some((id) => latestRuleset(id) === undefined)) {
    return { code: ERROR_CODES.unknownRuleset, detail: { key: "ENABLED_RULESETS" } };
  }
  const ruleset = enabledRuleset(defaultRuleset, enabledRulesets);
  if (ruleset === undefined) {
    return { code: ERROR_CODES.unknownRuleset, detail: { key: "DEFAULT_RULESET" } };
  }
  const dictionary = catalog.find((meta) => meta.id === defaultDictionary);
  if (dictionary === undefined) {
    return { code: ERROR_CODES.unknownDictionary, detail: { key: "DEFAULT_DICTIONARY" } };
  }
  if (!isCompatible(ruleset, dictionary)) {
    return { code: ERROR_CODES.incompatibleDictionary, detail: { key: "DEFAULT_DICTIONARY" } };
  }
  return OK;
}

/** The input keys a creator chooses with. */
const INPUT_KEYS: ReadonlySet<string> = new Set(["rulesetId", "dictionaryId"]);

/**
 * The versions resolved options carry: accepted so that resolved options resolve again to the
 * same choices (a rematch, 02 §2.1 rule 10), checked to be non-negative integers, and otherwise
 * ignored. Never honoured: no input can pin an old version.
 */
const VERSION_KEYS: ReadonlySet<string> = new Set(["rulesetVersion", "dictionaryVersion"]);

/** The unknown keys `UNKNOWN_OPTION` may name in its detail (words §10.3). */
const SAFE_KEY = /^[A-Za-z0-9_]{1,64}$/u;

/**
 * Resolves a creator's input `{ rulesetId?, dictionaryId? }` (words §10.1): missing fields take
 * the instance defaults; an unknown or disabled ruleset, a dictionary the creator may not use, or
 * an incompatible pair is an error value. Resolves the ruleset's latest version and the
 * dictionary's current version, whatever versions the input names (resolved options are a valid
 * input). `undefined` and `null` mean "all defaults".
 */
export function resolveOptions(input: unknown, ctx: OptionsContext): Options | GameError {
  const given: unknown = input ?? {};
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    return { code: ERROR_CODES.optionsNotObject };
  }
  const fields = new Map<string, unknown>(Object.entries(given as Record<string, unknown>));
  for (const [key, value] of fields) {
    if (VERSION_KEYS.has(key)) {
      if (value !== undefined && !(Number.isSafeInteger(value) && (value as number) >= 0)) {
        return { code: ERROR_CODES.invalidOption, detail: { option: key } };
      }
      continue;
    }
    if (!INPUT_KEYS.has(key)) {
      // The key is echoed only if it looks like an option name, never arbitrary input.
      return SAFE_KEY.test(key)
        ? { code: ERROR_CODES.unknownOption, detail: { option: key } }
        : { code: ERROR_CODES.unknownOption };
    }
  }
  const { enabledRulesets, defaultRuleset, defaultDictionary } = settings(ctx.config);
  const rulesetId = fields.get("rulesetId") ?? defaultRuleset;
  const ruleset =
    typeof rulesetId === "string" ? enabledRuleset(rulesetId, enabledRulesets) : undefined;
  if (ruleset === undefined) return { code: ERROR_CODES.unknownRuleset };
  const dictionaryId = fields.get("dictionaryId") ?? defaultDictionary;
  const dictionary = ctx.resources.find((meta) => meta.id === dictionaryId);
  if (dictionary === undefined) return { code: ERROR_CODES.unknownDictionary };
  if (!isCompatible(ruleset, dictionary)) return { code: ERROR_CODES.incompatibleDictionary };
  return {
    rulesetId: ruleset.id,
    rulesetVersion: ruleset.version,
    dictionaryId: dictionary.id,
    dictionaryVersion: dictionary.version,
  };
}

/**
 * The new-game form's data (words §10.1): the enabled rulesets with their key numbers and premium
 * picture, the dictionaries the creator may use with the rulesets each is compatible with, and the
 * defaults (null where the default isn't available to this creator).
 */
export function catalog(ctx: OptionsContext): Catalog {
  const { enabledRulesets, defaultRuleset, defaultDictionary } = settings(ctx.config);
  const rulesets = enabledRulesets.flatMap((id) => {
    const ruleset = latestRuleset(id);
    return ruleset === undefined ? [] : [ruleset];
  });
  // Dictionaries are the only resource kind (02 §2.1 rule 7).
  const available = ctx.resources;
  return {
    rulesets: rulesets.map((ruleset) => ({
      id: ruleset.id,
      version: ruleset.version,
      name: ruleset.name,
      description: ruleset.description,
      language: ruleset.language,
      boardSize: ruleset.boardSize,
      rackSize: ruleset.rackSize,
      tileCount: totalTiles(ruleset),
      bingoBonus: ruleset.bingoBonus,
      swapOrder: ruleset.swapOrder,
      swapMinBag: ruleset.swapMinBag,
      scorelessTurnLimit: ruleset.scorelessTurnLimit,
      players: { min: ruleset.minPlayers, max: ruleset.maxPlayers },
      premiums: [...ruleset.premiums],
    })),
    dictionaries: available.map((meta) => ({
      id: meta.id,
      version: meta.version,
      name: meta.name,
      language: meta.language,
      distribution: meta.distribution,
      source: meta.source,
      compatibleRulesets: rulesets
        .filter((ruleset) => isCompatible(ruleset, meta))
        .map((ruleset) => ruleset.id),
    })),
    defaults: {
      rulesetId: rulesets.some((ruleset) => ruleset.id === defaultRuleset) ? defaultRuleset : null,
      dictionaryId: available.some((meta) => meta.id === defaultDictionary)
        ? defaultDictionary
        : null,
    },
  };
}

/** Seat-count bounds from the ruleset (words §10.1). */
export function players(options: Options): { min: number; max: number } {
  const ruleset = rulesetOf(options);
  return { min: ruleset.minPlayers, max: ruleset.maxPlayers };
}

/** Refuses a seat count the bag can't fill every rack for (words §10.1). */
export function validateStart(options: Options, seats: number): Ok | GameError {
  const ruleset = rulesetOf(options);
  const needed = ruleset.rackSize * seats;
  const tiles = totalTiles(ruleset);
  return needed <= tiles ? OK : { code: ERROR_CODES.notEnoughTiles, detail: { needed, tiles } };
}
