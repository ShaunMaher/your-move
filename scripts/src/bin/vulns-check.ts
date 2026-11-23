/**
 * `pnpm lint:vulns`: runs OSV-Scanner (the mise-pinned binary) on the lockfile and fails on a
 * known vulnerability in a production dependency that osv-scanner.toml doesn't ignore (11 §6).
 */
import { execFileSync, spawnSync } from "node:child_process";

import { classifyFindings } from "../vulns/check.js";
import { fail, ROOT_DIR, run } from "./cli.js";

run("lint:vulns", () => {
  const scan = spawnSync(
    "osv-scanner",
    [
      "scan",
      "source",
      "--config",
      "osv-scanner.toml",
      "--lockfile",
      "pnpm-lock.yaml",
      "--format",
      "json",
    ],
    { cwd: ROOT_DIR, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  // Exit 0: nothing found; 1: vulnerabilities found; anything else: the scan itself failed.
  if (scan.error || (scan.status !== 0 && scan.status !== 1)) {
    fail("lint:vulns", [`osv-scanner did not run: ${scan.error?.message ?? scan.stderr}`]);
  }
  const prod = execFileSync("pnpm", ["licenses", "list", "--prod", "--json", "--recursive"], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const findings = classifyFindings(scan.stdout, prod);
  for (const finding of findings.filter((f) => !f.production)) {
    console.warn(
      `lint:vulns: development only: ${finding.name}@${finding.version} (${finding.ids.join(", ")})`,
    );
  }
  const production = findings.filter((finding) => finding.production);
  if (production.length > 0) {
    fail(
      "lint:vulns",
      production.map(
        (finding) =>
          `${finding.name}@${finding.version}: ${finding.ids.join(", ")} — upgrade, or record an accepted risk in docs/security/findings.md and ignore it in osv-scanner.toml with the same expiry`,
      ),
    );
  }
  console.log("lint:vulns: no known vulnerability in a production dependency");
  return Promise.resolve();
});
