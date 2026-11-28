import { isGameType } from "@your-move/sdk";
import { checkIcon } from "@your-move/testkit";
import { describe, expect, it } from "vitest";

import { client } from "./client/index.js";
import { engines } from "./engine/index.js";
import { manifest } from "./manifest.js";
import { OPTIONS } from "./test-support.js";

describe("paths manifest (02 §7.2)", () => {
  it("is a valid, BSD-2-Clause licensed manifest", () => {
    expect(isGameType(manifest.type)).toBe(true);
    expect(manifest.licence).toBe("BSD-2-Clause");
  });

  it("agrees with every exported engine", () => {
    for (const [version, engine] of Object.entries(engines)) {
      expect(engine.version).toBe(Number(version));
      expect(engine.type).toBe(manifest.type);
      expect(engine.test.hiddenInformation).toBe(manifest.hiddenInformation);
      expect(engine.players(OPTIONS)).toEqual(manifest.players);
      expect(manifest.rules[engine.version]).toMatch(/^# Paths\n/u);
      expect(engine.resources(OPTIONS)).toEqual([]);
    }
  });

  it("has rules in Markdown without HTML or trademarked names", () => {
    for (const rules of Object.values(manifest.rules)) {
      expect(rules).not.toMatch(/[<>]/u);
      expect(rules).not.toMatch(/tsuro|dragon/iu);
    }
  });

  it("has an icon of basic shapes only that passes the icon allow-list", () => {
    expect(checkIcon(manifest.icon)).toEqual([]);
    const elements = [...manifest.icon.matchAll(/<([a-z]+)/gu)].map((match) => match[1]);
    expect(new Set(elements)).toEqual(new Set(["svg", "rect", "path", "circle"]));
  });

  it("has no client module yet (the board UI is the next slice)", () => {
    expect(client).toBeNull();
  });
});
