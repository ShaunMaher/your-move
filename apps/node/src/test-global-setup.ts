/**
 * Builds the built-in dictionaries' served layout before the Node tests if it is missing, so a
 * clean checkout's `vitest --project apps/node` passes without a `pnpm build` first (A2 review
 * P-13). The game tests read it as the Node build does; tests without games don't need it.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INDEX = fileURLToPath(
  new URL("../../../packages/dictionary/generated/served/index.json", import.meta.url),
);

export default function setup(): void {
  if (existsSync(INDEX)) return;
  execFileSync("pnpm", ["--filter", "@your-move/dictionary", "build"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}
