/**
 * The kit's static checks (docs/spec/02-game-framework.md §6.1) and the option sets and seat counts
 * it plays.
 */
import {
  RESERVED_ERROR_CODES,
  isGameError,
  type AnyGameDefinition,
  type OptionsContext,
} from "@your-move/sdk";

import { canonical } from "./canonical.js";
import { errorName, type Combo, type Reporter } from "./report.js";
import type { KitOptions } from "./types.js";

/**
 * The static checks of 02 §6.1 (reserved and undeclared codes, catalog, config and option
 * schemas, player counts, timeouts), and what to play: each option input with every seat count
 * `validateStart` accepts.
 */
export function resolveCombos(
  report: Reporter,
  def: AnyGameDefinition,
  kitOptions: KitOptions,
): Combo[] {
  const where = { version: def.version };
  const reserved = def.errorCodes.filter((code) => RESERVED_ERROR_CODES.includes(code));
  if (reserved.length > 0) {
    report.fail(
      "schema",
      `errorCodes contains reserved codes: ${reserved.join(", ")} (02 §2.2)`,
      where,
    );
  }
  const ctx = context(report, def, kitOptions);
  if (ctx === null) return [];
  try {
    report.okOrGameError(def, def.checkConfig(ctx.config, ctx.resources), "checkConfig", where);
    const catalog = def.catalog(ctx);
    if (!def.catalogSchema.safeParse(catalog).success) {
      report.fail("schema", "catalog() doesn't match catalogSchema", where);
    }
    for (const garbage of [null, 42, "x", [1], { unknownOption: true }]) {
      const resolved = def.resolveOptions(garbage, ctx);
      if (isGameError(resolved)) report.errorCode(def, resolved.code, "resolveOptions", where);
      else if (!def.optionsSchema.safeParse(resolved).success) {
        report.fail(
          "schema",
          "resolveOptions returned options that don't match optionsSchema",
          where,
        );
      }
    }
  } catch (error) {
    report.fail("schema", `option resolution threw ${errorName(error)}`, where);
    return [];
  }

  const combos: Combo[] = [];
  for (const input of kitOptions.optionInputs ?? [{}]) {
    let options: unknown;
    try {
      options = def.resolveOptions(input, ctx);
    } catch (error) {
      report.fail("schema", `resolveOptions threw ${errorName(error)}`, where);
      continue;
    }
    if (isGameError(options)) {
      report.fail(
        "schema",
        `resolveOptions refused option input ${canonical(input)}: ${options.code}`,
        where,
      );
      continue;
    }
    if (!def.optionsSchema.safeParse(options).success) {
      report.fail("schema", "resolved options don't match optionsSchema", where);
      continue;
    }
    try {
      const { min, max } = def.players(options);
      const timeout = def.defaultTurnTimeoutDays(options);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
        report.fail(
          "schema",
          "defaultTurnTimeoutDays must be a whole number of days from 1 to 30",
          where,
        );
      }
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || min > max) {
        report.fail(
          "schema",
          `players() returned an invalid range ${String(min)}–${String(max)}`,
          where,
        );
        continue;
      }
      let playable = 0;
      for (let seats = min; seats <= max; seats += 1) {
        const start = def.validateStart(options, seats);
        if (isGameError(start)) {
          report.errorCode(def, start.code, "validateStart", where);
        } else {
          playable += 1;
          combos.push({ def, options, seats });
        }
      }
      if (playable === 0) {
        report.fail(
          "schema",
          `validateStart refuses every seat count for ${canonical(input)}`,
          where,
        );
      }
    } catch (error) {
      report.fail("schema", `players/validateStart threw ${errorName(error)}`, where);
    }
  }
  return combos;
}

/** What `resolveOptions` sees: the given context, or the module's empty configuration. */
function context(
  report: Reporter,
  def: AnyGameDefinition,
  kitOptions: KitOptions,
): OptionsContext | null {
  if (kitOptions.context !== undefined) return kitOptions.context;
  const config = def.configSchema.safeParse({});
  if (!config.success) {
    report.fail("schema", "configSchema doesn't accept an empty configuration; pass context", {
      version: def.version,
    });
    return null;
  }
  return { config: config.data, resources: [] };
}
