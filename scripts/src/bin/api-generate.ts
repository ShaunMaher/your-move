/** `pnpm api:generate`: regenerates the committed OpenAPI document and client types. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildOpenApiDocument, renderApiArtifacts } from "../api/generate.js";
import { formatAs, ROOT_DIR, run } from "./cli.js";

run("api:generate", async () => {
  const artifacts = await renderApiArtifacts(await buildOpenApiDocument());
  const outputs: [string, string][] = [
    ["packages/api-client/openapi/v1.json", artifacts.document],
    ["packages/api-client/src/schema.ts", artifacts.types],
  ];
  for (const [path, content] of outputs) {
    const file = join(ROOT_DIR, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, await formatAs(file, content));
    console.log(`api:generate: wrote ${path}`);
  }
});
