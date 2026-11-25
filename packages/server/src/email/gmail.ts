/**
 * The `gmail` email provider (docs/spec/09-operations.md §2, 08 T15), on both runtimes: Web
 * `fetch` and Web Crypto only.
 *
 * An access token comes from the refresh token (cached until shortly before it expires); each
 * message is raw MIME from the shared builder, sent with `users.messages.send` as the one user
 * who granted the token. The token check fails closed: on every refresh the scope must be exactly
 * what the authorize helper requests, and the `id_token` must be present, for this client, and
 * carry GMAIL_SENDER's verified address; anything else is refused, so a wrongly authorised token
 * can't send.
 *
 * Failures reject and log one error-level alert with fixed fields: never a secret, an address, a
 * message or Google's response text.
 */
import { fromBase64Url, toBase64Url } from "../base64.js";
import { parseMailbox } from "../config/email.js";
import type { EmailConfig } from "../config/parse.js";
import type { Logger } from "../log.js";
import { buildMime } from "./mime.js";
import { EmailHeaderError, type EmailMessage, type EmailSender, markAlerted } from "./sender.js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
/**
 * The scopes the authorize helper requests and a token must carry, exactly (Google reports `email`
 * as its `userinfo.email` URL).
 */
export const REQUIRED_SCOPES: readonly string[] = [
  "openid",
  USERINFO_EMAIL_SCOPE,
  GMAIL_SEND_SCOPE,
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
/** A cached access token is dropped this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

type GmailConfig = Extract<EmailConfig, { provider: "gmail" }>;

/** The token is for the wrong scope or the wrong account: nothing may be sent with it. */
export class GmailTokenRefused extends Error {
  override readonly name = "GmailTokenRefused";
}

/** A failure that has already been logged as an alert. */
class LoggedFailure extends Error {
  override readonly name = "LoggedFailure";
}

/** A redirect answer: never followed (a token or a message must go only where the URL says). */
class RedirectRefused extends Error {
  override readonly name = "RedirectRefused";
}

/** What the sender returns beyond `send`: a check the Node startup runs (09 §2 step 3). */
export interface GmailEmailSender extends EmailSender {
  /**
   * Refreshes the token now and checks its scope and account. Throws {@link GmailTokenRefused} if
   * they are wrong; any other failure is logged as an alert and resolves, so a Google outage
   * doesn't stop the server from starting.
   */
  verifyCredentials(): Promise<void>;
}

export interface GmailOptions {
  readonly config: GmailConfig;
  readonly log: Logger;
  readonly now: () => Date;
  readonly fetch: typeof fetch;
}

/** The claims of an unverified `id_token`: fine when it arrives straight from Google over TLS. */
export function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const payload = idToken.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    return typeof claims === "object" && claims !== null && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The scopes in a token response, with Google's alias for `email` normalised. */
export function grantedScopes(scope: unknown): Set<string> {
  const scopes =
    typeof scope === "string" ? scope.split(/\s+/u).filter((value) => value !== "") : [];
  return new Set(scopes.map((value) => (value === "email" ? USERINFO_EMAIL_SCOPE : value)));
}

/** Whether `scopes` is exactly {@link REQUIRED_SCOPES}: no more, no fewer. */
export function isExpectedScopes(scopes: ReadonlySet<string>): boolean {
  return scopes.size === REQUIRED_SCOPES.length && REQUIRED_SCOPES.every((s) => scopes.has(s));
}

/** The names in `scopes` that are ours to log, and how many others there were (never Google's text). */
function describeScopes(scopes: ReadonlySet<string>): { scope: string; otherScopes: number } {
  const known = REQUIRED_SCOPES.filter((name) => scopes.has(name));
  return { scope: known.join(" "), otherScopes: scopes.size - known.length };
}

/** Whether `idToken` is for this client and carries the sender's verified address. */
function idTokenIsSenders(idToken: unknown, clientId: string, sender: string): boolean {
  const claims = typeof idToken === "string" ? idTokenClaims(idToken) : null;
  const email = claims?.["email"];
  return (
    claims !== null &&
    claims["aud"] === clientId &&
    (claims["email_verified"] === true || claims["email_verified"] === "true") &&
    typeof email === "string" &&
    email.toLowerCase() === sender
  );
}

/** An OAuth error code such as `invalid_grant`, if the body has one in the fixed vocabulary. */
function oauthError(body: unknown): string | undefined {
  const value = (body as { error?: unknown } | null)?.error;
  return typeof value === "string" && /^[a-z_]{1,40}$/u.test(value) ? value : undefined;
}

export function createGmailEmailSender(options: GmailOptions): GmailEmailSender {
  const { config, log } = options;
  const from = parseMailbox(config.from);
  if (from === null) throw new Error("EMAIL_FROM is not a valid mailbox");
  let cached: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  /** Posts without following redirects (`error` is unsupported on Workers); a redirect is a failure. */
  async function post(url: string, init: RequestInit): Promise<Response> {
    const response = await options.fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await discard(response);
      throw new RedirectRefused("gmail answered with a redirect");
    }
    return response;
  }

  async function refresh(): Promise<string> {
    const response = await post(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = oauthError(body);
      log.error("gmail token refresh failed: no email can be sent", {
        alert: code === "invalid_grant" ? "email_credentials_rejected" : "email_token_failed",
        provider: "gmail",
        status: response.status,
        oauthError: code,
      });
      throw new LoggedFailure("gmail token refresh failed");
    }
    const fields = body as {
      access_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
      id_token?: unknown;
    } | null;
    const scopes = grantedScopes(fields?.scope);
    if (!isExpectedScopes(scopes)) {
      log.error("the gmail token's scopes are not exactly openid, email and gmail.send: refusing", {
        alert: "email_token_scope",
        provider: "gmail",
        ...describeScopes(scopes),
      });
      throw new GmailTokenRefused(
        "the Gmail refresh token must grant exactly openid, email and gmail.send",
      );
    }
    if (!idTokenIsSenders(fields?.id_token, config.clientId, config.sender)) {
      log.error("the gmail token is not GMAIL_SENDER's verified account for this client", {
        alert: "email_token_account",
        provider: "gmail",
      });
      throw new GmailTokenRefused(
        "the Gmail refresh token does not belong to GMAIL_SENDER (id_token missing, unverified, or for another account or client)",
      );
    }
    if (typeof fields?.access_token !== "string" || typeof fields.expires_in !== "number") {
      log.error("gmail token response is malformed", {
        alert: "email_token_failed",
        provider: "gmail",
      });
      throw new LoggedFailure("gmail token response is malformed");
    }
    cached = {
      token: fields.access_token,
      expiresAt: options.now().getTime() + fields.expires_in * 1000 - EXPIRY_MARGIN_MS,
    };
    return cached.token;
  }

  function accessToken(): Promise<string> {
    if (cached !== null && options.now().getTime() < cached.expiresAt) {
      return Promise.resolve(cached.token);
    }
    // One refresh at a time: concurrent sends share it.
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function sendRaw(raw: string, token: string): Promise<Response> {
    return post(SEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: toBase64Url(new TextEncoder().encode(raw)) }),
    });
  }

  return {
    async send(message: EmailMessage): Promise<void> {
      try {
        const raw = buildMime({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          date: options.now(),
          messageId: `${crypto.randomUUID()}@${from.address.slice(from.address.lastIndexOf("@") + 1)}`,
        });
        let response = await sendRaw(raw, await accessToken());
        if (response.status === 401) {
          // The cached token was revoked or expired early: one fresh one, then give up.
          cached = null;
          await discard(response);
          response = await sendRaw(raw, await accessToken());
        }
        if (!response.ok) {
          await discard(response);
          log.error("gmail rejected the message: it was not sent", {
            alert: "email_send_failed",
            provider: "gmail",
            status: response.status,
          });
          throw new LoggedFailure(`gmail send failed with status ${response.status.toString()}`);
        }
        await discard(response);
      } catch (error) {
        // Whatever fails, one alert has been logged by the end of this block (token failures and
        // rejections logged their own); the error is marked so the caller logs nothing more (09 §2).
        if (error instanceof GmailTokenRefused || error instanceof LoggedFailure) {
          throw markAlerted(error);
        }
        if (error instanceof EmailHeaderError) {
          log.error("the message has an unsafe header: it was not sent", {
            alert: "email_send_failed",
            provider: "gmail",
          });
          throw markAlerted(error);
        }
        log.error("gmail could not be reached: the message was not sent", {
          alert: "email_send_failed",
          provider: "gmail",
        });
        throw markAlerted(new Error("gmail could not be reached"));
      }
    },
    async verifyCredentials(): Promise<void> {
      cached = null;
      try {
        await accessToken();
      } catch (error) {
        if (error instanceof GmailTokenRefused) throw error;
        // A failed response was logged by `refresh`; a network failure is logged here.
        if (!(error instanceof LoggedFailure)) {
          log.error("gmail could not be reached at startup", {
            alert: "email_token_failed",
            provider: "gmail",
          });
        }
      }
    },
  };
}

/** Releases a response body nobody will read (the connection can then be reused or closed). */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}
