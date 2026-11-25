/**
 * The Web Push sender (docs/spec/03-architecture.md §4 `Platform.push`, §7): encrypts a message for
 * one subscription (RFC 8291), signs a VAPID token for its push service (RFC 8292) and posts it.
 * Written once over Web-standard APIs; each runtime builds it with {@link corePushSender}.
 *
 * The post follows 08 T12: the endpoint is checked against the allow-list again before every send,
 * redirects are never followed, and the request is abandoned after 5 seconds.
 */
import { fromBase64Url } from "../base64.js";
import type { AppConfig } from "../config/parse.js";
import type { Logger } from "../log.js";
import { type EphemeralKeys, encryptPushMessage, freshEphemeralKeys } from "./encrypt.js";
import { parseEndpoint } from "./endpoint.js";
import { importVapidKeys, type VapidConfig, VapidKeyError, vapidAuthorization } from "./vapid.js";

/** What a notification shows, and where tapping it goes (a path of this app). */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** A same-origin path, e.g. `/g/<id>`. */
  readonly url: string;
  /** Notifications with one tag replace each other (one per game). */
  readonly tag: string;
}

/** One stored subscription (04 `push_subscriptions`). */
export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/**
 * `delivered`: the push service accepted it. `gone`: it answered 404 or 410, or the stored
 * endpoint no longer passes the allow-list, so the subscription is deleted (04). `failed`:
 * anything else, by status or error class only (never the endpoint, a capability URL).
 */
export type PushOutcome =
  | { readonly kind: "delivered" }
  | { readonly kind: "gone" }
  | { readonly kind: "failed"; readonly status?: number; readonly errorClass?: string };

export interface PushSender {
  /** False when VAPID isn't configured: nothing is ever sent. */
  readonly enabled: boolean;
  /** Sends one message to one subscription. Never throws. */
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
  /** Checks the configured key pair (startup on Node); throws {@link VapidKeyError}. */
  verifyKeys(): Promise<void>;
}

/** How long a push service keeps an undelivered message (RFC 8030 §5.2). */
const TTL_SECONDS = 24 * 60 * 60;
/** 08 T12. */
const TIMEOUT_MS = 5000;

const encoder = new TextEncoder();

export interface WebPushSenderOptions {
  readonly vapid: VapidConfig;
  readonly log: Logger;
  readonly now: () => Date;
  readonly fetch: typeof fetch;
  /** Tests only: fixed ephemeral keys and salt instead of fresh ones per message. */
  readonly ephemeral?: () => Promise<EphemeralKeys>;
}

export function createWebPushSender(options: WebPushSenderOptions): PushSender {
  const { log } = options;
  let keys: ReturnType<typeof importVapidKeys> | null = null;
  let alerted = false;
  const vapidKeys = () => (keys ??= importVapidKeys(options.vapid));
  const ephemeral = options.ephemeral ?? freshEphemeralKeys;

  async function post(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    const endpoint = parseEndpoint(target.endpoint);
    if (endpoint === null) return { kind: "gone" };
    const signing = await vapidKeys();
    const body = await encryptPushMessage(
      encoder.encode(JSON.stringify(message)),
      {
        p256dh: new Uint8Array(fromBase64Url(target.p256dh)),
        auth: new Uint8Array(fromBase64Url(target.auth)),
      },
      await ephemeral(),
    );
    const response = await options.fetch(endpoint.href, {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(endpoint, signing, options.now().getTime()),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(TTL_SECONDS),
        Urgency: "normal",
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Nothing in the answer is used; release the connection.
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return { kind: "delivered" };
    if (response.status === 404 || response.status === 410) return { kind: "gone" };
    return { kind: "failed", status: response.status };
  }

  return {
    enabled: true,
    async send(target, message) {
      try {
        return await post(target, message);
      } catch (error) {
        if (error instanceof VapidKeyError) {
          keys = null;
          if (!alerted) {
            alerted = true;
            log.error("push not sent: the VAPID keys are invalid", { alert: "push_keys_invalid" });
          }
        }
        return {
          kind: "failed",
          errorClass: error instanceof Error ? error.constructor.name : typeof error,
        };
      }
    },
    async verifyKeys() {
      await importVapidKeys(options.vapid);
    },
  };
}

/** The sender when VAPID isn't configured: push is off (09 §1). */
export const DISABLED_PUSH_SENDER: PushSender = {
  enabled: false,
  send: () => Promise.resolve({ kind: "failed", errorClass: "PushDisabled" }),
  verifyKeys: () => Promise.resolve(),
};

/** The push sender for a configuration: Web Push with its VAPID keys, or none without them. */
export function corePushSender(
  config: AppConfig,
  log: Logger,
  now: () => Date,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): PushSender {
  if (config.vapid === null) return DISABLED_PUSH_SENDER;
  return createWebPushSender({ vapid: config.vapid, log, now, fetch: fetchImpl });
}
