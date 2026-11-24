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
      "rules version 2: the definition says version 3",
      'rules version 2: engine type "toy" differs from manifest type "Bad"',
      "rules version 2: hiddenInformation differs between the engine and the manifest",
      "rules version 2: the manifest has no rules text for it",
      'rules version 2: requests a "dictionary" resource the manifest doesn\'t list',
      "the engines allow 2–3 players over their option inputs, but the manifest says 3–3",
    ]);
  });

  it("requires the manifest's players to equal the union of the engines' bounds", () => {
    const toy = toyGame();
    const narrow = { ...toy, players: () => ({ min: 2, max: 2 }) };
    expect(checkManifest(toyManifest, { 1: narrow })).toEqual([
      "the engines allow 2–2 players over their option inputs, but the manifest says 2–3",
    ]);
    const byOption = {
      ...toy,
      players: (options: { open?: boolean | undefined }) => ({
        min: 2,
        max: options.open === true ? 3 : 2,
      }),
    };
    expect(checkManifest(toyManifest, { 1: byOption })).toEqual([]);
    expect(checkManifest(toyManifest, { 1: byOption }, { optionInputs: [{}] })).toHaveLength(1);
  });

  it("uses the module's test.context, or the override", () => {
    const toy = toyGame();
    const withContext = {
      ...toy,
      configSchema: toy.actionSchema,
      test: { ...toy.test, context: () => ({ config: { card: 1 }, resources: [] }) },
    };
    expect(
      checkManifest({ ...toyManifest, players: { min: 1, max: 1 } }, { 1: withContext }),
    ).toHaveLength(1);
    expect(
      checkManifest(
        { ...toyManifest, players: { min: 1, max: 1 } },
        { 1: { ...toy, configSchema: toy.actionSchema } },
        {
          context: { config: {}, resources: [] },
        },
      ),
    ).toHaveLength(1);
  });

  it("accepts resource requests of a kind the manifest lists", () => {
    const toy = toyGame();
    const engines = { 1: { ...toy, resources: () => [{ kind: "dictionary" as const, id: "d" }] } };
    expect(checkManifest({ ...toyManifest, resources: ["dictionary"] }, engines)).toEqual([]);
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
    expect(checkManifest(toyManifest, { 1: throwing }, { optionInputs: [{}, { bad: 1 }] })).toEqual(
      [],
    );
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
