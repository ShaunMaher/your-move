/**
 * Registers the service worker and reports when an updated one is waiting (07 §4): the app shows
 * "New version available" and activates the update only when the person agrees, so a game in
 * progress is never replaced under them. Once it is activated, every open tab reloads, the other
 * tabs without being asked (the old worker's cache is gone, so a tab left on the old code would
 * find its files missing); input not yet sent in those tabs is lost. It also follows the worker's
 * request to show a game when a notification is tapped.
 */
import { navigate } from "./router.js";

export interface UpdateWatch {
  /** Activates the waiting worker; the page reloads when it takes over. */
  readonly apply: () => void;
}

/**
 * Watches a registration for a worker that finishes installing while another controls the page.
 * `container` is `navigator.serviceWorker`; it is a parameter so tests can fake it.
 */
export function watchForUpdates(
  container: ServiceWorkerContainer,
  registration: ServiceWorkerRegistration,
  onUpdate: (watch: UpdateWatch) => void,
  reload: () => void,
): void {
  // A page controlled by a worker reloads when another takes over, in whichever tab the person
  // asked for the update. The first worker claiming an uncontrolled page also fires
  // `controllerchange`, and that must not reload a page that has just loaded.
  let controlled = container.controller !== null;
  // WebKit under load can fire `controllerchange` for a claim the page already saw when it
  // started watching; with the controller unchanged there is nothing to reload for.
  let seen = container.controller;
  const offer = (worker: ServiceWorker) => {
    onUpdate({
      apply: () => {
        worker.postMessage("SKIP_WAITING");
      },
    });
  };
  // An update is a worker that is not the one in control. Under load WebKit has been seen to show
  // the page its controller (the first worker, claiming it) before the page has seen that same
  // worker leave `installed`, so "something controls the page" alone offered the very first
  // install as an update; the controller must be a different worker. The comparison relies on the
  // browser keeping one `ServiceWorker` object per worker per client (the Service Worker spec);
  // a browser that broke that would fail toward an extra offer, never toward hiding an update.
  const replacesController = (worker: ServiceWorker) =>
    container.controller !== null && container.controller !== worker;
  // A worker already waiting from an earlier visit. The guard cannot be false here (a waiting
  // worker is never the controller); it is kept for symmetry, the race being the `statechange`
  // path's alone.
  if (registration.waiting !== null && replacesController(registration.waiting)) {
    offer(registration.waiting);
  }
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (installing === null) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && replacesController(installing)) offer(installing);
    });
  });
  container.addEventListener("controllerchange", () => {
    if (container.controller === seen) return;
    seen = container.controller;
    const wasControlled = controlled;
    controlled = true;
    if (wasControlled) reload();
  });
}

/**
 * Moves to a game when the service worker asks: a tapped notification for a window already open
 * (07 §4). Only a game's path is accepted, and only from a service worker of this origin.
 */
export function followNotificationTaps(
  container: ServiceWorkerContainer,
  open: (path: string) => void,
): void {
  container.addEventListener("message", (event: MessageEvent) => {
    if (event.origin !== "" && event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const { type, path } = data as { type?: unknown; path?: unknown };
    if (type === "open" && typeof path === "string" && /^\/g\/[^/?#\\]+$/u.test(path)) open(path);
  });
  // Messages wait until the page says it is listening.
  container.startMessages();
}

/** Registers `/sw.js` in a production build; a no-op in development and where unsupported. */
export function registerServiceWorker(onUpdate: (watch: UpdateWatch) => void): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const container = navigator.serviceWorker;
  followNotificationTaps(container, (path) => {
    navigate(path);
  });
  const register = () => {
    void container.register("/sw.js").then(
      (registration) => {
        watchForUpdates(container, registration, onUpdate, () => {
          window.location.reload();
        });
        // A long-lived home-screen app is resumed, not reloaded: look for a new version then.
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            void registration.update().catch(() => undefined);
          }
        });
      },
      () => undefined,
    );
  };
  // After the page has loaded, so installing the worker never competes with showing the app.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
