import { isGameType } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import { client } from "./client/index.js";
import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";

describe("example manifest (02 §7.2)", () => {
  it("is a valid, BSD-2-Clause licensed manifest", () => {
    expect(isGameType(manifest.type)).toBe(true);
    expect(manifest.licence).toBe("BSD-2-Clause");
  });

  it("agrees with every exported engine and the client", () => {
    for (const [version, engine] of Object.entries(engines)) {
      expect(engine.version).toBe(Number(version));
      expect(engine.type).toBe(manifest.type);
      expect(engine.test.hiddenInformation).toBe(manifest.hiddenInformation);
      expect(engine.players(engine.optionsSchema.parse({ handSize: 3, lives: 2 }))).toEqual(
        manifest.players,
      );
      expect(manifest.rules[engine.version]).toMatch(/^# Example\n/u);
      expect(engine.resources({ handSize: 3, lives: 2 })).toEqual(manifest.resources);
    }
    expect(client.type).toBe(manifest.type);
    expect(client.versions).toEqual(Object.keys(engines).map(Number));
  });

  it("has rules in Markdown without HTML", () => {
    for (const rules of Object.values(manifest.rules)) expect(rules).not.toMatch(/[<>]/u);
  });

  it("has an icon of basic shapes only: no scripts, links, styles or foreign content", () => {
    expect(manifest.icon).toMatch(
      /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*<\/svg>$/u,
    );
    const elements = [...manifest.icon.matchAll(/<([a-z]+)/gu)].map((match) => match[1]);
    expect(new Set(elements)).toEqual(new Set(["svg", "rect", "circle"]));
    expect(manifest.icon).not.toMatch(/href|on[a-z]+=|style|url\(/iu);
  });
});
