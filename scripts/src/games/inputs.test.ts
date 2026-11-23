import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { uncheckedInputs, writeBundleInputs, writeVerifiedFiles } from "./inputs.js";
import type { LoadedGame } from "./load.js";

/** A repository root with one installed game package holding `files`. */
function instance(files: readonly string[]): { root: string; game: LoadedGame } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "inputs-")));
  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, "games/x");
  for (const file of files) {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  const game = { packageName: "@x/game-x", pkg: { dir } } as unknown as LoadedGame;
  return { root, game };
}

describe("bundler-input closure", () => {
  it("passes when every input from a game package was checked", () => {
    const { root, game } = instance(["dist/engine/index.js", "dist/client/index.js"]);
    writeVerifiedFiles(
      root,
      [game],
      new Set([
        join(game.pkg.dir, "dist/engine/index.js"),
        join(game.pkg.dir, "dist/client/index.js"),
        "/elsewhere.js",
      ]),
    );
    expect(JSON.parse(readFileSync(join(root, "generated/verified-files.json"), "utf8"))).toEqual({
      packages: [
        {
          name: "@x/game-x",
          dir: "games/x",
          files: ["games/x/dist/client/index.js", "games/x/dist/engine/index.js"],
        },
      ],
    });
    writeBundleInputs(root, "web", root, [
      join(root, "games/x/dist/client/index.js"),
      "\0virtual",
      "apps/web/src/main.tsx?x=1",
    ]);
    writeBundleInputs(root, "node", join(root, "apps/node"), [
      "../../games/x/dist/engine/index.js",
    ]);
    writeBundleInputs(root, "worker", root, []);
    expect(uncheckedInputs(root)).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "generated/bundles/web.json"), "utf8"))).toEqual({
      baseDir: root,
      inputs: [join(root, "games/x/dist/client/index.js"), "apps/web/src/main.tsx"].sort(),
    });
  });

  it("fails on an input from a game package that wasn't checked", () => {
    const { root, game } = instance([
      "dist/engine/index.js",
      "dist/engine/package.json",
      "dist/other.js",
    ]);
    writeVerifiedFiles(root, [game], new Set([join(game.pkg.dir, "dist/engine/index.js")]));
    writeBundleInputs(root, "web", root, ["games/x/dist/engine/index.js", "games/x/dist/other.js"]);
    writeBundleInputs(root, "node", root, ["games/x/dist/engine/package.json"]);
    expect(uncheckedInputs(root, ["web", "node"])).toEqual([
      "the web build read games/x/dist/other.js from @x/game-x, which games:verify didn't check",
      "the node build read games/x/dist/engine/package.json from @x/game-x, which games:verify didn't check",
    ]);
  });

  it("fails closed when a record is missing", () => {
    const { root, game } = instance([]);
    expect(uncheckedInputs(root)).toEqual([
      "generated/verified-files.json is missing: run pnpm games:verify first",
    ]);
    writeVerifiedFiles(root, [game], new Set());
    writeBundleInputs(root, "web", root, []);
    expect(uncheckedInputs(root)).toEqual([
      "generated/bundles/node.json is missing: the node build didn't record its inputs",
      "generated/bundles/worker.json is missing: the worker build didn't record its inputs",
    ]);
  });
});
