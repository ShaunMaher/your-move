/**
 * Picks the email sender for a configuration (09 §2). The core builds the providers that need only
 * Web-standard APIs; a runtime passes its own for the rest (`smtp` on Node).
 */
import type { AppConfig } from "../config/parse.js";
import type { Logger } from "../log.js";
import {
  type CapturedEmail,
  createConsoleEmailSender,
  createUnavailableEmailSender,
  type EmailSender,
} from "./sender.js";

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
): EmailSender & { captured?: () => readonly CapturedEmail[] } {
  if (config.email.provider === "console") return createConsoleEmailSender(log, now);
  if (runtimeSender !== undefined) return runtimeSender;
  log.warn("email provider not available in this build: no email will be sent", {
    alert: "email_provider_unavailable",
    provider: config.email.provider,
  });
  return createUnavailableEmailSender(config.email.provider, log);
}
