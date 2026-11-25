/**
 * Enumeration parity of responses and work (docs/spec/06-auth.md §3.2, 08 T4, Q3): `/otp/request`
 * and `/otp/verify` answer byte for byte the same whether or not the address has an account, and
 * make the same repository calls with the same rate-limit amounts on every path. Their timing is
 * tested statistically in auth-timing.test.ts, which runs in a job of its own (ADR 0006); these
 * checks are deterministic and run everywhere.
 */
import type { Env, Repositories } from "@your-move/server";
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness, PROD_ENV } from "./test-harness.js";

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

type Method = (...args: unknown[]) => unknown;

/**
 * Wraps every repository method to record its call, by name; a rate-limit hit also records the
 * amount each counter adds, since adding 0 writes nothing and is quicker (06 §3.2).
 */
function recordingRepos(calls: string[]): (repos: Repositories) => Repositories {
  return (repos) =>
    Object.fromEntries(
      Object.entries(repos).map(([repoName, repo]: [string, Record<string, Method>]) => [
        repoName,
        Object.fromEntries(
          Object.entries(repo).map(([methodName, method]) => [
            methodName,
            (...args: unknown[]) => {
              const hits = repoName === "rateLimits" ? (args[0] as { amount: number }[]) : null;
              const amounts = hits === null ? "" : `(${hits.map((hit) => hit.amount).join(",")})`;
              calls.push(`${repoName}.${methodName}${amounts}`);
              return method.apply(repo, args);
            },
          ]),
        ),
      ]),
    ) as unknown as Repositories;
}

/** A harness whose repository calls are recorded, and a way to record one request's calls. */
function recordingHarness(env: Env): {
  harness: Harness;
  callsOf: (send: () => Promise<Response>) => Promise<string[]>;
} {
  const calls: string[] = [];
  const harness = createHarness(env, { wrapRepos: recordingRepos(calls) });
  return {
    harness,
    async callsOf(send) {
      await harness.emails();
      calls.length = 0;
      const response = await send();
      await response.arrayBuffer();
      const made = [...calls];
      await harness.emails();
      return made;
    },
  };
}

describe("enumeration parity: responses and work (06 §3.2, 05 §Auth & account)", () => {
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

  it("/otp/request makes the same repository calls, with the same amounts, on every path", async () => {
    const env: Env = {
      ...PROD_ENV,
      LIMIT_NEW_ACCOUNTS_IP_DAY: "1",
      LIMIT_OTP_EMAIL_GLOBAL_HOUR: "100000",
      LIMIT_OTP_EMAIL_GLOBAL_DAY: "100000",
    };
    const { harness, callsOf } = recordingHarness(env);
    h = harness;
    const ask = (email: string, ip: string) => () =>
      harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip });
    await harness.signIn("known@example.org", { ip: "10.0.0.1" });
    await harness.signIn("suspended@example.org", { ip: "10.0.0.2" });
    harness.exec("UPDATE users SET suspended_at = 1 WHERE email = ?", "suspended@example.org");
    for (let i = 0; i < 5; i++)
      await harness.requestCode("limited@example.org", { ip: `10.0.1.${String(i)}` });
    // 10.0.0.1 has created an account today, so its bucket is full: an unknown address asked
    // from there gets a challenge that can never verify, and no email (06 §3.2).
    const paths = {
      known: await callsOf(ask("known@example.org", "10.0.2.1")),
      unknown: await callsOf(ask("nobody@example.org", "10.0.2.2")),
      suspended: await callsOf(ask("suspended@example.org", "10.0.2.3")),
      "per-email limited": await callsOf(ask("limited@example.org", "10.0.2.4")),
      "known, full new-accounts bucket": await callsOf(ask("known@example.org", "10.0.0.1")),
      "unknown, full new-accounts bucket": await callsOf(ask("other@example.org", "10.0.0.1")),
    };
    // The silent paths really were silent.
    for (const email of ["limited@example.org", "other@example.org"]) {
      expect((await harness.emails()).filter((e) => e.to === email)).toHaveLength(
        email === "limited@example.org" ? 5 : 0,
      );
    }
    harness.close();
    h = null;
    // Over the instance-wide cap: an instance of its own, whose one email signing in used up.
    const capped = recordingHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_HOUR: "1" });
    h = capped.harness;
    const askCapped = (email: string, ip: string) => () =>
      capped.harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip });
    await capped.harness.signIn("known@example.org", { ip: "10.0.3.1" });
    const overCap = {
      "known, over the cap": await capped.callsOf(askCapped("known@example.org", "10.0.3.2")),
      "unknown, over the cap": await capped.callsOf(askCapped("nobody@example.org", "10.0.3.3")),
    };
    for (const [path, calls] of Object.entries({ ...paths, ...overCap })) {
      expect({ path, calls }).toEqual({ path, calls: paths.known });
    }
    expect(paths.known).toContain("rateLimits.hit(1,1)");
  });

  it("/otp/verify makes the same repository calls for a wrong code, known or unknown", async () => {
    const { harness, callsOf } = recordingHarness(PROD_ENV);
    h = harness;
    await harness.signIn("known@example.org", { ip: "10.0.0.1" });
    const calls = [];
    for (const [i, email] of ["known@example.org", "nobody@example.org"].entries()) {
      await harness.requestCode(email, { ip: `10.0.4.${String(i)}` });
      calls.push(
        await callsOf(() =>
          harness.request(
            "POST",
            "/api/v1/auth/otp/verify",
            { email, code: "12345678" },
            { ip: `10.0.5.${String(i)}` },
          ),
        ),
      );
    }
    expect(calls[1]).toEqual(calls[0]);
  });
});
