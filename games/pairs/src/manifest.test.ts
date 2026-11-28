import { isGameType } from "@your-move/sdk";
import { checkIcon } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";
import { OPTIONS } from "./test-support.js";

describe("pairs manifest (02 §7.2, pairs §8.8)", () => {
  it("is a valid, BSD-2-Clause licensed manifest", () => {
    expect(isGameType(manifest.type)).toBe(true);
    expect(manifest.licence).toBe("BSD-2-Clause");
    expect(manifest.name).toBe("Pairs");
    expect(manifest.description).toBe("Turn over two cards at a time and find the matching pairs.");
  });

  it("agrees with every exported engine", () => {
    for (const [version, engine] of Object.entries(engines)) {
      expect(engine.version).toBe(Number(version));
      expect(engine.type).toBe(manifest.type);
      expect(engine.test.hiddenInformation).toBe(manifest.hiddenInformation);
      expect(engine.players(OPTIONS)).toEqual(manifest.players);
      expect(manifest.rules[engine.version]).toMatch(/^# Pairs\n/u);
      expect(engine.resources(OPTIONS)).toEqual([]);
    }
  });

  it("has rules in Markdown without HTML or trademarked names, stating what pairs §8.8 asks", () => {
    for (const rules of Object.values(manifest.rules)) {
      expect(rules).not.toMatch(/[<>]/u);
      expect(rules).not.toMatch(/memory|concentration/iu);
      expect(rules).toMatch(/1,296/u);
      expect(rules).toMatch(/until the next player turns over their first card/u);
      expect(rules).toMatch(/never which card/u);
      expect(rules).toMatch(/screenshots/u);
    }
  });

  it("has an icon of basic shapes only that passes the icon allow-list", () => {
    expect(checkIcon(manifest.icon)).toEqual([]);
    const elements = [...manifest.icon.matchAll(/<([a-z]+)/gu)].map((match) => match[1]);
    expect(new Set(elements)).toEqual(new Set(["svg", "rect", "path", "circle"]));
  });
});
