/**
 * Builds what the suite runs against, exactly as the build stage does: the built-in dictionaries,
 * the web app, the Node server bundle and the Worker bundle with its `_headers`. Then starts the Node build
 * (`node apps/node/dist/main.js`) on a free port; the Worker half runs in Wrangler's test harness.
 * The builds record their bundler inputs in a temporary directory, not generated/bundles/, so a
 * test run never stands in for `pnpm build`'s records (02 §7.3).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import { CONTRACT_SECRETS, CONTRACT_VARS } from "./env.js";

declare module "vitest" {
  export interface ProvidedContext {
    nodeUrl: string;
    /** The Node build's database file, for seeding signed-in players (no email is readable). */
    nodeDb: string;
  }
}

const NODE_MAIN = fileURLToPath(new URL("../../../apps/node/dist/main.js", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null)
      throw new Error(`the Node build exited with ${String(child.exitCode)}`);
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the Node build did not answer /api/health");
}

export default async function setup(project: TestProject): Promise<() => void> {
  const records = mkdtempSync(join(tmpdir(), "contract-bundles-"));
  const build = (name: string) => {
    execFileSync("pnpm", ["--filter", name, "build"], {
      stdio: "inherit",
      // Vitest sets NODE_ENV=test; a build inheriting it bundles React's development build into
      // apps/web/dist, which is the one `pnpm build` made. Builds are production builds.
      env: {
        ...process.env,
        NODE_ENV: "production",
        PUBLIC_URL: CONTRACT_VARS.PUBLIC_URL,
        BUNDLE_INPUTS_DIR: records,
      },
    });
  };
  try {
    build("@your-move/dictionary");
    build("@your-move/web");
    build("@your-move/node");
    build("@your-move/worker");
  } finally {
    rmSync(records, { recursive: true, force: true });
  }

  const port = await freePort();
  // A fresh database, migrated by the Node build at startup.
  const data = mkdtempSync(join(tmpdir(), "contract-db-"));
  const database = join(data, "app.sqlite");
  const child = spawn(process.execPath, ["--disallow-code-generation-from-strings", NODE_MAIN], {
    env: {
      ...process.env,
      ...CONTRACT_VARS,
      ...CONTRACT_SECRETS,
      PORT: String(port),
      LOG_LEVEL: "warn",
      DATABASE_PATH: database,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${String(port)}`;
  try {
    await waitForHealth(url, child);
  } catch (error) {
    // Don't leave the server running when the suite can't start.
    child.kill("SIGTERM");
    rmSync(data, { recursive: true, force: true });
    throw error;
  }
  project.provide("nodeUrl", url);
  project.provide("nodeDb", database);
  return () => {
    child.kill("SIGTERM");
    rmSync(data, { recursive: true, force: true });
  };
}
