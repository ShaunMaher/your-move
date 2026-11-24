/**
 * The sign-in and account endpoints (docs/spec/05-api.md §Auth & account, 06 §3–§5, §7): OTP
 * request and verify, logout and logout-all, `GET`/`PATCH /me`, and account deletion with a
 * step-up code.
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
  UserSettingsSchema,
} from "@your-move/shared";
import type { Context, MiddlewareHandler } from "hono";

import { validateDisplayName } from "../accounts/display-name.js";
import { normaliseAddress } from "../accounts/email.js";
import { isLocalDev } from "../config/local-dev.js";
import { hmacHex, type Subkeys } from "../crypto/subkeys.js";
import type { UserRecord } from "../db/repositories.js";
import type { EmailMessage } from "../email/sender.js";
import {
  accountDeletedEmail,
  approximateTime,
  deleteAccountCodeEmail,
  signInCodeEmail,
  suspendedNoticeEmail,
  type TemplateContext,
} from "../email/templates.js";
import type { AppEnv, Platform } from "../platform.js";
import { ipBuckets } from "./client-ip.js";
import { checkLimits } from "./limits.js";
import {
  issueSignInCode,
  issueStepUpCode,
  type OtpDeps,
  type ClientBuckets,
  chargeNewAccount,
  newAccountAllowed,
  verifyCode,
} from "./otp.js";
import {
  clearedSessionCookie,
  createSession,
  loadSession,
  readSessionCookie,
  sessionCookie,
} from "./session.js";

type ErrorStatus = 400 | 401 | 403 | 429;
type Code = Extract<
  ErrorCode,
  "BAD_REQUEST" | "INVALID_CODE" | "UNAUTHENTICATED" | "SUSPENDED" | "RATE_LIMITED"
>;

const MESSAGES: Readonly<Record<Code, string>> = {
  BAD_REQUEST: "The request was rejected.",
  INVALID_CODE: "That code is wrong or has expired.",
  UNAUTHENTICATED: "Please sign in.",
  SUSPENDED: "This account is suspended.",
  RATE_LIMITED: "Too many requests. Please wait and try again.",
};

function fail<S extends ErrorStatus, C extends Code>(c: Context, status: S, code: C) {
  return c.json({ error: { code, message: MESSAGES[code] } }, status);
}

/** Stored settings: known keys only, anything unreadable treated as unset. */
const storedSettings = UserSettingsSchema.partial().catch({});

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
    settings: { whoCanAddMe: settings.whoCanAddMe ?? "pastOpponents" },
    ageAttested: user.ageAttestedMinAge !== null && user.ageAttestedMinAge >= minAge,
    // M2b: onboarding is the display name; the age confirmation joins in M4 (10 M2).
    needsOnboarding: user.onboardedAt === null,
    isAdmin: user.email !== null && adminEmails.includes(user.email),
  };
}

export interface AuthRouteOptions {
  readonly platform: Platform;
  /** HKDF subkeys of `APP_SECRET`, derived once per app. */
  readonly keys: () => Promise<Subkeys>;
}

/**
 * Runs `task` after the response (06 §3.2): through the request's `waitUntil` (per request on
 * Workers, tracked on Node), started on a later macrotask so it never delays the response. Errors
 * are logged by class only.
 */
function background(c: Context, platform: Platform, task: () => Promise<unknown>): void {
  const run = new Promise((resolve) => setTimeout(resolve, 0))
    .then(task)
    .catch((error: unknown) => {
      platform.log.error("background task failed", {
        errorClass: error instanceof Error ? error.name : typeof error,
      });
    });
  let context: { waitUntil(promise: Promise<unknown>): void } | null = null;
  try {
    context = c.executionCtx;
  } catch {
    // No execution context (a bare `app.request` in a test): the task simply runs detached.
  }
  context?.waitUntil(run);
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
  const clientBuckets = async (c: Context, keys: Subkeys): Promise<ClientBuckets | null> => {
    const ip = platform.clientIp(c.req.raw, c.env);
    if (!ip.ok) return null;
    const buckets = await Promise.all(
      ipBuckets(ip.ip).map(async (bucket) => ({
        hash: await hmacHex(keys.ip, bucket.bucket),
        multiplier: bucket.multiplier,
      })),
    );
    return { ipBuckets: buckets };
  };

  const clearCookie = (c: Context): void => {
    c.header("Set-Cookie", clearedSessionCookie(localDev), { append: true });
  };

  /** Session only (05 §Token scopes). Bearer tokens arrive in M3. */
  const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = readSessionCookie(c.req.header("Cookie"), localDev);
    if (c.req.header("Authorization") !== undefined) {
      // A cookie and a bearer token together are refused (05 §Conventions); tokens alone can't
      // authenticate until M3.
      return token === null ? fail(c, 401, "UNAUTHENTICATED") : fail(c, 400, "BAD_REQUEST");
    }
    if (token === null) return fail(c, 401, "UNAUTHENTICATED");
    const active = await loadSession(repos, token, now(), (task) => {
      background(c, platform, task);
    });
    if (active === null) {
      clearCookie(c);
      return fail(c, 401, "UNAUTHENTICATED");
    }
    if (active.user.suspendedAt !== null) return fail(c, 403, "SUSPENDED");
    c.set("session", active);
    await next();
    return undefined;
  };
  // Registered before the handlers, so it runs first.
  for (const path of [
    logoutRoute.path,
    logoutAllRoute.path,
    getMeRoute.path,
    deleteOtpRoute.path,
  ]) {
    app.use(path, requireSession);
  }

  app.openapi(otpRequestRoute, async (c) => {
    const email = normaliseAddress(c.req.valid("json").email);
    if (email === null) return fail(c, 400, "BAD_REQUEST");
    const context = await deps();
    const buckets = await clientBuckets(c, context.keys);
    if (buckets === null) return fail(c, 400, "BAD_REQUEST");
    const outcome = await issueSignInCode(context, email, buckets);
    if (outcome.kind === "ip-limited") return fail(c, 429, "RATE_LIMITED");
    if (outcome.send?.type === "code") {
      send(c, signInCodeEmail(email, outcome.send.code, templateContext()));
    } else if (outcome.send?.type === "suspended") {
      send(c, suspendedNoticeEmail(email, templateContext()));
    }
    return c.json({}, 202);
  });

  app.openapi(otpVerifyRoute, async (c) => {
    const body = c.req.valid("json");
    const email = normaliseAddress(body.email);
    if (email === null) return fail(c, 400, "BAD_REQUEST");
    const context = await deps();
    const buckets = await clientBuckets(c, context.keys);
    if (buckets === null) return fail(c, 400, "BAD_REQUEST");
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
    if (body.displayName !== undefined) {
      const result = validateDisplayName(body.displayName, config.appName);
      if (!result.ok) return fail(c, 400, "BAD_REQUEST");
      const at = now();
      if (user.onboardedAt === null) {
        // Completing onboarding (06 §5). Claiming email-invite seats joins with games (M3/M4).
        await repos.users.update(user.id, {
          displayName: result.name,
          onboardedAt: at,
          updatedAt: at,
        });
        user = { ...user, displayName: result.name, onboardedAt: at, updatedAt: at };
      } else if (result.name !== user.displayName) {
        const [limit] = await checkLimits(repos, config, at, [
          { name: "DISPLAY_NAME_CHANGES_30D", key: user.id, amount: 1 },
        ]);
        if (limit?.exceeded === true) return fail(c, 429, "RATE_LIMITED");
        await repos.users.update(user.id, { displayName: result.name, updatedAt: at });
        await repos.authEvents.record({
          userId: user.id,
          type: "display_name_changed",
          ipHash: null,
          createdAt: at,
        });
        user = { ...user, displayName: result.name, updatedAt: at };
      }
    }
    return c.json(toMe(user, config.adminEmails, config.minAge), 200);
  });

  app.openapi(deleteOtpRoute, async (c) => {
    const active = c.get("session");
    const email = active.user.email;
    if (email === null) return fail(c, 400, "BAD_REQUEST");
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
    if (email === null) return fail(c, 400, "BAD_REQUEST");
    const context = await deps();
    const buckets = await clientBuckets(c, context.keys);
    if (buckets === null) return fail(c, 400, "BAD_REQUEST");
    const outcome = await verifyCode(
      context,
      email,
      "delete_account",
      c.req.valid("json").code,
      buckets,
    );
    if (outcome === "limited") return fail(c, 429, "RATE_LIMITED");
    if (outcome === "invalid") return fail(c, 400, "INVALID_CODE");
    // 04 §Account deletion. Game steps (resign, cancel, leave) join with games in M3; until then
    // no account holds game rows.
    await repos.users.deleteAccount(
      { id: active.user.id, email },
      {
        userId: active.user.id,
        type: "account_deleted",
        ipHash: buckets.ipBuckets[0]?.hash ?? null,
        createdAt: context.now,
      },
    );
    send(c, accountDeletedEmail(email, templateContext()));
    clearCookie(c);
    return c.body(null, 204);
  });
}
