import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadGames, type LoadedGame } from "./load.js";
import { nodeModulesResolver } from "./packages.js";
import { verifyGames } from "./verify.js";

/** Fixture packages as a registry would install them (scripts/test-fixtures/games/node_modules). */
const FIXTURES = fileURLToPath(new URL("../../test-fixtures/games", import.meta.url));
const resolvePackage = nodeModulesResolver(FIXTURES);
const SDK_DIR = join(FIXTURES, "node_modules/@your-move/sdk");

async function load(
  ...games: ({ package: string; acceptLicence?: string } | string)[]
): Promise<readonly LoadedGame[]> {
  const result = await loadGames(
    { games: games.map((game) => (typeof game === "string" ? { package: game } : game)) },
    resolvePackage,
  );
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.games;
}

async function verify(...games: Parameters<typeof load>): Promise<string[]> {
  return verifyGames({
    rootDir: FIXTURES,
    games: await load(...games),
    sdkVersion: "1.2.0",
    sdkDir: SDK_DIR,
  });
}

describe("games:verify", () => {
  it("passes a well-formed package that reaches only the SDK, Zod, React and its own files", async () => {
    expect(await verify("@fixture/game-good")).toEqual([]);
  });

  it("lets a client import the packages in its own dependencies", async () => {
    expect(await verify("@fixture/game-clientdep")).toEqual([]);
  });

  it("passes an empty instance", async () => {
    expect(await verify()).toEqual([]);
  });

  it.each<[string, Parameters<typeof load>, RegExp]>([
    [
      "two packages declaring the same type",
      ["@fixture/game-good", "@fixture/game-twin"],
      /game-twin: type "good" is already declared by @fixture\/game-good/u,
    ],
    ["an invalid type id", ["@fixture/game-badtype"], /type "Bad-Type" must match/u],
    [
      "an SDK range that excludes the instance's SDK",
      ["@fixture/game-oldsdk"],
      /peer range "\^2\.0\.0" does not include this instance.s SDK 1\.2\.0/u,
    ],
    [
      "no @your-move/sdk peer dependency",
      ["@fixture/game-peerless"],
      /must declare @your-move\/sdk as a peer dependency/u,
    ],
    [
      "a licence outside the allow-list",
      ["@fixture/game-gpl"],
      /licence "GPL-3\.0-only" is not on the allow-list/u,
    ],
    [
      "a manifest licence that differs from package.json",
      ["@fixture/game-mismatch"],
      /manifest licence "MIT" differs from package\.json "ISC"/u,
    ],
    [
      "the SDK, Zod or React as dependencies",
      ["@fixture/game-deps"],
      /zod must be peer dependencies, not dependencies/u,
    ],
    ["a peer outside the SDK, React and Zod", ["@fixture/game-deps"], /found lodash/u],
    [
      "an engine importing node:fs",
      ["@fixture/game-fs"],
      /game-engine-imports: .*engine\/index\.js must not reach (node:)?fs/u,
    ],
    [
      "an engine reaching a client-only dependency through its own files",
      ["@fixture/game-deep"],
      /game-engine-imports: .* must not reach .*left-pad/u,
    ],
    [
      "an engine importing @your-move/sdk/client",
      ["@fixture/game-sdkclient"],
      /game-engine-no-sdk-client/u,
    ],
    [
      "a client importing a package other than the SDK, React and Zod",
      ["@fixture/game-clientdeps"],
      /game-client-imports: .* must not reach .*left-pad/u,
    ],
  ])("fails %s", async (_label, games, expected) => {
    const problems = await verify(...games);
    expect(
      problems.some((problem) => expected.test(problem)),
      problems.join("\n"),
    ).toBe(true);
  });

  it("accepts a licence outside the allow-list when the instance accepts it explicitly", async () => {
    expect(await verify({ package: "@fixture/game-gpl", acceptLicence: "GPL-3.0-only" })).toEqual(
      [],
    );
    expect(await verify({ package: "@fixture/game-gpl", acceptLicence: "MPL-2.0" })).toHaveLength(
      1,
    );
  });
});

describe("loading installed packages", () => {
  it.each<[string, string, RegExp]>([
    ["not installed", "@fixture/game-absent", /not installed/u],
    ["missing an entry point", "@fixture/game-noclient", /missing the "\.\/client" entry point/u],
    [
      "an invalid manifest",
      "@fixture/game-badmanifest",
      /manifest export is invalid \(.*name.*\)/u,
    ],
    [
      "an engine without an engines map",
      "@fixture/game-noengines",
      /must export an "engines" map/u,
    ],
  ])("reports a package %s", async (_label, name, expected) => {
    const result = await loadGames({ games: [{ package: name }] }, resolvePackage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join("\n")).toMatch(expected);
  });

  it("records rules versions and the enabled default", async () => {
    const result = await loadGames(
      { games: [{ package: "@fixture/game-good", enabled: false }] },
      resolvePackage,
    );
    expect(result).toMatchObject({
      ok: true,
      games: [{ rulesVersions: [1], enabledByDefault: false, manifest: { type: "good" } }],
    });
  });
});
