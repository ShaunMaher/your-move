import type { IForbiddenRuleType } from "dependency-cruiser";
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

interface To {
  path?: unknown;
  pathNot?: unknown;
  reachable?: unknown;
}

/** The rule's `to` restriction, whichever rule shape it is. */
function to(rule: IForbiddenRuleType): To {
  const restriction: To = "to" in rule ? rule.to : {};
  return restriction;
}

function rule(name: string, rules = gamePackageRules(layout)): IForbiddenRuleType {
  const found = rules.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no rule ${name}`);
  return found;
}

describe("gamePackageRules", () => {
  it("builds the import rules, all errors", () => {
    const rules = gamePackageRules(layout);
    expect(rules.map((candidate) => candidate.name)).toEqual([
      "game-engine-imports",
      "game-engine-no-sdk-client",
      "game-manifest-imports",
      "game-manifest-no-sdk-client",
      "game-client-imports",
      "game-no-direct-zod",
    ]);
    for (const candidate of rules) expect(candidate.severity).toBe("error");
    for (const candidate of rules.slice(0, 5)) expect(to(candidate).reachable).toBe(true);
  });

  it.each(["engine", "manifest"])(
    "lets the %s reach only its own files, the SDK and Zod (through the SDK)",
    (part) => {
      expect(to(rule(`game-${part}-imports`)).pathNot).toEqual([layout.ownFiles, SDK, ZOD]);
      expect(to(rule(`game-${part}-no-sdk-client`)).path).toBe(`${SDK}(src|dist)/client[.]`);
    },
  );

  it("forbids importing Zod directly from any of the package's files", () => {
    expect(rule("game-no-direct-zod")).toMatchObject({
      from: { path: "^dist/" },
      to: { path: ZOD },
    });
  });

  it("turns $1 group references into one path segment where they can't be groups", () => {
    const rules = gamePackageRules({ ...layout, ownFiles: "^games/$1/src/" });
    expect(rule("game-no-direct-zod", rules).from).toEqual({ path: "^games/[^/]+/src/" });
    expect(to(rule("game-engine-imports", rules)).pathNot).toContain("^games/$1/src/");
  });

  it("lets the client reach React and its own dependencies too", () => {
    const rules = gamePackageRules({ ...layout, clientDependencies: ["left-pad", "@scope/x.y"] });
    expect(to(rule("game-client-imports", rules)).pathNot).toEqual([
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
    expect(to(rule("game-engine-imports", rules)).pathNot).toContain("^packages/sdk/");
    expect(to(rule("game-engine-no-sdk-client", rules)).path).toBe(
      "^packages/sdk/(src|dist)/client[.]",
    );
  });
});
