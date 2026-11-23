/** `pnpm renovate:sync`: regenerates renovate.json's game-package rule from instance.config.ts. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadInstanceConfig } from "../games/load.js";
import { withGameRule } from "../renovate/sync.js";
import { formatAs, ROOT_DIR, run } from "./cli.js";

run("renovate:sync", async () => {
  const file = join(ROOT_DIR, "renovate.json");
  const instance = await loadInstanceConfig(ROOT_DIR);
  const updated = withGameRule(
    JSON.parse(readFileSync(file, "utf8")),
    instance.games.map((game) => game.package),
  );
  writeFileSync(file, await formatAs(file, JSON.stringify(updated)));
  console.log(`renovate:sync: ${String(instance.games.length)} game package(s) in renovate.json`);
});
