/**
 * Paths the server always handles (03 §9): the single source for the server's 404 routes, the
 * service worker's deny list (07 §4) and, by hand, `run_worker_first` in the Worker's
 * configuration. Patterns are a path prefix followed by `/*`, or an exact path. Dependency-free,
 * so the web build can import it on its own (`@your-move/shared/server-paths`).
 */
export const SERVER_PATHS = ["/api/*", "/manifest.webmanifest", "/__dev/*"] as const;
