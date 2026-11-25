/** The game catalog (05), fetched once per signed-in person and kept until the session ends. */
import type { ApiClient } from "@your-move/api-client";

import { type Call, type Catalog, loadCatalogFrom } from "./game-api.js";

let cached: Promise<Call<Catalog>> | null = null;

/** The catalog; a failed fetch is not kept, so the next ask tries again. */
export function loadCatalog(api: ApiClient): Promise<Call<Catalog>> {
  cached ??= loadCatalogFrom(api).then((result) => {
    if (!result.ok) cached = null;
    return result;
  });
  return cached;
}

/** Forgets the catalog: it differs per person (their own uploads, their last options). */
export function forgetCatalog(): void {
  cached = null;
}
