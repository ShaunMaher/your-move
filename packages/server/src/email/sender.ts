/**
 * Email delivery (docs/spec/09-operations.md §2): the `EmailSender` port each runtime provides,
 * the message type every template produces, and the providers that need nothing but Web-standard
 * APIs. SMTP (Node only) lives in `apps/node`; `gmail` and the HTTP-API providers arrive later
 * (10 M4).
 */
import type { NormalisedEmail } from "../accounts/email.js";
import type { Logger } from "../log.js";

/** One email: plain text plus minimal HTML, from a fixed template (09 §2). */
export interface EmailMessage {
  readonly to: NormalisedEmail;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface EmailSender {
  /** Sends one message. Rejects on failure; callers run it in the background (06 §3.2). */
  send(message: EmailMessage): Promise<void>;
}

/** Thrown for a message that would break out of its header (08 T14). */
export class EmailHeaderError extends Error {
  override readonly name = "EmailHeaderError";
}

/**
 * Refuses a message whose header values contain a line break or other control character, so no
 * template mistake or unexpected input can inject headers (08 T14). Every provider calls it.
 */
export function assertSafeHeaders(message: EmailMessage): void {
  for (const value of [message.to, message.subject]) {
    if (/\p{Cc}/u.test(value))
      throw new EmailHeaderError("header value contains a control character");
  }
}

/** A message the `console` provider captured, for `/__dev/emails` (09 §2). */
export interface CapturedEmail extends EmailMessage {
  readonly sentAt: string;
}

export interface ConsoleEmailSender extends EmailSender {
  /** Captured messages, newest last (at most {@link CAPTURE_LIMIT}). */
  captured(): readonly CapturedEmail[];
}

const CAPTURE_LIMIT = 200;

/**
 * The `console` provider: local-dev only (09 §1, `isLocalDev`). Keeps messages in memory for the
 * `/__dev/emails` page and logs that one was captured — never its contents, which hold codes.
 */
export function createConsoleEmailSender(log: Logger, now: () => Date): ConsoleEmailSender {
  const messages: CapturedEmail[] = [];
  return {
    async send(message) {
      assertSafeHeaders(message);
      messages.push({ ...message, sentAt: now().toISOString() });
      if (messages.length > CAPTURE_LIMIT) messages.shift();
      log.info("email captured (console provider)", { capturedEmails: messages.length });
      await Promise.resolve();
    },
    captured() {
      return [...messages];
    },
  };
}

/**
 * Stands in for a provider whose implementation hasn't landed yet (`gmail` in M4; `resend`,
 * `postmark`, `ses`, `cloudflare` later): every send is dropped with an alert in the log, so the
 * operator sees at once that no mail goes out, while the API keeps its normal responses.
 */
export function createUnavailableEmailSender(provider: string, log: Logger): EmailSender {
  return {
    send() {
      log.error("email not sent: provider not available in this build", {
        alert: "email_provider_unavailable",
        provider,
      });
      // Resolves: the alert above is the one log entry, not a second "background task failed".
      return Promise.resolve();
    },
  };
}
