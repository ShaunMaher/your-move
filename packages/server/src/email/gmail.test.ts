import { describe, expect, it } from "vitest";

import { normaliseAddress } from "../accounts/email.js";
import { parseConfig } from "../config/parse.js";
import { createJsonLogger } from "../log.js";
import {
  createGmailEmailSender,
  GMAIL_SEND_SCOPE,
  GmailTokenRefused,
  grantedScopes,
  idTokenClaims,
  isExpectedScopes,
} from "./gmail.js";
import { coreEmailSender } from "./providers.js";
import { EmailHeaderError, wasAlerted } from "./sender.js";
import { signInCodeEmail } from "./templates.js";

const FAKE = {
  clientId: "fake-client-id.apps.example",
  clientSecret: "fake-client-secret-value",
  refreshToken: "fake-refresh-token-value",
  access: "fake-access-token-value",
};
const config = {
  provider: "gmail",
  from: '"Example Games" <no-reply@example.org>',
  clientId: FAKE.clientId,
  clientSecret: FAKE.clientSecret,
  refreshToken: FAKE.refreshToken,
  sender: "no-reply@example.org",
} as const;
const recipient = normaliseAddress("sam@example.org");
if (recipient === null) throw new Error("test address is invalid");
const message = signInCodeEmail(recipient, "12345678", {
  appName: "Example Games",
  publicUrl: "https://play.example.org",
  requestedAt: "2026-01-01 09:00 UTC",
});

function jwt(claims: Record<string, unknown>): string {
  return `h.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}.s`;
}

const GOOD_ID_TOKEN = jwt({
  email: "No-Reply@example.org",
  email_verified: true,
  aud: FAKE.clientId,
});
const GOOD_SCOPE = `openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SEND_SCOPE}`;

interface Call {
  url: string;
  headers: Headers;
  body: string;
}

/** A fake Google: token endpoint and `messages.send`, scripted per test. */
function fakeGoogle(
  script: {
    token?: (call: number) => Response;
    send?: (call: number) => Response;
  } = {},
) {
  const calls: Call[] = [];
  let tokens = 0;
  let sends = 0;
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    const call: Call = {
      url,
      headers: new Headers(init?.headers),
      body:
        typeof init?.body === "string" || init?.body instanceof URLSearchParams
          ? init.body.toString()
          : "",
    };
    calls.push(call);
    if (url === "https://oauth2.googleapis.com/token") {
      const response =
        script.token?.(tokens++) ??
        Response.json({
          access_token: FAKE.access,
          expires_in: 3600,
          scope: GOOD_SCOPE,
          token_type: "Bearer",
          id_token: GOOD_ID_TOKEN,
        });
      return Promise.resolve(response);
    }
    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      return Promise.resolve(script.send?.(sends++) ?? Response.json({ id: "m1" }));
    }
    return Promise.reject(new Error(`unexpected request to ${url}`));
  };
  return { fetch: impl, calls };
}

function setup(script?: Parameters<typeof fakeGoogle>[0]) {
  const lines: Record<string, unknown>[] = [];
  let time = 0;
  const now = () => new Date(time);
  const google = fakeGoogle(script);
  const sender = createGmailEmailSender({
    config,
    now,
    fetch: google.fetch,
    log: createJsonLogger({
      level: "debug",
      now,
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  });
  return {
    sender,
    lines,
    calls: google.calls,
    advance: (ms: number) => {
      time += ms;
    },
    sends: () => google.calls.filter((call) => call.url.endsWith("/messages/send")),
    tokens: () => google.calls.filter((call) => call.url.endsWith("/token")),
  };
}

/** Everything that must never appear in a log line. */
function expectNoSecrets(lines: unknown): void {
  const text = JSON.stringify(lines);
  for (const secret of [
    ...Object.values(FAKE),
    "sam@example.org",
    "12345678",
    "no-reply@example.org",
  ]) {
    expect(text).not.toContain(secret);
  }
}

describe("gmail sender", () => {
  it("refreshes a token, then sends raw MIME as base64url with the bearer token", async () => {
    const { sender, calls, sends, tokens } = setup();
    await sender.send(message);
    expect(calls.map((call) => call.url)).toEqual([
      "https://oauth2.googleapis.com/token",
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    ]);
    const form = new URLSearchParams(tokens()[0]?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "refresh_token",
      client_id: FAKE.clientId,
      client_secret: FAKE.clientSecret,
      refresh_token: FAKE.refreshToken,
    });
    const send = sends()[0];
    expect(send?.headers.get("authorization")).toBe(`Bearer ${FAKE.access}`);
    const { raw } = JSON.parse(send?.body ?? "{}") as { raw: string };
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/u);
    const mime = new TextDecoder().decode(
      Uint8Array.from(atob(raw.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
    );
    expect(mime).toContain('From: "Example Games" <no-reply@example.org>\r\n');
    expect(mime).toContain("To: sam@example.org\r\n");
    expect(mime).toContain("Subject: 12345678 is your Example Games sign-in code\r\n");
    expect(mime).toMatch(/Message-ID: <[0-9a-f-]{36}@example\.org>/u);
    expect(mime).toContain("1234 5678");
  });

  it("caches the access token until a minute before it expires, then refreshes", async () => {
    const { sender, tokens, advance } = setup();
    await sender.send(message);
    advance(3600_000 - 61_000);
    await sender.send(message);
    expect(tokens()).toHaveLength(1);
    advance(2_000);
    await sender.send(message);
    expect(tokens()).toHaveLength(2);
  });

  it("shares one refresh between concurrent sends", async () => {
    const { sender, tokens, sends } = setup();
    await Promise.all([sender.send(message), sender.send(message), sender.send(message)]);
    expect(tokens()).toHaveLength(1);
    expect(sends()).toHaveLength(3);
  });

  it("on 401 drops the token, refreshes once and retries once", async () => {
    const { sender, tokens, sends } = setup({
      send: (call) =>
        call === 0 ? new Response("{}", { status: 401 }) : Response.json({ id: "m" }),
    });
    await sender.send(message);
    expect(tokens()).toHaveLength(2);
    expect(sends()).toHaveLength(2);
  });

  it("a second 401 is a failure, not a loop", async () => {
    const { sender, sends, lines } = setup({ send: () => new Response("{}", { status: 401 }) });
    await expect(sender.send(message)).rejects.toThrow("status 401");
    expect(sends()).toHaveLength(2);
    expect(lines.at(-1)).toMatchObject({ alert: "email_send_failed", status: 401 });
  });

  it.each([400, 403, 429, 500, 503])(
    "a %i from Gmail rejects with one alert and no secrets",
    async (status) => {
      const { sender, lines, sends } = setup({
        send: () =>
          new Response(JSON.stringify({ error: { message: "sam@example.org 12345678" } }), {
            status,
          }),
      });
      await expect(sender.send(message)).rejects.toThrow(`status ${status.toString()}`);
      expect(sends()).toHaveLength(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: "error",
        alert: "email_send_failed",
        provider: "gmail",
        status,
      });
      expectNoSecrets(lines);
    },
  );

  it("a revoked refresh token alerts email_credentials_rejected and sends nothing", async () => {
    const { sender, lines, sends } = setup({
      token: () =>
        Response.json(
          { error: "invalid_grant", error_description: "Bad Request" },
          { status: 400 },
        ),
    });
    await expect(sender.send(message)).rejects.toThrow();
    expect(sends()).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      alert: "email_credentials_rejected",
      oauthError: "invalid_grant",
    });
    expectNoSecrets(lines);
  });

  it("never logs a hostile error code from the token endpoint", async () => {
    const { sender, lines } = setup({
      token: () => Response.json({ error: "x\nsam@example.org" }, { status: 500 }),
    });
    await expect(sender.send(message)).rejects.toThrow();
    expect(lines[0]).toMatchObject({ alert: "email_token_failed" });
    expect(lines[0]).not.toHaveProperty("oauthError", expect.anything());
    expectNoSecrets(lines);
  });

  it("a network failure rejects with an alert and no detail", async () => {
    const lines: Record<string, unknown>[] = [];
    const now = () => new Date(0);
    const sender = createGmailEmailSender({
      config,
      now,
      fetch: () => Promise.reject(new Error(`connect failed for ${FAKE.refreshToken}`)),
      log: createJsonLogger({
        level: "debug",
        now,
        sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
    });
    await expect(sender.send(message)).rejects.toThrow("could not be reached");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ alert: "email_send_failed", errorClass: "Error" });
    expectNoSecrets(lines);
  });

  it("a hostile header is refused before anything is sent", async () => {
    const { sender, calls, lines } = setup();
    await expect(
      sender.send({ ...message, subject: "x\r\nBcc: victim@example.org" }),
    ).rejects.toThrow(EmailHeaderError);
    expect(calls).toHaveLength(0);
    expect(lines[0]).toMatchObject({ alert: "email_send_failed" });
    expectNoSecrets(lines);
  });

  it("never follows redirects (`manual`, which workerd supports) and bounds each request", async () => {
    let init: RequestInit | undefined;
    const now = () => new Date(0);
    const sender = createGmailEmailSender({
      config,
      now,
      fetch: (_url, options) => {
        init = options;
        return Promise.resolve(Response.json({ error: "x" }, { status: 500 }));
      },
      log: createJsonLogger({ level: "error", now, sink: () => undefined }),
    });
    await expect(sender.send(message)).rejects.toThrow();
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([301, 302, 303, 307, 308])(
    "a %i from the token endpoint or from send is a failure, and nothing is followed",
    async (status) => {
      const redirect = () =>
        new Response(null, { status, headers: { location: "https://evil.example/collect" } });
      for (const script of [{ token: redirect }, { send: redirect }]) {
        const { sender, calls, lines, sends } = setup(script);
        await expect(sender.send(message)).rejects.toThrow();
        expect(calls.every((call) => !call.url.includes("evil"))).toBe(true);
        expect(sends().length).toBeLessThanOrEqual(1);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ alert: "email_send_failed" });
        expectNoSecrets(lines);
      }
    },
  );

  it("treats an opaque redirect (what a runtime may report for `manual`) as a failure", async () => {
    const opaque = Object.defineProperty(new Response(null, { status: 200 }), "type", {
      value: "opaqueredirect",
    });
    const { sender } = setup({ token: () => opaque });
    await expect(sender.send(message)).rejects.toThrow();
  });

  it("every failure it rejects with is marked as already alerted (09 §2)", async () => {
    const failures = [
      setup({ send: () => new Response("{}", { status: 500 }) }),
      setup({ token: () => Response.json({ error: "invalid_grant" }, { status: 400 }) }),
      setup(withScopeFor("https://mail.google.com/")),
    ];
    for (const { sender, lines } of failures) {
      const error = await sender.send(message).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(wasAlerted(error)).toBe(true);
      expect(lines).toHaveLength(1);
    }
    const header = setup();
    const error = await header.sender
      .send({ ...message, subject: "x\r\ny" })
      .catch((caught: unknown) => caught);
    expect(wasAlerted(error)).toBe(true);
  });

  it("releases the body of a response it won't read", async () => {
    let cancelled = 0;
    const body = () =>
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      });
    const { sender } = setup({
      send: (call) => new Response(body(), { status: call === 0 ? 401 : 500 }),
    });
    await expect(sender.send(message)).rejects.toThrow();
    expect(cancelled).toBe(2);
  });
});

function withScopeFor(scope: string) {
  return {
    token: () =>
      Response.json({
        access_token: FAKE.access,
        expires_in: 3600,
        scope,
        id_token: GOOD_ID_TOKEN,
      }),
  };
}

describe("token scope and account (09 §2, 08 T15)", () => {
  const withScope = (scope: string, extra: Record<string, unknown> = {}) => ({
    token: () =>
      Response.json({
        access_token: FAKE.access,
        expires_in: 3600,
        scope,
        id_token: GOOD_ID_TOKEN,
        ...extra,
      }),
  });

  it.each([
    "https://www.googleapis.com/auth/gmail.readonly",
    `${GMAIL_SEND_SCOPE} https://mail.google.com/`,
    `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.modify`,
    "openid email",
    GMAIL_SEND_SCOPE,
    `email ${GMAIL_SEND_SCOPE}`,
    `${GOOD_SCOPE} https://www.googleapis.com/auth/userinfo.profile`,
    "",
  ])("refuses to send with scope %j", async (scope) => {
    const { sender, sends, lines } = setup(withScope(scope));
    await expect(sender.send(message)).rejects.toThrow(GmailTokenRefused);
    expect(sends()).toHaveLength(0);
    expect(lines[0]).toMatchObject({ alert: "email_token_scope" });
    expectNoSecrets(lines);
  });

  it.each([`openid email ${GMAIL_SEND_SCOPE}`, GOOD_SCOPE])("accepts scope %j", async (scope) => {
    const { sender, sends } = setup(withScope(scope));
    await sender.send(message);
    expect(sends()).toHaveLength(1);
  });

  const ok = { email: "no-reply@example.org", email_verified: true, aud: FAKE.clientId };
  it.each([
    ["another account", jwt({ ...ok, email: "admin@example.org" })],
    ["no id_token", undefined],
    ["an unparseable id_token", "not-a-jwt"],
    ["an id_token with no email", jwt({ email_verified: true, aud: FAKE.clientId })],
    ["another client", jwt({ ...ok, aud: "someone-else" })],
    ["no audience", jwt({ email: ok.email, email_verified: true })],
    ["an unverified email", jwt({ ...ok, email_verified: false })],
    ["no email_verified", jwt({ email: ok.email, aud: FAKE.clientId })],
  ])("refuses a token with %s, and sends nothing", async (_name, id_token) => {
    const { sender, sends, lines } = setup(withScope(GOOD_SCOPE, { id_token }));
    await expect(sender.send(message)).rejects.toThrow(GmailTokenRefused);
    expect(sends()).toHaveLength(0);
    expect(lines[0]).toMatchObject({ alert: "email_token_account" });
    expectNoSecrets(lines);
  });

  it("accepts Google's string email_verified", async () => {
    const { sender, sends } = setup(
      withScope(GOOD_SCOPE, { id_token: jwt({ ...ok, email_verified: "true" }) }),
    );
    await sender.send(message);
    expect(sends()).toHaveLength(1);
  });

  it("logs only the scope names it knows, and a count of the others (A5-S-8)", async () => {
    const hostile = "https://evil.example/x\nsam@example.org";
    const { sender, lines } = setup(withScope(`${GOOD_SCOPE} ${hostile}`));
    await expect(sender.send(message)).rejects.toThrow(GmailTokenRefused);
    expect(lines[0]).toMatchObject({ alert: "email_token_scope", otherScopes: 2 });
    expect(JSON.stringify(lines)).not.toContain("evil");
    expectNoSecrets(lines);
  });

  it("verifyCredentials refuses a wrong scope or account at startup", async () => {
    await expect(
      setup(withScope("https://mail.google.com/")).sender.verifyCredentials(),
    ).rejects.toThrow(GmailTokenRefused);
    await expect(
      setup(
        withScope(GOOD_SCOPE, { id_token: jwt({ ...ok, email: "other@example.org" }) }),
      ).sender.verifyCredentials(),
    ).rejects.toThrow(GmailTokenRefused);
  });

  it("verifyCredentials passes a good token, and only logs when Google is down or rejects it", async () => {
    await expect(setup().sender.verifyCredentials()).resolves.toBeUndefined();
    const down = setup({ token: () => new Response("", { status: 503 }) });
    await expect(down.sender.verifyCredentials()).resolves.toBeUndefined();
    expect(down.lines).toHaveLength(1);
    expect(down.lines[0]).toMatchObject({ level: "error", alert: "email_token_failed" });
    const revoked = setup({
      token: () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    await expect(revoked.sender.verifyCredentials()).resolves.toBeUndefined();
    expect(revoked.lines[0]).toMatchObject({ alert: "email_credentials_rejected" });
  });

  it("helpers: scope sets and id_token claims", () => {
    expect(isExpectedScopes(grantedScopes(GOOD_SCOPE))).toBe(true);
    expect(isExpectedScopes(grantedScopes(`openid email ${GMAIL_SEND_SCOPE}`))).toBe(true);
    expect(isExpectedScopes(grantedScopes("openid email"))).toBe(false);
    expect(isExpectedScopes(grantedScopes(GMAIL_SEND_SCOPE))).toBe(false);
    expect(isExpectedScopes(grantedScopes(undefined))).toBe(false);
    expect(idTokenClaims(jwt({ email: "a@b.c" }))).toEqual({ email: "a@b.c" });
    for (const bad of ["", "a", "a.!!!.c", "a.e30.c".replace("e30", btoa("[1]"))]) {
      expect(idTokenClaims(bad)).toBeNull();
    }
  });
});

describe("provider selection", () => {
  const env = {
    PUBLIC_URL: "https://play.example.org",
    APP_SECRET: btoa("0123456789abcdef0123456789abcdef"),
    OPERATOR_CONTACT: "ops@example.org",
    EMAIL_PROVIDER: "gmail",
    EMAIL_FROM: '"Games" <no-reply@example.org>',
    GMAIL_CLIENT_ID: FAKE.clientId,
    GMAIL_CLIENT_SECRET: FAKE.clientSecret,
    GMAIL_REFRESH_TOKEN: FAKE.refreshToken,
    GMAIL_SENDER: "no-reply@example.org",
  };

  it("coreEmailSender builds the gmail sender over the given fetch, not the unavailable stand-in", async () => {
    const parsed = parseConfig(env, { runtime: "node", installedGames: [] });
    const lines: unknown[] = [];
    const now = () => new Date(0);
    const google = fakeGoogle();
    const sender = coreEmailSender(
      parsed,
      createJsonLogger({ level: "debug", now, sink: (line) => lines.push(line) }),
      now,
      undefined,
      google.fetch,
    );
    expect(sender.verifyCredentials).toBeTypeOf("function");
    await sender.send(message);
    expect(google.calls).toHaveLength(2);
    expect(lines).toEqual([]);
  });

  it("the config refuses a GMAIL_SENDER that isn't EMAIL_FROM's address", () => {
    expect(() =>
      parseConfig(
        { ...env, GMAIL_SENDER: "admin@example.org" },
        { runtime: "node", installedGames: [] },
      ),
    ).toThrow(/GMAIL_SENDER/u);
  });
});
