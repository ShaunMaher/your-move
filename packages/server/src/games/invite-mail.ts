/**
 * Invite emails (docs/spec/06-auth.md §6.3, §6.6, alpha A17): which typed addresses get one, the
 * caps they count toward, and the messages. An email-invite seat (no account, or one that hasn't
 * finished onboarding) whose address isn't suppressed would be mailed; it counts toward every
 * invite-email cap and is sent only if none is exceeded.
 *
 * The work is the same for every typed address, whatever it resolves to (Q3, 06 §3.2 approach):
 * the suppression lookup covers them all, every address writes the same counters (one that won't
 * be mailed adds 1 to the never-read `silent` key instead), every message is built, and the caller
 * schedules one background task whatever it carries. Nothing here says which addresses were mailed.
 */
import type { NormalisedEmail } from "../accounts/email.js";
import { alertOnCrossing, checkLimits, type LimitCheck, type LimitName } from "../auth/limits.js";
import type { Subkeys } from "../crypto/subkeys.js";
import type { UserRecord } from "../db/repositories.js";
import { type EmailMessage, wasAlerted } from "../email/sender.js";
import { invitationEmail } from "../email/templates.js";
import { unsubscribeToken, unsubscribeUrl } from "../email/unsubscribe-token.js";
import type { Platform } from "../platform.js";
import { LOBBY_LIFETIME_MS } from "./lifecycle.js";
import { NEW_PLAYER_NAME } from "./names.js";

const DAY = 86_400_000;
/** An inviter younger than this who hasn't completed a game gets the lower daily rate (06 §6.6). */
const NEW_ACCOUNT_MS = 7 * DAY;
/** The `rate_limits` key that counts what isn't mailed: written, never read (06 §3.2). */
const SILENT = "silent";

/** The caps one would-be invite email counts toward, in this order (06 §6.6, 08 §4). */
const CAPS = [
  "INVITE_EMAILS_INVITER_DAY",
  "INVITE_EMAILS_INVITER_30D",
  "INVITE_EMAILS_NEW_INVITER_DAY",
  "INVITE_EMAILS_TARGET_30D",
  "INVITE_EMAILS_GLOBAL_DAY",
] as const satisfies readonly LimitName[];

export interface InviteMailInput {
  readonly creator: UserRecord;
  /** The game type's display name, from its manifest. */
  readonly gameName: string;
  readonly turnTimeoutDays: number;
  /** The typed addresses, normalised, and their `emailId`s, in the same order. */
  readonly emails: readonly NormalisedEmail[];
  readonly emailIds: readonly string[];
  /**
   * Each address's onboarded human, or null: an email-invite seat (no account, or one that
   * hasn't finished onboarding), the only kind an invite email goes to.
   */
  readonly invitable: readonly (UserRecord | null)[];
}

export interface InviteMail {
  /** Each address's `invites.sent_at`: `now` when its email is to be sent, else null. */
  readonly sentAt: readonly (number | null)[];
  /** The messages to send after the response; possibly none. */
  readonly messages: readonly EmailMessage[];
}

/**
 * Decides and counts the invite emails of one create request and builds every message. Call it
 * only once every refusal has passed: the counters it writes are the sends' own.
 */
export async function planInviteMail(
  deps: { readonly platform: Platform; readonly keys: Subkeys },
  input: InviteMailInput,
  now: number,
): Promise<InviteMail> {
  const { platform, keys } = deps;
  const { repos, config, log } = platform;
  const { creator, emails, emailIds } = input;
  if (emails.length === 0) return { sentAt: [], messages: [] };

  const [suppressed, finished] = await Promise.all([
    repos.emailSuppressions.suppressedAmong(emailIds),
    repos.users.hasFinishedGame(creator.id),
  ]);
  const unmailable = new Set(suppressed);
  const young = creator.createdAt > now - NEW_ACCOUNT_MS && !finished;
  const wouldSend = emailIds.map((hash, i) => input.invitable[i] === null && !unmailable.has(hash));

  const keyFor = (name: (typeof CAPS)[number], i: number): string => {
    if (wouldSend[i] !== true) return SILENT;
    if (name === "INVITE_EMAILS_TARGET_30D") return emailIds[i] ?? SILENT;
    if (name === "INVITE_EMAILS_GLOBAL_DAY") return "all";
    return creator.id;
  };
  const checks = emailIds.flatMap((_hash, i) =>
    CAPS.map((name): LimitCheck => ({ name, key: keyFor(name, i), amount: 1 })),
  );
  const results = await checkLimits(repos, config, now, checks);
  const sends = wouldSend.map((would, i) => {
    if (!would) return false;
    const own = results.slice(i * CAPS.length, (i + 1) * CAPS.length);
    // The new-account rate applies only to a young account that hasn't completed a game.
    return !own.some(
      (result) => result.exceeded && (result.name !== "INVITE_EMAILS_NEW_INVITER_DAY" || young),
    );
  });
  alertOnCrossing(
    log,
    results.filter((result, i) => {
      return result.name === "INVITE_EMAILS_GLOBAL_DAY" && wouldSend[Math.floor(i / CAPS.length)];
    }),
  );

  const messages = await Promise.all(
    emails.map(async (email, i) => {
      const token = await unsubscribeToken(keys, {
        purpose: "invites",
        emailId: emailIds[i] ?? "",
      });
      return invitationEmail(email, {
        appName: config.appName,
        publicUrl: config.publicUrl,
        inviterName: creator.displayName ?? NEW_PLAYER_NAME,
        inviterEmail: creator.email ?? "",
        gameName: input.gameName,
        turnTimeoutDays: input.turnTimeoutDays,
        openDays: LOBBY_LIFETIME_MS / DAY,
        unsubscribeUrl: unsubscribeUrl(config.publicUrl, token),
      });
    }),
  );
  return {
    sentAt: sends.map((send) => (send ? now : null)),
    messages: messages.filter((_message, i) => sends[i] === true),
  };
}

/**
 * Sends a create request's invite emails, in the background after the response (06 §6.3). A
 * failed message is logged by class (unless its provider already alerted, 09 §2) and doesn't stop
 * the others; nothing is retried.
 */
export async function sendInviteMail(
  platform: Platform,
  messages: readonly EmailMessage[],
): Promise<void> {
  for (const message of messages) {
    try {
      await platform.email.send(message);
    } catch (error) {
      if (!wasAlerted(error)) {
        // The class only: the message may quote the address (09 §5).
        platform.log.error("invite email not sent", {
          errorClass: error instanceof Error ? error.constructor.name : typeof error,
        });
      }
    }
  }
}
