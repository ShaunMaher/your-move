/**
 * `pnpm games:generate`: reads instance.config.ts and writes generated/ (02 §7.3). Runs from the
 * root `prepare` script and before typecheck, lint and test (11 §3).
 */
import { join } from "node:path";

import { renderAll, writeGenerated } from "../games/generate.js";
import { loadGames, loadInstanceConfig } from "../games/load.js";
import { nodeModulesResolver } from "../games/packages.js";
import { checkIdentity } from "../games/verify.js";
import { buildWorkspaceGames, workspacePackageDirs } from "../games/workspace.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("games:generate", async () => {
  const instance = await loadInstanceConfig(ROOT_DIR);
  const resolvePackage = nodeModulesResolver(ROOT_DIR);
  buildWorkspaceGames(instance, resolvePackage, workspacePackageDirs(ROOT_DIR));
  const result = await loadGames(instance, resolvePackage);
  if (!result.ok) fail("games:generate", result.problems);
  const identity = checkIdentity(result.games);
  if (identity.length > 0) fail("games:generate", identity);
  writeGenerated(join(ROOT_DIR, "generated"), renderAll(result.games));
  console.log(`games:generate: ${String(result.games.length)} game package(s) → generated/`);
});
