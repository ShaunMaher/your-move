/** Unit tests of the framework's small parts: ranking, settings, randomness, resources, registry. */
import type { DictionaryManifest } from "@your-move/dictionary";
import { type AnyGameDefinition, OK } from "@your-move/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { GamePlayerRecord, GameRecord } from "../db/repositories.js";
import { ApiError } from "../http/api-error.js";
import { accept, LOBBY_LIFETIME_MS, rerank, start } from "./lifecycle.js";
import { cryptoRandom, recorded } from "./random.js";
import { createGameRegistry, GameConfigError } from "./registry.js";
import {
  createResourceProvider,
  DictionaryUnavailableError,
  ResourceConfigError,
} from "./resources.js";
import { lastOptionsOf, mergeOptions, rememberedInput } from "./settings.js";

describe("rerank (02 §4 Ranking)", () => {
  it("drops declined seats and re-ranks the rest with standard competition ranking", () => {
    const ranked = rerank(
      [
        { seat: 2, rank: 1, score: 9 },
        { seat: 0, rank: 2, score: 5 },
        { seat: 1, rank: 2, score: 5 },
        { seat: 3, rank: 4 },
      ],
      new Set([2]),
    );
    expect([...ranked.entries()].sort()).toEqual([
      [0, { rank: 1, score: 5 }],
      [1, { rank: 1, score: 5 }],
      [3, { rank: 3 }],
    ]);
  });
});

describe("remembered options (05 §Remembered options)", () => {
  it("merges top-level keys, request keys winning; only objects merge", () => {
    expect(mergeOptions({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 1, b: 3 });
    expect(mergeOptions(undefined, { b: 3 })).toEqual({ b: 3 });
    expect(mergeOptions("x", { b: 3 })).toBe("x");
    expect(mergeOptions({ a: 1 }, ["no"])).toEqual({ a: 1 });
  });

  it("reads remembered options only from an object, and survives unreadable settings", () => {
    const stored = JSON.stringify({ lastOptions: { words: { a: 1 } }, lastGameType: "words" });
    expect(lastOptionsOf(stored, "words")).toEqual({ a: 1 });
    expect(lastOptionsOf("not json", "words")).toBeUndefined();
    expect(lastOptionsOf("[1]", "words")).toBeUndefined();
  });

  it("doesn't remember an input too large to be worth keeping", () => {
    expect(rememberedInput(undefined)).toBe("{}");
    expect(rememberedInput({ a: 1 })).toBe('{"a":1}');
    expect(rememberedInput({ big: "x".repeat(5000) })).toBeNull();
  });
});

describe("the recorded WebCrypto source", () => {
  it("records every draw as [max, value] and stays in range", () => {
    const { rng, draws } = recorded(cryptoRandom());
    for (const max of [1, 2, 7, 2 ** 32]) {
      const value = rng.nextInt(max);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(max);
    }
    expect(draws.map(([max]) => max)).toEqual([1, 2, 7, 2 ** 32]);
    expect(() => rng.nextInt(0)).toThrow(RangeError);
  });

  it("is roughly uniform", () => {
    const { rng } = recorded(cryptoRandom());
    const counts = [0, 0, 0];
    for (let i = 0; i < 3000; i++) {
      const value = rng.nextInt(3);
      counts[value] = (counts[value] ?? 0) + 1;
    }
    for (const count of counts) expect(count).toBeGreaterThan(800);
  });
});

function manifest(id: string): DictionaryManifest {
  return {
    id,
    version: 1,
    name: id,
    description: id,
    language: "en",
    licence: "CC0-1.0",
    sourceUrl: "https://example.org/list.txt",
    sha256: "0".repeat(64),
    distribution: "public",
    wordCount: 1,
    alphabet: ["a"],
    wordsSha256: "a".repeat(64),
    bytes: 3,
    skipped: { length: 0, characters: 0 },
  };
}

describe("the resource provider", () => {
  const index = { dictionaries: [manifest("one"), manifest("two")], globalRemovals: [] };

  it("offers the enabled built-ins with their download URL, and describes any of them", () => {
    const provider = createResourceProvider({
      dictionaries: { index, loadText: () => Promise.resolve("aa\n") },
      enabled: ["two"],
      now: () => 0,
    });
    expect(provider.listForUser("dictionary", "u").map((meta) => meta.id)).toEqual(["two"]);
    expect(provider.enabled().map((meta) => meta.id)).toEqual(["two"]);
    expect(provider.authorizeForNewGame("dictionary", "two", "u")).toBe(true);
    expect(provider.authorizeForNewGame("dictionary", "one", "u")).toBe(false);
    expect(provider.describe("dictionary", "one")?.downloadUrl).toBe(
      `/assets/dictionaries/one-v1.${"a".repeat(16)}.txt`,
    );
    expect(provider.unknownCode("dictionary")).toBe("UNKNOWN_DICTIONARY");
  });

  it("refuses DICTIONARIES_ENABLED naming an unknown dictionary", () => {
    expect(() =>
      createResourceProvider({
        dictionaries: { index, loadText: () => Promise.resolve("") },
        enabled: ["three"],
        now: () => 0,
      }),
    ).toThrow(ResourceConfigError);
  });

  it("times a load out, and remembers a failure briefly before trying again", async () => {
    let clock = 0;
    let calls = 0;
    const provider = createResourceProvider({
      dictionaries: {
        index,
        loadText: () => {
          calls += 1;
          return calls === 1 ? new Promise<string>(() => undefined) : Promise.resolve("aa\n");
        },
      },
      enabled: null,
      now: () => clock,
      timeoutMs: 5,
      failureTtlMs: 1000,
    });
    const load = () => provider.load([{ kind: "dictionary", resourceId: "one" }]);
    await expect(load()).rejects.toThrow(DictionaryUnavailableError);
    await expect(load()).rejects.toThrow(/recently/u);
    expect(calls).toBe(1);
    clock = 1000;
    // The list's size and hash don't match its manifest: still a failure, but a fresh attempt.
    await expect(load()).rejects.toThrow();
    expect(calls).toBe(2);
    expect(await provider.load([{ kind: "other", resourceId: "x" }])).toEqual({});
  });

  it("remembers a list whose size or hash doesn't match: not fetched or hashed again at once (S-6)", async () => {
    let clock = 0;
    let calls = 0;
    const provider = createResourceProvider({
      dictionaries: {
        index,
        loadText: () => {
          calls += 1;
          return Promise.resolve("not the manifest's list\n");
        },
      },
      enabled: null,
      now: () => clock,
      failureTtlMs: 1000,
    });
    const load = () => provider.load([{ kind: "dictionary", resourceId: "one" }]);
    await expect(load()).rejects.toThrow(/one/u);
    await expect(load()).rejects.toThrow(DictionaryUnavailableError);
    await expect(load()).rejects.toThrow(DictionaryUnavailableError);
    expect(calls).toBe(1);
    clock = 1000;
    await expect(load()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

/** A minimal definition: only what the registry reads. */
function definition(version: number, overrides: Partial<AnyGameDefinition> = {}) {
  return {
    type: "toy",
    version,
    configSchema: z.object({ LEVEL: z.string().optional() }).strict(),
    checkConfig: () => OK,
    ...overrides,
  } as unknown as AnyGameDefinition;
}

const toyManifest = {
  type: "toy",
  name: "Toy",
  description: "",
  icon: "",
  licence: "MIT",
  resources: [],
  hiddenInformation: false,
  players: { min: 2, max: 2 },
  rules: {},
};

describe("the games registry (02 §7.3)", () => {
  it("picks the latest rules version, keeps the others, and parses only the module's own keys", () => {
    const registry = createGameRegistry(
      [
        {
          manifest: toyManifest,
          engines: { 1: definition(1), 2: definition(2) },
          enabledByDefault: true,
        },
      ],
      { gameConfig: { toy: { LEVEL: "3" } }, enabledGames: ["toy"], resources: [] },
    );
    const toy = registry.get("toy");
    expect(toy?.latest.version).toBe(2);
    expect(toy?.engine(1)?.version).toBe(1);
    expect(toy?.engine(3)).toBeUndefined();
    expect(toy?.config).toEqual({ LEVEL: "3" });
    expect(registry.enabled().map((type) => type.type)).toEqual(["toy"]);
    expect(registry.get("other")).toBeUndefined();
  });

  it("names every failing key and never a value", () => {
    const failing = definition(1, {
      checkConfig: () => ({ code: "BAD_LEVEL", detail: { key: "LEVEL" } }),
    });
    try {
      createGameRegistry(
        [{ manifest: toyManifest, engines: { 1: failing }, enabledByDefault: true }],
        {
          gameConfig: { toy: { LEVEL: "secret-value" } },
          enabledGames: [],
          resources: [],
        },
      );
      throw new Error("accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(GameConfigError);
      expect((error as GameConfigError).issues).toEqual([
        "GAMES_TOY_LEVEL: refused by the toy game (BAD_LEVEL)",
      ]);
    }
    expect(() =>
      createGameRegistry([{ manifest: toyManifest, engines: {}, enabledByDefault: true }], {
        gameConfig: {},
        enabledGames: [],
        resources: [],
      }),
    ).toThrow(/exports no rules version/u);
    const unknownKey = () =>
      createGameRegistry(
        [{ manifest: toyManifest, engines: { 1: definition(1) }, enabledByDefault: true }],
        {
          gameConfig: { toy: { COLOUR: "secret-value" } },
          enabledGames: [],
          resources: [],
        },
      );
    expect(unknownKey).toThrow(GameConfigError);
    expect(unknownKey).not.toThrow(/secret-value/u);
  });
});

describe("ApiError", () => {
  it("answers framework codes with their status and module codes with 400, detail as-is", () => {
    const framework = ApiError.of("NOT_YOUR_TURN");
    expect([framework.status, framework.body()]).toEqual([
      409,
      { error: { code: "NOT_YOUR_TURN", message: "It isn't your turn." } },
    ]);
    const module = ApiError.module("NOT_IN_HAND", { card: 3 });
    expect([module.status, module.body().error.code, module.body().error.detail]).toEqual([
      400,
      "NOT_IN_HAND",
      { card: 3 },
    ]);
  });
});

describe("an automatic start validateStart refuses (02 §4 Start, step 2)", () => {
  it("doesn't happen: the accept alone is written, and the game waits for the creator", () => {
    const row = (
      id: string,
      state: GamePlayerRecord["state"],
      joinedVia: GamePlayerRecord["joinedVia"],
    ) =>
      ({
        id,
        state,
        joinedVia,
        joinedAt: state === "joined" ? 1 : null,
        seat: null,
      }) as GamePlayerRecord;
    const creator = row("a", "joined", "creator");
    const invited = row("b", "invited", null);
    const ctx = {
      game: { status: "lobby", seats: 2, aiAssistance: "off", seatOrder: "join" } as GameRecord,
      players: [creator, invited],
      definition: {
        validateStart: () => ({ code: "NOPE" }),
        players: () => ({ min: 2, max: 2 }),
      } as unknown as AnyGameDefinition,
      options: {},
      state: null,
      random: cryptoRandom(),
    };
    expect(accept(ctx, invited, 5)).toEqual({
      game: { updatedAt: 5 },
      updatePlayers: [
        {
          id: "b",
          set: { state: "joined", joinedVia: "invitation", joinedAt: 5, inviteEmail: null },
        },
      ],
    });
  });
});

describe("start and accept at the lobby's expiry (A2 review S2-5)", () => {
  const row = (id: string, state: GamePlayerRecord["state"], joinedVia: "creator" | null) =>
    ({
      id,
      state,
      joinedVia,
      joinedAt: state === "joined" ? 1 : null,
      seat: null,
    }) as GamePlayerRecord;
  const creator = row("a", "joined", "creator");
  const invited = row("b", "invited", null);
  const ctx = {
    game: {
      status: "lobby",
      createdAt: 1000,
      seats: 2,
      aiAssistance: "off",
      seatOrder: "join",
    } as GameRecord,
    players: [creator, row("c", "joined", null), invited],
    definition: {
      players: () => ({ min: 2, max: 3 }),
      validateStart: () => OK,
    } as unknown as AnyGameDefinition,
    options: {},
    state: null,
    random: cryptoRandom(),
  };
  const due = 1000 + LOBBY_LIFETIME_MS;

  it("refuse a lobby at or past its expiry, even one still marked lobby", () => {
    expect(start(ctx, creator, due)).toEqual({ refused: "WRONG_STATUS" });
    expect(accept(ctx, invited, due + 5)).toEqual({ refused: "WRONG_STATUS" });
  });

  it("accept a lobby a moment before it", () => {
    expect(accept(ctx, invited, due - 1)).not.toHaveProperty("refused");
  });
});
