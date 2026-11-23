/**
 * `pnpm games:verify [--fast]`: fails the build when an installed game package breaks the rules
 * of 02 §7.3 (M0 subset; see ../games/verify.ts).
 *
 * `--fast` is what `pnpm build` and the Docker build pass. It is accepted now so callers are
 * stable; from M1 it runs the fast test kit instead of the full one. In M0 there is no kit, so
 * both modes run the same checks.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { loadGames, loadInstanceConfig } from "../games/load.js";
import { nodeModulesResolver } from "../games/packages.js";
import { verifyGames } from "../games/verify.js";
import { workspacePackageDirs } from "../games/workspace.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("games:verify", async () => {
  const { values } = parseArgs({ options: { fast: { type: "boolean", default: false } } });
  const resolvePackage = nodeModulesResolver(ROOT_DIR);
  const sdkDir = resolvePackage("@your-move/sdk");
  if (sdkDir === null) fail("games:verify", ["@your-move/sdk is not installed at the root"]);
  const { version: sdkVersion } = JSON.parse(
    readFileSync(join(sdkDir, "package.json"), "utf8"),
  ) as { version: string };

  const instance = await loadInstanceConfig(ROOT_DIR);
  const loaded = await loadGames(instance, resolvePackage);
  if (!loaded.ok) fail("games:verify", loaded.problems);
  const problems = await verifyGames({
    rootDir: ROOT_DIR,
    games: loaded.games,
    sdkVersion,
    sdkDir,
    workspaceDirs: workspacePackageDirs(ROOT_DIR),
  });
  if (problems.length > 0) fail("games:verify", problems);
  console.log(
    `games:verify${values.fast ? " --fast" : ""}: ${String(loaded.games.length)} game package(s) OK against SDK ${sdkVersion}`,
  );
});
