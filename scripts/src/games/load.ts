/**
 * Loading the instance configuration and each installed package's manifest and engines. Installed
 * packages are trusted like any dependency (02 §7.5), so importing them at build time is expected.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { GameManifest } from "@your-move/sdk";
import { z } from "zod";

import { instanceConfigSchema } from "../instance/define.js";
import { readGamePackage, type GamePackage, type PackageResolver } from "./packages.js";

const manifestSchema = z
  .object({
    type: z.string(),
    name: z.string().min(1),
    description: z.string().min(1),
    // Sanitised at build from M1 (02 §7.3); M0 only checks it is a string.
    icon: z.string(),
    licence: z.string().min(1),
    resources: z.array(z.literal("dictionary")),
    hiddenInformation: z.boolean(),
    players: z
      .object({ min: z.number().int().min(1), max: z.number().int().min(1) })
      .strict()
      .refine((players) => players.min <= players.max, { error: "min must not exceed max" }),
    rules: z.record(z.string().regex(/^[1-9][0-9]*$/u), z.string()),
    homepage: z.string().exactOptional(),
  })
  .strict() satisfies z.ZodType<GameManifest>;

export interface LoadedGame {
  /** The name it is installed under in instance.config.ts. */
  readonly packageName: string;
  readonly pkg: GamePackage;
  readonly manifest: GameManifest;
  /** The rules versions the engine exports (02 §7.4), ascending. */
  readonly rulesVersions: readonly number[];
  readonly enabledByDefault: boolean;
  readonly acceptLicence: string | undefined;
}

export type LoadResult =
  | { readonly ok: true; readonly games: readonly LoadedGame[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Imports `instance.config.ts` from `rootDir` and validates it. */
export async function loadInstanceConfig(
  rootDir: string,
): Promise<z.output<typeof instanceConfigSchema>> {
  const module = (await import(pathToFileURL(join(rootDir, "instance.config.ts")).href)) as {
    default?: unknown;
  };
  const parsed = instanceConfigSchema.safeParse(module.default);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`instance.config.ts is invalid:\n  ${issues.join("\n  ")}`);
  }
  return parsed.data;
}

async function importExport(file: string, name: string): Promise<unknown> {
  const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  return module[name];
}

/** Reads every installed game package: package.json, manifest and exported rules versions. */
export async function loadGames(
  instance: z.output<typeof instanceConfigSchema>,
  resolvePackage: PackageResolver,
): Promise<LoadResult> {
  const problems: string[] = [];
  const games: LoadedGame[] = [];
  for (const entry of instance.games) {
    const read = readGamePackage(entry.package, resolvePackage);
    if (!read.ok) {
      problems.push(...read.problems);
      continue;
    }
    const manifest = manifestSchema.safeParse(
      await importExport(read.pkg.entries.manifest, "manifest"),
    );
    if (!manifest.success) {
      const fields = [
        ...new Set(manifest.error.issues.map((issue) => issue.path.join(".") || "(root)")),
      ];
      problems.push(
        `${entry.package}: its manifest export is invalid (${fields.join(", ")}) (02 §7.2)`,
      );
      continue;
    }
    const engines = await importExport(read.pkg.entries.engine, "engines");
    if (typeof engines !== "object" || engines === null || Array.isArray(engines)) {
      problems.push(
        `${entry.package}: its engine entry point must export an "engines" map (02 §7.1)`,
      );
      continue;
    }
    if (Object.keys(engines).some((key) => !/^[1-9][0-9]*$/u.test(key))) {
      problems.push(`${entry.package}: "engines" keys must be rules version numbers (02 §7.1)`);
      continue;
    }
    games.push({
      packageName: entry.package,
      pkg: read.pkg,
      manifest: manifest.data,
      rulesVersions: Object.keys(engines)
        .map(Number)
        .sort((a, b) => a - b),
      enabledByDefault: entry.enabled ?? true,
      acceptLicence: entry.acceptLicence,
    });
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, games };
}
