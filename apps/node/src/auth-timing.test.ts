/**
 * Enumeration timing parity (docs/spec/06-auth.md §3.2, 08 T4, Q3): `/otp/request` and
 * `/otp/verify` take statistically indistinguishable time whether or not the address has an
 * account. The responses, and the repository calls behind them, are compared exactly in
 * auth-parity.test.ts.
 *
 * Design (ADR 0006). Requests are timed in pairs, one of each arm in a random order within each
 * pair, each address used once and each request from its own client IP (so no limit is reached).
 * Drift, garbage collection and database growth hit both members of a pair alike and cancel in
 * their difference. Around every measured request the test waits for background work (the emails)
 * while keeping the event loop busy. Sleeping on the email task's timer let the CPU idle down, and
 * the request after it then ran slower at random: the paired differences' interquartile range was
 * about 800 µs, against about 90 µs with the CPU kept busy.
 *
 * Verdict: the Hodges–Lehmann shift of the paired differences, relative to the median request,
 * must lie within ±3% (BOUND). This is an effect-size bound, not a significance test. A
 * significance test's z-score grows with the sample for any real difference, however small, and
 * doesn't say whether the difference matters, so none is computed. The power check plants one
 * extra indexed SELECT on the known-account path (review P-7) and requires its shift to exceed
 * the same bound.
 *
 * Measured on a developer laptop (16 threads, otherwise idle), 600 pairs per comparison, 20
 * consecutive full runs on 2026-11-25, all passing (median request about 0.75–1.15 ms). The
 * ranges are what was observed over those runs, not guarantees: another machine or a longer
 * series can fall outside them.
 * - planted SELECT: +5.08% to +6.84% (+57 to +76 µs);
 * - request known vs unknown: +0.08% to +1.69%;
 * - verify known vs unknown: +0.40% to +1.72%;
 * - suspended vs known: −0.81% to +0.56%;
 * - per-email-limited known vs unknown: −0.03% to +1.63%;
 * - new-accounts-limited unknown vs known: −1.54% to −0.02%;
 * - over the global cap, known vs unknown: +0.38% to +1.21%;
 * - not asserted: per-email-limited vs unlimited known, −3.31% to −1.29%.
 * (−1.54% and −3.31% are from review runs on the same laptop after those 20.)
 * Over those runs the worst asserted equivalence was 1.46 points inside the bound (−1.54% against
 * 3%), and the weakest planted SELECT 2.08 points above it (+5.08%).
 *
 * What remains: the known-account path is about 10 µs (about 0.9%) slower in every
 * known-vs-unknown comparison. The statements are the same, but inside them the known account's
 * row is read and decoded, and auth_events.user_id's foreign key is checked (at most about 3 µs of
 * it; the two can't be separated at this precision). An earlier silent-path speed-up (about
 * −1.7%, new-accounts-limited) was real and is fixed: an upsert adding 0 writes no page, so the
 * paths that send nothing now add 1 to a counter of their own (otp.ts), and auth-parity.test.ts
 * checks the amounts exactly.
 *
 * The first design compared unpaired arms of 200 with a Mann–Whitney U test: |z| < 4 to pass and
 * z > 4 for power. Its pass and power bounds overlapped, and on the same laptop its power check
 * measured z = 1.77 to 5.25.
 *
 * Because this is a measurement, it needs a quiet machine (ADR 0006). CI runs this file only in
 * its own `test:timing` job, never alongside the rest of the suite. A coder runs it locally before
 * handing off any change to the sign-in paths: about 25 s here.
 */
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";

import { normaliseAddress, type Repositories } from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, PROD_ENV, T0 } from "./test-harness.js";

/** Pairs measured per comparison: each pair is one request of each arm. */
const PAIRS = 600;
/** The equivalence bound on the shift, relative to the median request (see the header). */
const BOUND = 0.03;
/**
 * Time limits, about 10× the slowest local run (2.6 s per comparison, 7.0 s for the two with heavy
 * set-up, 2026-11-25), leaving room for a slower arm64 runner. Re-measure them from the first
 * `test:timing` jobs, never retry (ADR 0004, ADR 0006).
 */
const TIMEOUT_MS = 30_000;
const HEAVY_TIMEOUT_MS = 75_000;

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The Hodges–Lehmann shift of paired differences: the median of their pairwise means. */
function hodgesLehmann(differences: readonly number[]): number {
  const means: number[] = [];
  differences.forEach((d, i) => {
    for (let j = i; j < differences.length; j++) means.push((d + (differences[j] ?? 0)) / 2);
  });
  return median(means);
}

const ip = (i: number): string =>
  `10.${String((i >> 16) & 255)}.${String((i >> 8) & 255)}.${String(i & 255)}`;

/** One group of measured requests: how to make each address and set it up before the request. */
interface Arm {
  /** Creates the i-th address of this group (unmeasured). */
  readonly make: (harness: Harness, i: number) => Promise<string>;
  /** Runs, unmeasured, just before each measured request. */
  readonly prepare?: (harness: Harness, email: string, from: string) => Promise<unknown>;
}

/** A known, onboarded account. */
const knownArm: Arm = {
  make: async (harness, i) => {
    const text = `known-${String(i)}-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const email = normaliseAddress(text);
    if (email === null) throw new Error("bad test address");
    await harness.platform.repos.users.create({
      id: crypto.randomUUID(),
      email,
      displayName: "Known",
      onboardedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    return text;
  },
};

const unknownArm: Arm = {
  make: (_, i) =>
    Promise.resolve(`unknown-${String(i)}-${crypto.randomUUID().slice(0, 6)}@example.org`),
};

interface Comparison {
  /** Hodges–Lehmann shift of (a − b), relative to the median request. */
  readonly shift: number;
  readonly shiftMicros: number;
  readonly medianMicros: number;
}

/**
 * Waits for all background work (emails) while keeping the event loop, and so the CPU, busy:
 * sleeping until a timer fires let the core idle down, and the request after it ran measurably
 * slower and far less predictably (see the header).
 */
async function settle(harness: Harness): Promise<void> {
  const drained = harness.emails().then(() => true);
  let done = false;
  while (!done) done = await Promise.race([drained, setImmediate(false)]);
}

/**
 * Times PAIRS pairs of requests, one of each arm in a random order within each pair, each address
 * used once and each request from its own client IP, and returns the shift between the arms.
 */
async function compare(
  harness: Harness,
  send: (email: string, from: string) => Promise<Response>,
  a: Arm,
  b: Arm,
): Promise<Comparison> {
  const pairs: [string, string][] = [];
  for (let i = 0; i < PAIRS; i++) pairs.push([await a.make(harness, i), await b.make(harness, i)]);
  // Warm-up: JIT and statement caches, not measured.
  for (let i = 0; i < 30; i++) await send(`warm-${String(i)}@example.org`, ip(200_000 + i));
  await settle(harness);
  let n = 0;
  const time = async (arm: Arm, email: string): Promise<number> => {
    const from = ip(++n);
    await arm.prepare?.(harness, email, from);
    // Background work (the set-up's emails) finishes before the measurement, never inside it.
    await settle(harness);
    const started = performance.now();
    const response = await send(email, from);
    const elapsed = performance.now() - started;
    await response.arrayBuffer();
    await settle(harness);
    return elapsed;
  };
  const differences: number[] = [];
  const all: number[] = [];
  for (const [first, second] of pairs) {
    const aFirst = Math.random() < 0.5;
    const t1 = await time(aFirst ? a : b, aFirst ? first : second);
    const t2 = await time(aFirst ? b : a, aFirst ? second : first);
    const [ta, tb] = aFirst ? [t1, t2] : [t2, t1];
    differences.push(ta - tb);
    all.push(ta, tb);
  }
  const shift = hodgesLehmann(differences);
  const typical = median(all);
  return {
    shift: shift / typical,
    shiftMicros: shift * 1000,
    medianMicros: typical * 1000,
  };
}

/** Prints a result for the record (the header and the review record quote them). */
function report(label: string, result: Comparison): void {
  const sign = result.shift >= 0 ? "+" : "";
  process.stdout.write(
    `${label}: shift = ${sign}${(100 * result.shift).toFixed(2)}% ` +
      `(${sign}${result.shiftMicros.toFixed(1)} µs of ${result.medianMicros.toFixed(0)} µs)\n`,
  );
}

/** The verdict: the shift is within the equivalence bound (see the header for why this bound). */
function expectIndistinguishable(result: Comparison): void {
  expect(Math.abs(result.shift)).toBeLessThan(BOUND);
}

const request = (harness: Harness) => (email: string, from: string) =>
  harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip: from });
const verifyWrong = (harness: Harness) => (email: string, from: string) =>
  harness.request("POST", "/api/v1/auth/otp/verify", { email, code: "12345678" }, { ip: from });

/** Another client address in the same request's family, for unmeasured set-up requests. */
const other = (from: string, i: number): string => `${from.replace(/^10\./u, "11.")}${String(i)}`;

describe("enumeration parity: timing (06 §3.2, statistical test)", () => {
  it(
    "/otp/request: known vs unknown",
    async () => {
      h = createHarness();
      const result = await compare(h, request(h), knownArm, unknownArm);
      report("request known vs unknown", result);
      expectIndistinguishable(result);
    },
    TIMEOUT_MS,
  );

  it(
    "/otp/verify, wrong code with a live challenge: known vs unknown",
    async () => {
      h = createHarness();
      const withChallenge = (arm: Arm): Arm => ({
        ...arm,
        prepare: (harness, email, from) => request(harness)(email, other(from, 0)),
      });
      const result = await compare(
        h,
        verifyWrong(h),
        withChallenge(knownArm),
        withChallenge(unknownArm),
      );
      report("verify known vs unknown", result);
      expectIndistinguishable(result);
    },
    TIMEOUT_MS,
  );

  it(
    "/otp/request: a suspended account vs a known one",
    async () => {
      h = createHarness();
      const suspended: Arm = {
        make: async (harness, i) => {
          const email = await knownArm.make(harness, i);
          harness.exec("UPDATE users SET suspended_at = 1 WHERE email = ?", email);
          return email;
        },
      };
      const result = await compare(h, request(h), suspended, knownArm);
      report("request suspended vs known", result);
      expectIndistinguishable(result);
    },
    TIMEOUT_MS,
  );

  it(
    "/otp/request over the per-email limit: known vs unknown (and vs an unlimited known one)",
    async () => {
      h = createHarness({
        ...PROD_ENV,
        LIMIT_OTP_EMAIL_GLOBAL_HOUR: "100000",
        LIMIT_OTP_EMAIL_GLOBAL_DAY: "100000",
      });
      // Five earlier requests from other clients use up the address's hour.
      const useUp = async (harness: Harness, email: string, from: string): Promise<void> => {
        for (let i = 0; i < 5; i++) await request(harness)(email, other(from, i));
      };
      const limitedKnown: Arm = { ...knownArm, prepare: useUp };
      const limitedUnknown: Arm = { ...unknownArm, prepare: useUp };
      const result = await compare(h, request(h), limitedKnown, limitedUnknown);
      report("request per-email-limited, known vs unknown", result);
      expectIndistinguishable(result);
      // For the record only: the limited path creates no challenge (06 §3), so it may be a little
      // quicker than an unlimited one. That says nothing about the account: the caller can see the
      // limit was reached from their own request count, and it is the same for every address.
      report(
        "request per-email-limited vs unlimited known (not asserted)",
        await compare(h, request(h), limitedKnown, knownArm),
      );
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    "/otp/request: an unknown address from a full new-accounts bucket vs a known one",
    async () => {
      // Hundreds of set-up sign-ins: the instance-wide email caps are raised out of the way.
      h = createHarness({
        ...PROD_ENV,
        LIMIT_NEW_ACCOUNTS_IP_DAY: "1",
        LIMIT_OTP_EMAIL_GLOBAL_HOUR: "100000",
        LIMIT_OTP_EMAIL_GLOBAL_DAY: "100000",
      });
      // Each measured client has already created an account.
      const fill = async (harness: Harness, _email: string, from: string): Promise<void> => {
        await harness.signIn(`filler-${crypto.randomUUID()}@example.org`, { ip: from });
      };
      const result = await compare(
        h,
        request(h),
        { ...unknownArm, prepare: fill },
        { ...knownArm, prepare: fill },
      );
      report("request new-accounts-limited vs known", result);
      expectIndistinguishable(result);
    },
    HEAVY_TIMEOUT_MS,
  );

  it(
    "/otp/request over the instance-wide email cap: known vs unknown",
    async () => {
      h = createHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_HOUR: "1" });
      const result = await compare(h, request(h), knownArm, unknownArm);
      report("request over the global cap, known vs unknown", result);
      expectIndistinguishable(result);
    },
    TIMEOUT_MS,
  );

  it(
    "has power: one extra indexed SELECT on the known path is detected",
    async () => {
      const oneMoreSelect = (repos: Repositories): Repositories => ({
        ...repos,
        users: {
          ...repos.users,
          async findByEmail(email) {
            const user = await repos.users.findByEmail(email);
            if (user !== null) await repos.users.findById(user.id);
            return user;
          },
        },
      });
      h = createHarness(undefined, { wrapRepos: oneMoreSelect });
      const result = await compare(h, request(h), knownArm, unknownArm);
      report("request with one planted SELECT", result);
      expect(result.shift).toBeGreaterThan(BOUND);
    },
    TIMEOUT_MS,
  );
});
