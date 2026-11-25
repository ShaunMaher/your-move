/*
 * The service worker (docs/spec/07-frontend.md §4). The build prepends `BUILD`: a version, the
 * list of files that make up the app shell and the paths the server handles. It works offline for
 * the shell only: it never touches `/api/*` or any other server-handled path, and there is no
 * offline move queue.
 */
/* global BUILD -- prepended by the build (vite-plugin/service-worker.ts) */

const CACHE = `shell-${BUILD.version}`;

// How long a navigation waits for the network before the cached shell is shown instead: long
// enough for a slow mobile connection to answer, short enough that a connection that is up but
// dead (a lie-fi) doesn't leave a blank page for the browser's own, much longer, timeout.
const NAVIGATION_TIMEOUT_MS = 4000;

/** A server path pattern is `/prefix/*` (the prefix and everything below it) or an exact path. */
function isServerPath(pathname) {
  return BUILD.serverPaths.some((pattern) =>
    pattern.endsWith("/*")
      ? pathname === pattern.slice(0, -2) || pathname.startsWith(pattern.slice(0, -1))
      : pathname === pattern,
  );
}

function shell() {
  return caches.match("/", { cacheName: CACHE });
}

/**
 * The network first, so a new deployment shows at once; the cached shell when the network fails
 * or is slow. The app then says "You're offline" itself.
 */
function navigation(request) {
  const network = fetch(request);
  // Resolves with the shell after the timeout; with no shell it never resolves, and the network
  // alone decides.
  const slow = new Promise((resolve) => {
    setTimeout(resolve, NAVIGATION_TIMEOUT_MS);
  })
    .then(shell)
    .then((cached) => cached ?? new Promise(() => undefined));
  return Promise.race([network, slow]).catch(() =>
    shell().then((cached) => cached ?? Response.error()),
  );
}

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
  if (isServerPath(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith(navigation(request));
    return;
  }
  // Hashed build output and icons: cached, else the network.
  event.respondWith(
    caches.match(request, { cacheName: CACHE }).then((hit) => hit ?? fetch(request)),
  );
});
