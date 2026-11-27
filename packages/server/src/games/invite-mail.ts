/**
 * Invite emails (docs/spec/06-auth.md §6.3, §6.6, alpha A17): which typed addresses get one, the
 * caps they count toward, and the messages.
 *
 * Only an email-invite seat (no account, or one that hasn't finished onboarding) with `normal`
 * delivery whose address isn't suppressed may be mailed. The caps count in two tiers, the same
 * way for every typed address (review A17-S-1):
 *
 * 1. the inviter's own caps (a day, 30 days, and the new-account rate) count **every** typed
 *    address as an attempt, whatever it resolves to, so the allowance an address uses up says
 *    nothing about it;
 * 2. the shared caps (per address, instance-wide) use their real keys only for an address that may
 *    be mailed and passed the inviter's caps; every other address adds 1 to the never-read `silent`
 *    key instead (06 §3.2), so nobody can spend another address's or the instance's budget with
 *    addresses that would never be mailed.
 *
 * A message is sent only when every cap passed. The work is the same for every typed address
 * (Q3): the suppression lookup covers them all, every address writes the same number of counters,
 * every message is built, and the caller schedules one background task whatever it carries.
 * `invites.sent_at` and the instance cap's alert are written in that task, after the response.
 */
import type { NormalisedEmail } from "../accounts/email.js";
import { alertOncePerWindow, checkLimits, type LimitCheck } from "../auth/limits.js";
import type { Subkeys } from "../crypto/subkeys.js";
import type { UserRecord } from "../db/repositories.js";
import { type EmailMessage, wasAlerted } from "../email/sender.js";
import { invitationEmail } from "../email/templates.js";
import { unsubscribeToken, unsubscribeUrl } from "../email/unsubscribe-token.js";
import type { Platform } from "../platform.js";
import { LOBBY_LIFETIME_MS } from "./lifecycle.js";
import { NEW_PLAYER_NAME } from "./names.js";

const DAY = 86_400_000;
/** An inviter younger than this with no past opponent gets the lower daily rate (06 §6.6). */
const NEW_ACCOUNT_MS = 7 * DAY;
/** The `rate_limits` key that counts what isn't counted for real: written, never read (06 §3.2). */
const SILENT = "silent";

export interface InviteMailInput {
  readonly creator: UserRecord;
  /** The game type's display name, from its manifest. */
  readonly gameName: string;
  /** The typed addresses, normalised, their `emailId`s and their `invites` row ids, in order. */
  readonly emails: readonly NormalisedEmail[];
  readonly emailIds: readonly string[];
  readonly inviteIds: readonly string[];
  /**
   * Whether each address's seat may be mailed at all: an email-invite seat (no onboarded user)
   * whose delivery is `normal`. A `hidden` seat (over the inbound cap) is never mailed, like a
   * suppressed address (06 §6.3).
   */
  readonly mailable: readonly boolean[];
}

/** One invite email to send, and the `invites` row whose `sent_at` records it. */
export interface InviteDelivery {
  readonly inviteId: string;
  readonly message: EmailMessage;
}

export interface InviteMail {
  /** The emails to send after the response; possibly none. */
  readonly deliveries: readonly InviteDelivery[];
  /** Whether the instance-wide cap stopped one (its alert is logged in the background). */
  readonly instanceCapped: boolean;
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
  const { repos, config } = platform;
  const { creator, emails, emailIds } = input;
  if (emails.length === 0) return { deliveries: [], instanceCapped: false };

  const [suppressed, playedBefore] = await Promise.all([
    repos.emailSuppressions.suppressedAmong(emailIds),
    repos.users.hasPastOpponent(creator.id),
  ]);
  const unmailable = new Set(suppressed);
  const young = creator.createdAt > now - NEW_ACCOUNT_MS && !playedBefore;
  const mayMail = emailIds.map((hash, i) => input.mailable[i] === true && !unmailable.has(hash));

  // Tier 1: the inviter's own caps, one attempt for every typed address (A17-S-1).
  const inviterCaps = ["INVITE_EMAILS_INVITER_DAY", "INVITE_EMAILS_INVITER_30D"] as const;
  const inviter = await checkLimits(
    repos,
    config,
    now,
    emailIds.flatMap((): LimitCheck[] => [
      ...inviterCaps.map((name) => ({ name, key: creator.id, amount: 1 })),
      { name: "INVITE_EMAILS_NEW_INVITER_DAY", key: creator.id, amount: 1 },
    ]),
  );
  const perAddress = inviterCaps.length + 1;
  const passedInviter = emailIds.map((_hash, i) =>
    inviter
      .slice(i * perAddress, (i + 1) * perAddress)
      // The new-account rate binds only a young account that hasn't played anyone yet.
      .every(
        (result) => !result.exceeded || (result.name === "INVITE_EMAILS_NEW_INVITER_DAY" && !young),
      ),
  );

  // Tier 2: the shared caps, real only for an address that may be mailed and passed tier 1.
  const real = mayMail.map((may, i) => may && passedInviter[i] === true);
  const shared = await checkLimits(
    repos,
    config,
    now,
    emailIds.flatMap((hash, i): LimitCheck[] => [
      { name: "INVITE_EMAILS_TARGET_30D", key: real[i] === true ? hash : SILENT, amount: 1 },
      { name: "INVITE_EMAILS_GLOBAL_DAY", key: real[i] === true ? "all" : SILENT, amount: 1 },
    ]),
  );
  const sharedOf = (i: number) => shared.slice(i * 2, i * 2 + 2);
  const sends = real.map((ok, i) => ok && sharedOf(i).every((result) => !result.exceeded));
  const instanceCapped = real.some((ok, i) => ok && sharedOf(i)[1]?.exceeded === true);

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
        openDays: LOBBY_LIFETIME_MS / DAY,
        unsubscribeUrl: unsubscribeUrl(config.publicUrl, token),
      });
    }),
  );
  return {
    deliveries: messages.flatMap((message, i) =>
      sends[i] === true ? [{ inviteId: input.inviteIds[i] ?? "", message }] : [],
    ),
    instanceCapped,
  };
}

/**
 * Sends a create request's invite emails, in the background after the response (06 §6.3), then
 * records the ones the sender accepted in `invites.sent_at` (04) and, when the instance-wide cap
 * stopped one, logs its alert once per window (08 §4). A failed message is logged by class
 * (unless its provider already alerted, 09 §2), keeps `sent_at` NULL and doesn't stop the others;
 * nothing is retried.
 */
export async function sendInviteMail(platform: Platform, mail: InviteMail): Promise<void> {
  const sent: string[] = [];
  for (const delivery of mail.deliveries) {
    try {
      await platform.email.send(delivery.message);
      sent.push(delivery.inviteId);
    } catch (error) {
      if (!wasAlerted(error)) {
        // The class only: the message may quote the address (09 §5).
        platform.log.error("invite email not sent", {
          errorClass: error instanceof Error ? error.constructor.name : typeof error,
        });
      }
    }
  }
  const now = platform.now().getTime();
  if (sent.length > 0) await platform.repos.invites.markSent(sent, now);
  if (mail.instanceCapped) {
    await alertOncePerWindow(platform.repos, platform.log, "INVITE_EMAILS_GLOBAL_DAY", now);
  }
}
