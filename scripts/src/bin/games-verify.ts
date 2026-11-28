/**
 * `pnpm games:verify [--fast] [--cpu-budget-ms <n>] [--only <type>] [--shard <i>/<n>]`: fails the
 * build when an installed game package breaks the rules of 02 §7.3 (see ../games/verify.ts).
 * Without `--fast` it runs the full test kit (CI's `test:games` jobs); `pnpm build` and the Docker
 * build pass `--fast` (02 §6), unsharded. The deploy job never runs it.
 *
 * `--only <type>` checks only the package of that game type. `--shard <i>/<n>` plays the `i`-th of
 * `n` shards of each package's full kit, by option set and seat count (`runKit`'s `shard`); every
 * check that plays no game still runs in each shard, and the `n` shards together play exactly the
 * unsharded run's games with the same seeds and find its failures. CI runs the shards as parallel
 * jobs (11 §9). A run restricted either way deletes `generated/verified-files.json` (below), which
 * only the whole run's checks may describe, so `games:check-inputs` fails until a whole run. `--cpu-budget-ms` (or the `KIT_CPU_BUDGET_MS` variable, which CI sets once
 * for every job and image build that runs the kit) raises the kit's CPU budget (default 5 ms,
 * 08 T25) on a host slower than the reference hardware; the budget is measured on the host
 * running the kit (@your-move/testkit, budget.ts).
 *
 * It also writes `generated/verified-files.json`: every installed package file the checks covered,
 * by role (reached from the engine and manifest entry points, or from the client entry point),
 * which `pnpm games:check-inputs` compares with what the bundlers read (10 M1).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { CPU_BUDGET_VARIABLE, readCpuBudget } from "@your-move/testkit";

import type { CheckedPackage } from "../games/inputs.js";
import { loadGames, loadInstanceConfig } from "../games/load.js";
import { nodeModulesResolver } from "../games/packages.js";
import { kitClock, parseShard, verifyGames, type KitPlayed } from "../games/verify.js";
import { buildWorkspaceGames, workspacePackageDirs } from "../games/workspace.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("games:verify", async () => {
  const { values } = parseArgs({
    options: {
      fast: { type: "boolean", default: false },
      "cpu-budget-ms": { type: "string" },
      only: { type: "string" },
      shard: { type: "string" },
    },
  });
  const budget = readCpuBudget(values["cpu-budget-ms"], process.env[CPU_BUDGET_VARIABLE]);
  if (!budget.ok) fail("games:verify", [budget.problem]);
  const cpuBudgetMs = budget.ms;
  const { only } = values;
  const shard = values.shard === undefined ? undefined : parseShard(values.shard);
  if (typeof shard === "string") fail("games:verify", [shard]);
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
  const played: KitPlayed[] = [];
  const mode = values.fast ? "fast" : "full";
  const problems = await verifyGames({
    rootDir: ROOT_DIR,
    games: loaded.games,
    sdkVersion,
    sdkDir,
    workspaceDirs,
    kit: mode,
    ...(cpuBudgetMs === undefined ? {} : { cpuBudgetMs }),
    ...(only === undefined ? {} : { only }),
    ...(shard === undefined ? {} : { shard }),
    checked,
    played,
    recordIn: ROOT_DIR,
  });
  if (problems.length > 0) fail("games:verify", problems);
  const whole = only === undefined && shard === undefined;
  // The whole run's count and fingerprint of combinations, so shard logs can be compared.
  for (const { name, games, combos, allCombos, comboDigest } of played) {
    console.log(
      `  ${name}: ${String(games)} games in ${String(combos)} of ${String(allCombos)} option set and seat count combinations (list ${comboDigest})`,
    );
  }
  const part = [
    ...(only === undefined ? [] : [`only ${only}`]),
    ...(shard === undefined ? [] : [`shard ${String(shard.index)}/${String(shard.count)}`]),
  ];
  console.log(
    `games:verify (${mode} kit${part.length === 0 ? "" : `, ${part.join(", ")}`}${cpuBudgetMs === undefined ? "" : `, CPU budget ${String(cpuBudgetMs)} ms`}, timed by ${kitClock.source}): ${String(checked.length)} game package(s) OK against SDK ${sdkVersion}${whole ? "" : "; generated/verified-files.json removed (a restricted run)"}`,
  );
});
