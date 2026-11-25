/*
 * The service worker (docs/spec/07-frontend.md §4). The build prepends `BUILD`: a version and the
 * list of files that make up the app shell. It works offline for the shell only: it never touches
 * `/api/*` or any other server-rendered path, and there is no offline move queue.
 */
/* global BUILD -- prepended by the build (vite.config.ts) */

const CACHE = `shell-${BUILD.version}`;
// Server-rendered paths the shell must never stand in for (03 §9, 07 §4).
const SERVER_PATHS = [/^\/api\//u, /^\/__dev\//u, /^\/manifest\.webmanifest$/u];

self.addEventListener("install", (event) => {
  // The new worker waits for the page's say-so (the "New version available" prompt) to take over.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.addAll(BUILD.precache.map((path) => new Request(path, { cache: "reload" }))),
      ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (SERVER_PATHS.some((pattern) => pattern.test(url.pathname))) return;

  if (request.mode === "navigate") {
    // The network first, so a new deployment shows at once; the cached shell when offline. The app
    // then says "You're offline" itself.
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/", { cacheName: CACHE }).then((shell) => shell ?? Response.error()),
      ),
    );
    return;
  }
  // Hashed build output and icons: cached, else the network.
  event.respondWith(
    caches.match(request, { cacheName: CACHE }).then((hit) => hit ?? fetch(request)),
  );
});
