/**
 * `pnpm --filter @your-move/dictionary build` (run by `pnpm build`): builds every dictionary into
 * `packages/dictionary/generated/` (words §9.1) and prints each one's sizes.
 */
import { fileURLToPath } from "node:url";

import { buildAll } from "./files.js";

const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const outDir = fileURLToPath(new URL("../../generated", import.meta.url));

try {
  for (const report of await buildAll(packageDir, outDir)) {
    console.log(
      `dictionary ${report.id}: ${String(report.words)} words, ${String(report.bytes)} bytes (gzip ${String(report.gzipBytes)}, brotli ${String(report.brotliBytes)})`,
    );
  }
} catch (error) {
  console.error(
    `dictionary build failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
