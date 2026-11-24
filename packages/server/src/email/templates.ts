/**
 * The fixed sign-in and account email templates (docs/spec/06-auth.md §3.3, §4, §7): plain text
 * plus minimal HTML, no remote images or tracking (09 §2), `APP_NAME` from config. Every
 * interpolated value is HTML-escaped in the HTML part. None carries the code in a link.
 */
import type { NormalisedEmail } from "../accounts/email.js";
import type { EmailMessage } from "./sender.js";

export interface TemplateContext {
  readonly appName: string;
  readonly publicUrl: string;
  /** When the request was made, e.g. `2026-01-01 09:30 UTC`. */
  readonly requestedAt: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** `12345678` → `1234 5678` (06 §3). */
export function groupCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/** A UTC timestamp to the minute: the "approximate request time" of 06 §3.3. */
export function approximateTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function message(
  to: NormalisedEmail,
  subject: string,
  paragraphs: readonly string[],
): EmailMessage {
  return {
    to,
    subject,
    text: `${paragraphs.join("\n\n")}\n`,
    html: `<!doctype html><html><body>${paragraphs
      .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
      .join("")}</body></html>`,
  };
}

const NEVER_ASK = "We will never ask you for this code — don't share it with anyone.";

/** The sign-in code email (06 §3.3). */
export function signInCodeEmail(
  to: NormalisedEmail,
  code: string,
  context: TemplateContext,
): EmailMessage {
  return message(to, `${code} is your ${context.appName} sign-in code`, [
    `Your ${context.appName} sign-in code is: ${groupCode(code)}`,
    "It expires in 10 minutes.",
    NEVER_ASK,
    "If you didn't request this, ignore this email.",
    `Requested at about ${context.requestedAt}.`,
    context.publicUrl,
  ]);
}

/**
 * What a suspended account's holder gets instead of a code (06 §4): a fixed notice, so only the
 * address holder learns of the suspension.
 */
export function suspendedNoticeEmail(to: NormalisedEmail, context: TemplateContext): EmailMessage {
  return message(to, `Your ${context.appName} account is suspended`, [
    `Someone asked to sign in to ${context.appName} with this address, but the account is suspended, so no sign-in code was sent.`,
    "If you didn't request this, ignore this email.",
    `Requested at about ${context.requestedAt}.`,
  ]);
}

/** The step-up code for account deletion (06 §7): names the action, distinct from sign-in. */
export function deleteAccountCodeEmail(
  to: NormalisedEmail,
  code: string,
  context: TemplateContext,
): EmailMessage {
  return message(to, `Your code to delete your ${context.appName} account`, [
    `Your code to delete your ${context.appName} account is: ${groupCode(code)}`,
    "Entering it deletes your account and everything in it, immediately and permanently.",
    "It expires in 10 minutes.",
    NEVER_ASK,
    "If you didn't ask to delete your account, don't use this code: someone may be using your account. Sign out everywhere from Settings.",
    `Requested at about ${context.requestedAt}.`,
  ]);
}

/** Sent after an account deletion (06 §7). */
export function accountDeletedEmail(to: NormalisedEmail, context: TemplateContext): EmailMessage {
  return message(to, `Your ${context.appName} account has been deleted`, [
    `Your ${context.appName} account was deleted at about ${context.requestedAt}.`,
    "You can sign up again with this address at any time.",
  ]);
}
