/**
 * Picks the email sender for a configuration (09 §2). The core builds the providers that need only
 * Web-standard APIs; a runtime passes its own for the rest (`smtp` on Node).
 */
import type { AppConfig } from "../config/parse.js";
import type { Logger } from "../log.js";
import { createGmailEmailSender } from "./gmail.js";
import {
  type CapturedEmail,
  createConsoleEmailSender,
  createUnavailableEmailSender,
  type EmailSender,
} from "./sender.js";

/** What a runtime keeps as `Platform.email`: the sender plus what a provider may add. */
export type CoreEmailSender = EmailSender & {
  /** The `console` provider's captures. */
  captured?: () => readonly CapturedEmail[];
  /** The `gmail` provider's startup check of its token (09 §2). */
  verifyCredentials?: () => Promise<void>;
};

/**
 * The sender for `config.email.provider`: the `console` capture in local-dev mode (the config
 * parser already refuses it elsewhere), `runtimeSender` when the runtime provides this provider,
 * and otherwise a sender that alerts on every message because the provider isn't built yet.
 */
export function coreEmailSender(
  config: AppConfig,
  log: Logger,
  now: () => Date,
  runtimeSender?: EmailSender,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): CoreEmailSender {
  if (config.email.provider === "console") return createConsoleEmailSender(log, now);
  if (config.email.provider === "gmail") {
    return createGmailEmailSender({ config: config.email, log, now, fetch: fetchImpl });
  }
  if (runtimeSender !== undefined) return runtimeSender;
  log.error("email provider not available in this build: no email will be sent", {
    alert: "email_provider_unavailable",
    provider: config.email.provider,
  });
  return createUnavailableEmailSender(config.email.provider, log);
}
