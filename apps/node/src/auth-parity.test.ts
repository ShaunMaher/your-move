/**
 * Enumeration parity (docs/spec/06-auth.md §3.2, 08 T4, Q3): `/otp/request` and `/otp/verify`
 * answer identically, and take statistically indistinguishable time, whether or not the address
 * has an account.
 *
 * Method: known and unknown addresses are measured interleaved in a shuffled order (so drift, GC
 * and database growth hit both groups alike), each address used once, each request from its own
 * client IP (so no limit is reached). The groups are compared with a two-sided Mann–Whitney U test
 * (normal approximation) and by their medians. The test is loose on purpose (|z| < 4, medians
 * within 35%); its power is checked by the last test, which slows the known-account path by 2 ms
 * and must be detected.
 */
import { performance } from "node:perf_hooks";

import { normaliseAddress, type Repositories } from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, T0 } from "./test-harness.js";

const SAMPLES = 120;

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

interface Timings {
  readonly known: number[];
  readonly unknown: number[];
}

/** Times `send` for SAMPLES known and SAMPLES unknown addresses, interleaved and shuffled. */
async function measure(
  harness: Harness,
  send: (email: string, ip: string) => Promise<Response>,
  /** Runs, unmeasured, before each measured request. */
  prepare?: (email: string, ip: string) => Promise<unknown>,
): Promise<Timings> {
  const jobs: { kind: "known" | "unknown"; email: string }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const known = `known-${String(i)}-${crypto.randomUUID().slice(0, 6)}@example.org`;
    const email = normaliseAddress(known);
    if (email === null) throw new Error("bad test address");
    await harness.platform.repos.users.create({
      id: crypto.randomUUID(),
      email,
      displayName: "Known",
      onboardedAt: T0,
      createdAt: T0,
      updatedAt: T0,
    });
    jobs.push({ kind: "known", email: known });
    jobs.push({
      kind: "unknown",
      email: `unknown-${String(i)}-${crypto.randomUUID().slice(0, 6)}@example.org`,
    });
  }
  // Warm-up: JIT and statement caches, not measured.
  for (let i = 0; i < 20; i++) await send(`warm-${String(i)}@example.org`, ip(100_000 + i));
  const timings: Timings = { known: [], unknown: [] };
  let n = 0;
  for (const job of shuffle(jobs)) {
    const from = ip(++n);
    await prepare?.(job.email, from);
    const started = performance.now();
    const response = await send(job.email, from);
    const elapsed = performance.now() - started;
    await response.arrayBuffer();
    timings[job.kind].push(elapsed);
  }
  await harness.emails();
  return timings;
}

/** Prints a result for the record (the handoff quotes them). */
function report(label: string, result: { z: number; ratio: number }): void {
  process.stdout.write(
    `${label}: z = ${result.z.toFixed(2)}, median ratio = ${result.ratio.toFixed(3)}\n`,
  );
}

function indistinguishable({ known, unknown }: Timings): { z: number; ratio: number } {
  return { z: mannWhitneyZ(known, unknown), ratio: median(known) / median(unknown) };
}

describe("enumeration parity: responses (06 §3.2, 05 §Auth & account)", () => {
  it("/otp/request answers byte-for-byte the same for every kind of address", async () => {
    h = createHarness();
    const harness = h;
    const known = "known@example.org";
    await harness.signIn(known, { ip: "10.0.0.1" });
    const suspended = "suspended@example.org";
    await harness.signIn(suspended, { ip: "10.0.0.2" });
    harness.exec("UPDATE users SET suspended_at = 1 WHERE email = ?", suspended);
    const limited = "limited@example.org";
    for (let i = 0; i < 5; i++) await harness.requestCode(limited, { ip: `10.0.1.${String(i)}` });

    const answers = await Promise.all(
      [known, "nobody@example.org", suspended, limited].map((email, i) =>
        harness.request(
          "POST",
          "/api/v1/auth/otp/request",
          { email },
          { ip: `10.0.2.${String(i)}` },
        ),
      ),
    );
    const shapes = await Promise.all(
      answers.map(async (r) => ({
        status: r.status,
        body: await r.text(),
        headers: [...r.headers.entries()].sort(),
      })),
    );
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    expect(shapes[0]?.status).toBe(202);
  });

  it("/otp/verify answers a wrong code the same for a known and an unknown address", async () => {
    h = createHarness();
    const harness = h;
    await harness.signIn("known@example.org", { ip: "10.0.0.1" });
    const answers = await Promise.all(
      ["known@example.org", "nobody@example.org"].map((email, i) =>
        harness.request(
          "POST",
          "/api/v1/auth/otp/verify",
          { email, code: "12345678" },
          { ip: `10.0.3.${String(i)}` },
        ),
      ),
    );
    const shapes = await Promise.all(
      answers.map(async (r) => ({
        status: r.status,
        body: await r.text(),
        headers: [...r.headers.entries()].sort(),
      })),
    );
    expect(shapes[0]).toEqual(shapes[1]);
  });
});

describe("enumeration parity: timing (06 §3.2, loose statistical test)", () => {
  const request = (harness: Harness) => (email: string, from: string) =>
    harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip: from });
  const verify = (harness: Harness) => (email: string, from: string) =>
    harness.request("POST", "/api/v1/auth/otp/verify", { email, code: "12345678" }, { ip: from });

  it("/otp/request takes the same time for known and unknown addresses", async () => {
    h = createHarness();
    const result = indistinguishable(await measure(h, request(h)));
    report("otp/request parity", result);
    expect(Math.abs(result.z)).toBeLessThan(4);
    expect(result.ratio).toBeGreaterThan(1 / 1.35);
    expect(result.ratio).toBeLessThan(1.35);
  }, 60_000);

  it("/otp/verify (wrong code) takes the same time for known and unknown addresses", async () => {
    h = createHarness();
    const harness = h;
    // Every address first gets a live challenge, as an attacker's target would.
    const result = indistinguishable(await measure(harness, verify(harness), request(harness)));
    report("otp/verify parity", result);
    expect(Math.abs(result.z)).toBeLessThan(4);
    expect(result.ratio).toBeGreaterThan(1 / 1.35);
    expect(result.ratio).toBeLessThan(1.35);
  }, 60_000);

  it("the method has power: a 2 ms slower known-account path is detected", async () => {
    const slowKnown = (repos: Repositories): Repositories => ({
      ...repos,
      users: {
        ...repos.users,
        async findByEmail(email) {
          const user = await repos.users.findByEmail(email);
          if (user !== null) await new Promise((resolve) => setTimeout(resolve, 2));
          return user;
        },
      },
    });
    h = createHarness(undefined, { wrapRepos: slowKnown });
    const result = indistinguishable(await measure(h, request(h)));
    report("otp/request with a planted 2 ms difference", result);
    expect(Math.abs(result.z)).toBeGreaterThan(4);
  }, 60_000);
});
