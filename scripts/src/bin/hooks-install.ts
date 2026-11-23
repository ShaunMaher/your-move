/**
 * Installs the lefthook git hooks (11 §7) when `pnpm install` runs in a git checkout. Hooks are a
 * convenience, so outside one (a Docker build, an exported tarball) this skips quietly; inside one
 * a lefthook failure still fails the install.
 */
import { execFileSync } from "node:child_process";

import { ROOT_DIR } from "./cli.js";

function inGitCheckout(): boolean {
  try {
    return (
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: ROOT_DIR,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    return false;
  }
}

if (process.env["CI"] || !inGitCheckout()) {
  console.log("hooks:install: not a developer git checkout; skipping lefthook");
} else {
  execFileSync("pnpm", ["exec", "lefthook", "install"], { cwd: ROOT_DIR, stdio: "inherit" });
}
