/**
 * The instance configuration: which game packages this instance installs (docs/spec/02-game-
 * framework.md §7.3). `instance.config.ts` at the repository root calls {@link defineInstance}.
 */
import { z } from "zod";

const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;

const installedGameSchema = z
  .object({
    /** The game package's npm name, e.g. `@your-move/game-words`. */
    package: z.string().regex(NPM_PACKAGE_NAME, { error: "must be an npm package name" }),
    /** Offered for new games unless `ENABLED_GAMES` says otherwise. Default `true`. */
    enabled: z.boolean().optional(),
    /** The SPDX id of a licence outside the allow-list that the operator accepts (02 §7.3). */
    acceptLicence: z.string().min(1).optional(),
  })
  .strict();

export const instanceConfigSchema = z
  .object({ games: z.array(installedGameSchema) })
  .strict()
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, game] of config.games.entries()) {
      if (seen.has(game.package)) {
        ctx.addIssue({
          code: "custom",
          message: `${game.package} is listed twice`,
          path: ["games", index, "package"],
        });
      }
      seen.add(game.package);
    }
  });

export type InstanceConfig = z.input<typeof instanceConfigSchema>;
export type InstalledGameConfig = z.input<typeof installedGameSchema>;

/** Declares the instance's installed game packages (typed; validated when loaded). */
export function defineInstance(config: InstanceConfig): InstanceConfig {
  return config;
}
