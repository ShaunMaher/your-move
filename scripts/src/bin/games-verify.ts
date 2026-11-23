/**
 * `pnpm games:verify [--fast]`: fails the build when an installed game package breaks the rules
 * of 02 §7.3 (see ../games/verify.ts). Without `--fast` it runs the full test kit (CI's test
 * stage); `pnpm build` and the Docker build pass `--fast` (02 §6). The deploy job never runs it.
 *
 * It also writes `generated/verified-files.json`: every installed package file the checks covered,
 * which `pnpm games:check-inputs` compares with what the bundlers read (10 M1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeVerifiedFiles } from "../games/inputs.js";
import { loadGames, loadInstanceConfig } from "../games/load.js";
import { nodeModulesResolver } from "../games/packages.js";
import { verifyGames } from "../games/verify.js";
import { buildWorkspaceGames, workspacePackageDirs } from "../games/workspace.js";
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
  const workspaceDirs = workspacePackageDirs(ROOT_DIR);
  buildWorkspaceGames(instance, resolvePackage, workspaceDirs);
  const loaded = await loadGames(instance, resolvePackage);
  if (!loaded.ok) fail("games:verify", loaded.problems);
  const checked = new Set<string>();
  const mode = values.fast ? "fast" : "full";
  const problems = await verifyGames({
    rootDir: ROOT_DIR,
    games: loaded.games,
    sdkVersion,
    sdkDir,
    workspaceDirs,
    kit: mode,
    checked,
  });
  if (problems.length > 0) fail("games:verify", problems);
  writeVerifiedFiles(ROOT_DIR, loaded.games, checked);
  console.log(
    `games:verify (${mode} kit): ${String(loaded.games.length)} game package(s) OK against SDK ${sdkVersion}`,
  );
});
