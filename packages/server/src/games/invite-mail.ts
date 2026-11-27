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
import {
  alertOncePerWindow,
  checkLimits,
  crossedThisWindow,
  type LimitCheck,
} from "../auth/limits.js";
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

/** One typed address of the request: its address, `emailId`, `invites` row and whether it may be mailed. */
export interface TypedAddress {
  readonly email: NormalisedEmail;
  readonly emailId: string;
  /** The `invites` row whose `sent_at` records its email. */
  readonly inviteId: string;
  /**
   * Whether its seat may be mailed at all: an email-invite seat (no onboarded user) whose
   * delivery is `normal`. A `hidden` seat (over the inbound cap) is never mailed, like a
   * suppressed address (06 §6.3).
   */
  readonly mailable: boolean;
}

export interface InviteMailInput {
  readonly creator: UserRecord;
  /** The game type's display name, from its manifest. */
  readonly gameName: string;
  /** The typed addresses, in the request's order. */
  readonly addresses: readonly TypedAddress[];
}

/** One invite email to send, and the `invites` row whose `sent_at` records it. */
interface InviteDelivery {
  readonly inviteId: string;
  readonly message: EmailMessage;
}

export interface InviteMail {
  /** The request's time: the window the instance cap's alert and stop are counted in. */
  readonly now: number;
  /** The emails to send after the response; possibly none. */
  readonly deliveries: readonly InviteDelivery[];
  /** Whether the instance-wide cap stopped one (its alert and stop are written in the background). */
  readonly instanceCapped: boolean;
}

/**
 * Decides and counts the invite emails of one create request and builds every message. Call it
 * only once every refusal has passed: the counters it writes are the sends' own.
 *
 * Once the instance-wide cap has been crossed in a fixed UTC day (its alert marker, 08 §4), no
 * invite email is sent for the rest of that day, whatever the sliding estimate says later, so an
 * instance held near the cap answers a probe at most about once a day (review A17-S2-1). The
 * marker is read for every request with a typed address, the same way whatever the addresses are.
 */
export async function planInviteMail(
  deps: { readonly platform: Platform; readonly keys: Subkeys },
  input: InviteMailInput,
  now: number,
): Promise<InviteMail> {
  const { platform, keys } = deps;
  const { repos, config } = platform;
  const { creator, addresses } = input;
  if (addresses.length === 0) return { now, deliveries: [], instanceCapped: false };
  const emailIds = addresses.map((address) => address.emailId);

  const [suppressed, playedBefore, stoppedToday] = await Promise.all([
    repos.emailSuppressions.suppressedAmong(emailIds),
    repos.users.hasPastOpponent(creator.id),
    crossedThisWindow(repos, "INVITE_EMAILS_GLOBAL_DAY", now),
  ]);
  const unmailable = new Set(suppressed);
  const young = creator.createdAt > now - NEW_ACCOUNT_MS && !playedBefore;

  // Tier 1: the inviter's own caps, one attempt for every typed address (A17-S-1).
  const inviterCaps = [
    "INVITE_EMAILS_INVITER_DAY",
    "INVITE_EMAILS_INVITER_30D",
    "INVITE_EMAILS_NEW_INVITER_DAY",
  ] as const;
  const inviter = await checkLimits(
    repos,
    config,
    now,
    addresses.flatMap((): LimitCheck[] =>
      inviterCaps.map((name) => ({ name, key: creator.id, amount: 1 })),
    ),
  );

  const decided = addresses.map((address, i) => {
    const passedInviter = inviter
      .slice(i * inviterCaps.length, (i + 1) * inviterCaps.length)
      // The new-account rate binds only a young account that hasn't played anyone yet.
      .every(
        (result) => !result.exceeded || (result.name === "INVITE_EMAILS_NEW_INVITER_DAY" && !young),
      );
    // Tier 2 counts for real only an address that may be mailed and passed tier 1.
    const real = address.mailable && !unmailable.has(address.emailId) && passedInviter;
    return { address, real };
  });
  const shared = await checkLimits(
    repos,
    config,
    now,
    decided.flatMap(({ address, real }): LimitCheck[] => [
      { name: "INVITE_EMAILS_TARGET_30D", key: real ? address.emailId : SILENT, amount: 1 },
      { name: "INVITE_EMAILS_GLOBAL_DAY", key: real ? "all" : SILENT, amount: 1 },
    ]),
  );
  const outcomes = decided.map(({ address, real }, i) => {
    const [target, instance] = [shared[2 * i], shared[2 * i + 1]];
    if (target === undefined || instance === undefined)
      throw new Error("a limit result is missing");
    return {
      address,
      send: real && !stoppedToday && !target.exceeded && !instance.exceeded,
      capped: real && instance.exceeded,
    };
  });

  const deliveries = await Promise.all(
    outcomes.map(async ({ address, send }) => {
      const token = await unsubscribeToken(keys, { purpose: "invites", emailId: address.emailId });
      const message = invitationEmail(address.email, {
        appName: config.appName,
        publicUrl: config.publicUrl,
        inviterName: creator.displayName ?? NEW_PLAYER_NAME,
        inviterEmail: creator.email ?? "",
        gameName: input.gameName,
        openDays: LOBBY_LIFETIME_MS / DAY,
        unsubscribeUrl: unsubscribeUrl(config.publicUrl, token),
      });
      return { send, delivery: { inviteId: address.inviteId, message } };
    }),
  );
  return {
    now,
    deliveries: deliveries.flatMap(({ send, delivery }) => (send ? [delivery] : [])),
    instanceCapped: outcomes.some((outcome) => outcome.capped),
  };
}

/**
 * Sends a create request's invite emails, in the background after the response (06 §6.3): first,
 * when the instance-wide cap stopped one, its alert and the day's stop marker (08 §4), then the
 * emails, then `invites.sent_at` (04) for the ones the sender accepted. A failed message is logged by class
 * (unless its provider already alerted, 09 §2), keeps `sent_at` NULL and doesn't stop the others;
 * nothing is retried.
 */
export async function sendInviteMail(platform: Platform, mail: InviteMail): Promise<void> {
  // The alert, and the marker that stops invite emails for the rest of the UTC day, come first,
  // in the request's own window, so a failing send can't skip them (review A17-S2-3).
  if (mail.instanceCapped) {
    await alertOncePerWindow(platform.repos, platform.log, "INVITE_EMAILS_GLOBAL_DAY", mail.now);
  }
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
  if (sent.length > 0) await platform.repos.invites.markSent(sent, platform.now().getTime());
}
