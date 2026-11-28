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
 * A rate-limit hit as `NAME:key=amount`. Keys derived from the address or the client (HMACs, so
 * different on every path) become `<hash>`; the instance-wide counters' fixed keys (`all`,
 * `silent`) stay, so a path writing the wrong one differs.
 */
function describeHit(hit: { key: string; amount: number }): string {
  const split = hit.key.indexOf(":");
  const name = hit.key.slice(0, split);
  const value = hit.key.slice(split + 1);
  const fixed = value === "all" || value === "silent";
  return `${name}:${fixed ? value : "<hash>"}=${String(hit.amount)}`;
}

/**
 * Wraps every repository method to record its call, by name; a rate-limit hit also records each
 * counter's limit name, key and the amount it adds, since adding 0 writes nothing and is quicker
 * (06 §3.2).
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
              const hits =
                repoName === "rateLimits" ? (args[0] as { key: string; amount: number }[]) : null;
              const detail = hits === null ? "" : `(${hits.map(describeHit).join(",")})`;
              calls.push(`${repoName}.${methodName}${detail}`);
              return method.apply(repo, args);
            },
          ]),
        ),
      ]),
    ) as unknown as Repositories;
}

/** What one request did before and after its response. */
interface Work {
  readonly calls: string[];
  /** Background tasks it scheduled. */
  readonly scheduled: number;
}

/** A harness whose repository calls are recorded, and a way to record one request's work. */
function recordingHarness(env: Env): {
  harness: Harness;
  workOf: (send: () => Promise<Response>) => Promise<Work>;
} {
  const calls: string[] = [];
  const harness = createHarness(env, { wrapRepos: recordingRepos(calls) });
  return {
    harness,
    async workOf(send) {
      await harness.emails();
      calls.length = 0;
      const before = harness.backgroundScheduled();
      const response = await send();
      await response.arrayBuffer();
      const made = [...calls];
      const scheduled = harness.backgroundScheduled() - before;
      await harness.emails();
      return { calls: made, scheduled };
    },
  };
}

/** The calls of a path that sends nothing, as the sending paths' calls would be: `all` for `silent`. */
function asSending(calls: readonly string[]): string[] {
  return calls.map((call) => call.replaceAll(":silent=", ":all="));
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

  it("/otp/request makes the same repository calls, with the same limits, keys and amounts, on every path", async () => {
    const env: Env = {
      ...PROD_ENV,
      LIMIT_NEW_ACCOUNTS_IP_DAY: "1",
      LIMIT_OTP_EMAIL_GLOBAL_HOUR: "100000",
      LIMIT_OTP_EMAIL_GLOBAL_DAY: "100000",
    };
    const { harness, workOf } = recordingHarness(env);
    h = harness;
    const ask = (email: string, ip: string) => () =>
      harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip });
    await harness.signIn("known@example.org", { ip: "10.0.0.1" });
    await harness.signIn("suspended@example.org", { ip: "10.0.0.2" });
    harness.exec("UPDATE users SET suspended_at = 1 WHERE email = ?", "suspended@example.org");
    for (let i = 0; i < 5; i++)
      await harness.requestCode("limited@example.org", { ip: `10.0.1.${String(i)}` });
    // A known address at its per-email limit: its sign-in was the first of five requests.
    await harness.signIn("limited-known@example.org", { ip: "10.0.6.0" });
    for (let i = 1; i < 5; i++)
      await harness.requestCode("limited-known@example.org", { ip: `10.0.6.${String(i)}` });
    // 10.0.0.1 has created an account today, so its bucket is full: an unknown address asked
    // from there gets a challenge that can never verify, and no email (06 §3.2).
    const sending = {
      known: await workOf(ask("known@example.org", "10.0.2.1")),
      unknown: await workOf(ask("nobody@example.org", "10.0.2.2")),
      suspended: await workOf(ask("suspended@example.org", "10.0.2.3")),
      "known, full new-accounts bucket": await workOf(ask("known@example.org", "10.0.0.1")),
      "suspended, full new-accounts bucket": await workOf(ask("suspended@example.org", "10.0.0.1")),
    };
    const silent = {
      "per-email limited": await workOf(ask("limited@example.org", "10.0.2.4")),
      "known, per-email limited": await workOf(ask("limited-known@example.org", "10.0.2.5")),
      "unknown, full new-accounts bucket": await workOf(ask("other@example.org", "10.0.0.1")),
    };
    // The silent paths really were silent.
    const sentTo = async (email: string) =>
      (await harness.emails()).filter((e) => e.to === email).length;
    expect(await sentTo("limited@example.org")).toBe(5);
    expect(await sentTo("limited-known@example.org")).toBe(5);
    expect(await sentTo("other@example.org")).toBe(0);
    harness.close();
    h = null;
    // Over the instance-wide cap: an instance of its own, whose one email signing in used up.
    const capped = recordingHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_HOUR: "1" });
    h = capped.harness;
    const askCapped = (email: string, ip: string) => () =>
      capped.harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip });
    await capped.harness.signIn("known@example.org", { ip: "10.0.3.1" });
    const overCap = {
      "known, over the cap": await capped.workOf(askCapped("known@example.org", "10.0.3.2")),
      "unknown, over the cap": await capped.workOf(askCapped("nobody@example.org", "10.0.3.3")),
    };
    capped.harness.close();
    h = null;

    const reference = sending.known.calls;
    for (const [path, work] of Object.entries({ ...sending, ...overCap })) {
      expect({ path, calls: work.calls }).toEqual({ path, calls: reference });
    }
    // Paths that send nothing count in the separate counter, and nothing else differs.
    for (const [path, work] of Object.entries(silent)) {
      expect({ path, calls: asSending(work.calls) }).toEqual({ path, calls: reference });
      expect(work.calls).toContain(
        "rateLimits.hit(OTP_EMAIL_GLOBAL_HOUR:silent=1,OTP_EMAIL_GLOBAL_DAY:silent=1)",
      );
      expect(work.calls.join(" ")).not.toContain(":all=");
    }
    expect(reference).toContain(
      "rateLimits.hit(OTP_EMAIL_GLOBAL_HOUR:all=1,OTP_EMAIL_GLOBAL_DAY:all=1)",
    );
    // The background task is scheduled exactly once on every path that answers 202.
    for (const [path, work] of Object.entries({ ...sending, ...silent, ...overCap })) {
      expect({ path, scheduled: work.scheduled }).toEqual({ path, scheduled: 1 });
    }
  });

  it("/otp/request refused on the client IP makes the same calls for a known and an unknown address", async () => {
    const { harness, workOf } = recordingHarness({ ...PROD_ENV, LIMIT_OTP_REQUEST_IP_HOUR: "1" });
    h = harness;
    await harness.signIn("known@example.org", { ip: "10.0.7.0" });
    const refused = async (email: string, ip: string): Promise<Work> => {
      await harness.requestCode("warm@example.org", { ip });
      return workOf(() => harness.request("POST", "/api/v1/auth/otp/request", { email }, { ip }));
    };
    const known = await refused("known@example.org", "10.0.7.1");
    const unknown = await refused("nobody@example.org", "10.0.7.2");
    expect(known.calls).toEqual(unknown.calls);
    // Refused before anything per-address: one counter write, no challenge, no background task.
    expect(known.calls).toEqual(["rateLimits.hit(OTP_REQUEST_IP_HOUR:<hash>=1)"]);
    expect(known.scheduled).toBe(0);
    expect(unknown.scheduled).toBe(0);
  });

  it("/otp/verify makes the same repository calls for a wrong code, known or unknown", async () => {
    const { harness, workOf } = recordingHarness(PROD_ENV);
    h = harness;
    await harness.signIn("known@example.org", { ip: "10.0.0.1" });
    const calls = [];
    for (const [i, email] of ["known@example.org", "nobody@example.org"].entries()) {
      await harness.requestCode(email, { ip: `10.0.4.${String(i)}` });
      calls.push(
        (
          await workOf(() =>
            harness.request(
              "POST",
              "/api/v1/auth/otp/verify",
              { email, code: "12345678" },
              { ip: `10.0.5.${String(i)}` },
            ),
          )
        ).calls,
      );
    }
    expect(calls[1]).toEqual(calls[0]);
  });

  it("/otp/verify makes the same calls with no live challenge, and past the failure lockout", async () => {
    const { harness, workOf } = recordingHarness({
      ...PROD_ENV,
      LIMIT_OTP_VERIFY_FAIL_EMAIL_HOUR: "2",
    });
    h = harness;
    // known@ has an account whose only challenge was consumed by signing in: none is live.
    await harness.signIn("known@example.org", { ip: "10.0.0.1" });
    const wrong = (email: string, ip: string) => () =>
      harness.request("POST", "/api/v1/auth/otp/verify", { email, code: "12345678" }, { ip });
    const none = [
      await workOf(wrong("known@example.org", "10.0.8.1")),
      await workOf(wrong("nobody@example.org", "10.0.8.2")),
    ];
    expect(none[1]?.calls).toEqual(none[0]?.calls);
    // Two failures each reach the lockout of 2; the next verify is refused.
    for (const [i, email] of ["known@example.org", "nobody@example.org"].entries()) {
      await workOf(wrong(email, `10.0.9.${String(i)}`));
      await workOf(wrong(email, `10.0.10.${String(i)}`));
    }
    const refused = [
      await workOf(wrong("known@example.org", "10.0.11.1")),
      await workOf(wrong("nobody@example.org", "10.0.11.2")),
    ];
    expect(refused[1]?.calls).toEqual(refused[0]?.calls);
    expect(refused[0]?.calls.length).toBeLessThan(none[0]?.calls.length ?? 0);
  });

  it("the instance-wide day cap sends exactly 500 codes, and the 501st is answered like the rest (08 §4.2, Q3)", async () => {
    // One client, with the per-IP and hourly limits out of the way: only the day cap binds. Every
    // send is recorded (the capture keeps only the latest 200).
    const sentTo: string[] = [];
    h = createHarness(
      { ...PROD_ENV, LIMIT_OTP_REQUEST_IP_HOUR: "100000", LIMIT_OTP_EMAIL_GLOBAL_HOUR: "100000" },
      {
        wrapSender: (capture) => ({
          send: (message) => {
            sentTo.push(message.to);
            return capture.send(message);
          },
        }),
      },
    );
    const harness = h;
    const shapes = [];
    for (let i = 0; i < 501; i++) {
      const response = await harness.request(
        "POST",
        "/api/v1/auth/otp/request",
        { email: `person${String(i)}@example.org` },
        { ip: "10.0.8.1" },
      );
      shapes.push({
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()].sort(),
      });
    }
    await harness.emails(); // lets the background sends finish
    expect(sentTo).toHaveLength(500);
    expect(new Set(sentTo).size).toBe(500);
    expect(sentTo).not.toContain("person500@example.org");
    for (const shape of shapes) expect(shape).toEqual(shapes[0]);
    expect(shapes[500]?.status).toBe(202);
    expect(harness.logs.filter((line) => line["alert"] === "OTP_EMAIL_GLOBAL_DAY")).toHaveLength(1);
  });
});
