/**
 * The repository contract suite against D1 (03 §4): a local D1 database in workerd, migrated by
 * `wrangler d1 migrations apply` from the shared migrations exactly as a deployment would be, then
 * reached from this test process through Wrangler's platform proxy.
 *
 * workerd needs SSE4.2 on x86-64, so CI runs this file in the arm64 `test:worker` job (see
 * .gitlab-ci.yml), like the Worker half of the API contract suite.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { repositoryContract } from "@your-move/server/testing";
import { getPlatformProxy } from "wrangler";

import { d1Repositories } from "../src/d1.js";

const CONFIG = fileURLToPath(new URL("wrangler.d1.toml", import.meta.url));
const WRANGLER = fileURLToPath(new URL("../node_modules/.bin/wrangler", import.meta.url));

repositoryContract("D1", async () => {
  const state = mkdtempSync(join(tmpdir(), "d1-contract-"));
  execFileSync(
    WRANGLER,
    ["d1", "migrations", "apply", "DB", "--local", "--config", CONFIG, "--persist-to", state],
    { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, CI: "true" } },
  );
  const proxy = await getPlatformProxy<{ DB: Parameters<typeof d1Repositories>[0] }>({
    configPath: CONFIG,
    persist: { path: join(state, "v3") },
  });
  return {
    repos: d1Repositories(proxy.env.DB),
    close: async () => {
      await proxy.dispose();
      rmSync(state, { recursive: true, force: true });
    },
  };
});
