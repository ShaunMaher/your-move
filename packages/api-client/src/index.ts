/**
 * The typed client for the public API (docs/spec/05-api.md): `openapi-fetch` over the types
 * `openapi-typescript` generates from the committed OpenAPI document (`pnpm api:generate`). The
 * web app, the MCP server and anyone else's tools use the API only through this package.
 *
 * @packageDocumentation
 */
import createClient, { type ClientOptions } from "openapi-fetch";

import type { components, paths } from "./schema.js";

export type { components, paths };

/** A response body schema from the document, e.g. `Schema<"HealthResponse">`. */
export type Schema<Name extends keyof components["schemas"]> = components["schemas"][Name];

/**
 * Creates a client. In a browser on the app's own origin, the default `baseUrl` (the page's
 * origin) is right; elsewhere pass the instance's `PUBLIC_URL`.
 */
export function createApiClient(options: ClientOptions = {}) {
  return createClient<paths>(options);
}

export type ApiClient = ReturnType<typeof createApiClient>;
