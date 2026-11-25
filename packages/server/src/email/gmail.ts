/**
 * The `gmail` email provider (docs/spec/09-operations.md §2, 08 T15), on both runtimes: Web
 * `fetch` and Web Crypto only.
 *
 * An access token comes from the refresh token (cached until shortly before it expires); each
 * message is raw MIME from the shared builder, sent with `users.messages.send` as the one user
 * who granted the token. The token's scope must be `gmail.send` (plus `openid`/`email`): on every
 * refresh anything else, or a token that belongs to another account, is refused, so a wrongly
 * authorised token can't send.
 *
 * Failures reject and log one error-level alert with fixed fields: never a secret, an address, a
 * message or Google's response text.
 */
import { parseMailbox } from "../config/email.js";
import type { EmailConfig } from "../config/parse.js";
import type { Logger } from "../log.js";
import { buildMime } from "./mime.js";
import { EmailHeaderError, type EmailMessage, type EmailSender } from "./sender.js";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
/** Scopes a token may carry besides `gmail.send` (what the authorize helper requests). */
const HARMLESS_SCOPES = ["openid", "email", USERINFO_EMAIL_SCOPE];

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
    const base64 = payload.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
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

/** Whether `scopes` is `gmail.send` plus at most the harmless identity scopes. */
export function isSendOnly(scopes: ReadonlySet<string>): boolean {
  const allowed = new Set([
    GMAIL_SEND_SCOPE,
    ...HARMLESS_SCOPES.map((value) => (value === "email" ? USERINFO_EMAIL_SCOPE : value)),
  ]);
  return scopes.has(GMAIL_SEND_SCOPE) && [...scopes].every((value) => allowed.has(value));
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

  const post = (url: string, init: RequestInit): Promise<Response> =>
    options.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

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
    if (!isSendOnly(scopes)) {
      log.error("the gmail token's scope is not gmail.send only: refusing to send with it", {
        alert: "email_token_scope",
        provider: "gmail",
        scope: [...scopes].join(" "),
      });
      throw new GmailTokenRefused("the Gmail refresh token must grant gmail.send and nothing else");
    }
    if (typeof fields?.id_token === "string") {
      const claims = idTokenClaims(fields.id_token);
      const email = typeof claims?.["email"] === "string" ? claims["email"].toLowerCase() : null;
      if (email !== null && email !== config.sender) {
        log.error("the gmail token belongs to another account than GMAIL_SENDER", {
          alert: "email_token_account",
          provider: "gmail",
        });
        throw new GmailTokenRefused(
          "the Gmail refresh token belongs to an account other than GMAIL_SENDER",
        );
      }
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
      body: JSON.stringify({ raw: toBase64Url(raw) }),
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
          response = await sendRaw(raw, await accessToken());
        }
        if (!response.ok) {
          log.error("gmail rejected the message: it was not sent", {
            alert: "email_send_failed",
            provider: "gmail",
            status: response.status,
          });
          throw new LoggedFailure(`gmail send failed with status ${response.status.toString()}`);
        }
      } catch (error) {
        // Token failures and rejections logged their own alert; the rest are logged here.
        if (error instanceof GmailTokenRefused || error instanceof LoggedFailure) throw error;
        if (error instanceof EmailHeaderError) {
          log.error("the message has an unsafe header: it was not sent", {
            alert: "email_send_failed",
            provider: "gmail",
          });
          throw error;
        }
        log.error("gmail could not be reached: the message was not sent", {
          alert: "email_send_failed",
          provider: "gmail",
        });
        throw new Error("gmail could not be reached");
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

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
