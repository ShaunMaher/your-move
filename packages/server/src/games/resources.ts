/**
 * The framework's resources (docs/spec/02-game-framework.md §2.1 rules 6–7, 03 §10): which ones a
 * creator may use, authorising them for a new game, and loading them for `validate` and
 * `preview`. Dictionaries are the only kind in v1; the built-in ones come from the runtime's
 * {@link BuiltinDictionaries}, filtered by `DICTIONARIES_ENABLED`. Operator and uploaded
 * dictionaries (`serverOnly`, with their lookup budget) arrive in M6.
 */
import {
  createDictionaryProvider,
  type DictionaryIndex,
  type DictionaryManifest,
  servedPath,
} from "@your-move/dictionary";
import type { ResourceCatalog, ResourceKind, ResourceMeta, Resources } from "@your-move/sdk";

/**
 * What a runtime supplies about the built-in dictionaries: the build's index, and a loader for one
 * word list. `loadText` resolves only once it holds the whole text and rejects on any failure; the
 * core adds the timeout and the brief negative cache of 10 M3 around it.
 */
export interface BuiltinDictionaries {
  readonly index: DictionaryIndex;
  loadText(manifest: DictionaryManifest): Promise<string>;
}

/** No built-in dictionaries: for apps that never play a game (the OpenAPI document generator). */
export const NO_DICTIONARIES: BuiltinDictionaries = {
  index: { dictionaries: [], globalRemovals: [] },
  loadText: () => Promise.reject(new Error("no dictionaries")),
};

export interface ResourceProvider {
  /** Metadata of what this user may use in a new game (`OptionsContext.resources`, the catalog). */
  listForUser(kind: ResourceKind, userId: string): ResourceCatalog;
  /** Whether the user may use this resource in a new game (02 §2.1 rule 7). */
  authorizeForNewGame(kind: ResourceKind, id: string, userId: string): boolean;
  /** Every enabled built-in and operator resource, for `checkConfig` (02 §2.1 rule 8). */
  enabled(): ResourceCatalog;
  /** Metadata of any resource a game may use, enabled or not (the game envelope). */
  describe(kind: ResourceKind, id: string): ResourceMeta | undefined;
  /** Loads the resources of a game for `validate` and `preview` (02 §2.1 rule 6). */
  load(resources: readonly { kind: string; resourceId: string }[]): Promise<Resources>;
  /** The module error code an authorisation failure is reported as (02 §2.1 rule 7). */
  unknownCode(kind: ResourceKind): string;
}

/** Thrown when `DICTIONARIES_ENABLED` names a dictionary this build doesn't have. */
export class ResourceConfigError extends Error {
  override readonly name = "ResourceConfigError";
}

export interface ResourceProviderOptions {
  readonly dictionaries: BuiltinDictionaries;
  /** `DICTIONARIES_ENABLED`; null for every built-in one. */
  readonly enabled: readonly string[] | null;
  readonly now: () => number;
  /** How long one word-list load may take. */
  readonly timeoutMs?: number;
  /** How long a failed load is remembered before it is tried again. */
  readonly failureTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_FAILURE_TTL_MS = 30_000;

/** Thrown for a load refused because the same list failed moments ago. */
export class DictionaryUnavailableError extends Error {
  override readonly name = "DictionaryUnavailableError";
}

/**
 * Wraps a runtime's `loadText` with the 10 M3 contract's timeout and negative cache: a load that
 * takes too long fails, and for a short while after a failure the list isn't fetched again, so an
 * unavailable asset can't be refetched on every request.
 */
function resilient(
  load: BuiltinDictionaries["loadText"],
  options: {
    readonly now: () => number;
    readonly timeoutMs: number;
    readonly failureTtlMs: number;
  },
): BuiltinDictionaries["loadText"] {
  const failedAt = new Map<string, number>();
  return async (manifest) => {
    const failed = failedAt.get(manifest.id);
    if (failed !== undefined && options.now() - failed < options.failureTtlMs) {
      throw new DictionaryUnavailableError(`dictionary ${manifest.id} failed to load recently`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DictionaryUnavailableError(`dictionary ${manifest.id} took too long to load`));
      }, options.timeoutMs);
    });
    try {
      const text = await Promise.race([load(manifest), timeout]);
      failedAt.delete(manifest.id);
      return text;
    } catch (error) {
      failedAt.set(manifest.id, options.now());
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createResourceProvider(options: ResourceProviderOptions): ResourceProvider {
  const { index } = options.dictionaries;
  const known = new Set(index.dictionaries.map((manifest) => manifest.id));
  for (const id of options.enabled ?? []) {
    if (!known.has(id)) {
      throw new ResourceConfigError(
        `DICTIONARIES_ENABLED: "${id}" is not a built-in dictionary of this build`,
      );
    }
  }
  const provider = createDictionaryProvider({
    index,
    loadText: resilient((manifest) => options.dictionaries.loadText(manifest), {
      now: options.now,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      failureTtlMs: options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS,
    }),
  });
  const manifests = new Map(index.dictionaries.map((manifest) => [manifest.id, manifest]));
  // Built-in lists are public: the framework sets their versioned, hashed download URL (words §9.4).
  const all: ResourceCatalog = Object.freeze(
    provider.catalog().map((meta) => {
      const manifest = manifests.get(meta.id);
      return Object.freeze(
        manifest === undefined ? meta : { ...meta, downloadUrl: servedPath(manifest) },
      );
    }),
  );
  const enabledIds = new Set(options.enabled ?? known);
  const enabled: ResourceCatalog = Object.freeze(all.filter((meta) => enabledIds.has(meta.id)));

  return {
    // Every enabled built-in is open to everyone; uploads (M6) are the owner's alone.
    listForUser: () => enabled,
    // Dictionaries are the only kind (02 §2.1 rule 7).
    authorizeForNewGame: (_kind, id) => enabledIds.has(id),
    enabled: () => enabled,
    describe: (_kind, id) => all.find((meta) => meta.id === id),
    async load(resources) {
      let dictionary: Resources["dictionary"];
      for (const resource of resources) {
        if (resource.kind !== "dictionary") continue;
        const list = await provider.load(resource.resourceId);
        if (list !== undefined) dictionary = list;
      }
      return dictionary === undefined ? {} : { dictionary };
    },
    unknownCode: () => "UNKNOWN_DICTIONARY",
  };
}
