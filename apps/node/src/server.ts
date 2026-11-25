/**
 * The Node HTTP application: the core app plus static files for the SPA (03 §9). Security headers
 * come from the core's middleware, which wraps these handlers too; cache rules come from the same
 * shared definition the Cloudflare `_headers` file is generated from.
 */
import { serveStatic } from "@hono/node-server/serve-static";
import {
  createApp,
  type App,
  HASHED_ASSETS_PREFIX,
  staticCacheControl,
  type InstalledGame,
  type Platform,
} from "@your-move/server";

const DICTIONARIES_PREFIX = "/assets/dictionaries/";

export interface NodeAppOptions {
  readonly platform: Platform;
  readonly games: readonly InstalledGame[];
  /** The built SPA (`apps/web/dist`). */
  readonly staticRoot: string;
  /** The built-in dictionaries' served layout, published at `/assets/dictionaries/` (words §9.4). */
  readonly dictionariesRoot: string;
}

export function createNodeApp(options: NodeAppOptions): App {
  const app = createApp({ platform: options.platform, games: options.games });
  // Server paths (/api/*, /__dev/*, /manifest.webmanifest) are answered by createApp and never
  // reach the handlers below.
  app.use("*", async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set("Cache-Control", staticCacheControl(c.req.path));
  });
  // Word lists for clients' local previews: versioned, hashed names, so immutable like other
  // hashed assets; precompressed copies are sent to clients that accept them.
  app.use(
    `${DICTIONARIES_PREFIX}*`,
    serveStatic({
      root: options.dictionariesRoot,
      precompressed: true,
      rewriteRequestPath: (path) => path.slice(DICTIONARIES_PREFIX.length - 1),
    }),
  );
  app.use("*", serveStatic({ root: options.staticRoot }));
  // A missing hashed asset is a 404, never the shell (which would then be cached as immutable).
  app.get(`${HASHED_ASSETS_PREFIX}*`, (c) => c.notFound());
  // SPA fallback: every other GET gets the shell.
  app.get("*", serveStatic({ root: options.staticRoot, path: "index.html" }));
  return app;
}
