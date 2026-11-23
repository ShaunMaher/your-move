/**
 * The manifest must agree with the engine (docs/spec/02-game-framework.md §7.2): `type`,
 * `hiddenInformation` and the `players` bounds match every exported `GameDefinition`, `rules` has
 * an entry for every exported rules version, and the engine requests only the resource kinds the
 * manifest lists.
 */
import {
  isGameError,
  isGameType,
  type GameEngines,
  type GameManifest,
  type OptionsContext,
} from "@your-move/sdk";

import { checkIcon } from "./icon.js";

/**
 * Every disagreement between a manifest and the engines it ships with, plus icon problems;
 * empty when they agree. `optionInputs` are resolved to find each option set's player bounds and
 * resource requests.
 *
 * @public
 */
export function checkManifest(
  manifest: GameManifest,
  engines: GameEngines,
  optionInputs: readonly unknown[] = [{}],
  context?: OptionsContext,
): string[] {
  const problems: string[] = [];
  if (!isGameType(manifest.type)) {
    problems.push(`manifest type "${manifest.type}" must match ^[a-z][a-z0-9]{1,31}$`);
  }
  problems.push(...checkIcon(manifest.icon).map((problem) => `manifest icon: ${problem}`));
  const versions = Object.entries(engines);
  if (versions.length === 0) problems.push("the engine exports no rules version");
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
    const config = def.configSchema.safeParse({});
    const ctx = context ?? (config.success ? { config: config.data, resources: [] } : undefined);
    if (ctx === undefined) continue;
    for (const input of optionInputs) {
      let options: unknown;
      try {
        options = def.resolveOptions(input, ctx);
      } catch {
        continue; // The kit reports exceptions.
      }
      if (isGameError(options)) continue;
      try {
        const { min, max } = def.players(options);
        if (min < manifest.players.min || max > manifest.players.max) {
          problems.push(
            `${at}: players ${String(min)}–${String(max)} are outside the manifest's ${String(manifest.players.min)}–${String(manifest.players.max)}`,
          );
        }
        for (const request of def.resources(options)) {
          if (!manifest.resources.includes(request.kind)) {
            problems.push(`${at}: requests a "${request.kind}" resource the manifest doesn't list`);
          }
        }
      } catch {
        // The kit reports exceptions.
      }
    }
  }
  return [...new Set(problems)];
}
