import { describe, expect, it } from "vitest";

import type { InstalledGame } from "../app.js";
import { findOrphans, installedSchema, registryMismatches, type Installed } from "./installed.js";

const INSTALLED: Installed = {
  words: {
    package: "@your-move/game-words",
    version: "1.2.0",
    rulesVersions: [1, 2],
    enabledByDefault: true,
  },
};

function game(type: string, versions: number[]): InstalledGame {
  return {
    manifest: {
      type,
      name: type,
      description: "",
      icon: "",
      licence: "MIT",
      resources: [],
      hiddenInformation: false,
      players: { min: 2, max: 2 },
      rules: {},
    },
    engines: Object.fromEntries(versions.map((version) => [version, {}])),
    enabledByDefault: true,
  };
}

describe("findOrphans", () => {
  it("finds games of a removed type and of a dropped rules version", () => {
    expect(
      findOrphans(
        [
          { id: "a", game_type: "words", game_version: 2 },
          { id: "b", game_type: "words", game_version: 3 },
          { id: "c", game_type: "paths", game_version: 1 },
        ],
        INSTALLED,
      ),
    ).toEqual([
      { id: "b", gameType: "words", gameVersion: 3, reason: "rules version not exported" },
      { id: "c", gameType: "paths", gameVersion: 1, reason: "type not installed" },
    ]);
  });

  it("finds nothing when every live game has an engine", () => {
    expect(findOrphans([{ id: "a", game_type: "words", game_version: 1 }], INSTALLED)).toEqual([]);
  });
});

describe("installedSchema", () => {
  it("accepts what games:generate writes", () => {
    expect(installedSchema.parse({})).toEqual({});
    expect(installedSchema.parse(INSTALLED)).toEqual(INSTALLED);
  });

  it.each([
    { Words: INSTALLED["words"] },
    { words: { ...INSTALLED["words"], rulesVersions: ["1"] } },
    { words: { ...INSTALLED["words"], extra: true } },
  ])("rejects malformed data %#", (data) => {
    expect(installedSchema.safeParse(data).success).toBe(false);
  });
});

describe("registryMismatches", () => {
  it("is empty when the registry matches installed.json", () => {
    expect(registryMismatches([game("words", [2, 1])], INSTALLED)).toEqual([]);
    expect(registryMismatches([], {})).toEqual([]);
  });

  it("reports extra, missing and differing types", () => {
    expect(registryMismatches([game("words", [1]), game("paths", [1])], INSTALLED)).toEqual([
      'game type "words" exports different rules versions than installed.json lists',
      'registry has game type "paths", installed.json does not',
    ]);
    expect(registryMismatches([], INSTALLED)).toEqual([
      'installed.json lists "words", the registry does not',
    ]);
  });
});
