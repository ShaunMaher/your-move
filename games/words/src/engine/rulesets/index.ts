/**
 * The ruleset registry (docs/spec/games/words.md §8.1, §8.2): every version of every bundled
 * ruleset. Versions are immutable and all of them stay registered, so games keep the ruleset they
 * started with; new games use the latest version. Server and client bundle the whole registry.
 */
import { casualV1 } from "./casual/v1.js";
import { classicV1 } from "./classic/v1.js";
import { rulesetSchema, type Ruleset, type RulesetData } from "./schema.js";

/** Every ruleset's versions, keyed by id. */
export type RulesetRegistry = ReadonlyMap<string, readonly Ruleset[]>;

/**
 * Parses and checks a registry: each entry's versions are its id's rulesets numbered 1, 2, 3, …
 * in order. Throws on any problem, so an invalid ruleset can't be loaded (words §8.2).
 */
export function createRegistry(
  data: Readonly<Record<string, readonly RulesetData[]>>,
): RulesetRegistry {
  const registry = new Map<string, readonly Ruleset[]>();
  for (const [id, versions] of Object.entries(data)) {
    if (versions.length === 0) throw new Error(`ruleset ${id} has no versions`);
    const parsed = versions.map((version, index) => {
      const result = rulesetSchema.safeParse(version);
      if (!result.success) {
        throw new Error(`ruleset ${id} v${String(index + 1)} is invalid: ${result.error.message}`);
      }
      if (result.data.id !== id || result.data.version !== index + 1) {
        throw new Error(
          `ruleset ${id} entry ${String(index + 1)} must be ${id} v${String(index + 1)}`,
        );
      }
      return result.data;
    });
    registry.set(id, parsed);
  }
  return registry;
}

/** The bundled rulesets (words §8.3). */
export const RULESETS: RulesetRegistry = createRegistry({
  classic: [classicV1],
  casual: [casualV1],
});

/** The latest version of a ruleset, or undefined for an unknown id. */
export function latestRuleset(
  id: string,
  registry: RulesetRegistry = RULESETS,
): Ruleset | undefined {
  return registry.get(id)?.at(-1);
}

/** One version of a ruleset, or undefined if either is unknown. */
export function findRuleset(
  id: string,
  version: number,
  registry: RulesetRegistry = RULESETS,
): Ruleset | undefined {
  return registry.get(id)?.find((ruleset) => ruleset.version === version);
}
