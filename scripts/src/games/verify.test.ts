import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import { loadGames, type LoadedGame } from "./load.js";
import { nodeModulesResolver, packageFileProblems } from "./packages.js";
import { resolveWorkspaceRange, verifyGames } from "./verify.js";
import { workspacePackageDirs } from "./workspace.js";

/**
 * Fixture packages as a registry would install them under scripts/test-fixtures/games/node_modules.
 * The game packages themselves are in registry/@fixture, linked from there, so they aren't under a
 * node_modules directory (which gitleaks' default config never scans).
 */
const FIXTURES = fileURLToPath(new URL("../../test-fixtures/games", import.meta.url));
const resolvePackage = nodeModulesResolver(FIXTURES);
const SDK_DIR = realpathSync(join(FIXTURES, "node_modules/@your-move/sdk"));

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
    workspaceDirs: new Set(),
  });
}

/** As `verify`, with the named fixture treated as a package of this workspace. */
async function verifyAsWorkspace(name: string): Promise<string[]> {
  return verifyGames({
    rootDir: FIXTURES,
    games: await load(name),
    sdkVersion: "1.2.0",
    sdkDir: SDK_DIR,
    workspaceDirs: new Set([realpathSync(join(FIXTURES, "node_modules", name))]),
  });
}

describe("games:verify", () => {
  it("passes a well-formed package that reaches only the SDK, Zod, React and its own files", async () => {
    expect(await verify("@fixture/game-good")).toEqual([]);
  });

  it("lets a client import the packages in its own dependencies", async () => {
    expect(await verify("@fixture/game-clientdep")).toEqual([]);
  });

  it("checks a workspace package's workspace: peer range like the published range", async () => {
    expect(await verifyAsWorkspace("@fixture/game-workspace")).toEqual([]);
  });

  it("refuses workspace: ranges in a package installed from a registry", async () => {
    expect((await verify("@fixture/game-workspace")).join("\n")).toMatch(
      /@your-move\/sdk "workspace:\^" uses the workspace: protocol, but the package isn't in this workspace/u,
    );
  });

  it("fails an engine importing zod directly instead of @your-move/sdk/schema", async () => {
    const problems = await verify("@fixture/game-zod");
    expect(problems.join("\n")).toMatch(/game-no-direct-zod/u);
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
      "another package.json inside the package (its imports map would redirect bundlers)",
      ["@fixture/game-nested"],
      /must not contain another package\.json \(dist\/engine\/package\.json\)/u,
    ],
    [
      "a CommonJS file anywhere in the package",
      ["@fixture/game-cjsfile"],
      /must not contain CommonJS \(dist\/engine\/helper\.cjs\)/u,
    ],
    [
      "a symlinked package.json inside the package (its target's browser map would redirect bundlers)",
      ["@fixture/game-pjlink"],
      /must not contain another package\.json \(dist\/engine\/package\.json\)/u,
    ],
    [
      "any symlink in a package from a registry",
      ["@fixture/game-outlink"],
      /must not contain a symlink \(dist\/vendor\)/u,
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
    [
      "whose exports add a condition a bundler might prefer",
      "@fixture/game-condswap",
      /exports\["\.\/engine"\] must be exactly \{ types, import \}/u,
    ],
    [
      "whose exports use the string shorthand",
      "@fixture/game-shorthand",
      /exports\["\.\/engine"\] must be exactly \{ types, import \}/u,
    ],
    ["with an imports map", "@fixture/game-importsmap", /must not have a package\.json "imports"/u],
    [
      "with a browser field",
      "@fixture/game-browserfield",
      /must not have a package\.json "browser"/u,
    ],
    ["that isn't ESM", "@fixture/game-commonjs", /must be ESM/u],
    [
      "whose import target is CommonJS",
      "@fixture/game-cjstarget",
      /exports\["\.\/engine"\]\.import is "\.\/dist\/engine\/index\.cjs"; it must end with \.js or \.mjs/u,
    ],
    [
      "whose types target isn't a declaration file",
      "@fixture/game-typestarget",
      /exports\["\.\/engine"\]\.types is "\.\/dist\/engine\/index\.js"; it must end with \.d\.ts or \.d\.mts/u,
    ],
    [
      "whose entry point is a symlink out of the package",
      "@fixture/game-symlink",
      /points at "\.\/dist\/engine\/index\.js", which is not a file inside the package/u,
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

describe("packageFileProblems", () => {
  /** A package directory holding `files` (path → content), removed after the test. */
  function packageWith(files: Record<string, string>): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "game-package-")));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    onTestFinished(() => {
      rmSync(dir, { recursive: true, force: true });
    });
    return dir;
  }

  const BUNDLED = {
    "package.json": "{}",
    "dist/engine/index.js": "export {};\n",
    "node_modules/left-pad/package.json": '{ "name": "left-pad" }',
    "node_modules/left-pad/index.js": "export default 1;\n",
  };

  it("refuses a node_modules directory (bundled dependencies) in a package from a registry", () => {
    expect(packageFileProblems("@x/game", packageWith(BUNDLED), false)).toEqual([
      "@x/game: must not contain a node_modules directory (node_modules) (02 §7.1.1)",
    ]);
  });

  it("refuses a symlink leading out of a workspace package", async () => {
    expect((await verifyAsWorkspace("@fixture/game-outlink")).join("\n")).toMatch(
      /dist\/vendor links outside the package/u,
    );
  });

  it("skips a workspace package's own node_modules, where pnpm links its dev dependencies", () => {
    expect(packageFileProblems("@x/game", packageWith(BUNDLED), true)).toEqual([]);
  });

  it("refuses a node_modules directory deeper inside a workspace package", () => {
    const dir = packageWith({ "package.json": "{}", "dist/node_modules/x/index.js": "" });
    expect(packageFileProblems("@x/game", dir, true)).toEqual([
      "@x/game: must not contain a node_modules directory (dist/node_modules) (02 §7.1.1)",
    ]);
  });

  it("in a workspace package, ignores a dangling symlink and follows none inside the package", () => {
    const dir = packageWith({ "package.json": "{}", "dist/engine/index.js": "" });
    symlinkSync("missing.js", join(dir, "dist/engine/gone.js"));
    symlinkSync("engine", join(dir, "dist/again"));
    expect(packageFileProblems("@x/game", dir, true)).toEqual([]);
  });

  it("checks a symlink's own name: a linked package.json or .cjs file is refused even in a workspace package", () => {
    const dir = packageWith({ "package.json": "{}", "dist/meta.json": "{}", "dist/x.js": "" });
    symlinkSync("../meta.json", join(dir, "dist/engine-package.json"));
    mkdirSync(join(dir, "dist/engine"));
    symlinkSync("../meta.json", join(dir, "dist/engine/package.json"));
    symlinkSync("x.js", join(dir, "dist/y.cjs"));
    expect(packageFileProblems("@x/game", dir, true)).toEqual([
      '@x/game: must not contain another package.json (dist/engine/package.json): Node and bundlers would read its "imports", "browser" and "type" (02 §7.1.1)',
      "@x/game: must not contain CommonJS (dist/y.cjs) (02 §7.1.1)",
    ]);
  });
});

describe("workspacePackageDirs", () => {
  it("lists this repository's workspace packages by real path", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const dirs = workspacePackageDirs(root);
    expect(dirs).toContain(realpathSync(join(root, "games/example")));
    expect(dirs).toContain(realpathSync(join(root, "scripts")));
    expect(dirs).not.toContain(realpathSync(root));
  });

  it.each([
    ["packages that aren't a list", "packages: games/*\n", /must be a list of globs/u],
    ["a negated glob", "packages:\n  - games/*\n  - '!games/old'\n", /negated globs/u],
  ])("refuses %s", (_, yaml, expected) => {
    const dir = mkdtempSync(join(tmpdir(), "workspace-"));
    writeFileSync(join(dir, "pnpm-workspace.yaml"), yaml);
    expect(() => workspacePackageDirs(dir)).toThrow(expected);
  });
});

describe("resolveWorkspaceRange", () => {
  it.each([
    ["workspace:^", "^1.2.0"],
    ["workspace:~", "~1.2.0"],
    ["workspace:*", "1.2.0"],
    ["workspace:^1.0.0", "^1.0.0"],
    ["^1.0.0", "^1.0.0"],
  ])("%s → %s", (range, expected) => {
    expect(resolveWorkspaceRange(range, "1.2.0")).toBe(expected);
  });
});
