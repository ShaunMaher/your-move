/**
 * One-time codes (docs/spec/06-auth.md §3): generation, hashing, issuing and verifying, for
 * sign-in and for the purpose-bound step-up codes (§7).
 *
 * Enumeration parity (§3.2, Q3): issuing runs the same reads and writes whether or not the address
 * has an account, is rate-limited, suspended or over a cap — only flags passed to the same
 * statements differ — and email goes out in the background after the response. Verifying checks
 * the same challenges for every address, and an HMAC against a dummy value when none is live.
 */
import type { NormalisedEmail } from "../accounts/email.js";
import type { AppConfig } from "../config/parse.js";
import { emailId, hmacHex, type Subkeys, verifyHmacHex } from "../crypto/subkeys.js";
import type { OtpPurpose, Repositories, UserRecord } from "../db/repositories.js";
import type { Logger } from "../log.js";
import { checkLimits, type LimitCheck } from "./limits.js";

export const CODE_TTL_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 5;
export const MAX_LIVE_CHALLENGES = 3;

const CODE_SPACE = 100_000_000;
/** The largest multiple of 10^8 below 2^32: values at or above it are redrawn (no modulo bias). */
const ACCEPT_BELOW = Math.floor(2 ** 32 / CODE_SPACE) * CODE_SPACE;

/** An 8-digit code, uniform over 00000000–99999999 (CSPRNG with rejection sampling, 06 §3). */
export function generateCode(
  random: (buffer: Uint32Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b),
): string {
  const buffer = new Uint32Array(1);
  for (;;) {
    random(buffer);
    const value = buffer[0] ?? ACCEPT_BELOW;
    if (value < ACCEPT_BELOW) return String(value % CODE_SPACE).padStart(8, "0");
  }
}

/** `HMAC-SHA256(K_otp, challengeId ‖ code)` (06 §3). */
export function hashCode(keys: Subkeys, challengeId: string, code: string): Promise<string> {
  return hmacHex(keys.otp, `${challengeId}${code}`);
}

/** Strips the spaces and dashes people type or paste (06 §3.3). */
export function cleanCode(input: string): string {
  return input.replace(/[\s-]/gu, "");
}

/** What the caller knows about one request: the client's IP-bucket hashes. */
export interface RequestOrigin {
  /** HMACs (`ip/v1`) of the client's buckets, with each bucket's limit multiplier. */
  readonly ipBuckets: readonly { readonly hash: string; readonly multiplier: number }[];
}

export interface OtpDeps {
  readonly repos: Repositories;
  readonly config: AppConfig;
  readonly keys: Subkeys;
  readonly log: Logger;
  readonly now: number;
}

/** The decision for one code request, before anything is sent. */
export interface IssueOutcome {
  readonly kind: "ip-limited" | "accepted";
  /** The code to email, or the suspended notice; null when nothing may be sent. */
  readonly send:
    { readonly type: "code"; readonly code: string } | { readonly type: "suspended" } | null;
  readonly user: UserRecord | null;
}

/** Logs an instance-wide cap being exceeded: an alert (08 §4). */
function alertIfExceeded(
  log: Logger,
  results: readonly { name: string; exceeded: boolean }[],
): void {
  for (const result of results) {
    if (result.exceeded) log.error("instance-wide limit exceeded", { alert: result.name });
  }
}

/**
 * Handles `POST /auth/otp/request` (06 §3, §3.2). The steps and statements are the same on every
 * path; the flags decide whether a challenge is created, whether it can ever verify (`emailed`),
 * and what is sent.
 */
export async function issueSignInCode(
  deps: OtpDeps,
  email: NormalisedEmail,
  origin: RequestOrigin,
): Promise<IssueOutcome> {
  const { repos, config, keys, now } = deps;
  const [id, user] = await Promise.all([emailId(keys, email), repos.users.findByEmail(email)]);

  const ipChecks: LimitCheck[] = origin.ipBuckets.map((bucket) => ({
    name: "OTP_REQUEST_IP_HOUR",
    key: bucket.hash,
    amount: 1,
    multiplier: bucket.multiplier,
  }));
  const newAccountChecks: LimitCheck[] = origin.ipBuckets.map((bucket) => ({
    name: "NEW_ACCOUNTS_IP_DAY",
    key: bucket.hash,
    amount: 0,
    multiplier: bucket.multiplier,
  }));
  const results = await checkLimits(repos, config, now, [
    ...ipChecks,
    { name: "OTP_REQUEST_EMAIL_HOUR", key: id, amount: 1 },
    { name: "OTP_REQUEST_EMAIL_DAY", key: id, amount: 1 },
    ...newAccountChecks,
  ]);
  const ipLimited = results.slice(0, ipChecks.length).some((result) => result.exceeded);
  if (ipLimited) return { kind: "ip-limited", send: null, user };
  const emailLimited = results
    .slice(ipChecks.length, ipChecks.length + 2)
    .some((result) => result.exceeded);
  const newAccountLimited =
    user === null && results.slice(ipChecks.length + 2).some((result) => result.exceeded);
  const suspended = user?.suspendedAt != null;

  // Per-email limit: no challenge, nothing touched, nothing sent (06 §3). Unknown address from a
  // bucket over the new-accounts limit: a challenge that can never verify, nothing sent (§3.2).
  const create = !emailLimited;
  const wouldSend = create && !newAccountLimited;
  const global = await checkLimits(repos, config, now, [
    { name: "OTP_EMAIL_GLOBAL_HOUR", key: "all", amount: wouldSend ? 1 : 0 },
    { name: "OTP_EMAIL_GLOBAL_DAY", key: "all", amount: wouldSend ? 1 : 0 },
  ]);
  const globalCapped = wouldSend && global.some((result) => result.exceeded);
  if (wouldSend) alertIfExceeded(deps.log, global);
  const sends = wouldSend && !globalCapped;

  const challengeId = crypto.randomUUID();
  const code = generateCode();
  const codeHash = await hashCode(keys, challengeId, code);
  await repos.otp.issue(
    {
      id: challengeId,
      email,
      purpose: "signin",
      codeHash,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
      emailed: sends && !suspended ? 1 : 0,
    },
    { create, maxLive: MAX_LIVE_CHALLENGES, maxAttempts: MAX_ATTEMPTS },
  );
  await repos.authEvents.record({
    userId: user?.id ?? null,
    type: "otp_requested",
    ipHash: origin.ipBuckets[0]?.hash ?? null,
    createdAt: now,
  });
  const send = !sends
    ? null
    : suspended
      ? { type: "suspended" as const }
      : { type: "code" as const, code };
  return { kind: "accepted", send, user };
}

/**
 * Issues a purpose-bound step-up code for a signed-in user (06 §7). Rate-limited per user
 * (08 §4); the instance-wide OTP email cap applies as for sign-in.
 */
export async function issueStepUpCode(
  deps: OtpDeps,
  user: { readonly id: string; readonly email: NormalisedEmail },
  purpose: Exclude<OtpPurpose, "signin">,
): Promise<
  { readonly kind: "limited" } | { readonly kind: "issued"; readonly code: string | null }
> {
  const { repos, config, keys, now } = deps;
  const limits = await checkLimits(repos, config, now, [
    { name: "STEP_UP_USER_HOUR", key: user.id, amount: 1 },
    { name: "STEP_UP_USER_DAY", key: user.id, amount: 1 },
  ]);
  if (limits.some((result) => result.exceeded)) return { kind: "limited" };
  const global = await checkLimits(repos, config, now, [
    { name: "OTP_EMAIL_GLOBAL_HOUR", key: "all", amount: 1 },
    { name: "OTP_EMAIL_GLOBAL_DAY", key: "all", amount: 1 },
  ]);
  alertIfExceeded(deps.log, global);
  const sends = !global.some((result) => result.exceeded);
  const challengeId = crypto.randomUUID();
  const code = generateCode();
  await repos.otp.issue(
    {
      id: challengeId,
      email: user.email,
      purpose,
      codeHash: await hashCode(keys, challengeId, code),
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
      emailed: sends ? 1 : 0,
    },
    { create: true, maxLive: MAX_LIVE_CHALLENGES, maxAttempts: MAX_ATTEMPTS },
  );
  return { kind: "issued", code: sends ? code : null };
}

export type VerifyOutcome = "ok" | "invalid" | "limited";

/** A fixed challenge id for the dummy comparison when no challenge is live (06 §3.2). */
const DUMMY_HASH = "0".repeat(64);

/**
 * Checks a code against the live challenges of (email, purpose), newest first, each check
 * consuming one attempt on that challenge (06 §3, §3.1). Applies the per-IP verify limit and the
 * per-email failed-verify lockout; counts failures per email and instance-wide (with an alert).
 */
export async function verifyCode(
  deps: OtpDeps,
  email: NormalisedEmail,
  purpose: OtpPurpose,
  input: string,
  origin: RequestOrigin,
): Promise<VerifyOutcome> {
  const { repos, config, keys, now } = deps;
  const id = await emailId(keys, email);
  const gate = await checkLimits(repos, config, now, [
    ...origin.ipBuckets.map((bucket): LimitCheck => ({
      name: "OTP_VERIFY_IP_HOUR",
      key: bucket.hash,
      amount: 1,
      multiplier: bucket.multiplier,
    })),
    { name: "OTP_VERIFY_FAIL_EMAIL_HOUR", key: id, amount: 0 },
  ]);
  if (gate.some((result) => result.exceeded)) return "limited";

  const code = cleanCode(input);
  const live = await repos.otp.live(email, purpose, now, MAX_ATTEMPTS);
  let matched = false;
  if (live.length === 0) {
    await verifyHmacHex(keys.otp, `dummy${code}`, DUMMY_HASH);
  }
  for (const challengeId of live) {
    const attempt = await repos.otp.attempt(challengeId, now, MAX_ATTEMPTS);
    if (attempt === null) continue;
    // A never-emailed challenge still runs the comparison, then always fails (06 §3.1).
    const equal = await verifyHmacHex(keys.otp, `${challengeId}${code}`, attempt.codeHash);
    if (equal && attempt.emailed) {
      matched = await repos.otp.consume(challengeId, now);
      break;
    }
  }
  if (matched) return "ok";

  const failures = await checkLimits(repos, config, now, [
    { name: "OTP_VERIFY_FAIL_EMAIL_HOUR", key: id, amount: 1 },
    { name: "OTP_VERIFY_FAIL_GLOBAL_HOUR", key: "all", amount: 1 },
  ]);
  alertIfExceeded(deps.log, failures.slice(1));
  return "invalid";
}
