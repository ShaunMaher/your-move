/**
 * Enumeration parity of responses (docs/spec/06-auth.md §3.2, 08 T4, Q3): `/otp/request` and
 * `/otp/verify` answer byte for byte the same whether or not the address has an account. Their
 * timing is tested statistically in auth-timing.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createHarness, type Harness } from "./test-harness.js";

let h: Harness | null = null;
afterEach(() => {
  h?.close();
  h = null;
});

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
