/**
 * drizzle-kit configuration: `pnpm --filter @your-move/server db:generate <name>` writes the SQL
 * migration for a change to the shared schema (docs/spec/04-data-model.md), to be reviewed and
 * committed (11 §3). The same files are applied by the Node runtime at startup and by
 * `wrangler d1 migrations apply` on Cloudflare (`migrations_dir` in wrangler.example.toml).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./migrations",
});
