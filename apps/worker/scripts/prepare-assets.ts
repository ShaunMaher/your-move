/**
 * Copies the built SPA and the built-in dictionaries into apps/worker/dist/assets and writes its
 * `_headers` file from the shared security-header definition (03 §9), so static responses carry
 * exactly the headers the Worker and the Node server send. HSTS follows `PUBLIC_URL` (https unless unset); the Turnstile origin
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

const dictionaries = new URL("../../../packages/dictionary/generated/served/", import.meta.url);
if (!existsSync(dictionaries)) {
  throw new Error(
    "packages/dictionary/generated is missing: build the dictionaries first (pnpm build does)",
  );
}

rmSync(assets, { recursive: true, force: true });
cpSync(webDist, assets, { recursive: true });
// The built-in dictionaries' served layout (words §9.4): the Worker reads them through the assets
// binding, and clients download the word lists by their versioned, hashed names.
cpSync(dictionaries, new URL("assets/dictionaries/", assets), { recursive: true });
writeFileSync(new URL("_headers", assets), headers);
console.log(
  `prepare-assets: copied the SPA and wrote _headers (HSTS ${publicUrl.startsWith("https:") ? "on" : "off"})`,
);
