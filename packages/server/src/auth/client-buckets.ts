/**
 * The client's hashed IP buckets for one request (08 §4.1): every bucket of the resolved address,
 * as the `ip/v1` HMAC that `rate_limits` keys use (never the raw address), with the limit
 * multiplier of its width. Shared by every route with a per-IP limit.
 */
import type { Context } from "hono";

import { hmacHex, type Subkeys } from "../crypto/subkeys.js";
import type { Platform } from "../platform.js";
import { ipBuckets } from "./client-ip.js";
import type { ClientBuckets } from "./otp.js";

/** The request's hashed buckets, or null when its client address is missing (the route's `400`). */
export async function clientBucketsOf(
  platform: Pick<Platform, "clientIp">,
  c: Context,
  keys: Subkeys,
): Promise<ClientBuckets | null> {
  const ip = platform.clientIp(c.req.raw, c.env);
  if (!ip.ok) return null;
  const buckets = await Promise.all(
    ipBuckets(ip.ip).map(async (bucket) => ({
      hash: await hmacHex(keys.ip, bucket.bucket),
      multiplier: bucket.multiplier,
    })),
  );
  return { ipBuckets: buckets };
}
