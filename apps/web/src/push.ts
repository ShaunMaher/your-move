/**
 * Web Push on this device (07 §4, 03 §7; alpha A8): whether it can be turned on here, turning it on
 * and off, keeping the server's copy of the subscription current at each launch, and dropping it
 * when the session ends (06 §4). The service worker shows what arrives (`sw/sw.js`).
 *
 * Permission is asked for only after a tap (iOS allows nothing else): {@link turnOnPush} calls
 * `Notification.requestPermission()` before it awaits anything, so it must be called straight
 * from the click handler.
 */
import type { ApiClient } from "@your-move/api-client";

import { isIosSafari, isStandalone } from "./install.js";

/**
 * - `no-server-key`: this instance has no VAPID key, so it sends no pushes.
 * - `needs-install`: iOS or iPadOS Safari in a tab; push works only from the Home Screen.
 * - `unsupported`: no service worker, Push API or notifications here.
 * - `denied`: the person blocked notifications for this site in the browser's settings.
 * - `off` / `on`: whether this device has a subscription.
 */
export type PushState = "no-server-key" | "needs-install" | "unsupported" | "denied" | "off" | "on";

/** What turning push on or off came to. */
export type PushChange = "on" | "off" | "denied" | "unauthenticated" | "offline" | "failed";

/** Remembered once the post-game prompt has been shown on this device (07 §4). */
const OFFERED_KEY = "ym.push-offered";

function supported(): boolean {
  return (
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    typeof Notification !== "undefined"
  );
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker.getRegistration();
  } catch {
    return undefined;
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const found = await registration();
  if (found === undefined) return null;
  try {
    return await found.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/** The VAPID public key (unpadded base64url) as the bytes `applicationServerKey` takes. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, key: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (current === null) return false;
  const a = new Uint8Array(current);
  const b = keyBytes(key);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Where this device stands (see {@link PushState}). */
export async function pushState(serverKey: string | undefined): Promise<PushState> {
  if (serverKey === undefined) return "no-server-key";
  if (!supported()) return isIosSafari() && !isStandalone() ? "needs-install" : "unsupported";
  if ((await registration()) === undefined) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const subscription = await currentSubscription();
  return subscription !== null && Notification.permission === "granted" ? "on" : "off";
}

type Answer = "ok" | "unauthenticated" | "offline" | "failed";

async function answer(request: Promise<{ response: Response }>): Promise<Answer> {
  try {
    const { response } = await request;
    if (response.ok) return "ok";
    return response.status === 401 ? "unauthenticated" : "failed";
  } catch {
    return "offline";
  }
}

function save(api: ApiClient, subscription: PushSubscription): Promise<Answer> {
  const { endpoint, keys } = subscription.toJSON();
  if (endpoint === undefined || keys?.["p256dh"] === undefined || keys["auth"] === undefined) {
    return Promise.resolve("failed");
  }
  return answer(
    api.POST("/api/v1/push/subscriptions", {
      body: { endpoint, keys: { p256dh: keys["p256dh"], auth: keys["auth"] } },
    }),
  );
}

async function subscribe(api: ApiClient, serverKey: string): Promise<PushChange> {
  const found = await registration();
  if (found === undefined) return "failed";
  let subscription: PushSubscription;
  try {
    subscription = await found.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(serverKey),
    });
  } catch {
    return "failed";
  }
  const saved = await save(api, subscription);
  if (saved === "ok") return "on";
  // The server doesn't have it, so the device mustn't think it's on.
  await subscription.unsubscribe().catch(() => false);
  return saved;
}

/**
 * Asks for permission, subscribes this device and saves the subscription for this session. Call it
 * directly from a tap: the permission request comes first, before anything is awaited.
 */
export function turnOnPush(api: ApiClient, serverKey: string): Promise<PushChange> {
  let asked: Promise<NotificationPermission>;
  try {
    asked = Notification.requestPermission();
  } catch {
    return Promise.resolve("failed");
  }
  return asked.then(
    (permission): Promise<PushChange> | PushChange => {
      if (permission === "granted") return subscribe(api, serverKey);
      // Dismissed without an answer, the prompt can come again: still just off.
      return permission === "denied" ? "denied" : "off";
    },
    () => "failed" as const,
  );
}

/** Removes the subscription from the server and from this device. */
export async function turnOffPush(api: ApiClient): Promise<PushChange> {
  const subscription = await currentSubscription();
  if (subscription === null) return "off";
  const removed = await answer(
    api.DELETE("/api/v1/push/subscriptions", { body: { endpoint: subscription.endpoint } }),
  );
  if (removed !== "ok") return removed;
  await subscription.unsubscribe().catch(() => false);
  return "off";
}

/**
 * At launch, signed in (07 §4): Safari has no `pushsubscriptionchange`, so an existing subscription
 * is saved again (an idempotent upsert, and the session may be new). One made with a VAPID key the
 * server no longer has is replaced by one with the current key. Failures wait for the next launch.
 */
export async function resyncPush(api: ApiClient, serverKey: string | undefined): Promise<void> {
  if (serverKey === undefined || !supported() || Notification.permission !== "granted") return;
  const subscription = await currentSubscription();
  if (subscription === null) return;
  if (sameKey(subscription, serverKey)) {
    await save(api, subscription);
    return;
  }
  await subscription.unsubscribe().catch(() => false);
  await subscribe(api, serverKey);
}

/**
 * The session ended here (06 §4): this device stops receiving pushes. The server already deleted
 * the subscription with the session; this removes the browser's side, so a shared device doesn't
 * keep showing the last person's games.
 */
export function dropPushSubscription(): void {
  if (!supported()) return;
  void currentSubscription()
    .then((subscription) => subscription?.unsubscribe())
    .catch(() => undefined);
}

/**
 * Whether to offer notifications once a game is created (03 §7): the server sends pushes, this
 * device could take them but hasn't been asked, and the offer hasn't been made here before.
 */
export async function shouldOfferPush(serverKey: string | undefined): Promise<boolean> {
  if (offered()) return false;
  if ((await pushState(serverKey)) !== "off") return false;
  return Notification.permission === "default";
}

function offered(): boolean {
  try {
    return window.localStorage.getItem(OFFERED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers that the offer was made, so it isn't made again on this device. */
export function rememberPushOffered(): void {
  try {
    window.localStorage.setItem(OFFERED_KEY, "1");
  } catch {
    // Storage unavailable: the offer may come again after the next game is created.
  }
}
