/**
 * Builds what the Worker half of the suite runs: the web app (for static assets) and the Worker
 * bundle with its `_headers` (`apps/worker` build), exactly as the build stage does.
 */
import { execFileSync } from "node:child_process";

export default function setup(): void {
  const run = (args: string[]) => {
    execFileSync("pnpm", args, {
      stdio: "inherit",
      env: { ...process.env, PUBLIC_URL: "https://play.example.org" },
    });
  };
  run(["--filter", "@your-move/web", "build"]);
  run(["--filter", "@your-move/worker", "build"]);
}
