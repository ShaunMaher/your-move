/**
 * Rate limits (docs/spec/08-security.md §4) as sliding windows over the `rate_limits` table
 * (06 §3.1): two adjacent fixed windows, the previous one weighted by how much of it still
 * overlaps the sliding window, so a burst at a window boundary can't double the limit.
 *
 * Each limit has a `LIMIT_<NAME>` override (09 §1); the names below are the known ones.
 */
import type { AppConfig } from "../config/parse.js";
import type { RateLimitCount, RateLimitHit, Repositories } from "../db/repositories.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface LimitRule {
  /** Default allowance per window; `LIMIT_<NAME>` overrides it. */
  readonly limit: number;
  readonly windowMs: number;
}

/** The sign-in limits of 08 §4, by their `LIMIT_*` name. */
export const AUTH_LIMITS = {
  OTP_REQUEST_EMAIL_HOUR: { limit: 5, windowMs: HOUR },
  OTP_REQUEST_EMAIL_DAY: { limit: 10, windowMs: DAY },
  OTP_REQUEST_IP_HOUR: { limit: 20, windowMs: HOUR },
  OTP_VERIFY_FAIL_EMAIL_HOUR: { limit: 10, windowMs: HOUR },
  OTP_VERIFY_IP_HOUR: { limit: 50, windowMs: HOUR },
  OTP_EMAIL_GLOBAL_HOUR: { limit: 200, windowMs: HOUR },
  OTP_EMAIL_GLOBAL_DAY: { limit: 1000, windowMs: DAY },
  OTP_VERIFY_FAIL_GLOBAL_HOUR: { limit: 500, windowMs: HOUR },
  NEW_ACCOUNTS_IP_DAY: { limit: 10, windowMs: DAY },
  DISPLAY_NAME_CHANGES_30D: { limit: 3, windowMs: 30 * DAY },
  STEP_UP_USER_HOUR: { limit: 5, windowMs: HOUR },
  STEP_UP_USER_DAY: { limit: 10, windowMs: DAY },
} as const satisfies Record<string, LimitRule>;

export type LimitName = keyof typeof AUTH_LIMITS;

/** Every `LIMIT_*` name the rate limiter reads (the config parser refuses unknown ones). */
export const RATE_LIMIT_NAMES: readonly string[] = Object.keys(AUTH_LIMITS);

/** One counter to update: a limit, the key it counts under, and how much to add. */
export interface LimitCheck {
  readonly name: LimitName;
  readonly key: string;
  /** 1 counts this request; 0 reads the counter through the same statements (06 §3.2). */
  readonly amount: 0 | 1;
  /** Scales the limit, e.g. 4× for an IPv6 /56 bucket (08 §4.1). Default 1. */
  readonly multiplier?: number;
}

export interface LimitResult {
  readonly name: LimitName;
  /** The sliding-window estimate, this request included. */
  readonly estimate: number;
  readonly limit: number;
  /** Over the limit: a counted request beyond it, or a read at or beyond it. */
  readonly exceeded: boolean;
}

/** The effective allowance for a limit (`LIMIT_<NAME>` or the default). */
export function limitOf(config: AppConfig, name: LimitName): number {
  return config.limits[name] ?? AUTH_LIMITS[name].limit;
}

/**
 * Applies the checks in one atomic batch and judges each against its limit.
 */
export async function checkLimits(
  repos: Repositories,
  config: AppConfig,
  now: number,
  checks: readonly LimitCheck[],
): Promise<LimitResult[]> {
  const hits: RateLimitHit[] = checks.map((check) => {
    const { windowMs } = AUTH_LIMITS[check.name];
    const windowStart = Math.floor(now / windowMs) * windowMs;
    return {
      key: `${check.name}:${check.key}`,
      windowStart,
      previousWindowStart: windowStart - windowMs,
      amount: check.amount,
    };
  });
  const counts: RateLimitCount[] = await repos.rateLimits.hit(hits);
  return checks.map((check, i) => {
    const { windowMs } = AUTH_LIMITS[check.name];
    const hit = hits[i];
    const count = counts[i] ?? { current: 0, previous: 0 };
    const elapsed = hit === undefined ? 0 : (now - hit.windowStart) / windowMs;
    const estimate = count.previous * (1 - elapsed) + count.current;
    const limit = limitOf(config, check.name) * (check.multiplier ?? 1);
    return {
      name: check.name,
      estimate,
      limit,
      exceeded: check.amount === 0 ? estimate >= limit : estimate > limit,
    };
  });
}
