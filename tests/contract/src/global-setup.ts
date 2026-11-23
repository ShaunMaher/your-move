/**
 * Builds what the suite runs against, exactly as the build stage does: the web app, the Node
 * server bundle and the Worker bundle with its `_headers`. Then starts the Node build
 * (`node apps/node/dist/main.js`) on a free port; the Worker half runs in Wrangler's test harness.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import type { TestProject } from "vitest/node";

import { CONTRACT_SECRETS, CONTRACT_VARS } from "./env.js";

declare module "vitest" {
  export interface ProvidedContext {
    nodeUrl: string;
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
  const build = (name: string) => {
    execFileSync("pnpm", ["--filter", name, "build"], {
      stdio: "inherit",
      env: { ...process.env, PUBLIC_URL: CONTRACT_VARS.PUBLIC_URL },
    });
  };
  build("@your-move/web");
  build("@your-move/node");
  build("@your-move/worker");

  const port = await freePort();
  const child = spawn(process.execPath, ["--disallow-code-generation-from-strings", NODE_MAIN], {
    env: {
      ...process.env,
      ...CONTRACT_VARS,
      ...CONTRACT_SECRETS,
      PORT: String(port),
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const url = `http://127.0.0.1:${String(port)}`;
  await waitForHealth(url, child);
  project.provide("nodeUrl", url);
  return () => {
    child.kill("SIGTERM");
  };
}
