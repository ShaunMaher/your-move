import { describe, expect, it } from "vitest";

import { checkManifest } from "./manifest.js";
import { asEngines, toyGame, toyManifest } from "./test-support.js";

describe("checkManifest", () => {
  it("accepts a manifest that agrees with its engine", () => {
    expect(checkManifest(toyManifest, asEngines(toyGame()))).toEqual([]);
  });

  it("reports every disagreement", () => {
    const toy = toyGame();
    const engines = {
      1: { ...toy, type: "other" },
      2: { ...toy, version: 3, resources: () => [{ kind: "dictionary" as const, id: "d" }] },
    };
    expect(
      checkManifest(
        {
          ...toyManifest,
          type: "Bad",
          icon: "",
          hiddenInformation: false,
          players: { min: 3, max: 3 },
        },
        engines,
      ),
    ).toEqual([
      'manifest type "Bad" must match ^[a-z][a-z0-9]{1,31}$',
      "manifest icon: is empty",
      'rules version 1: engine type "other" differs from manifest type "Bad"',
      "rules version 1: hiddenInformation differs between the engine and the manifest",
      "rules version 1: players 2–3 are outside the manifest's 3–3",
      "rules version 2: the definition says version 3",
      'rules version 2: engine type "toy" differs from manifest type "Bad"',
      "rules version 2: hiddenInformation differs between the engine and the manifest",
      "rules version 2: the manifest has no rules text for it",
      "rules version 2: players 2–3 are outside the manifest's 3–3",
      'rules version 2: requests a "dictionary" resource the manifest doesn\'t list',
    ]);
  });

  it("reports an engine with no rules version", () => {
    expect(checkManifest(toyManifest, {})).toEqual(["the engine exports no rules version"]);
  });

  it("leaves exceptions and refused options to the kit", () => {
    const toy = toyGame();
    const throwing = {
      ...toy,
      players: () => {
        throw new Error("x");
      },
    };
    expect(checkManifest(toyManifest, { 1: throwing }, [{}, { bad: 1 }])).toEqual([]);
    const refusing = {
      ...toy,
      resolveOptions: () => {
        throw new Error("y");
      },
    };
    expect(checkManifest(toyManifest, { 1: refusing })).toEqual([]);
    expect(checkManifest(toyManifest, { 1: { ...toy, configSchema: toy.actionSchema } })).toEqual(
      [],
    );
  });
});
