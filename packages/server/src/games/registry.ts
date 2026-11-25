/**
 * The games registry (docs/spec/02-game-framework.md §7.3): the installed game packages the
 * runtime injected into `createApp`, each with its module config parsed from its own
 * `GAMES_<TYPE>_*` keys (02 §2.1 rule 8) and checked against the enabled resources by
 * `checkConfig` at startup. The framework knows games only through this.
 */
import type {
  AnyGameDefinition,
  GameEngines,
  GameManifest,
  ModuleConfig,
  ResourceCatalog,
} from "@your-move/sdk";

import { guardEngine } from "./engine-fault.js";

/** One installed game package, as the generated server registry lists it (02 §7.3). */
export interface InstalledGame {
  readonly manifest: GameManifest;
  readonly engines: GameEngines;
  readonly enabledByDefault: boolean;
}

export interface GameType {
  readonly type: string;
  readonly manifest: GameManifest;
  /** The newest rules version: every new game uses it (02 §7.4). */
  readonly latest: AnyGameDefinition;
  /** The parsed module config, the module's own keys only. */
  readonly config: ModuleConfig;
  /** Offered for new games (`ENABLED_GAMES`); a disabled type keeps serving its games. */
  readonly enabled: boolean;
  /** The definition of one rules version, if this build still exports it. */
  engine(version: number): AnyGameDefinition | undefined;
}

export interface GameRegistry {
  /** An installed game type, enabled or not. */
  get(type: string): GameType | undefined;
  /** The enabled game types, in installation order. */
  enabled(): readonly GameType[];
}

/** A startup refusal from a game's config (02 §2.1 rule 8): names keys, never values. */
export class GameConfigError extends Error {
  override readonly name = "GameConfigError";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid game configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
  }
}

/** A key name safe to print from a module's error detail. */
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;

function keyOf(detail: unknown): string | undefined {
  if (typeof detail !== "object" || detail === null || !("key" in detail)) return undefined;
  const key: unknown = detail.key;
  return typeof key === "string" && KEY.test(key) ? key : undefined;
}

export interface RegistryOptions {
  /** `GAMES_<TYPE>_*` values by type, prefix stripped (`AppConfig.gameConfig`). */
  readonly gameConfig: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly enabledGames: readonly string[];
  /** Every enabled built-in and operator resource, for `checkConfig`. */
  readonly resources: ResourceCatalog;
}

/**
 * Builds the registry, parsing each module's config with its strict `configSchema` and running
 * every exported version's `checkConfig`. Throws {@link GameConfigError} naming each failing key.
 */
export function createGameRegistry(
  installed: readonly InstalledGame[],
  options: RegistryOptions,
): GameRegistry {
  const issues: string[] = [];
  const types = new Map<string, GameType>();
  for (const game of installed) {
    const type = game.manifest.type;
    const prefix = `GAMES_${type.toUpperCase()}_`;
    const definitions = Object.values(game.engines).sort((a, b) => a.version - b.version);
    const latest = definitions.at(-1);
    if (latest === undefined) {
      issues.push(`${type}: the package exports no rules version`);
      continue;
    }
    const parsed = latest.configSchema.safeParse(options.gameConfig[type] ?? {});
    if (!parsed.success) {
      // Zod's messages can quote the received value, so only the key is named.
      const keys = new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "")));
      for (const key of keys) {
        issues.push(
          key === "" ? `${prefix}*: invalid configuration` : `${prefix}${key}: invalid value`,
        );
      }
      continue;
    }
    const config: ModuleConfig = parsed.data;
    for (const definition of definitions) {
      const checked = definition.checkConfig(config, options.resources);
      if (!("ok" in checked)) {
        const key = keyOf(checked.detail);
        issues.push(
          `${key === undefined ? `${prefix}*` : `${prefix}${key}`}: refused by the ${type} game (${checked.code})`,
        );
      }
    }
    // Module calls behind the fault boundary: an exception is logged without its message (S-5).
    const byVersion = new Map(
      definitions.map((definition) => [definition.version, guardEngine(definition)]),
    );
    types.set(type, {
      type,
      manifest: game.manifest,
      latest: byVersion.get(latest.version) ?? latest,
      config,
      enabled: options.enabledGames.includes(type),
      engine: (version) => byVersion.get(version),
    });
  }
  if (issues.length > 0) throw new GameConfigError([...new Set(issues)]);
  const enabled = [...types.values()].filter((type) => type.enabled);
  return {
    get: (type) => types.get(type),
    enabled: () => enabled,
  };
}
