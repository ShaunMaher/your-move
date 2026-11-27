/**
 * The fixed email templates (docs/spec/06-auth.md §3.3, §4, §7; 03 §7 for the nudge): plain text
 * plus minimal HTML, no remote images or tracking (09 §2), `APP_NAME` from config. Every
 * interpolated value is HTML-escaped in the HTML part. None carries a code in a link.
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
function groupCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/** A UTC timestamp to the minute: the "approximate request time" of 06 §3.3. */
export function approximateTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** A paragraph of plain text, or text followed by one of our own links. */
type Paragraph = string | { readonly text: string; readonly href: string };

function message(
  to: NormalisedEmail,
  subject: string,
  paragraphs: readonly Paragraph[],
): EmailMessage {
  const plain = (paragraph: Paragraph): string =>
    typeof paragraph === "string" ? paragraph : `${paragraph.text} ${paragraph.href}`;
  const html = (paragraph: Paragraph): string =>
    typeof paragraph === "string"
      ? escapeHtml(paragraph)
      : `${escapeHtml(paragraph.text)} <a href="${escapeHtml(paragraph.href)}">${escapeHtml(paragraph.href)}</a>`;
  return {
    to,
    subject,
    text: `${paragraphs.map(plain).join("\n\n")}\n`,
    html: `<!doctype html><html><body>${paragraphs
      .map((paragraph) => `<p>${html(paragraph)}</p>`)
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

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export interface NudgeContext {
  readonly appName: string;
  /** The game type's display name, from its manifest. */
  readonly gameName: string;
  /** The display names of the other seated players. */
  readonly opponents: readonly string[];
  /** The game's last public `describe` text with the names filled in, if it has one. */
  readonly lastMove: string | null;
  readonly gameUrl: string;
  readonly settingsUrl: string;
  readonly unsubscribeUrl: string;
}

/**
 * The "It's your turn" email nudge (03 §7, 08 T18): built only from the game type's name, display
 * names and public `describe` text, never from state, options or addresses; with the unsubscribe
 * link and headers (05 §Email links).
 */
export function nudgeEmail(to: NormalisedEmail, context: NudgeContext): EmailMessage {
  const withWhom = context.opponents.length === 0 ? "" : ` with ${namesList(context.opponents)}`;
  const paragraphs: Paragraph[] = [
    `It's your turn in your ${context.gameName} game${withWhom}. It has been waiting for you for over a day.`,
    ...(context.lastMove === null ? [] : [`Last move: ${context.lastMove}`]),
    { text: "Play now:", href: context.gameUrl },
    `You're getting this because you turned on email nudges in ${context.appName}: at most one a day for each game that's waiting for you.`,
    { text: "Turn them off in Settings:", href: context.settingsUrl },
    { text: "Or unsubscribe with one click:", href: context.unsubscribeUrl },
  ];
  return {
    ...message(to, `It's your turn in ${context.gameName} on ${context.appName}`, paragraphs),
    listUnsubscribe: context.unsubscribeUrl,
  };
}

export interface InvitationContext {
  readonly appName: string;
  readonly publicUrl: string;
  /** The inviter's display name ("New player" if unset). */
  readonly inviterName: string;
  /** The inviter's own address: the invitee sees it (Q10, 08 §5). */
  readonly inviterEmail: string;
  /** The game type's display name, from its manifest. */
  readonly gameName: string;
  readonly turnTimeoutDays: number;
  /** How many days the invitation stays open: the lobby's lifetime (02 §4). */
  readonly openDays: number;
  readonly unsubscribeUrl: string;
}

const days = (n: number): string => `${String(n)} ${n === 1 ? "day" : "days"}`;

/**
 * The invite email to an email-invite seat (06 §6.3, alpha A17): a fixed template whose only
 * user-chosen text is the inviter's display name, which display-name rules restrict (06 §5.1).
 * It says who invited the person to which game type and how to join, and nothing else about the
 * game: never its options, state or other players. With the `invites` unsubscribe link and
 * headers (05 §Email links).
 */
export function invitationEmail(to: NormalisedEmail, context: InvitationContext): EmailMessage {
  const { appName, inviterName, gameName } = context;
  const paragraphs: Paragraph[] = [
    `${inviterName} (${context.inviterEmail}) has invited you to play ${gameName} on ${appName}.`,
    `Each player has ${days(context.turnTimeoutDays)} for each move. The invitation stays open for ${days(context.openDays)}.`,
    { text: "To join, sign in with this email address at", href: context.publicUrl },
    `There's no password: ${appName} emails you a sign-in code. Then choose the name other players will see, and the invitation will be waiting in your list of games.`,
    `On a phone you can add ${appName} to your home screen. On an iPhone, open the link in Safari, tap Share, then "Add to Home Screen". On Android, open it in Chrome and choose "Install app" or "Add to Home screen".`,
    `If you don't know ${inviterName} or don't want to play, you can ignore this email.`,
    { text: "Don't send me invites again:", href: context.unsubscribeUrl },
  ];
  return {
    ...message(to, `${inviterName} invited you to play ${gameName} on ${appName}`, paragraphs),
    listUnsubscribe: context.unsubscribeUrl,
  };
}
