/**
 * Removes the run's database directory (playwright.config.ts names it; the server creates it) —
 * but only one of the temporary directories the config names, so a stray `E2E_DATA_DIR` in the
 * environment can never point the teardown at anything else (M2a review P2-7).
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const PREFIX = join(tmpdir(), "your-move-e2e-");

export default function globalTeardown(): void {
  const dir = process.env["E2E_DATA_DIR"];
  if (dir === undefined) return;
  if (!dir.startsWith(PREFIX) || dir.slice(PREFIX.length).includes(sep)) {
    console.warn(`global teardown: leaving ${dir} alone (not a ${PREFIX}* directory)`);
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}
