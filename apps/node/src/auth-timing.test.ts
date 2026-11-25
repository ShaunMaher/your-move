/**
 * Enumeration timing parity (docs/spec/06-auth.md §3.2, 08 T4, Q3): `/otp/request` and
 * `/otp/verify` take statistically indistinguishable time whether or not the address has an
 * account. The responses themselves are compared byte for byte in auth-parity.test.ts.
 *
 * Method: known and unknown addresses are measured interleaved in a shuffled order (so drift, GC
 * and database growth hit both groups alike), each address used once, each request from its own
 * client IP (so no limit is reached). The groups are compared with a two-sided Mann–Whitney U test
 * (normal approximation) and by their medians. The test is loose on purpose (|z| < 4, medians
 * within 35%); its power is checked by the last test, which plants one extra indexed SELECT on the
 * known-account path and must be detected.
 *
 * A measurement, so it needs a quiet machine (ADR 0006): CI runs this file only in its own
 * `test:timing` job, never alongside the rest of the suite, and a coder runs it locally before
 * handing off a change to the sign-in paths.
 */
import { performance } from "node:perf_hooks";

import { normaliseAddress, type Repositories } from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, PROD_ENV, T0 } from "./test-harness.js";

const SAMPLES = 200;

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

/** Mann–Whitney U z-score of two samples (ties get average ranks). */
function mannWhitneyZ(a: readonly number[], b: readonly number[]): number {
  const all = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort(
    (x, y) => x.v - y.v,
  );
  const ranks = new Array<number>(all.length);
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]?.v === all[i]?.v) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let rankSumA = 0;
  all.forEach((entry, i) => {
    if (entry.g === 0) rankSumA += ranks[i] ?? 0;
  });
  const n1 = a.length;
  const n2 = b.length;
  const u = rankSumA - (n1 * (n1 + 1)) / 2;
  const mean = (n1 * n2) / 2;
  const sd = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return (u - mean) / sd;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j] as T, items[i] as T];
  }
  return items;
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
  readonly z: number;
  readonly ratio: number;
}

/**
 * Times SAMPLES requests of each arm, interleaved in a shuffled order, each address used once and
 * each request from its own client IP, and compares the two with a Mann–Whitney U test.
 */
async function compare(
  harness: Harness,
  send: (email: string, from: string) => Promise<Response>,
  a: Arm,
  b: Arm,
): Promise<Comparison> {
  const jobs: { arm: 0 | 1; email: string }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    jobs.push({ arm: 0, email: await a.make(harness, i) });
    jobs.push({ arm: 1, email: await b.make(harness, i) });
  }
  // Warm-up: JIT and statement caches, not measured.
  for (let i = 0; i < 20; i++) await send(`warm-${String(i)}@example.org`, ip(200_000 + i));
  const times: [number[], number[]] = [[], []];
  let n = 0;
  for (const job of shuffle(jobs)) {
    const from = ip(++n);
    await (job.arm === 0 ? a : b).prepare?.(harness, job.email, from);
    const started = performance.now();
    const response = await send(job.email, from);
    const elapsed = performance.now() - started;
    await response.arrayBuffer();
    times[job.arm].push(elapsed);
    // Background work (emails) finishes before the next measurement, so it never lands in one.
    await harness.emails();
  }
  await harness.emails();
  return { z: mannWhitneyZ(times[0], times[1]), ratio: median(times[0]) / median(times[1]) };
}

/** Prints a result for the record (the review record quotes them). */
function report(label: string, result: Comparison): void {
  process.stdout.write(
    `${label}: z = ${result.z.toFixed(2)}, median ratio = ${result.ratio.toFixed(3)}\n`,
  );
}

/**
 * The verdict: |z| < 4 is the test; the median band (within 35%) is only a sanity check. The
 * power test below shows that a difference as small as one extra indexed SELECT is caught.
 */
function expectIndistinguishable(result: Comparison): void {
  expect(Math.abs(result.z)).toBeLessThan(4);
  expect(result.ratio).toBeGreaterThan(1 / 1.35);
  expect(result.ratio).toBeLessThan(1.35);
}

const request = (harness: Harness) => (email: string, from: string) =>
  harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip: from });
const verifyWrong = (harness: Harness) => (email: string, from: string) =>
  harness.request("POST", "/api/v1/auth/otp/verify", { email, code: "12345678" }, { ip: from });

/** Another client address in the same request's family, for unmeasured set-up requests. */
const other = (from: string, i: number): string => `${from.replace(/^10\./u, "11.")}${String(i)}`;

describe("enumeration parity: timing (06 §3.2, statistical test)", () => {
  it("/otp/request: known vs unknown", async () => {
    h = createHarness();
    const result = await compare(h, request(h), knownArm, unknownArm);
    report("request known vs unknown", result);
    expectIndistinguishable(result);
  }, 60_000);

  it("/otp/verify, wrong code with a live challenge: known vs unknown", async () => {
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
  }, 60_000);

  it("/otp/request: a suspended account vs a known one", async () => {
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
  }, 60_000);

  it("/otp/request over the per-email limit: known vs unknown (and vs an unlimited known one)", async () => {
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
  }, 180_000);

  it("/otp/request: an unknown address from a full new-accounts bucket vs a known one", async () => {
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
  }, 120_000);

  it("/otp/request over the instance-wide email cap: known vs unknown", async () => {
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_HOUR: "1" });
    const result = await compare(h, request(h), knownArm, unknownArm);
    report("request over the global cap, known vs unknown", result);
    expectIndistinguishable(result);
  }, 60_000);

  it("has power: one extra indexed SELECT on the known path is detected", async () => {
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
    expect(Math.abs(result.z)).toBeGreaterThan(4);
  }, 60_000);
});
