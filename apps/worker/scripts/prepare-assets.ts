/**
 * Copies the built SPA into apps/worker/dist/assets and writes its `_headers` file from the shared
 * security-header definition (03 §9), so static responses carry exactly the headers the Worker
 * and the Node server send. HSTS follows `PUBLIC_URL` (https unless unset); the Turnstile origin
 * is added when `TURNSTILE_ENABLED=true` at build time.
 */
import { cpSync, existsSync, rmSync, writeFileSync } from "node:fs";

import { renderHeadersFile } from "@your-move/server";

const webDist = new URL("../../web/dist/", import.meta.url);
const assets = new URL("../dist/assets/", import.meta.url);
if (!existsSync(webDist)) {
  throw new Error("apps/web/dist is missing: build the web app first (pnpm build does)");
}

const publicUrl = process.env["PUBLIC_URL"] ?? "https://";
const headers = renderHeadersFile({
  hsts: publicUrl.startsWith("https:"),
  turnstile: process.env["TURNSTILE_ENABLED"] === "true",
});

rmSync(assets, { recursive: true, force: true });
cpSync(webDist, assets, { recursive: true });
writeFileSync(new URL("_headers", assets), headers);
console.log(
  `prepare-assets: copied the SPA and wrote _headers (HSTS ${publicUrl.startsWith("https:") ? "on" : "off"})`,
);
