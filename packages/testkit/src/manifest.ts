/**
 * The manifest must agree with the engine (docs/spec/02-game-framework.md §7.2): `type`,
 * `hiddenInformation` and the `players` bounds match the exported `GameDefinition`s, `rules` has
 * an entry for every exported rules version, and the engine requests only the resource kinds the
 * manifest lists.
 */
import {
  isGameError,
  isGameType,
  type AnyGameDefinition,
  type GameEngines,
  type GameManifest,
  type OptionsContext,
} from "@your-move/sdk";

import { checkIcon } from "./icon.js";

/** The kit's overrides of the module's own test hooks (see `KitOptions`). */
interface Overrides {
  readonly optionInputs?: readonly unknown[];
  readonly context?: OptionsContext;
}

/** What `resolveOptions` sees: the override, the module's `test.context`, or its empty config. */
function contextFor(def: AnyGameDefinition, overrides: Overrides): OptionsContext | undefined {
  if (overrides.context !== undefined) return overrides.context;
  if (def.test.context !== undefined) return def.test.context();
  const config = def.configSchema.safeParse({});
  return config.success ? { config: config.data, resources: [] } : undefined;
}

/**
 * Every disagreement between a manifest and the engines it ships with, plus icon problems;
 * empty when they agree. Each engine's option inputs (`test.optionInputs`, or the override) are
 * resolved to find their player bounds and resource requests: the manifest's `players` must equal
 * the union of those bounds (02 §7.2). Exceptions are left to the kit, which reports them.
 *
 * @public
 */
export function checkManifest(
  manifest: GameManifest,
  engines: GameEngines,
  overrides: Overrides = {},
): string[] {
  const problems: string[] = [];
  if (!isGameType(manifest.type)) {
    problems.push(`manifest type "${manifest.type}" must match ^[a-z][a-z0-9]{1,31}$`);
  }
  problems.push(...checkIcon(manifest.icon).map((problem) => `manifest icon: ${problem}`));
  const versions = Object.entries(engines);
  if (versions.length === 0) problems.push("the engine exports no rules version");
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [key, def] of versions) {
    const at = `rules version ${key}`;
    if (def.version !== Number(key)) {
      problems.push(`${at}: the definition says version ${String(def.version)}`);
    }
    if (def.type !== manifest.type) {
      problems.push(
        `${at}: engine type "${def.type}" differs from manifest type "${manifest.type}"`,
      );
    }
    if (def.test.hiddenInformation !== manifest.hiddenInformation) {
      problems.push(`${at}: hiddenInformation differs between the engine and the manifest`);
    }
    if (typeof manifest.rules[def.version] !== "string" || manifest.rules[def.version] === "") {
      problems.push(`${at}: the manifest has no rules text for it`);
    }
    try {
      const ctx = contextFor(def, overrides);
      if (ctx === undefined) continue;
      for (const input of overrides.optionInputs ?? def.test.optionInputs(ctx)) {
        const options = def.resolveOptions(input, ctx);
        if (isGameError(options)) continue;
        const players = def.players(options);
        min = Math.min(min, players.min);
        max = Math.max(max, players.max);
        for (const request of def.resources(options)) {
          if (!manifest.resources.includes(request.kind)) {
            problems.push(`${at}: requests a "${request.kind}" resource the manifest doesn't list`);
          }
        }
      }
    } catch {
      // The kit reports exceptions.
    }
  }
  if (Number.isFinite(min) && (min !== manifest.players.min || max !== manifest.players.max)) {
    problems.push(
      `the engines allow ${String(min)}–${String(max)} players over their option inputs, but the manifest says ${String(manifest.players.min)}–${String(manifest.players.max)}`,
    );
  }
  return [...new Set(problems)];
}
