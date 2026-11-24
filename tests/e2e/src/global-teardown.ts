/** Removes the run's database directory (playwright.config.ts names it; the server creates it). */
import { rmSync } from "node:fs";

export default function globalTeardown(): void {
  const dir = process.env["E2E_DATA_DIR"];
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
}
