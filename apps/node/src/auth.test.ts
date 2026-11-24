/**
 * Integration tests for sign-in (docs/spec/06-auth.md §3–§4, 05 §Auth & account, 08 §4): the real
 * app on a real SQLite database, one test per rule. The timing-parity test is in
 * `auth-parity.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codeOf,
  cookieOf,
  createHarness,
  DAY,
  type Harness,
  HOUR,
  LOCAL_ENV,
  MINUTE,
  PROD_ENV,
} from "./test-harness.js";

let h: Harness;
let n = 0;
/** A fresh address per call. */
const fresh = (): string => `user${String(++n)}-${crypto.randomUUID().slice(0, 8)}@example.org`;

beforeEach(() => {
  h = createHarness();
});
afterEach(() => {
  h.close();
});

const otpRequest = (email: string, options?: Parameters<Harness["request"]>[3]) =>
  h.request("POST", "/api/v1/auth/otp/request", { email }, options);
const otpVerify = (email: string, code: string, options?: Parameters<Harness["request"]>[3]) =>
  h.request("POST", "/api/v1/auth/otp/verify", { email, code }, options);

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe("POST /api/v1/auth/otp/request", () => {
  it("answers 202 {} and emails an 8-digit code with the fixed template (06 §3.3)", async () => {
    const email = fresh();
    const response = await otpRequest(email);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
    const sent = await h.lastEmail(email);
    const code = codeOf(sent);
    expect(code).toMatch(/^\d{8}$/u);
    expect(sent?.subject).toBe(`${code} is your Family Games sign-in code`);
    expect(sent?.text).toContain(`${code.slice(0, 4)} ${code.slice(4)}`);
    expect(sent?.text).toContain("expires in 10 minutes");
    expect(sent?.text).toContain("We will never ask you for this code");
    expect(sent?.text).toContain("If you didn't request this, ignore this email.");
    expect(sent?.text).toContain("2026-01-01 09:00 UTC");
    expect(sent?.html).not.toContain(`href`);
  });

  it("normalises the address: case and surrounding space don't matter", async () => {
    const email = fresh();
    const code = await h.requestCode(`  ${email.toUpperCase()} `);
    expect((await otpVerify(email, code)).status).toBe(200);
  });

  it.each([
    "not-an-address",
    "a@b",
    "two@@example.org",
    "x <a@example.org>",
    "a@example.org\r\nBcc: b@example.org",
  ])("refuses an invalid address %j with 400 BAD_REQUEST", async (email) => {
    const response = await otpRequest(email);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("BAD_REQUEST");
  });

  it("never stores the code: only an HMAC of it", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const logs = JSON.stringify(h.logs);
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(email);
  });
});

describe("POST /api/v1/auth/otp/verify", () => {
  it("signs a new address up: 200, needsOnboarding, and the __Host- session cookie (06 §4)", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const response = await otpVerify(email, `${code.slice(0, 4)} ${code.slice(4)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: Record<string, unknown>;
      needsOnboarding: boolean;
    };
    expect(body.needsOnboarding).toBe(true);
    expect(body.user).toMatchObject({
      kind: "human",
      email,
      displayName: null,
      settings: { whoCanAddMe: "pastOpponents" },
      ageAttested: false,
      needsOnboarding: true,
      isAdmin: false,
    });
    const cookie = response.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(
      /^__Host-sid=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/u,
    );
  });

  it("signs an existing account in to the same user", async () => {
    const email = fresh();
    const first = await h.signIn(email);
    const second = await h.signIn(email);
    const me = async (cookie: string) =>
      (
        (await (await h.request("GET", "/api/v1/me", undefined, { cookie })).json()) as {
          id: string;
        }
      ).id;
    expect(await me(first)).toBe(await me(second));
  });

  it("a wrong code, an unknown address and a malformed code all answer the same 400 INVALID_CODE", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const wrong = code === "00000000" ? "00000001" : "00000000";
    const answers = await Promise.all([
      otpVerify(email, wrong),
      otpVerify(fresh(), code),
      otpVerify(email, "12ab"),
    ]);
    const bodies = await Promise.all(answers.map((r) => r.text()));
    expect(answers.map((r) => r.status)).toEqual([400, 400, 400]);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({ error: { code: "INVALID_CODE" } });
  });

  it("a code expires after 10 minutes", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    h.advance(10 * MINUTE);
    expect((await otpVerify(email, code)).status).toBe(400);
  });

  it("a code works just before it expires", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    h.advance(10 * MINUTE - 1);
    expect((await otpVerify(email, code)).status).toBe(200);
  });

  it("a code is single use", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    expect((await otpVerify(email, code)).status).toBe(200);
    expect((await otpVerify(email, code)).status).toBe(400);
  });

  it("5 wrong attempts burn the challenge: the right code then fails", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const wrong = code === "00000000" ? "00000001" : "00000000";
    for (let i = 0; i < 5; i++) expect((await otpVerify(email, wrong)).status).toBe(400);
    expect((await otpVerify(email, code)).status).toBe(400);
  });

  it("4 wrong attempts leave the challenge usable", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const wrong = code === "00000000" ? "00000001" : "00000000";
    for (let i = 0; i < 4; i++) await otpVerify(email, wrong);
    expect((await otpVerify(email, code)).status).toBe(200);
  });

  it("up to 3 live challenges all verify, so a new request can't invalidate a received code", async () => {
    const email = fresh();
    const codes = [
      await h.requestCode(email),
      await h.requestCode(email),
      await h.requestCode(email),
    ];
    expect((await otpVerify(email, codes[0] ?? "")).status).toBe(200);
  });

  it("issuing a 4th challenge burns the oldest", async () => {
    const email = fresh();
    const codes: string[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push(await h.requestCode(email));
      h.advance(1);
    }
    expect((await otpVerify(email, codes[0] ?? "")).status).toBe(400);
    expect((await otpVerify(email, codes[1] ?? "")).status).toBe(200);
  });

  it("a wrong verify consumes one attempt on each live challenge", async () => {
    const email = fresh();
    const old = await h.requestCode(email);
    await h.requestCode(email);
    const wrong = "99999999";
    // 5 wrong verifies use up the 5 attempts of both challenges.
    for (let i = 0; i < 5; i++) await otpVerify(email, wrong);
    expect((await otpVerify(email, old)).status).toBe(400);
  });

  it("50 parallel verifies of one code: exactly one signs in (06 §3.1)", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const answers = await Promise.all(Array.from({ length: 50 }, () => otpVerify(email, code)));
    const statuses = answers.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s !== 200).every((s) => s === 400)).toBe(true);
  });

  it("50 parallel wrong verifies are counted atomically: the challenge burns after 5", async () => {
    const email = fresh();
    const code = await h.requestCode(email);
    const wrong = code === "00000000" ? "00000001" : "00000000";
    await Promise.all(
      Array.from({ length: 50 }, () => otpVerify(email, wrong, { ip: "198.51.100.7" })),
    );
    // Per-email failed-verify lockout would also refuse; a new client IP and a fresh hour show
    // the challenge itself is burned.
    h.advance(2 * HOUR);
    expect((await otpVerify(email, code, { ip: "198.51.100.8" })).status).toBe(400);
  });
});

describe("rate limits (08 §4)", () => {
  it("per email: the 6th request in an hour is silently dropped — no challenge, no email, earlier codes intact", async () => {
    const email = fresh();
    const codes: string[] = [];
    for (let i = 0; i < 5; i++)
      codes.push(await h.requestCode(email, { ip: `192.0.2.${String(i)}` }));
    const before = (await h.emails()).length;
    const response = await otpRequest(email, { ip: "192.0.2.99" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({});
    expect((await h.emails()).length).toBe(before);
    // The 3 newest challenges are still live: the drop touched none of them.
    expect((await otpVerify(email, codes[4] ?? "")).status).toBe(200);
  });

  it("per email: 10 requests a day", async () => {
    const email = fresh();
    for (let i = 0; i < 10; i++) {
      await h.requestCode(email, { ip: `192.0.2.${String(i)}` });
      h.advance(70 * MINUTE);
    }
    const before = (await h.emails()).length;
    expect((await otpRequest(email, { ip: "192.0.2.200" })).status).toBe(202);
    expect((await h.emails()).length).toBe(before);
  });

  it("per IP: the 21st request in an hour answers 429", async () => {
    for (let i = 0; i < 20; i++) expect((await otpRequest(fresh())).status).toBe(202);
    const response = await otpRequest(fresh());
    expect(response.status).toBe(429);
    expect(await errorCode(response)).toBe("RATE_LIMITED");
  });

  it("the sliding window weights the previous hour, so a boundary burst can't double the limit", async () => {
    h.setTime(Date.UTC(2026, 0, 1, 9, 59, 0));
    for (let i = 0; i < 20; i++) await otpRequest(fresh());
    h.setTime(Date.UTC(2026, 0, 1, 10, 1, 0));
    expect((await otpRequest(fresh())).status).toBe(429);
  });

  it("per email: 10 failed verifies an hour lock verifies out, even with the right code", async () => {
    const email = fresh();
    for (let i = 0; i < 10; i++) await otpVerify(email, "11111111", { ip: `192.0.2.${String(i)}` });
    const code = await h.requestCode(email, { ip: "192.0.2.50" });
    const response = await otpVerify(email, code, { ip: "192.0.2.51" });
    expect(response.status).toBe(429);
    h.advance(2 * HOUR);
    const later = await h.requestCode(email, { ip: "192.0.2.52" });
    expect((await otpVerify(email, later, { ip: "192.0.2.53" })).status).toBe(200);
  });

  it("per IP: the 51st verify in an hour answers 429", async () => {
    for (let i = 0; i < 50; i++) expect((await otpVerify(fresh(), "12345678")).status).toBe(400);
    expect((await otpVerify(fresh(), "12345678")).status).toBe(429);
  });

  it("IPv6: one /64 is one bucket, a /56 allows 4× and a /48 10× (08 §4.1)", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_REQUEST_IP_HOUR: "1" });
    expect((await otpRequest(fresh(), { ip: "2001:db8:0:100::1" })).status).toBe(202);
    expect((await otpRequest(fresh(), { ip: "2001:db8:0:100::2" })).status).toBe(429);
    // The /56 counts every request from its /64s, refused ones too: 4 allowed in all.
    for (const net of ["101", "102"]) {
      expect((await otpRequest(fresh(), { ip: `2001:db8:0:${net}::1` })).status).toBe(202);
    }
    expect((await otpRequest(fresh(), { ip: "2001:db8:0:103::1" })).status).toBe(429);
    // Other /56s of the same /48: 10 in all across the /48.
    for (const net of ["200", "300", "400", "500", "600"]) {
      expect((await otpRequest(fresh(), { ip: `2001:db8:0:${net}::1` })).status).toBe(202);
    }
    expect((await otpRequest(fresh(), { ip: "2001:db8:0:700::1" })).status).toBe(429);
    // Another /48 is unaffected.
    expect((await otpRequest(fresh(), { ip: "2001:db8:1::1" })).status).toBe(202);
  });

  it("an IPv4-mapped IPv6 address counts in the IPv4 bucket", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_REQUEST_IP_HOUR: "1" });
    expect((await otpRequest(fresh(), { ip: "198.51.100.20" })).status).toBe(202);
    expect((await otpRequest(fresh(), { ip: "::ffff:198.51.100.20" })).status).toBe(429);
  });

  it("X-Forwarded-For: spoofed left entries are ignored; the trusted hop's entry counts", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_REQUEST_IP_HOUR: "1" });
    expect((await otpRequest(fresh(), { xff: "1.1.1.1, 198.51.100.30" })).status).toBe(202);
    expect((await otpRequest(fresh(), { xff: "2.2.2.2, 198.51.100.30" })).status).toBe(429);
  });

  it("a missing or invalid client address answers 400; /api/health needs none", async () => {
    expect((await otpRequest(fresh(), { ip: null })).status).toBe(400);
    expect((await otpRequest(fresh(), { xff: "not-an-ip" })).status).toBe(400);
    expect((await h.request("GET", "/api/health", undefined, { ip: null })).status).toBe(200);
  });

  it("a socket peer outside TRUST_PROXY_PEERS answers 400 on an IP-using route", async () => {
    expect((await otpRequest(fresh(), { peer: "198.51.100.1" })).status).toBe(400);
  });

  it("new accounts per IP: an unknown address from a full bucket gets 202, no email, and a code that never verifies", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_NEW_ACCOUNTS_IP_DAY: "1" });
    const known = fresh();
    await h.signIn(known);
    const unknown = fresh();
    const before = (await h.emails()).length;
    expect((await otpRequest(unknown)).status).toBe(202);
    expect((await h.emails()).length).toBe(before);
    expect((await otpVerify(unknown, "12345678")).status).toBe(400);
    // A known address from the same bucket still gets its code.
    const code = await h.requestCode(known);
    expect((await otpVerify(known, code)).status).toBe(200);
  });

  it("instance-wide OTP email cap: over it, 202 with no email and an alert", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_HOUR: "2" });
    await h.requestCode(fresh());
    await h.requestCode(fresh(), { ip: "198.51.100.2" });
    const before = (await h.emails()).length;
    expect((await otpRequest(fresh(), { ip: "198.51.100.3" })).status).toBe(202);
    expect((await h.emails()).length).toBe(before);
    expect(h.logs.some((line) => line["alert"] === "OTP_EMAIL_GLOBAL_HOUR")).toBe(true);
  });

  it("instance-wide OTP email cap per day", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_DAY: "1" });
    await h.requestCode(fresh());
    h.advance(2 * HOUR);
    const before = (await h.emails()).length;
    expect((await otpRequest(fresh())).status).toBe(202);
    expect((await h.emails()).length).toBe(before);
    expect(h.logs.some((line) => line["alert"] === "OTP_EMAIL_GLOBAL_DAY")).toBe(true);
  });

  it("instance-wide failed verifies: over the threshold, an alert", async () => {
    h.close();
    h = createHarness({ ...PROD_ENV, LIMIT_OTP_VERIFY_FAIL_GLOBAL_HOUR: "2" });
    for (let i = 0; i < 3; i++) await otpVerify(fresh(), "12345678");
    expect(h.logs.some((line) => line["alert"] === "OTP_VERIFY_FAIL_GLOBAL_HOUR")).toBe(true);
  });

  it("refuses an unknown LIMIT_* name at startup", () => {
    expect(() => createHarness({ ...PROD_ENV, LIMIT_OTP_TYPO: "1" })).toThrow(/LIMIT_OTP_TYPO/u);
  });
});

describe("suspended accounts (06 §4)", () => {
  it("get the fixed suspended notice instead of a code, and can't sign in", async () => {
    const email = fresh();
    const cookie = await h.signIn(email);
    const me = (await (await h.request("GET", "/api/v1/me", undefined, { cookie })).json()) as {
      id: string;
    };
    // Suspension arrives with the Admin API (M3); set it in the database.
    h.exec("UPDATE users SET suspended_at = 1 WHERE id = ?", me.id);
    const response = await otpRequest(email);
    expect(response.status).toBe(202);
    const sent = await h.lastEmail(email);
    expect(sent?.subject).toBe("Your Family Games account is suspended");
    expect(sent?.text).not.toMatch(/\d{4} \d{4}/u);
    expect((await otpVerify(email, "12345678")).status).toBe(400);
    const surviving = await h.request("GET", "/api/v1/me", undefined, { cookie });
    expect(surviving.status).toBe(403);
    expect(await errorCode(surviving)).toBe("SUSPENDED");
  });
});

describe("sessions (06 §4)", () => {
  it("GET /api/v1/me answers the user with a session and 401 without", async () => {
    const email = fresh();
    const cookie = await h.signIn(email);
    const response = await h.request("GET", "/api/v1/me", undefined, { cookie });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email, needsOnboarding: true, isAdmin: false });
    const anonymous = await h.request("GET", "/api/v1/me");
    expect(anonymous.status).toBe(401);
    expect(await errorCode(anonymous)).toBe("UNAUTHENTICATED");
    const forged = await h.request("GET", "/api/v1/me", undefined, {
      cookie: `__Host-sid=${"A".repeat(43)}`,
    });
    expect(forged.status).toBe(401);
  });

  it("isAdmin follows ADMIN_EMAILS", async () => {
    const cookie = await h.signIn("Admin@Example.org");
    const me = (await (await h.request("GET", "/api/v1/me", undefined, { cookie })).json()) as {
      isAdmin: boolean;
    };
    expect(me.isAdmin).toBe(true);
  });

  it("sliding expiry: valid for 180 days since last use", async () => {
    const cookie = await h.signIn(fresh());
    h.advance(179 * DAY);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(200);
    h.advance(179 * DAY);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(200);
    h.advance(181 * DAY);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(401);
  });

  it("absolute cap: 400 days after sign-in, even with regular use", async () => {
    const cookie = await h.signIn(fresh());
    for (let day = 0; day < 399; day += 30) {
      h.advance(30 * DAY);
      if (day + 30 < 400) {
        expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(200);
      }
    }
    h.advance(30 * DAY);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(401);
  });

  it("last_seen_at is refreshed at most once an hour", async () => {
    const cookie = await h.signIn(fresh());
    const token = cookie.split("=")[1] ?? "";
    const digest = async () => {
      const bytes = new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
      );
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    };
    const seen = async () =>
      (await h.platform.repos.sessions.findByTokenHash(await digest()))?.session.lastSeenAt;
    const first = await seen();
    h.advance(30 * MINUTE);
    await h.request("GET", "/api/v1/me", undefined, { cookie });
    expect(await seen()).toBe(first);
    h.advance(31 * MINUTE);
    await h.request("GET", "/api/v1/me", undefined, { cookie });
    expect(await seen()).toBe((first ?? 0) + 61 * MINUTE);
  });

  it("logout deletes the session and clears the cookie", async () => {
    const cookie = await h.signIn(fresh());
    const response = await h.request("POST", "/api/v1/auth/logout", {}, { cookie });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toMatch(
      /^__Host-sid=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/u,
    );
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(401);
  });

  it("logout without a body (empty POST) works", async () => {
    const cookie = await h.signIn(fresh());
    expect((await h.request("POST", "/api/v1/auth/logout", undefined, { cookie })).status).toBe(
      204,
    );
  });

  it("logout-all signs every session of the user out, and only that user's", async () => {
    const email = fresh();
    const a = await h.signIn(email);
    const b = await h.signIn(email);
    const other = await h.signIn(fresh());
    const response = await h.request(
      "POST",
      "/api/v1/auth/logout-all",
      { revokeTokens: true },
      { cookie: a },
    );
    expect(response.status).toBe(204);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie: a })).status).toBe(401);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie: b })).status).toBe(401);
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie: other })).status).toBe(200);
  });

  it("logout needs a session", async () => {
    expect((await h.request("POST", "/api/v1/auth/logout", {})).status).toBe(401);
  });

  it("a cookie and a bearer token together are refused (05 §Conventions)", async () => {
    const cookie = await h.signIn(fresh());
    const response = await h.request("GET", "/api/v1/me", undefined, {
      cookie,
      headers: { Authorization: "Bearer ym_pat_x_y" },
    });
    expect(response.status).toBe(400);
  });
});

describe("Origin and JSON rules (05 §Conventions, 08 T6)", () => {
  it("a cookie request without Origin, or with another origin, gets 403 BAD_ORIGIN", async () => {
    const cookie = await h.signIn(fresh());
    for (const origin of [null, "https://evil.example", "http://play.example.org"]) {
      const response = await h.request("POST", "/api/v1/auth/logout", {}, { cookie, origin });
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe("BAD_ORIGIN");
    }
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(200);
  });

  it("a cookie DELETE without a body still needs the Origin", async () => {
    const cookie = await h.signIn(fresh());
    const response = await h.request("DELETE", "/api/v1/me", undefined, { cookie, origin: null });
    expect(response.status).toBe(403);
  });

  it("a public request without Origin is allowed; one from another origin is refused", async () => {
    expect((await otpRequest(fresh(), { origin: null })).status).toBe(202);
    const response = await otpRequest(fresh(), { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("BAD_ORIGIN");
  });

  it("a body that isn't JSON gets 415 UNSUPPORTED_MEDIA_TYPE", async () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await h.request(
        "POST",
        "/api/v1/auth/otp/request",
        { email: fresh() },
        {
          headers: { "Content-Type": type },
        },
      );
      expect(response.status).toBe(415);
      expect(await errorCode(response)).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
  });

  it("JSON with a charset is accepted", async () => {
    const response = await h.request(
      "POST",
      "/api/v1/auth/otp/request",
      { email: fresh() },
      {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      },
    );
    expect(response.status).toBe(202);
  });

  it("unknown fields are rejected (.strict())", async () => {
    const response = await h.request("POST", "/api/v1/auth/otp/request", {
      email: fresh(),
      admin: true,
    });
    expect(response.status).toBe(400);
  });

  it("a body over 16 kB gets 413 TOO_LARGE", async () => {
    const response = await h.request("POST", "/api/v1/auth/otp/request", {
      email: "x".repeat(17_000),
    });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("TOO_LARGE");
  });
});

describe("onboarding: PATCH /api/v1/me (06 §5)", () => {
  it("the first display name completes onboarding", async () => {
    const cookie = await h.signIn(fresh());
    const response = await h.request(
      "PATCH",
      "/api/v1/me",
      { displayName: "  Sam   Smith " },
      { cookie },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      displayName: "Sam Smith",
      needsOnboarding: false,
    });
  });

  it.each([
    "",
    "a".repeat(25),
    "see www.example",
    "me@home",
    "visit example.com",
    "call 5551234567",
    "Family Games fan",
    "the admin",
    "Sam\u{202E}evil",
    "Sam\u{200B}x",
    "Sam\nBcc: x",
  ])("refuses the display name %j", async (displayName) => {
    const cookie = await h.signIn(fresh());
    const response = await h.request("PATCH", "/api/v1/me", { displayName }, { cookie });
    expect(response.status).toBe(400);
  });

  it("after onboarding, at most 3 changes per 30 days", async () => {
    const cookie = await h.signIn(fresh());
    await h.request("PATCH", "/api/v1/me", { displayName: "Sam" }, { cookie });
    for (const name of ["Sam A", "Sam B", "Sam C"]) {
      expect(
        (await h.request("PATCH", "/api/v1/me", { displayName: name }, { cookie })).status,
      ).toBe(200);
    }
    const limited = await h.request("PATCH", "/api/v1/me", { displayName: "Sam D" }, { cookie });
    expect(limited.status).toBe(429);
    h.advance(61 * DAY);
    expect(
      (await h.request("PATCH", "/api/v1/me", { displayName: "Sam D" }, { cookie })).status,
    ).toBe(200);
  });
});

describe("account deletion with a step-up code (06 §7)", () => {
  it("emails a purpose-bound code; a sign-in code doesn't work; the right one deletes the account", async () => {
    const email = fresh();
    const cookie = await h.signIn(email);
    const signInCode = await h.requestCode(email);
    expect((await h.request("POST", "/api/v1/me/delete/otp", {}, { cookie })).status).toBe(202);
    const sent = await h.lastEmail(email);
    expect(sent?.subject).toBe("Your code to delete your Family Games account");
    const deleteCode = codeOf(sent);
    const wrong = await h.request("DELETE", "/api/v1/me", { code: signInCode }, { cookie });
    expect(wrong.status).toBe(400);
    expect(await errorCode(wrong)).toBe("INVALID_CODE");
    const response = await h.request("DELETE", "/api/v1/me", { code: deleteCode }, { cookie });
    expect(response.status).toBe(204);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await h.request("GET", "/api/v1/me", undefined, { cookie })).status).toBe(401);
    expect((await h.lastEmail(email))?.subject).toBe("Your Family Games account has been deleted");
    // A delete code can't sign in either.
    expect((await otpVerify(email, deleteCode)).status).toBe(400);
  });

  it("step-up requests are limited per user: 5 an hour", async () => {
    const cookie = await h.signIn(fresh());
    for (let i = 0; i < 5; i++) {
      expect((await h.request("POST", "/api/v1/me/delete/otp", {}, { cookie })).status).toBe(202);
    }
    expect((await h.request("POST", "/api/v1/me/delete/otp", {}, { cookie })).status).toBe(429);
  });
});

describe("local-dev mode and /__dev/emails (09 §2, 08 T19)", () => {
  it("answers 404 in a production config", async () => {
    const response = await h.request("GET", "/__dev/emails");
    expect(response.status).toBe(404);
  });

  it("lists captured emails in local-dev mode, with the plain sid cookie", async () => {
    h.close();
    h = createHarness(LOCAL_ENV);
    const email = fresh();
    const code = await h.requestCode(email);
    const listed = (await (await h.request("GET", "/__dev/emails")).json()) as {
      emails: { to: string; subject: string }[];
    };
    expect(listed.emails.some((e) => e.to === email && e.subject.startsWith(code))).toBe(true);
    const response = await otpVerify(email, code);
    expect(cookieOf(response)).toMatch(/^sid=/u);
    expect(response.headers.get("Set-Cookie")).not.toContain("Secure");
  });
});
