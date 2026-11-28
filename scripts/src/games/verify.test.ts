import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import type { CheckedPackage } from "./inputs.js";
import { loadGames, type LoadedGame } from "./load.js";
import { nodeModulesResolver, packageFileProblems } from "./packages.js";
import { parseShard, resolveWorkspaceRange, verifyGames, type KitPlayed } from "./verify.js";
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

describe("parseShard (--shard)", () => {
  it.each([
    ["1/1", { index: 1, count: 1 }],
    ["2/4", { index: 2, count: 4 }],
    ["4/4", { index: 4, count: 4 }],
  ])("reads %s", (text, shard) => {
    expect(parseShard(text)).toEqual(shard);
  });

  it.each(["0/4", "5/4", "1/0", "1", "1/4/2", "a/4", " 1/4", "1.5/4", "-1/4", "01/4"])(
    "refuses %s",
    (text) => {
      expect(parseShard(text)).toMatch(/^--shard must be <index>\/<count>/u);
    },
  );
});

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

  it("refuses TypeScript and JSX sources, which bundlers would compile and Node wouldn't", () => {
    const dir = packageWith({
      "package.json": "{}",
      "dist/engine/index.js": "",
      "dist/engine/index.d.ts": "",
      "dist/engine/index.d.mts": "",
      "dist/engine/rules.ts": "",
      "dist/engine/rules.MTS": "",
      "dist/client/board.tsx": "",
      "dist/engine/rules.jsx": "",
    });
    expect(new Set(packageFileProblems("@x/game", dir, false))).toEqual(
      new Set(
        [
          "dist/engine/rules.ts",
          "dist/engine/rules.MTS",
          "dist/client/board.tsx",
          "dist/engine/rules.jsx",
        ].map(
          (file) =>
            `@x/game: must not contain TypeScript or JSX sources (${file}): bundlers would compile them, Node wouldn't (02 §7.1.1)`,
        ),
      ),
    );
  });

  it("compares names case-insensitively, as case-insensitive file systems do", () => {
    const dir = packageWith({
      "package.json": "{}",
      "PACKAGE.JSON": "{}",
      "dist/Package.Json": "{}",
      "dist/x.CJS": "",
      "dist/Node_Modules/x.js": "",
    });
    expect(new Set(packageFileProblems("@x/game", dir, false))).toEqual(
      new Set([
        '@x/game: must not contain another package.json (PACKAGE.JSON): Node and bundlers would read its "imports", "browser" and "type" (02 §7.1.1)',
        '@x/game: must not contain another package.json (dist/Package.Json): Node and bundlers would read its "imports", "browser" and "type" (02 §7.1.1)',
        "@x/game: must not contain CommonJS (dist/x.CJS) (02 §7.1.1)",
        "@x/game: must not contain a node_modules directory (dist/Node_Modules) (02 §7.1.1)",
      ]),
    );
  });

  it("in a workspace package, checks only the files publishing would include, and every symlink", () => {
    const dir = packageWith({
      "package.json": "{}",
      "dist/engine/index.js": "",
      "src/fixtures/package.json": "{}",
      "vitest.config.cts": "",
      "coverage/node_modules/x.js": "",
    });
    symlinkSync("/", join(dir, "src/escape"));
    const packed = new Set(["package.json", "dist/engine/index.js"]);
    expect(packageFileProblems("@x/game", dir, true, packed)).toEqual([
      "@x/game: src/escape links outside the package",
    ]);
    // A package from a registry is checked in full whatever the list says.
    expect(packageFileProblems("@x/game", dir, false, packed)).toHaveLength(4);
  });
});

describe("games:verify with the test kit", () => {
  it("runs the kit and the engine ESLint rules on a package that passes them", async () => {
    const checked: CheckedPackage[] = [];
    const problems = await verifyGames({
      rootDir: FIXTURES,
      games: await load("@fixture/game-kit"),
      sdkVersion: "1.2.0",
      sdkDir: SDK_DIR,
      workspaceDirs: new Set(),
      kit: "fast",
      checked,
    });
    expect(problems).toEqual([]);
    const short = (file: string) => file.slice(file.indexOf("game-kit/"));
    expect(
      checked.map((pkg) => ({
        name: pkg.name,
        engine: pkg.engine.map(short),
        client: pkg.client.map(short),
        entries: Object.values(pkg.entries).map(short),
      })),
    ).toEqual([
      {
        name: "@fixture/game-kit",
        engine: ["game-kit/dist/engine/index.js", "game-kit/dist/manifest.js"],
        // The client reaches its own engine too (02 §3).
        client: ["game-kit/dist/client/index.js", "game-kit/dist/engine/index.js"],
        entries: [
          "game-kit/dist/engine/index.js",
          "game-kit/dist/client/index.js",
          "game-kit/dist/manifest.js",
        ],
      },
    ]);
  });

  it("fails a package that breaks the engine rules or the kit", async () => {
    const problems = await verifyGames({
      rootDir: FIXTURES,
      games: await load("@fixture/game-kitbad"),
      sdkVersion: "1.2.0",
      sdkDir: SDK_DIR,
      workspaceDirs: new Set(),
      kit: "fast",
    });
    const text = problems.join("\n");
    expect(text).toMatch(/game-kitbad\/dist\/engine\/index\.js:\d+: .*Date/u);
    expect(text).toMatch(/kit (termination|turns) \(rules version 1, 2 seats, seed \d+\)/u);
  });

  it("checks only the package --only names, and still every type id", async () => {
    const options = {
      rootDir: FIXTURES,
      games: await load("@fixture/game-kit", "@fixture/game-kitbad"),
      sdkVersion: "1.2.0",
      sdkDir: SDK_DIR,
      workspaceDirs: new Set<string>(),
      kit: "fast" as const,
    };
    const checked: CheckedPackage[] = [];
    expect(await verifyGames({ ...options, only: "counter", checked })).toEqual([]);
    expect(checked.map((pkg) => pkg.name)).toEqual(["@fixture/game-kit"]);
    expect((await verifyGames({ ...options, only: "counterbad" })).join("\n")).toMatch(
      /@fixture\/game-kitbad: kit /u,
    );
    expect(await verifyGames({ ...options, only: "nosuch" })).toEqual([
      "--only nosuch: no installed game has that type",
    ]);
  });

  it("still reports a duplicate type id under --only, whichever package it names", async () => {
    const problems = await verifyGames({
      rootDir: FIXTURES,
      games: await load("@fixture/game-good", "@fixture/game-twin"),
      sdkVersion: "1.2.0",
      sdkDir: SDK_DIR,
      workspaceDirs: new Set(),
      only: "good",
    });
    expect(problems.join("\n")).toMatch(
      /game-twin: type "good" is already declared by @fixture\/game-good/u,
    );
  });

  it("refuses --shard with the fast kit", async () => {
    const problems = await verifyGames({
      rootDir: FIXTURES,
      games: await load("@fixture/game-kit"),
      sdkVersion: "1.2.0",
      sdkDir: SDK_DIR,
      workspaceDirs: new Set(),
      kit: "fast",
      shard: { index: 1, count: 2 },
    });
    expect(problems).toEqual(["--shard runs the full kit only; the fast kit isn't sharded"]);
  });

  it("records the verified files only after a whole run that passes, and deletes them otherwise", async () => {
    const root = mkdtempSync(join(tmpdir(), "verified-"));
    onTestFinished(() => {
      rmSync(root, { recursive: true, force: true });
    });
    const file = join(root, "generated", "verified-files.json");
    const run = async (extra: Partial<Parameters<typeof verifyGames>[0]>, ...names: string[]) =>
      verifyGames({
        rootDir: FIXTURES,
        games: await load(...(names.length > 0 ? names : ["@fixture/game-kit"])),
        sdkVersion: "1.2.0",
        sdkDir: SDK_DIR,
        workspaceDirs: new Set(),
        kit: "full",
        recordIn: root,
        ...extra,
      });
    const recorded = (): string[] =>
      existsSync(file)
        ? (JSON.parse(readFileSync(file, "utf8")) as { packages: { name: string }[] }).packages.map(
            (pkg) => pkg.name,
          )
        : [];
    expect(await run({})).toEqual([]);
    expect(recorded()).toEqual(["@fixture/game-kit"]);
    expect(await run({ only: "counter" })).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(await run({})).toEqual([]);
    expect(await run({ shard: { index: 1, count: 2 } })).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(await run({})).toEqual([]);
    expect((await run({}, "@fixture/game-kitbad")).length).toBeGreaterThan(0);
    expect(existsSync(file)).toBe(false);
    // Three full kit runs of the fixture and one of the broken one: see the timeout below.
  }, 120_000);

  it("plays one shard of the full kit with --shard, and every shard together plays the whole run", async () => {
    const games = await load("@fixture/game-kit");
    const run = async (shard?: { index: number; count: number }) => {
      const played: KitPlayed[] = [];
      const problems = await verifyGames({
        rootDir: FIXTURES,
        games,
        sdkVersion: "1.2.0",
        sdkDir: SDK_DIR,
        workspaceDirs: new Set(),
        kit: "full",
        ...(shard === undefined ? {} : { shard }),
        played,
      });
      expect(problems).toEqual([]);
      return played;
    };
    const [whole] = await run();
    const shards = [await run({ index: 1, count: 2 }), await run({ index: 2, count: 2 })].flat();
    expect(whole?.combos).toBeGreaterThan(1);
    expect(shards.map((shard) => shard.combos)).toEqual([
      Math.ceil((whole?.combos ?? 0) / 2),
      Math.floor((whole?.combos ?? 0) / 2),
    ]);
    expect(shards.reduce((sum, shard) => sum + shard.games, 0)).toBe(whole?.games);
    for (const shard of shards) {
      expect([shard.allCombos, shard.comboDigest]).toEqual([whole?.combos, whole?.comboDigest]);
    }
    // A measured budget (ADR 0004): two full kit runs of the fixture take about 0.7 s on a
    // developer machine; CPU-bound tests have run up to 100x slower on the shared CI runner.
  }, 120_000);

  it("reports engines the kit can't run", async () => {
    const problems = await verifyGames({
      rootDir: FIXTURES,
      games: await load("@fixture/game-good"),
      sdkVersion: "1.2.0",
      sdkDir: SDK_DIR,
      workspaceDirs: new Set(),
      kit: "fast",
    });
    expect(problems.join("\n")).toMatch(/@fixture\/game-good: (the test kit couldn't run|kit )/u);
  });
});

/**
 * A fresh instance root whose node_modules holds real copies (no links) of the fixture SDK, Zod,
 * React and the named fixture game packages, as a registry install would. `edit` may change a
 * package's files before it is read. Removed after the test.
 */
function installedCopies(
  names: readonly string[],
  edit: (dir: string) => void = () => undefined,
): { root: string; dirs: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "installed-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  for (const shared of ["@your-move/sdk", "zod", "react"]) {
    cpSync(join(FIXTURES, "node_modules", shared), join(root, "node_modules", shared), {
      recursive: true,
      dereference: true,
    });
  }
  const dirs = names.map((name) => {
    const dir = join(root, "node_modules", name);
    cpSync(join(FIXTURES, "registry", name), dir, { recursive: true, dereference: true });
    edit(dir);
    return dir;
  });
  return { root, dirs };
}

/**
 * Verifies the named packages of an instance made by `installedCopies`. `afterLoad` runs once the
 * engines are imported, to change files only the static checks read.
 */
async function verifyInstalled(
  root: string,
  names: readonly string[],
  extra: Partial<Parameters<typeof verifyGames>[0]> = {},
  afterLoad: () => void = () => undefined,
): Promise<string[]> {
  const loaded = await loadGames(
    { games: names.map((name) => ({ package: name })) },
    nodeModulesResolver(root),
  );
  if (!loaded.ok) throw new Error(loaded.problems.join("\n"));
  afterLoad();
  return verifyGames({
    rootDir: root,
    games: loaded.games,
    sdkVersion: "1.2.0",
    sdkDir: realpathSync(join(root, "node_modules/@your-move/sdk")),
    workspaceDirs: new Set(),
    ...extra,
  });
}

describe("games:verify on packages that really sit under node_modules", () => {
  it("runs the engine ESLint rules on them (ESLint skips node_modules by default)", async () => {
    const { root } = installedCopies(["@fixture/game-kit", "@fixture/game-kitbad"]);
    expect(await verifyInstalled(root, ["@fixture/game-kit"])).toEqual([]);
    expect((await verifyInstalled(root, ["@fixture/game-kitbad"])).join("\n")).toMatch(
      /node_modules\/@fixture\/game-kitbad\/dist\/engine\/index\.js:\d+: .*Date/u,
    );
  });

  it("fails a package whose files ESLint ignored instead of linting", async () => {
    // ESLint always ignores .git/: a package resolved there must fail, not pass unlinted.
    const { root, dirs } = installedCopies(["@fixture/game-kitbad"]);
    const hidden = join(root, ".git/game-kitbad");
    mkdirSync(join(root, ".git"));
    cpSync(dirs[0] ?? "", hidden, { recursive: true });
    rmSync(dirs[0] ?? "", { recursive: true });
    symlinkSync(hidden, dirs[0] ?? "");
    expect((await verifyInstalled(root, ["@fixture/game-kitbad"])).join("\n")).toMatch(
      /\.git\/game-kitbad\/dist\/engine\/index\.js: ESLint ignored the file, so the engine rules didn't run on it/u,
    );
  });

  it("refuses relative imports that don't name the file", async () => {
    // `./rules` could resolve to rules.jsx, rules.ts or rules/index.js, depending on who resolves it.
    const { root, dirs } = installedCopies(["@fixture/game-good"]);
    const engine = join(dirs[0] ?? "", "dist/engine/index.js");
    const unspecified = () => {
      writeFileSync(engine, readFileSync(engine, "utf8").replace('"./rules.js"', '"./rules"'));
    };
    expect(
      (await verifyInstalled(root, ["@fixture/game-good"], {}, unspecified)).join("\n"),
    ).toMatch(
      /dist\/engine\/index\.js imports "\.\/rules"; relative imports must name the file, ending in \.js or \.mjs/u,
    );
  });

  it("refuses a workspace package whose entry points reach a file pnpm pack wouldn't publish", async () => {
    const { root, dirs } = installedCopies(["@fixture/game-good"], (dir) => {
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as object;
      const files = ["dist/engine/index.*", "dist/client", "dist/manifest.*"];
      writeFileSync(join(dir, "package.json"), JSON.stringify({ ...json, files }));
    });
    expect(
      await verifyInstalled(root, ["@fixture/game-good"], { workspaceDirs: new Set(dirs) }),
    ).toEqual([
      `@fixture/game-good: dist/engine/rules.js is reachable from an entry point but pnpm pack wouldn't publish it ("files" in package.json)`,
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
