/**
 * Invite emails (docs/spec/06-auth.md §6.3, §6.6, alpha A17) and the invitation email to a user
 * with email nudges on (06 §6.2, alpha A20): which invitees get one, the caps they count toward,
 * and the messages.
 *
 * An email-invite seat (no account, or one that hasn't finished onboarding) with `normal` delivery
 * may be mailed the invite email; a user's `normal` invitation may be mailed the invitation email
 * when they have email nudges on; neither when the address is suppressed (any reason). The caps
 * count in two tiers, the same way for every typed address (review A17-S-1):
 *
 * 1. the inviter's own caps (a day, 30 days, and the new-account rate) count **every** typed
 *    address as an attempt, whatever it resolves to, so the allowance an address uses up says
 *    nothing about it;
 * 2. the shared caps (per address, instance-wide) use their real keys only for an address that may
 *    be mailed and passed the inviter's caps; every other address adds 1 to the never-read `silent`
 *    key instead (06 §3.2), so nobody can spend another address's or the instance's budget with
 *    addresses that would never be mailed.
 *
 * A past opponent picked by id and seated as an invitation isn't a typed address: it counts
 * nothing toward tier 1 and tier 2 as above, so its work doesn't depend on its setting either.
 *
 * A message is sent only when every cap passed. The work is the same for every typed address
 * (Q3): the suppression lookup covers them all, every address writes the same number of counters,
 * one message is built for each (the template its seat would get, with one unsubscribe token), and
 * the caller schedules one background task whatever it carries. `invites.sent_at` and the instance
 * cap's alert are written in that task, after the response.
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
import { invitationEmail, invitationNudgeEmail } from "../email/templates.js";
import { unsubscribeToken, unsubscribeUrl } from "../email/unsubscribe-token.js";
import type { Platform } from "../platform.js";
import { LOBBY_LIFETIME_MS } from "./lifecycle.js";
import { NEW_PLAYER_NAME } from "./names.js";

const DAY = 86_400_000;
/** An inviter younger than this with no past opponent gets the lower daily rate (06 §6.6). */
const NEW_ACCOUNT_MS = 7 * DAY;
/** The `rate_limits` key that counts what isn't counted for real: written, never read (06 §3.2). */
const SILENT = "silent";

/** One invitee of the request who might be mailed: a typed address, or a pick seated as invited. */
export interface MailTarget {
  /** Where its email would go: the typed address, or a picked user's own. */
  readonly email: NormalisedEmail;
  /** Its `emailId`, the per-address cap's key (a placeholder for a pick that has none). */
  readonly emailId: string;
  /** The `invites` row whose `sent_at` records its email: a typed address's; null for a pick. */
  readonly inviteId: string | null;
  /**
   * The email its seat would get: the invite email of an email-invite seat (06 §6.3), or the
   * invitation email of a user's invitation (§6.2).
   */
  readonly seat: "emailInvite" | "invitation";
  /**
   * Whether it may be mailed at all, suppression aside: an email-invite seat whose delivery is
   * `normal`, or a user's `normal` invitation whose user gets the invitation email (email nudges
   * on, `email_id` set, not suspended or being deleted). A `hidden` or `inert` seat never is.
   */
  readonly mailable: boolean;
}

export interface InviteMailInput {
  readonly creator: UserRecord;
  /** The game type's display name, from its manifest. */
  readonly gameName: string;
  /** The typed addresses, in the request's order: each counts toward the inviter's caps. */
  readonly addresses: readonly MailTarget[];
  /** The picked past opponents seated as invitations (not added): none counts toward those. */
  readonly picked: readonly MailTarget[];
}

/** One email to send, and the `invites` row whose `sent_at` records it (none for a pick). */
interface InviteDelivery {
  readonly inviteId: string | null;
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
 * Decides and counts the invite and invitation emails of one create request and builds every
 * message. Call it only once every refusal has passed: the counters it writes are the sends' own.
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
  const { platform } = deps;
  const { repos, config } = platform;
  const { creator, addresses, picked } = input;
  // The typed addresses first: the inviter's caps below count those, in order.
  const targets = [...addresses, ...picked];
  if (targets.length === 0) return { now, deliveries: [], instanceCapped: false };
  const emailIds = targets.map((target) => target.emailId);

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

  const decided = targets.map((target, i) => {
    // A pick, after the typed addresses, has no tier-1 results: an empty slice passes.
    const passedInviter = inviter
      .slice(i * inviterCaps.length, (i + 1) * inviterCaps.length)
      // The new-account rate binds only a young account that hasn't played anyone yet.
      .every(
        (result) => !result.exceeded || (result.name === "INVITE_EMAILS_NEW_INVITER_DAY" && !young),
      );
    // Tier 2 counts for real only an address that may be mailed and passed tier 1.
    const real = target.mailable && !unmailable.has(target.emailId) && passedInviter;
    return { target, real };
  });
  const shared = await checkLimits(
    repos,
    config,
    now,
    decided.flatMap(({ target, real }): LimitCheck[] => [
      { name: "INVITE_EMAILS_TARGET_30D", key: real ? target.emailId : SILENT, amount: 1 },
      { name: "INVITE_EMAILS_GLOBAL_DAY", key: real ? "all" : SILENT, amount: 1 },
    ]),
  );
  const outcomes = decided.map(({ target, real }, i) => {
    const [perAddress, instance] = [shared[2 * i], shared[2 * i + 1]];
    if (perAddress === undefined || instance === undefined) {
      throw new Error("a limit result is missing");
    }
    return {
      target,
      send: real && !stoppedToday && !perAddress.exceeded && !instance.exceeded,
      capped: real && instance.exceeded,
    };
  });

  const deliveries = await Promise.all(
    outcomes.map(async ({ target, send }) => ({
      send,
      delivery: { inviteId: target.inviteId, message: await messageFor(deps, input, target) },
    })),
  );
  return {
    now,
    deliveries: deliveries.flatMap(({ send, delivery }) => (send ? [delivery] : [])),
    instanceCapped: outcomes.some((outcome) => outcome.capped),
  };
}

/**
 * The email a target's seat would get, with its one unsubscribe token: the invite email (purpose
 * `invites`, 06 §6.3) or the invitation email (purpose `nudges`, §6.2). One HMAC and one template
 * either way, so building it is the same work whatever the address turns out to be (Q3).
 */
async function messageFor(
  deps: { readonly platform: Platform; readonly keys: Subkeys },
  input: InviteMailInput,
  target: MailTarget,
): Promise<EmailMessage> {
  const { config } = deps.platform;
  const inviterName = input.creator.displayName ?? NEW_PLAYER_NAME;
  const invitation = target.seat === "invitation";
  const token = await unsubscribeToken(deps.keys, {
    purpose: invitation ? "nudges" : "invites",
    emailId: target.emailId,
  });
  const unsubscribe = unsubscribeUrl(config.publicUrl, token);
  if (invitation) {
    return invitationNudgeEmail(target.email, {
      appName: config.appName,
      publicUrl: config.publicUrl,
      inviterName,
      gameName: input.gameName,
      settingsUrl: new URL("/settings", config.publicUrl).toString(),
      unsubscribeUrl: unsubscribe,
    });
  }
  return invitationEmail(target.email, {
    appName: config.appName,
    publicUrl: config.publicUrl,
    inviterName,
    inviterEmail: input.creator.email ?? "",
    gameName: input.gameName,
    openDays: LOBBY_LIFETIME_MS / DAY,
    unsubscribeUrl: unsubscribe,
  });
}

/**
 * Sends a create request's invite and invitation emails, in the background after the response
 * (06 §6.2, §6.3): first, when the instance-wide cap stopped one, its alert and the day's stop
 * marker (08 §4), then the emails, then `invites.sent_at` (04) for the typed addresses whose email
 * the sender accepted. A failed message is logged by class (unless its provider already alerted,
 * 09 §2), keeps `sent_at` NULL and doesn't stop the others; nothing is retried.
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
      if (delivery.inviteId !== null) sent.push(delivery.inviteId);
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
