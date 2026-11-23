import { describe, expect, it } from "vitest";

import { gamePackageRules } from "./index.js";

const layout = {
  engineEntry: "^dist/engine/index\\.js$",
  clientEntry: "^dist/client/index\\.js$",
  manifestEntry: "^dist/manifest\\.js$",
  ownFiles: "^dist/",
};
const SDK = "(^|/)node_modules/@your-move/sdk/";
const ZOD = "(^|/)node_modules/zod/";

function rule(name: string, rules = gamePackageRules(layout)) {
  const found = rules.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no rule ${name}`);
  return found;
}

describe("gamePackageRules", () => {
  it("builds reachability rules, all errors", () => {
    const rules = gamePackageRules(layout);
    expect(rules.map((candidate) => candidate.name)).toEqual([
      "game-engine-imports",
      "game-engine-no-sdk-client",
      "game-manifest-imports",
      "game-manifest-no-sdk-client",
      "game-client-imports",
    ]);
    for (const candidate of rules) {
      expect(candidate.severity).toBe("error");
      expect(candidate.to.reachable).toBe(true);
    }
  });

  it.each(["engine", "manifest"])(
    "lets the %s reach only its own files, the SDK and Zod",
    (part) => {
      expect(rule(`game-${part}-imports`).to.pathNot).toEqual([layout.ownFiles, SDK, ZOD]);
      expect(rule(`game-${part}-no-sdk-client`).to.path).toBe(`${SDK}(src|dist)/client[.]`);
    },
  );

  it("lets the client reach React and its own dependencies too", () => {
    const rules = gamePackageRules({ ...layout, clientDependencies: ["left-pad", "@scope/x.y"] });
    expect(rule("game-client-imports", rules).to.pathNot).toEqual([
      layout.ownFiles,
      SDK,
      ZOD,
      "(^|/)node_modules/react/",
      "(^|/)node_modules/left-pad/",
      "(^|/)node_modules/@scope/x\\.y/",
    ]);
  });

  it("uses a source-linked SDK path when one is given", () => {
    const rules = gamePackageRules({ ...layout, sdk: "^packages/sdk/" });
    expect(rule("game-engine-imports", rules).to.pathNot).toContain("^packages/sdk/");
    expect(rule("game-engine-no-sdk-client", rules).to.path).toBe(
      "^packages/sdk/(src|dist)/client[.]",
    );
  });
});
