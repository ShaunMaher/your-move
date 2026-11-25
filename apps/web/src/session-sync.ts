/**
 * Keeps every open tab in step when the session ends (08 §2): signing out, or out everywhere, in
 * one tab clears the person from all of them, and a tab that was hidden checks again when it
 * becomes visible (the session may have been ended from another device).
 */
import { forgetCatalog } from "./catalog.js";
import { dropPushSubscription } from "./push.js";
import { clearReturnPath } from "./return-path.js";

const CHANNEL = "session";
const SIGNED_OUT = "signed-out";
const SIGNED_IN = "signed-in";

/** Local-storage keys under this prefix hold per-user game state (06 §4; `ym.game.<type>.<user>.<game>`). */
const GAME_STORAGE_PREFIX = "ym.game.";

/**
 * Per-user game state, cleared whenever no session is found (at launch, on any 401) as well as
 * when one ends; the remembered return path is left, because a signed-out visit needs it.
 */
export function clearGameState(): void {
  forgetCatalog();
  try {
    const { localStorage } = window;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(GAME_STORAGE_PREFIX) === true) localStorage.removeItem(key);
    }
  } catch {
    // Storage unavailable: there is nothing of ours in it.
  }
}

/**
 * Everything the client keeps about the person, cleared whenever their session ends in this tab:
 * the return path, per-game state and this device's push subscription (06 §4; the server deleted
 * its copy with the session).
 */
export function clearClientState(): void {
  clearReturnPath();
  clearGameState();
  dropPushSubscription();
}

function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
}

function announce(message: string): void {
  const channel = openChannel();
  channel?.postMessage(message);
  channel?.close();
}

/** Tells every other tab that the session has ended. */
export function announceSignedOut(): void {
  announce(SIGNED_OUT);
}

/** Tells every other tab that someone has signed in, so each checks who the session is now. */
export function announceSignedIn(): void {
  announce(SIGNED_IN);
}

/**
 * Calls `onSignedOut` when another tab ends the session and `onSignedIn` when another tab signs
 * someone in. Returns the function that stops listening.
 */
export function watchSession(handlers: {
  readonly onSignedOut: () => void;
  readonly onSignedIn: () => void;
}): () => void {
  const channel = openChannel();
  if (channel === null) return () => undefined;
  channel.onmessage = (event: MessageEvent) => {
    if (event.data === SIGNED_OUT) handlers.onSignedOut();
    else if (event.data === SIGNED_IN) handlers.onSignedIn();
  };
  return () => {
    channel.close();
  };
}

/** Calls `check` whenever the page becomes visible again. Returns the function that stops. */
export function onBecameVisible(check: () => void): () => void {
  const listener = () => {
    if (document.visibilityState === "visible") check();
  };
  document.addEventListener("visibilitychange", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
  };
}
