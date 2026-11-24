/**
 * The Cloudflare storage adapter (docs/spec/03-architecture.md §4, §5.1): the core's repositories
 * over the D1 binding `DB`, through Drizzle's D1 driver. D1's `batch()` runs its statements as one
 * transaction, which is all the repositories rely on (03 §5.2).
 *
 * The schema comes from the shared migrations, applied with `wrangler d1 migrations apply`
 * (`migrations_dir` in wrangler.example.toml); the Worker never migrates at runtime.
 */
import { createRepositories, type Repositories } from "@your-move/server";
import { drizzle } from "drizzle-orm/d1";

/** The repositories over a D1 database. */
export function d1Repositories(binding: D1Database): Repositories {
  return createRepositories(drizzle(binding));
}
