/**
 * `pnpm games:verify [--fast] [--cpu-budget-ms <n>]`: fails the build when an installed game
 * package breaks the rules of 02 §7.3 (see ../games/verify.ts). Without `--fast` it runs the full
 * test kit (CI's test stage); `pnpm build` and the Docker build pass `--fast` (02 §6). The deploy
 * job never runs it. `--cpu-budget-ms` raises the kit's CPU budget (default 5 ms, 08 T25) on a host
 * slower than the reference hardware; the budget is measured on the host running the kit.
 *
 * It also writes `generated/verified-files.json`: every installed package file the checks covered,
 * by role (reached from the engine and manifest entry points, or from the client entry point),
 * which `pnpm games:check-inputs` compares with what the bundlers read (10 M1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { writeVerifiedFiles, type CheckedPackage } from "../games/inputs.js";
import { loadGames, loadInstanceConfig } from "../games/load.js";
import { nodeModulesResolver } from "../games/packages.js";
import { verifyGames } from "../games/verify.js";
import { buildWorkspaceGames, workspacePackageDirs } from "../games/workspace.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("games:verify", async () => {
  const { values } = parseArgs({
    options: { fast: { type: "boolean", default: false }, "cpu-budget-ms": { type: "string" } },
  });
  const budget = values["cpu-budget-ms"];
  const cpuBudgetMs = budget === undefined ? undefined : Number(budget);
  if (cpuBudgetMs !== undefined && !(Number.isFinite(cpuBudgetMs) && cpuBudgetMs > 0)) {
    fail("games:verify", ["--cpu-budget-ms must be a positive number of milliseconds"]);
  }
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
  const checked: CheckedPackage[] = [];
  const mode = values.fast ? "fast" : "full";
  const problems = await verifyGames({
    rootDir: ROOT_DIR,
    games: loaded.games,
    sdkVersion,
    sdkDir,
    workspaceDirs,
    kit: mode,
    ...(cpuBudgetMs === undefined ? {} : { cpuBudgetMs }),
    checked,
  });
  if (problems.length > 0) fail("games:verify", problems);
  writeVerifiedFiles(ROOT_DIR, checked);
  console.log(
    `games:verify (${mode} kit${cpuBudgetMs === undefined ? "" : `, CPU budget ${String(cpuBudgetMs)} ms`}): ${String(loaded.games.length)} game package(s) OK against SDK ${sdkVersion}`,
  );
});
