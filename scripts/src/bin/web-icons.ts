/** Writes the web app's placeholder icons (`pnpm web:icons`, 07 §4). */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ICONS, renderIcon } from "../web/icons.js";
import { ROOT_DIR } from "./cli.js";

const dir = join(ROOT_DIR, "apps/web/public/icons");
mkdirSync(dir, { recursive: true });
for (const [name, { size, style }] of Object.entries(ICONS)) {
  writeFileSync(join(dir, name), renderIcon(size, style));
}
