/**
 * The one definition of the HTTP security headers (docs/spec/08-security.md §3) and static cache
 * rules (03 §9). Node applies it with {@link securityHeadersMiddleware}; the Cloudflare build
 * writes it into the static assets' `_headers` file with {@link renderHeadersFile}, so the two
 * targets cannot drift.
 */
import type { MiddlewareHandler } from "hono";

export interface SecurityHeaderOptions {
  /** Send `Strict-Transport-Security`: when `PUBLIC_URL` is https. */
  readonly hsts: boolean;
  /** Allow the Turnstile origin in `script-src` and `frame-src`. */
  readonly turnstile: boolean;
}

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The `Content-Security-Policy` value (08 §3). No `unsafe-inline` or `unsafe-eval`, ever. */
export function contentSecurityPolicy(options: Pick<SecurityHeaderOptions, "turnstile">): string {
  const script = options.turnstile ? `'self' ${TURNSTILE_ORIGIN}` : "'self'";
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    ["script-src", script],
    ["style-src", "'self'"],
    ["img-src", "'self' data:"],
    ["connect-src", "'self'"],
    ["font-src", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
    ["worker-src", "'self'"],
    ["manifest-src", "'self'"],
  ];
  if (options.turnstile) directives.push(["frame-src", TURNSTILE_ORIGIN]);
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

/** Headers sent on every response, API and static alike. */
export function securityHeaders(options: SecurityHeaderOptions): Readonly<Record<string, string>> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(options),
    ...(options.hsts ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

/** `Cache-Control` for API responses (05 §Conventions). */
export const API_CACHE_CONTROL = "no-store";

/** `Cache-Control` for content-hashed build output under `/assets/`. */
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** `Cache-Control` for everything else static, which must be revalidated (03 §9). */
const REVALIDATE_CACHE_CONTROL = "no-cache";

/** Paths whose files carry a content hash in their names (Vite's `build.assetsDir`). */
export const HASHED_ASSETS_PREFIX = "/assets/";

/** The `Cache-Control` value for a static path (Node's static handler). */
export function staticCacheControl(path: string): string {
  return path.startsWith(HASHED_ASSETS_PREFIX) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

/**
 * The Cloudflare `_headers` file for static assets (03 §9). Static responses bypass the Worker, so
 * this file carries the same headers. Cloudflare joins repeated headers from overlapping rules,
 * so `Cache-Control` is set only on paths that don't overlap: hashed assets, the shell and the
 * service worker. Other static paths (SPA fallbacks) get Cloudflare's default, which revalidates.
 */
export function renderHeadersFile(options: SecurityHeaderOptions): string {
  const block = (path: string, headers: Readonly<Record<string, string>>): string =>
    [path, ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`)].join("\n");
  return [
    "# Generated from packages/server/src/http/security-headers.ts. Do not edit.",
    block("/*", securityHeaders(options)),
    block(`${HASHED_ASSETS_PREFIX}*`, { "Cache-Control": IMMUTABLE_CACHE_CONTROL }),
    ...["/", "/index.html", "/sw.js"].map((path) =>
      block(path, { "Cache-Control": REVALIDATE_CACHE_CONTROL }),
    ),
    "",
  ].join("\n");
}

/** Hono middleware that sets the security headers on every response it sees. */
export function securityHeadersMiddleware(options: SecurityHeaderOptions): MiddlewareHandler {
  const headers = Object.entries(securityHeaders(options));
  return async (c, next) => {
    await next();
    for (const [name, value] of headers) c.res.headers.set(name, value);
  };
}
