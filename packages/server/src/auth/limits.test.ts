/**
 * The sliding-window limiter's bounds that the outbound email budget rests on (docs/spec/
 * 08-security.md §4.2): a day cap sends at most its figure in each fixed UTC day and at most twice
 * it in any 24 hours, and twice is reachable, which is why the budget counts each cap twice.
 */
import { describe, expect, it } from "vitest";

import type { RateLimitCount, RateLimitHit, Repositories } from "../db/repositories.js";
import { testPlatform } from "../test-support.js";
import {
  checkLimits,
  countInFixedWindow,
  EMAIL_DAY_CAPS,
  emailWorstCasePer24h,
  type LimitName,
} from "./limits.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Midnight UTC, 2026-01-01. */
const T0 = Date.UTC(2026, 0, 1);

/** Repositories whose `rate_limits` is an in-memory map with the real statements' semantics. */
function memoryRepos(): Repositories {
  const rows = new Map<string, number>();
  const hit = (hits: readonly RateLimitHit[]): Promise<RateLimitCount[]> =>
    Promise.resolve(
      hits.map((one) => {
        const key = `${one.key}@${String(one.windowStart)}`;
        const current = (rows.get(key) ?? 0) + one.amount;
        rows.set(key, current);
        return {
          current,
          previous: rows.get(`${one.key}@${String(one.previousWindowStart)}`) ?? 0,
        };
      }),
    );
  return { ...testPlatform().repos, rateLimits: { hit } };
}

/**
 * A sender that counts and sends one message at each time, as sign-in does: every attempt is
 * counted, and a message goes out only when its counted estimate is within the cap.
 */
function sender(name: LimitName, limit: number) {
  const repos = memoryRepos();
  const config = { limits: { [name]: limit } };
  const sent: number[] = [];
  return {
    sent,
    async attempt(at: number): Promise<boolean> {
      const [result] = await checkLimits(repos, config, at, [{ name, key: "all", amount: 1 }]);
      if (result?.exceeded !== false) return false;
      sent.push(at);
      return true;
    },
  };
}

/** The most sends in any 24 hours, over sorted send times. */
function most24h(sent: readonly number[]): number {
  let best = 0;
  let first = 0;
  for (let last = 0; last < sent.length; last++) {
    while ((sent[first] ?? 0) <= (sent[last] ?? 0) - DAY) first++;
    best = Math.max(best, last - first + 1);
  }
  return best;
}

/** A small seeded generator (mulberry32), so the schedule is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("a sliding day cap (08 §4.2)", () => {
  const L = 100;

  it("never sends more than the cap in a fixed UTC day, nor twice it in any 24 hours", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const random = seeded(seed);
      const cap = sender("OTP_EMAIL_GLOBAL_DAY", L);
      // Six days of bursts at random moments, most of them refused: far more demand than the cap.
      let at = T0;
      while (at < T0 + 6 * DAY) {
        at += Math.floor(random() * 90 * MINUTE);
        const burst = 1 + Math.floor(random() * 40);
        for (let i = 0; i < burst; i++) await cap.attempt(at);
      }
      const perDay = new Map<number, number>();
      for (const time of cap.sent) {
        const day = Math.floor(time / DAY);
        perDay.set(day, (perDay.get(day) ?? 0) + 1);
      }
      expect(Math.max(...perDay.values())).toBeLessThanOrEqual(L);
      expect(most24h(cap.sent)).toBeLessThanOrEqual(2 * L);
    }
  });

  it("can send nearly twice the cap in 24 hours: the full cap just before midnight, then again", async () => {
    const cap = sender("OTP_EMAIL_GLOBAL_DAY", L);
    const lastSecond = T0 + DAY - 1000;
    for (let i = 0; i < L; i++) expect(await cap.attempt(lastSecond)).toBe(true);
    // A minute before the next midnight the previous day weighs 1/1440: 99 more fit, under 24 h on.
    const nextDay = lastSecond + DAY - MINUTE;
    while (await cap.attempt(nextDay));
    expect(cap.sent).toHaveLength(2 * L - 1);
    expect(most24h(cap.sent)).toBe(2 * L - 1);
  });
});

describe("the outbound email budget (08 §4.2)", () => {
  it("covers the three instance-wide email day caps", () => {
    expect(EMAIL_DAY_CAPS).toEqual([
      "OTP_EMAIL_GLOBAL_DAY",
      "INVITE_EMAILS_GLOBAL_DAY",
      "NUDGE_EMAILS_PER_DAY",
    ]);
  });

  it("sends at most 1,500 in any 24 hours with the defaults, a quarter under gmail's 2,000", () => {
    const worst = emailWorstCasePer24h({ limits: {} });
    expect(worst).toBe(2 * (500 + 100 + 150));
    expect(worst).toBeLessThanOrEqual(0.75 * 2000);
  });

  it("counts each override twice", () => {
    expect(
      emailWorstCasePer24h({
        limits: {
          OTP_EMAIL_GLOBAL_DAY: 10,
          INVITE_EMAILS_GLOBAL_DAY: 20,
          NUDGE_EMAILS_PER_DAY: 30,
        },
      }),
    ).toBe(120);
  });
});

describe("a fixed-window count (alpha A20's invitation push, 06 §6.2)", () => {
  const HOUR = 60 * MINUTE;

  it("lets the limit through per fixed UTC day, and a refused count never holds back the next day", async () => {
    const repos = memoryRepos();
    const config = { limits: {} };
    const take = (at: number, keys: readonly string[]) =>
      countInFixedWindow(repos, config, "INVITATION_PUSHES_USER_DAY", keys, at);
    expect(await take(T0 + 23 * HOUR, ["bo", "cy"])).toEqual([true, true]);
    // Refused for the rest of that day, however often it is asked.
    for (let i = 0; i < 5; i++) expect(await take(T0 + 23 * HOUR + i, ["bo"])).toEqual([false]);
    // The next UTC day starts afresh, even an hour later: nothing carries over.
    expect(await take(T0 + DAY + 0.5 * HOUR, ["bo", "bo"])).toEqual([true, false]);
    expect(await take(T0, [])).toEqual([]);
  });

  it("honours a LIMIT_ override", async () => {
    const repos = memoryRepos();
    const config = { limits: { INVITATION_PUSHES_USER_DAY: 2 } };
    const results = await countInFixedWindow(
      repos,
      config,
      "INVITATION_PUSHES_USER_DAY",
      ["bo", "bo", "bo"],
      T0,
    );
    expect(results).toEqual([true, true, false]);
  });
});
