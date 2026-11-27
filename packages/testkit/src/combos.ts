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

import { canonical, sameJson } from "./canonical.js";
import { errorName, type Combo, type Reporter } from "./report.js";
import type { KitOptions } from "./types.js";

/**
 * The static checks of 02 §6.1 (reserved and undeclared codes, catalog, config and option
 * schemas, options that resolve to themselves, player counts, timeouts), and what to play: each option input with every seat count
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
  for (const input of optionInputs(report, def, ctx, kitOptions)) {
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
      // A rematch resolves a game's stored options again (02 §2.1 rule 10).
      const again = def.resolveOptions(options, ctx);
      if (!sameJson(again, options)) {
        report.fail(
          "schema",
          `resolveOptions doesn't return its own options unchanged for ${canonical(input)} (02 §2.1 rule 10)`,
          where,
        );
      }
    } catch (error) {
      report.fail("schema", `resolveOptions threw ${errorName(error)} on its own options`, where);
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
          const resources = kitOptions.resources ?? def.test.resources?.(options) ?? {};
          combos.push({ def, options, seats, min, resources });
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

/**
 * The option inputs to play: the kit's override, else the module's required `test.optionInputs`
 * (02 §6). A module without them fails, and is played with its defaults only.
 */
function optionInputs(
  report: Reporter,
  def: AnyGameDefinition,
  ctx: OptionsContext,
  kitOptions: KitOptions,
): readonly unknown[] {
  if (kitOptions.optionInputs !== undefined) return kitOptions.optionInputs;
  const where = { version: def.version };
  // A JavaScript module may lack the hook its types require.
  if ((def.test.optionInputs as unknown) === undefined) {
    report.fail(
      "schema",
      "test.optionInputs is missing: list the option sets the kit must play",
      where,
    );
    return [{}];
  }
  try {
    const inputs = def.test.optionInputs(ctx);
    if (Array.isArray(inputs) && inputs.length > 0) return inputs;
    report.fail("schema", "test.optionInputs must return at least one option input", where);
  } catch (error) {
    report.fail("schema", `test.optionInputs threw ${errorName(error)}`, where);
  }
  return [{}];
}

/**
 * What `resolveOptions` sees: the kit's override, the module's `test.context`, or the module's
 * empty configuration with no resources.
 */
function context(
  report: Reporter,
  def: AnyGameDefinition,
  kitOptions: KitOptions,
): OptionsContext | null {
  if (kitOptions.context !== undefined) return kitOptions.context;
  if (def.test.context !== undefined) {
    try {
      return def.test.context();
    } catch (error) {
      report.fail("schema", `test.context threw ${errorName(error)}`, { version: def.version });
      return null;
    }
  }
  const config = def.configSchema.safeParse({});
  if (!config.success) {
    report.fail("schema", "configSchema doesn't accept an empty configuration; pass context", {
      version: def.version,
    });
    return null;
  }
  return { config: config.data, resources: [] };
}
