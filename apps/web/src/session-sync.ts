/**
 * Keeps every open tab in step when the session ends (08 §2): signing out, or out everywhere, in
 * one tab clears the person from all of them, and a tab that was hidden checks again when it
 * becomes visible (the session may have been ended from another device).
 */
import { clearReturnPath } from "./return-path.js";

const CHANNEL = "session";
const SIGNED_OUT = "signed-out";

/** Local-storage keys under this prefix hold per-user game state (06 §4; `ym.game.<type>.<user>.<game>`). */
const GAME_STORAGE_PREFIX = "ym.game.";

/**
 * Everything the client keeps about the person, cleared whenever their session ends in this tab.
 * Later slices add to it: the push unsubscribe (A5) and anything else the app keeps per user.
 */
export function clearClientState(): void {
  clearReturnPath();
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

function openChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
}

/** Tells every other tab that the session has ended. */
export function announceSignedOut(): void {
  const channel = openChannel();
  channel?.postMessage(SIGNED_OUT);
  channel?.close();
}

/**
 * Calls `onSignedOut` when another tab ends the session. Returns the function that stops
 * listening.
 */
export function watchSignedOut(onSignedOut: () => void): () => void {
  const channel = openChannel();
  if (channel === null) return () => undefined;
  channel.onmessage = (event: MessageEvent) => {
    if (event.data === SIGNED_OUT) onSignedOut();
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
