/**
 * The sign-in and account endpoints (docs/spec/05-api.md §Auth & account, 06 §3–§5, §7): OTP
 * request and verify, logout and logout-all, `GET`/`PATCH /me` (with the `emailNudges` setting,
 * 03 §7, and the age confirmation, 06 §5), the under-age exit, and account deletion with a step-up
 * code.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  deleteMeRoute,
  deleteOtpRoute,
  getMeRoute,
  logoutAllRoute,
  logoutRoute,
  type ErrorCode,
  type Me,
  otpRequestRoute,
  otpVerifyRoute,
  patchMeRoute,
  underAgeRoute,
  UserSettingsSchema,
} from "@your-move/shared";
import type { Context } from "hono";
import { z } from "zod";

import { validateDisplayName } from "../accounts/display-name.js";
import { normaliseAddress } from "../accounts/email.js";
import { ageConfirmed, needsOnboarding } from "../accounts/onboarding.js";
import { isLocalDev } from "../config/local-dev.js";
import { emailId, type Subkeys } from "../crypto/subkeys.js";
import type { UserRecord, UserUpdate } from "../db/repositories.js";
import type { EmailMessage } from "../email/sender.js";
import {
  accountDeletedEmail,
  approximateTime,
  deleteAccountCodeEmail,
  signInCodeEmail,
  suspendedNoticeEmail,
  type TemplateContext,
} from "../email/templates.js";
import { type Claimant, claimInvitations } from "../games/claim.js";
import { background } from "../http/background.js";
import { errorBody, type ErrorReason } from "../http/error-log.js";
import type { AppEnv, Platform } from "../platform.js";
import { sendInvitationPushes } from "../push/notify.js";
import { clientBucketsOf } from "./client-buckets.js";
import { checkLimits } from "./limits.js";
import {
  issueSignInCode,
  issueStepUpCode,
  type OtpDeps,
  type ClientBuckets,
  chargeNewAccount,
  newAccountAllowed,
  takeOtpEmailRoom,
  verifyCode,
} from "./otp.js";
import { requireSession } from "./require-session.js";
import {
  clearedSessionCookie,
  createSession,
  loadSession,
  readSessionCookie,
  sessionCookie,
} from "./session.js";

type ErrorStatus = 400 | 401 | 403 | 409 | 429;
type Code = Extract<
  ErrorCode,
  "BAD_REQUEST" | "INVALID_CODE" | "UNAUTHENTICATED" | "SUSPENDED" | "WRONG_STATUS" | "RATE_LIMITED"
>;

const MESSAGES: Readonly<Record<Code, string>> = {
  BAD_REQUEST: "The request was rejected.",
  INVALID_CODE: "That code is wrong or has expired.",
  UNAUTHENTICATED: "Please sign in.",
  SUSPENDED: "This account is suspended.",
  WRONG_STATUS: "Your account is already set up.",
  RATE_LIMITED: "Too many requests. Please wait and try again.",
};

function fail<S extends ErrorStatus, C extends Code>(
  c: Context<AppEnv>,
  status: S,
  code: C,
  reason?: ErrorReason,
) {
  return c.json(errorBody(c, code, MESSAGES[code], reason === undefined ? {} : { reason }), status);
}

/**
 * Stored settings: known keys only, each read on its own, so one unreadable value counts as unset
 * without taking the others with it (A6-P-12).
 */
const storedSettings = z
  .object({
    whoCanAddMe: UserSettingsSchema.shape.whoCanAddMe.optional().catch(undefined),
    emailNudges: UserSettingsSchema.shape.emailNudges.optional().catch(undefined),
    theme: UserSettingsSchema.shape.theme.optional().catch(undefined),
  })
  .catch({});

/** The `Me` view of a user (05 §Auth & account). */
function toMe(user: UserRecord, adminEmails: readonly string[], minAge: number): Me {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(user.settings);
  } catch {
    // Unreadable settings count as unset.
  }
  const settings = storedSettings.parse(parsed);
  return {
    id: user.id,
    kind: user.kind,
    email: user.email,
    displayName: user.displayName,
    settings: {
      whoCanAddMe: settings.whoCanAddMe ?? "pastOpponents",
      // Off unless turned on (03 §7).
      emailNudges: settings.emailNudges ?? false,
      theme: settings.theme ?? "system",
    },
    ageAttested: ageConfirmed(user, minAge),
    // Again true for a user re-prompted after a MIN_AGE rise (06 §5).
    needsOnboarding: needsOnboarding(user, minAge),
    isAdmin: user.email !== null && adminEmails.includes(user.email),
  };
}

export interface AuthRouteOptions {
  readonly platform: Platform;
  /** HKDF subkeys of `APP_SECRET`, derived once per app. */
  readonly keys: () => Promise<Subkeys>;
  /** Email-invite seats completing onboarding claims at most; the sweep claims the rest. */
  readonly onboardingClaims: number;
}

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>, options: AuthRouteOptions): void {
  const { platform } = options;
  const { config, repos } = platform;
  const localDev = isLocalDev(config);
  const now = (): number => platform.now().getTime();
  const deps = async (): Promise<OtpDeps> => ({
    repos,
    config,
    keys: await options.keys(),
    log: platform.log,
    now: now(),
  });
  const templateContext = (): TemplateContext => ({
    appName: config.appName,
    publicUrl: config.publicUrl,
    requestedAt: approximateTime(platform.now()),
  });
  const send = (c: Context, message: EmailMessage): void => {
    background(c, platform, () => platform.email.send(message));
  };

  /** The client's IP buckets, hashed (08 §4.1), or null when the address is missing. */
  const clientBuckets = (c: Context, keys: Subkeys): Promise<ClientBuckets | null> =>
    clientBucketsOf(platform, c, keys);

  /**
   * Claims the new user's email-invite seats before onboarding answers, so their game list shows
   * the invitations (06 §6.4), and when one is a `normal` invitation sends them the generic
   * invitation push in the background (alpha A20). A failure never fails onboarding: it is logged
   * by class (09 §5) and the sweep claims the seats later.
   */
  const claimAtOnboarding = async (c: Context, claimant: Claimant, at: number): Promise<void> => {
    try {
      const { normal } = await claimInvitations(repos, claimant, at, options.onboardingClaims);
      if (normal > 0 && platform.push.enabled) {
        background(c, platform, () => sendInvitationPushes(platform, [claimant.id]));
      }
    } catch (error) {
      platform.log.error("invite claim at onboarding failed", {
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  };

  const clearCookie = (c: Context): void => {
    c.header("Set-Cookie", clearedSessionCookie(localDev), { append: true });
  };

  const session = requireSession(platform);
  // Registered before the handlers, so it runs first.
  for (const path of [
    logoutRoute.path,
    logoutAllRoute.path,
    getMeRoute.path,
    underAgeRoute.path,
    deleteOtpRoute.path,
  ]) {
    app.use(path, session);
  }

  app.openapi(otpRequestRoute, async (c) => {
    const email = normaliseAddress(c.req.valid("json").email);
    if (email === null) return fail(c, 400, "BAD_REQUEST", "invalid_email");
    const context = await deps();
    const buckets = await clientBuckets(c, context.keys);
    if (buckets === null) return fail(c, 400, "BAD_REQUEST", "no_client_ip");
    const outcome = await issueSignInCode(context, email, buckets);
    if (outcome.kind === "ip-limited") return fail(c, 429, "RATE_LIMITED");
    // Both messages are built on every path, sent or not, so the work before the response doesn't
    // depend on the outcome (06 §3.2).
    const template = templateContext();
    const codeEmail = signInCodeEmail(email, outcome.code, template);
    const notice = suspendedNoticeEmail(email, template);
    // The background task is scheduled on every path too, and does nothing when nothing may be
    // sent: scheduling only when sending made the silent paths measurably quicker.
    const message =
      outcome.send === null ? null : outcome.send.type === "code" ? codeEmail : notice;
    background(c, platform, () =>
      message === null ? Promise.resolve() : platform.email.send(message),
    );
    return c.json({}, 202);
  });

  app.openapi(otpVerifyRoute, async (c) => {
    const body = c.req.valid("json");
    const email = normaliseAddress(body.email);
    if (email === null) return fail(c, 400, "BAD_REQUEST", "invalid_email");
    const context = await deps();
    const buckets = await clientBuckets(c, context.keys);
    if (buckets === null) return fail(c, 400, "BAD_REQUEST", "no_client_ip");
    const existing = await repos.users.findByEmail(email);
    const outcome = await verifyCode(context, email, "signin", body.code, buckets);
    if (outcome === "limited") return fail(c, 429, "RATE_LIMITED");
    const ipHash = buckets.ipBuckets[0]?.hash ?? null;
    if (outcome === "invalid" || existing?.suspendedAt != null) {
      await repos.authEvents.record({
        userId: existing?.id ?? null,
        type: "otp_failed",
        ipHash,
        createdAt: context.now,
      });
      return fail(c, 400, "INVALID_CODE");
    }
    let user = existing;
    if (user === null) {
      // New accounts per IP (08 §4): judged and counted where the account is created, against
      // this request's buckets, so asking for the code from one address and verifying from
      // another can't get round it.
      if (!(await newAccountAllowed(context, buckets))) {
        await repos.authEvents.record({
          userId: null,
          type: "otp_failed",
          ipHash,
          createdAt: context.now,
        });
        return fail(c, 400, "INVALID_CODE");
      }
      const id = crypto.randomUUID();
      user = await repos.users.createOrGetByEmail({
        id,
        email,
        createdAt: context.now,
        updatedAt: context.now,
      });
      // Counted only when this request inserted the row, not when a racing verify did.
      if (user.id === id) await chargeNewAccount(context, buckets);
    }
    // Rotated on sign-in (06 §4): a session this browser presents is replaced, not left behind.
    const presented = readSessionCookie(c.req.header("Cookie"), localDev);
    if (presented !== null) {
      const previous = await loadSession(repos, presented, context.now, () => undefined);
      if (previous !== null) await repos.sessions.delete(previous.user.id, previous.session.id);
    }
    const token = await createSession(repos, user.id, context.now, c.req.header("User-Agent"));
    await repos.authEvents.record({
      userId: user.id,
      type: "signed_in",
      ipHash,
      createdAt: context.now,
    });
    c.header("Set-Cookie", sessionCookie(token, localDev));
    const me = toMe(user, config.adminEmails, config.minAge);
    return c.json({ user: me, needsOnboarding: me.needsOnboarding }, 200);
  });

  app.openapi(logoutRoute, async (c) => {
    const active = c.get("session");
    await repos.sessions.delete(active.user.id, active.session.id);
    clearCookie(c);
    return c.body(null, 204);
  });

  app.openapi(logoutAllRoute, async (c) => {
    const active = c.get("session");
    const body = c.req.valid("json");
    const at = now();
    await repos.sessions.deleteAll(active.user.id);
    if (body.revokeTokens === true) await repos.apiTokens.revokeAll(active.user.id, at);
    await repos.authEvents.record({
      userId: active.user.id,
      type: "signed_out_all",
      ipHash: null,
      createdAt: at,
    });
    clearCookie(c);
    return c.body(null, 204);
  });

  app.openapi(getMeRoute, (c) => {
    const active = c.get("session");
    return c.json(toMe(active.user, config.adminEmails, config.minAge), 200);
  });

  app.openapi(patchMeRoute, async (c) => {
    const active = c.get("session");
    const body = c.req.valid("json");
    let user = active.user;
    const at = now();
    // Checked before anything is written, so a refused name changes nothing else either.
    const named =
      body.displayName === undefined
        ? undefined
        : validateDisplayName(body.displayName, config.appName);
    if (named?.ok === false) return fail(c, 400, "BAD_REQUEST");
    const set: Partial<Omit<UserUpdate, "updatedAt">> = {};
    // A rename (06 §5) is budgeted and logged; a name set before onboarding completes isn't one.
    const renamed = named !== undefined && named.name !== user.displayName;
    const rename = renamed && user.onboardedAt !== null;
    if (rename) {
      const [limit] = await checkLimits(repos, config, at, [
        { name: "DISPLAY_NAME_CHANGES_30D", key: user.id, amount: 1 },
      ]);
      if (limit?.exceeded === true) return fail(c, 429, "RATE_LIMITED");
    }
    if (renamed) set.displayName = named.name;
    if (body.ageAttested === true && !ageConfirmed(user, config.minAge)) {
      // The confirmation's time and the MIN_AGE in force (06 §5): a later rise re-prompts.
      set.ageAttestedAt = at;
      set.ageAttestedMinAge = config.minAge;
    }
    const after = { ...user, ...set };
    // The request that leaves both the name and the age confirmation done completes onboarding.
    const completes =
      user.onboardedAt === null && after.displayName !== null && ageConfirmed(after, config.minAge);
    if (completes) set.onboardedAt = at;
    if (Object.keys(set).length > 0) {
      await repos.users.update(user.id, { ...set, updatedAt: at });
      user = { ...user, ...set, updatedAt: at };
    }
    if (rename) {
      await repos.authEvents.record({
        userId: user.id,
        type: "display_name_changed",
        ipHash: null,
        createdAt: at,
      });
    }
    // Completing onboarding claims the address's email-invite seats (06 §6.4).
    if (completes && user.email !== null) {
      await claimAtOnboarding(c, { id: user.id, email: user.email }, at);
    }
    const nudges = body.settings?.emailNudges;
    if (nudges !== undefined) {
      if (nudges) {
        // Nudges go to the account's address: an account without one can't have them.
        if (user.email === null) return fail(c, 400, "BAD_REQUEST", "no_email");
        // Records the address's emailId, which a nudges unsubscribe link finds the account by
        // (04 `users.email_id`, 05 §Email links).
        const id = await emailId(await options.keys(), user.email);
        await repos.users.setEmailNudges(user.id, { enabled: true, emailId: id, updatedAt: now() });
      } else {
        await repos.users.setEmailNudges(user.id, { enabled: false, updatedAt: now() });
      }
      // The settings were changed in SQL, key by key: read back what is stored now.
      user = (await repos.users.findById(user.id)) ?? user;
    }
    const theme = body.settings?.theme;
    if (theme !== undefined) {
      await repos.users.setTheme(user.id, theme, now());
      user = (await repos.users.findById(user.id)) ?? user;
    }
    return c.json(toMe(user, config.adminEmails, config.minAge), 200);
  });

  /**
   * "I'm under MIN_AGE" (06 §5). A new account goes at once, with no step-up code: the short
   * deletion, with its address suppressed and its email seats made inert. A re-prompted account
   * may be a parent's, held by a child, so only this session ends and nothing is deleted (T5).
   */
  app.openapi(underAgeRoute, async (c) => {
    const active = c.get("session");
    const { user } = active;
    if (!needsOnboarding(user, config.minAge)) return fail(c, 409, "WRONG_STATUS");
    const at = now();
    const keys = await options.keys();
    // The event is pseudonymous: the hashed IP bucket, never the address (06 §5, 09 §5).
    const ipHash = (await clientBuckets(c, keys))?.ipBuckets[0]?.hash ?? null;
    const signedOut = () => {
      clearCookie(c);
      return c.body(null, 204);
    };
    if (user.onboardedAt === null && user.email !== null) {
      const deleted = await repos.users.underAgeDelete(
        { id: user.id, email: user.email, emailId: await emailId(keys, user.email) },
        { ipHash, createdAt: at },
      );
      if (deleted) return signedOut();
      // Onboarding completed meanwhile: judged again for the account as it is now (06 §5).
      const current = await repos.users.findById(user.id);
      if (current === null) return signedOut();
      if (!needsOnboarding(current, config.minAge)) return fail(c, 409, "WRONG_STATUS");
    }
    // A re-prompted account: this session only, nothing deleted.
    await repos.sessions.delete(user.id, active.session.id);
    await repos.authEvents.record({
      userId: user.id,
      type: "under_age_exit",
      ipHash,
      createdAt: at,
    });
    return signedOut();
  });

  app.openapi(deleteOtpRoute, async (c) => {
    const active = c.get("session");
    const email = active.user.email;
    // The session user's own address is missing (an account without one), not a typed one.
    if (email === null) return fail(c, 400, "BAD_REQUEST", "no_email");
    const issued = await issueStepUpCode(
      await deps(),
      { id: active.user.id, email },
      "delete_account",
    );
    if (issued.kind === "limited") return fail(c, 429, "RATE_LIMITED");
    if (issued.code !== null)
      send(c, deleteAccountCodeEmail(email, issued.code, templateContext()));
    return c.json({}, 202);
  });

  app.openapi(deleteMeRoute, async (c) => {
    const active = c.get("session");
    const email = active.user.email;
    // The session user's own address is missing (an account without one), not a typed one.
    if (email === null) return fail(c, 400, "BAD_REQUEST", "no_email");
    const context = await deps();
    const buckets = await clientBuckets(c, context.keys);
    if (buckets === null) return fail(c, 400, "BAD_REQUEST", "no_client_ip");
    const outcome = await verifyCode(
      context,
      email,
      "delete_account",
      c.req.valid("json").code,
      buckets,
    );
    if (outcome === "limited") return fail(c, 429, "RATE_LIMITED");
    if (outcome === "invalid") return fail(c, 400, "INVALID_CODE");
    // 04 §Account deletion. Its game steps (resign, cancel, leave) are M4's: until then a deleted
    // user's game rows lose their user, and the lobbies they created lose their join links in the
    // same batch (alpha A18), so no one joins a lobby whose creator has gone.
    await repos.users.deleteAccount(
      { id: active.user.id, email },
      {
        userId: active.user.id,
        type: "account_deleted",
        ipHash: buckets.ipBuckets[0]?.hash ?? null,
        createdAt: context.now,
      },
    );
    // The confirmation is informational: over the instance-wide OTP email caps it is skipped, and
    // the account is deleted all the same (06 §7, 08 §4.2). So is a failure to count it: the
    // deletion has happened, so it is logged by class only (09 §5) and the answer is still 204.
    let confirm = false;
    try {
      confirm = await takeOtpEmailRoom(context);
    } catch (error) {
      platform.log.error("account-deleted email not counted", {
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
    if (confirm) send(c, accountDeletedEmail(email, templateContext()));
    clearCookie(c);
    return c.body(null, 204);
  });
}
