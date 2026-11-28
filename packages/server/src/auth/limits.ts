/**
 * Rate limits (docs/spec/08-security.md §4) as sliding windows over the `rate_limits` table
 * (06 §3.1): two adjacent fixed windows, the previous one weighted by how much of it still
 * overlaps the sliding window, so a burst at a window boundary can't double the limit. Over any
 * span of one window's length the count can still reach twice it (the previous window's weight
 * fades as the next fills), which the outbound email budget allows for (08 §4.2).
 *
 * Each limit has a `LIMIT_<NAME>` override (09 §1); the names below are the known ones.
 */
import type { RateLimitCount, RateLimitHit, Repositories } from "../db/repositories.js";

/** The part of the configuration the limits read (`LIMIT_*` overrides, 09 §1). */
interface LimitConfig {
  readonly limits: Readonly<Record<string, number>>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface LimitRule {
  /** Default allowance per window; `LIMIT_<NAME>` overrides it. */
  readonly limit: number;
  readonly windowMs: number;
}

/** The limits of 08 §4 built so far, by their `LIMIT_*` name. */
const LIMITS = {
  OTP_REQUEST_EMAIL_HOUR: { limit: 5, windowMs: HOUR },
  OTP_REQUEST_EMAIL_DAY: { limit: 10, windowMs: DAY },
  OTP_REQUEST_IP_HOUR: { limit: 20, windowMs: HOUR },
  OTP_VERIFY_FAIL_EMAIL_HOUR: { limit: 10, windowMs: HOUR },
  OTP_VERIFY_IP_HOUR: { limit: 50, windowMs: HOUR },
  OTP_EMAIL_GLOBAL_HOUR: { limit: 200, windowMs: HOUR },
  OTP_EMAIL_GLOBAL_DAY: { limit: 500, windowMs: DAY },
  OTP_VERIFY_FAIL_GLOBAL_HOUR: { limit: 500, windowMs: HOUR },
  NEW_ACCOUNTS_IP_DAY: { limit: 10, windowMs: DAY },
  DISPLAY_NAME_CHANGES_30D: { limit: 3, windowMs: 30 * DAY },
  STEP_UP_USER_HOUR: { limit: 5, windowMs: HOUR },
  STEP_UP_USER_DAY: { limit: 10, windowMs: DAY },
  // Games (A2): writes, moves, previews, game creation, email invitees and invitations received.
  WRITES_USER_MINUTE: { limit: 300, windowMs: MINUTE },
  MOVES_USER_MINUTE: { limit: 120, windowMs: MINUTE },
  PREVIEWS_USER_MINUTE: { limit: 300, windowMs: MINUTE },
  GAMES_CREATED_USER_DAY: { limit: 30, windowMs: DAY },
  GAMES_CREATED_PAIR_DAY: { limit: 5, windowMs: DAY },
  EMAIL_INVITEES_USER_HOUR: { limit: 5, windowMs: HOUR },
  EMAIL_INVITEES_USER_DAY: { limit: 10, windowMs: DAY },
  // The inbound invitation cap (06 §6.7): per target and creator, and per target in total.
  INVITATIONS_RECEIVED_PAIR_DAY: { limit: 1, windowMs: DAY },
  INVITATIONS_RECEIVED_DAY: { limit: 3, windowMs: DAY },
  // "It's your turn" email nudges sent, instance-wide and per recipient (alpha A6, 03 §7).
  NUDGE_EMAILS_PER_DAY: { limit: 150, windowMs: DAY },
  NUDGE_EMAILS_PER_USER_PER_DAY: { limit: 10, windowMs: DAY },
  // Invite emails to email-invite seats (alpha A17, 06 §6.6): per inviter, the rate of an account
  // younger than 7 days that hasn't completed a game, per address and instance-wide.
  INVITE_EMAILS_INVITER_DAY: { limit: 5, windowMs: DAY },
  INVITE_EMAILS_INVITER_30D: { limit: 20, windowMs: 30 * DAY },
  INVITE_EMAILS_NEW_INVITER_DAY: { limit: 2, windowMs: DAY },
  INVITE_EMAILS_TARGET_30D: { limit: 3, windowMs: 30 * DAY },
  INVITE_EMAILS_GLOBAL_DAY: { limit: 100, windowMs: DAY },
  // Join links (alpha A18, 06 §6.8): lookups and joins together, per user and per IP bucket (the
  // joiner's own limits only), and the links a creator makes or rotates.
  JOIN_LINK_USER_HOUR: { limit: 30, windowMs: HOUR },
  JOIN_LINK_IP_HOUR: { limit: 60, windowMs: HOUR },
  JOIN_LINKS_CREATED_USER_DAY: { limit: 20, windowMs: DAY },
  // The generic invitation push (alpha A20, 06 §6.2): per recipient, in the fixed UTC day.
  INVITATION_PUSHES_USER_DAY: { limit: 1, windowMs: DAY },
} as const satisfies Record<string, LimitRule>;

export type LimitName = keyof typeof LIMITS;

/** Every `LIMIT_*` name the rate limiter reads (the config parser refuses unknown ones). */
export const RATE_LIMIT_NAMES: readonly string[] = Object.keys(LIMITS);

/**
 * The instance-wide day caps of the outbound email budget (08 §4.2): every email the server sends
 * counts toward exactly one of them.
 */
export const EMAIL_DAY_CAPS = [
  "OTP_EMAIL_GLOBAL_DAY",
  "INVITE_EMAILS_GLOBAL_DAY",
  "NUDGE_EMAILS_PER_DAY",
] as const satisfies readonly LimitName[];

/** The effective allowance of each instance-wide email day cap (08 §4.2). */
export function emailDayCapLimits(
  config: LimitConfig,
): { readonly name: (typeof EMAIL_DAY_CAPS)[number]; readonly limit: number }[] {
  return EMAIL_DAY_CAPS.map((name) => ({ name, limit: limitOf(config, name) }));
}

/**
 * The most email the instance-wide caps can send in any 24 hours (08 §4.2): a sliding day window
 * sends at most its cap in each fixed UTC day, and any 24 hours overlap two of them.
 */
export function emailWorstCasePer24h(config: LimitConfig): number {
  return emailDayCapLimits(config).reduce((sum, cap) => sum + 2 * cap.limit, 0);
}

/** One counter to update: a limit, the key it counts under, and how much to add. */
export interface LimitCheck {
  readonly name: LimitName;
  readonly key: string;
  /**
   * How much this request counts (1, or e.g. its number of email invitees); 0 reads the counter
   * through the same statements (06 §3.2).
   */
  readonly amount: number;
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
function limitOf(config: LimitConfig, name: LimitName): number {
  return config.limits[name] ?? LIMITS[name].limit;
}

/**
 * Applies the checks in one atomic batch and judges each against its limit.
 */
export async function checkLimits(
  repos: Repositories,
  config: LimitConfig,
  now: number,
  checks: readonly LimitCheck[],
): Promise<LimitResult[]> {
  const hits: RateLimitHit[] = checks.map((check) => {
    const { windowMs } = LIMITS[check.name];
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
    const { windowMs } = LIMITS[check.name];
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

/**
 * Logs an instance-wide limit as an alert (08 §4) once, on the request that first crosses it, so
 * a sustained flood doesn't also flood the logs.
 */
export function alertOnCrossing(
  // The logger's one method used here, so this module needn't import the logger (which reads the
  // config, which reads the limit names from here).
  log: { error(msg: string, fields: { readonly alert: string }): void },
  results: readonly LimitResult[],
): void {
  for (const result of results) {
    if (result.exceeded && result.estimate - 1 <= result.limit) {
      log.error("instance-wide limit exceeded", { alert: result.name });
    }
  }
}

/**
 * Logs an instance-wide limit's alert (08 §4) at most once per fixed window of that limit: a
 * counter of its own (`alert:<NAME>` in `rate_limits`, a key `checkLimits`, whose keys start with
 * a limit's name, can't produce) is raised, and only the call that makes it 1 logs. Callers that
 * read a limit without counting over it use it so the crossing itself is never counted (the nudge
 * sweep, 03 §7); the invite emails use it from their background task, whose request already
 * counted, so the alert and the marker are written after the response (06 §6.6), and read the
 * marker back with {@link crossedThisWindow} to stop for the rest of the window.
 */
export async function alertOncePerWindow(
  repos: Repositories,
  log: { error(msg: string, fields: { readonly alert: string }): void },
  name: LimitName,
  now: number,
): Promise<void> {
  const { windowMs } = LIMITS[name];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const [count] = await repos.rateLimits.hit([
    { key: `alert:${name}`, windowStart, previousWindowStart: windowStart - windowMs, amount: 1 },
  ]);
  if (count?.current === 1) log.error("instance-wide limit exceeded", { alert: name });
}

/**
 * Counts one for each key in the current fixed window of the limit (for a day limit, the UTC day)
 * and says, for each, whether it is still within the limit: at most the limit per fixed window,
 * with nothing carried over from the one before, so a refused count never holds back the next
 * window (alpha A20's invitation push, 06 §6.2). One atomic batch, so two concurrent callers can't
 * both take the last place.
 */
export async function countInFixedWindow(
  repos: Repositories,
  config: LimitConfig,
  name: LimitName,
  keys: readonly string[],
  now: number,
): Promise<boolean[]> {
  if (keys.length === 0) return [];
  const { windowMs } = LIMITS[name];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const counts = await repos.rateLimits.hit(
    keys.map((key) => ({
      key: `${name}:${key}`,
      windowStart,
      previousWindowStart: windowStart - windowMs,
      amount: 1,
    })),
  );
  const limit = limitOf(config, name);
  return keys.map((_key, i) => (counts[i]?.current ?? Number.POSITIVE_INFINITY) <= limit);
}

/**
 * Whether {@link alertOncePerWindow} has marked the limit crossed in the current fixed window of
 * that limit (for a day limit, the UTC day). A read through the same statements as any counter,
 * adding nothing.
 */
export async function crossedThisWindow(
  repos: Repositories,
  name: LimitName,
  now: number,
): Promise<boolean> {
  const { windowMs } = LIMITS[name];
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const [count] = await repos.rateLimits.hit([
    { key: `alert:${name}`, windowStart, previousWindowStart: windowStart - windowMs, amount: 0 },
  ]);
  return (count?.current ?? 0) > 0;
}
