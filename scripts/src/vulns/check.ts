/**
 * The vulnerability gate (docs/spec/11-engineering.md §6): OSV-Scanner reports every known
 * vulnerability in the lockfile; one in a **production** dependency fails the pipeline unless it
 * is ignored in osv-scanner.toml (with an expiry and an accepted-risk entry). Development-only
 * findings are reported without failing.
 */
import { z } from "zod";

const osvSchema = z.object({
  results: z
    .array(
      z.object({
        packages: z.array(
          z.object({
            package: z.object({ name: z.string(), version: z.string(), ecosystem: z.string() }),
            vulnerabilities: z.array(z.object({ id: z.string() })),
          }),
        ),
      }),
    )
    .nullish(),
});

/** `pnpm licenses list --prod --json` lists every production package with its versions. */
const prodSchema = z.record(
  z.string(),
  z.array(z.object({ name: z.string(), versions: z.array(z.string()) })),
);

export interface Finding {
  readonly name: string;
  readonly version: string;
  readonly ids: readonly string[];
  readonly production: boolean;
}

/** Joins OSV-Scanner's JSON report with the production package list. */
export function classifyFindings(osvJson: string, prodJson: string): Finding[] {
  const production = new Set(
    Object.values(prodSchema.parse(JSON.parse(prodJson)))
      .flat()
      .flatMap((pkg) => pkg.versions.map((version) => `${pkg.name}@${version}`)),
  );
  const findings: Finding[] = [];
  for (const result of osvSchema.parse(JSON.parse(osvJson)).results ?? []) {
    for (const { package: pkg, vulnerabilities } of result.packages) {
      if (pkg.ecosystem !== "npm" || vulnerabilities.length === 0) continue;
      findings.push({
        name: pkg.name,
        version: pkg.version,
        ids: vulnerabilities.map((vulnerability) => vulnerability.id),
        production: production.has(`${pkg.name}@${pkg.version}`),
      });
    }
  }
  return findings;
}
