import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GMAIL_SEND_SCOPE } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { authorize, AuthorizeError, type AuthorizeOptions } from "./authorize.js";

const realFetch = globalThis.fetch;
const CLIENT_ID = "fake-client-id.apps.example";
const FAKE_TOKEN = "fake-refresh-token-value";
const GOOD_SCOPE = `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SEND_SCOPE}`;

function jwt(claims: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.s`;
}

const goodClaims = {
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  exp: 2_000_000_000,
  email: "No-Reply@example.org",
  email_verified: true,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gmail-authorize-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `authorize` against a fake Google. `browser` plays the person's browser: it gets the printed
 * authorization URL and returns the path-and-query to request on the loopback redirect.
 */
async function run(
  options: {
    token?: Record<string, unknown> | { status: number };
    browser?: (url: URL) => string;
    outFile?: string;
    timeoutMs?: number;
    callback?: (redirect: string) => Promise<void>;
    revokeStatus?: number;
  } = {},
) {
  const printed: string[] = [];
  const requests: {
    url: string;
    body: URLSearchParams;
    redirect?: string | undefined;
  }[] = [];
  let browserDone: Promise<void> = Promise.resolve();
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({
      url,
      redirect: init?.redirect,
      body: new URLSearchParams(
        typeof init?.body === "string" || init?.body instanceof URLSearchParams ? init.body : "",
      ),
    });
    if (url.endsWith("/token")) {
      const token = options.token ?? {
        refresh_token: FAKE_TOKEN,
        access_token: "fake-access",
        scope: GOOD_SCOPE,
        id_token: jwt(goodClaims),
      };
      if ("status" in token)
        return Promise.resolve(new Response("{}", { status: Number(token.status) }));
      return Promise.resolve(Response.json(token));
    }
    return Promise.resolve(new Response("", { status: options.revokeStatus ?? 200 }));
  };
  const config: AuthorizeOptions = {
    clientId: CLIENT_ID,
    clientSecret: "fake-client-secret-value",
    sender: "no-reply@example.org",
    outFile: options.outFile ?? join(dir, "token"),
    fetch: fake,
    now: () => new Date(1_700_000_000_000),
    random: (bytes) => {
      crypto.getRandomValues(bytes);
    },
    timeoutMs: options.timeoutMs ?? 10_000,
    print: (line) => {
      printed.push(line);
      if (line.startsWith("https://accounts.google.com/")) {
        const url = new URL(line);
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        const path =
          options.browser?.(url) ??
          `/callback?code=fake-code&state=${url.searchParams.get("state") ?? ""}`;
        browserDone = (
          options.callback ??
          (async (target) => {
            await realFetch(target);
          })
        )(`${redirect.origin}${path}`);
      }
    },
  };
  const result = await authorize(config).then(
    () => null,
    (error: unknown) => error,
  );
  await browserDone;
  return { result, printed, requests };
}

describe("gmail:authorize (09 §2)", () => {
  it("runs PKCE with exactly the three scopes, then writes the token to a new 0600 file", async () => {
    const { result, printed, requests } = await run();
    expect(result).toBeNull();
    const url = new URL(printed.find((line) => line.startsWith("https://"))?.toString() ?? "");
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({
      response_type: "code",
      client_id: CLIENT_ID,
      scope: `openid email ${GMAIL_SEND_SCOPE}`,
      code_challenge_method: "S256",
      access_type: "offline",
      login_hint: "no-reply@example.org",
    });
    expect(params["redirect_uri"]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
    expect(url.searchParams.has("include_granted_scopes")).toBe(false);
    expect(params["state"]?.length).toBeGreaterThanOrEqual(32);

    const exchange = requests.find((request) => request.url.endsWith("/token"))?.body;
    expect(exchange?.get("grant_type")).toBe("authorization_code");
    expect(exchange?.get("code")).toBe("fake-code");
    expect(exchange?.get("redirect_uri")).toBe(params["redirect_uri"]);
    // The challenge is the S256 of the verifier sent with the exchange.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(exchange?.get("code_verifier") ?? ""),
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    expect(params["code_challenge"]).toBe(expected);

    const file = join(dir, "token");
    expect(readFileSync(file, "utf8")).toBe(`${FAKE_TOKEN}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("never prints the refresh token, the client secret or the verifier", async () => {
    const { printed } = await run();
    const text = printed.join("\n");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain("fake-client-secret-value");
    expect(text).not.toContain("code_verifier");
    expect(text).toContain(join(dir, "token"));
  });

  it("ignores a redirect with the wrong state and still finishes on the right one", async () => {
    const seen: number[] = [];
    const { result } = await run({
      browser: (url) => `/callback?code=fake-code&state=${url.searchParams.get("state") ?? ""}`,
      callback: async (target) => {
        const wrong = await realFetch(target.replace(/state=[^&]+/u, "state=forged"));
        seen.push(wrong.status);
        const stray = await realFetch(new URL("/other", target));
        seen.push(stray.status);
        await realFetch(target);
      },
    });
    expect(seen).toEqual([400, 400]);
    expect(result).toBeNull();
    expect(existsSync(join(dir, "token"))).toBe(true);
  });

  it("fails when the person denies consent", async () => {
    const { result } = await run({
      browser: (url) =>
        `/callback?error=access_denied&state=${url.searchParams.get("state") ?? ""}`,
    });
    expect(result).toBeInstanceOf(AuthorizeError);
    expect(existsSync(join(dir, "token"))).toBe(false);
  });

  it("times out when nobody returns", async () => {
    const { result } = await run({
      timeoutMs: 50,
      callback: () => Promise.resolve(),
    });
    expect(result).toBeInstanceOf(AuthorizeError);
    expect((result as Error).message).toContain("timed out");
  });

  describe.each([
    ["wider scopes", { scope: `${GOOD_SCOPE} https://mail.google.com/` }, "scopes"],
    ["narrower scopes", { scope: GMAIL_SEND_SCOPE }, "scopes"],
    [
      "another account",
      { id_token: jwt({ ...goodClaims, email: "admin@example.org" }) },
      "different account",
    ],
    ["another client", { id_token: jwt({ ...goodClaims, aud: "someone-else" }) }, "another client"],
    ["an expired id_token", { id_token: jwt({ ...goodClaims, exp: 1 }) }, "expired"],
    [
      "an unverified email",
      { id_token: jwt({ ...goodClaims, email_verified: false }) },
      "not verified",
    ],
    ["another issuer", { id_token: jwt({ ...goodClaims, iss: "https://evil.example" }) }, "issuer"],
    ["no id_token", { id_token: undefined }, "id_token"],
  ])("refuses %s", (_name, override, message) => {
    it("writes nothing and revokes the token", async () => {
      const { result, requests, printed } = await run({
        token: {
          refresh_token: FAKE_TOKEN,
          access_token: "fake-access",
          scope: GOOD_SCOPE,
          id_token: jwt(goodClaims),
          ...override,
        },
      });
      expect(result).toBeInstanceOf(AuthorizeError);
      expect((result as Error).message).toContain(message);
      expect((result as Error).message).not.toContain(FAKE_TOKEN);
      expect(existsSync(join(dir, "token"))).toBe(false);
      const revoked = requests.find((request) => request.url.endsWith("/revoke"));
      expect(revoked?.body.get("token")).toBe(FAKE_TOKEN);
      expect(printed.join("\n")).not.toContain(FAKE_TOKEN);
    });
  });

  it("never follows a redirect on the revoke request either (A5-S2-6)", async () => {
    const { requests } = await run({
      token: {
        refresh_token: FAKE_TOKEN,
        access_token: "x",
        scope: "wrong",
        id_token: jwt(goodClaims),
      },
    });
    const revoked = requests.find((request) => request.url.endsWith("/revoke"));
    expect(revoked?.redirect).toBe("error");
  });

  it("says so when revocation fails, and when it works", async () => {
    const token = {
      refresh_token: FAKE_TOKEN,
      scope: GOOD_SCOPE,
      id_token: jwt({ ...goodClaims, email: "admin@example.org" }),
    };
    const failed = await run({ token, revokeStatus: 400 });
    expect((failed.result as Error).message).toContain("revocation failed");
    expect((failed.result as Error).message).toContain("security settings");
    expect((failed.result as Error).message).not.toContain(FAKE_TOKEN);
    const worked = await run({ token });
    expect((worked.result as Error).message).toContain("revoked");
    expect((worked.result as Error).message).not.toContain("revocation failed");
  });

  it("accepts Google's plain `email` scope name and a string email_verified", async () => {
    const { result } = await run({
      token: {
        refresh_token: FAKE_TOKEN,
        scope: `openid email ${GMAIL_SEND_SCOPE}`,
        id_token: jwt({ ...goodClaims, email_verified: "true" }),
      },
    });
    expect(result).toBeNull();
  });

  it("fails without a refresh token or when Google refuses the code", async () => {
    const none = await run({ token: { scope: GOOD_SCOPE, id_token: jwt(goodClaims) } });
    expect((none.result as Error).message).toContain("no refresh token");
    const refused = await run({ token: { status: 400 } });
    expect((refused.result as Error).message).toContain("HTTP 400");
    expect(existsSync(join(dir, "token"))).toBe(false);
  });

  it("never overwrites an existing file, and revokes the token it can't store", async () => {
    const outFile = join(dir, "existing");
    writeFileSync(outFile, "keep me");
    const { result, requests } = await run({ outFile });
    expect(result).toBeInstanceOf(AuthorizeError);
    expect(readFileSync(outFile, "utf8")).toBe("keep me");
    expect(requests.some((request) => request.url.endsWith("/revoke"))).toBe(true);
  });
});
