import { describe, expect, it } from "vitest";

import { GAME_RULE_DESCRIPTION, withGameRule } from "./sync.js";

const BASE = { extends: ["config:best-practices"], packageRules: [{ groupName: "Vitest" }] };

describe("withGameRule", () => {
  it("adds one labelled rule naming the installed game packages", () => {
    expect(withGameRule(BASE, ["@your-move/game-words", "@someone/game-hex"])).toEqual({
      extends: ["config:best-practices"],
      packageRules: [
        { groupName: "Vitest" },
        {
          description: GAME_RULE_DESCRIPTION,
          matchPackageNames: ["@someone/game-hex", "@your-move/game-words"],
          addLabels: ["game-package"],
        },
      ],
    });
  });

  it("replaces an existing rule and removes it when no games are installed", () => {
    const once = withGameRule(BASE, ["@your-move/game-words"]);
    expect(withGameRule(once, ["@your-move/game-words"])).toEqual(once);
    expect(withGameRule(once, [])).toEqual(BASE);
  });
});
