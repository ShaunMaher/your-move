/**
 * Sign-in rules settled by the M2b review (docs/reviews/m2b.md): limits charged only where they
 * belong, never-emailed challenges, session rotation, request rules and fault logging.
 */
import { afterEach, describe, expect, it } from "vitest";

import { cookieOf, createHarness, type Harness, LOCAL_ENV, PROD_ENV } from "./test-harness.js";

let h: Harness;
let n = 0;
const fresh = (): string => `review${String(++n)}-${crypto.randomUUID().slice(0, 8)}@example.org`;

afterEach(() => {
  h.close();
});

const otpRequest = (email: string, ip?: string) =>
  h.request("POST", "/api/v1/auth/otp/request", { email }, ip === undefined ? {} : { ip });
const otpVerify = (email: string, code: string, ip?: string) =>
  h.request("POST", "/api/v1/auth/otp/verify", { email, code }, ip === undefined ? {} : { ip });

async function mailCount(to: string): Promise<number> {
  return (await h.emails()).filter((email) => email.to === to).length;
}

describe("limits are charged only where they belong", () => {
  it("S-1: a request refused for its IP leaves the address's own allowance untouched", async () => {
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_REQUEST_IP_HOUR: "1" });
    const target = fresh();
    expect((await otpRequest(fresh(), "198.51.100.1")).status).toBe(202);
    for (let i = 0; i < 12; i++) {
      expect((await otpRequest(target, "198.51.100.1")).status).toBe(429);
    }
    // The address still gets its full 5 an hour from other clients.
    for (let i = 0; i < 5; i++) {
      expect((await otpRequest(target, `198.51.100.${String(10 + i)}`)).status).toBe(202);
    }
    expect(await mailCount(target)).toBe(5);
  });

  it("S-4: new accounts are judged and counted at the verifying client, wherever the code was asked for", async () => {
    h = createHarness({ ...PROD_ENV, LIMIT_NEW_ACCOUNTS_IP_DAY: "1" });
    const first = fresh();
    const code1 = await h.requestCode(first, { ip: "198.51.100.1" });
    expect((await otpVerify(first, code1, "203.0.113.50")).status).toBe(200);
    // The requesting client was never charged, so it still gets codes; the verifying one is full.
    const second = fresh();
    const code2 = await h.requestCode(second, { ip: "198.51.100.1" });
    const refused = await otpVerify(second, code2, "203.0.113.50");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("INVALID_CODE");
    // An existing account still signs in from the full bucket.
    const again = await h.requestCode(first, { ip: "198.51.100.2" });
    expect((await otpVerify(first, again, "203.0.113.50")).status).toBe(200);
  });

  it("P-17: two racing verifies that create one account count it once", async () => {
    h = createHarness({ ...PROD_ENV, LIMIT_NEW_ACCOUNTS_IP_DAY: "2" });
    const email = fresh();
    const a = await h.requestCode(email, { ip: "198.51.100.1" });
    const b = await h.requestCode(email, { ip: "198.51.100.2" });
    const answers = await Promise.all([
      otpVerify(email, a, "203.0.113.60"),
      otpVerify(email, b, "203.0.113.60"),
    ]);
    expect(answers.map((r) => r.status)).toEqual([200, 200]);
    // One account so far: a second new account from the same client still fits the limit of 2.
    const other = fresh();
    const code = await h.requestCode(other, { ip: "198.51.100.3" });
    expect((await otpVerify(other, code, "203.0.113.60")).status).toBe(200);
  });

  it("S-5: never-emailed challenges don't push a real code out", async () => {
    h = createHarness({ ...PROD_ENV, LIMIT_NEW_ACCOUNTS_IP_DAY: "1" });
    // Fill one client's new-accounts bucket.
    const filler = fresh();
    const fillerCode = await h.requestCode(filler, { ip: "198.51.100.9" });
    await otpVerify(filler, fillerCode, "198.51.100.9");
    // A new person asks for a code from their own client...
    const victim = fresh();
    const real = await h.requestCode(victim, { ip: "203.0.113.70" });
    // ...then three requests for the same address from the full bucket get never-emailed challenges.
    const before = await mailCount(victim);
    for (let i = 0; i < 3; i++) expect((await otpRequest(victim, "198.51.100.9")).status).toBe(202);
    expect(await mailCount(victim)).toBe(before);
    expect((await otpVerify(victim, real, "203.0.113.70")).status).toBe(200);
  });
});

describe("tests that can fail (P-2, P-3)", () => {
  it("P-2: a suspended account's real code doesn't sign in", async () => {
    h = createHarness();
    const email = fresh();
    await h.signIn(email);
    const code = await h.requestCode(email);
    h.exec("UPDATE users SET suspended_at = 1 WHERE email = ?", email);
    const response = await otpVerify(email, code);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "INVALID_CODE",
    );
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("P-3: a dropped request leaves the oldest live code intact too", async () => {
    h = createHarness();
    const email = fresh();
    const codes: string[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(await h.requestCode(email, { ip: `192.0.2.${String(i)}` }));
      h.advance(1);
    }
    expect((await otpRequest(email, "192.0.2.99")).status).toBe(202);
    // Codes 3, 4 and 5 are the live ones; the drop must not have burned code 3.
    expect((await otpVerify(email, codes[2] ?? "")).status).toBe(200);
  });
});

describe("request rules (P-8, P-9) and session rotation (P-10)", () => {
  it("P-8: a cookie and a bearer token together are refused on every API route", async () => {
    h = createHarness();
    const cookie = await h.signIn(fresh());
    const response = await h.request(
      "POST",
      "/api/v1/auth/otp/request",
      { email: fresh() },
      { cookie, headers: { Authorization: "Bearer ym_pat_x_y" } },
    );
    expect(response.status).toBe(400);
  });

  it("P-9: a no-input endpoint accepts an empty JSON body", async () => {
    h = createHarness();
    const cookie = await h.signIn(fresh());
    const response = await h.request("POST", "/api/v1/auth/logout", undefined, {
      cookie,
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(204);
  });

  it("P-10: signing in again replaces the session the browser presents", async () => {
    h = createHarness();
    const email = fresh();
    const first = await h.signIn(email);
    const code = await h.requestCode(email);
    const response = await h.request(
      "POST",
      "/api/v1/auth/otp/verify",
      { email, code },
      { cookie: first },
    );
    expect(response.status).toBe(200);
    const second = cookieOf(response);
    expect(second).not.toBe(first);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie: first })).status).toBe(401);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie: second })).status).toBe(200);
  });
});

describe("fault logging (S-2)", () => {
  it.each([
    ["a single statement (the driver's query error)", "DROP TABLE users"],
    ["a batch", "DROP TABLE otp_challenges"],
  ])("a failing query's SQL parameters never reach the log: %s", async (_, statement) => {
    h = createHarness();
    const email = fresh();
    h.exec(statement);
    const response = await otpRequest(email);
    expect(response.status).toBe(500);
    const fault = h.logs.find((line) => line["msg"] === "unhandled error");
    expect(fault).toBeDefined();
    if (statement.includes("users")) {
      // The driver wraps the failure: logged by class and cause only, never its message.
      expect(fault).toMatchObject({ errorClass: "DrizzleQueryError", causeClass: "Error" });
      expect(fault).not.toHaveProperty("errorMessage");
    }
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain(email);
    expect(logged).not.toContain("params:");
    expect(logged).not.toContain("Failed query");
  });
});

describe("addresses (S-7)", () => {
  it.each([
    "sam\u{202E}gro.elpmaxe@example.org",
    "sam\u{200B}@example.org",
    "sam@exam\u{2060}ple.org",
    "sam\u{AD}@example.org",
  ])("refuses an address with a format character: %j", async (email) => {
    h = createHarness();
    expect((await otpRequest(email)).status).toBe(400);
  });
});

describe("display names (round 2, P2-1)", () => {
  it.each(["\u{2028}", "\u{2029}"])(
    "PATCH /me refuses a Unicode line or paragraph separator (%j) and stores nothing",
    async (separator) => {
      h = createHarness();
      const cookie = await h.signIn(fresh());
      const response = await h.request(
        "PATCH",
        "/api/v1/me",
        { displayName: `Sam${separator}Smith` },
        { cookie },
      );
      expect(response.status).toBe(400);
      const me = (await (await h.request("GET", "/api/v1/me", undefined, { cookie })).json()) as {
        displayName: string | null;
      };
      expect(me.displayName).toBeNull();
    },
  );
});

describe("local-dev mode (S-8)", () => {
  it("/__dev/emails answers only requests addressed to PUBLIC_URL's host", async () => {
    h = createHarness(LOCAL_ENV);
    const own = await h.request("GET", "/__dev/emails", undefined, {
      headers: { Host: "localhost:8080" },
    });
    expect(own.status).toBe(200);
    const rebound = await h.request("GET", "/__dev/emails", undefined, {
      headers: { Host: "attacker.example:8080" },
    });
    expect(rebound.status).toBe(404);
  });
});

describe("alerts (P-12)", () => {
  it("an instance-wide cap alerts once when first crossed, not on every request after", async () => {
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_HOUR: "1" });
    for (let i = 0; i < 5; i++) await otpRequest(fresh(), `198.51.100.${String(i)}`);
    const alerts = h.logs.filter((line) => line["alert"] === "OTP_EMAIL_GLOBAL_HOUR");
    expect(alerts).toHaveLength(1);
  });
});
