/**
 * Sessions (docs/spec/06-auth.md §4): a 256-bit random token in an `HttpOnly` cookie, stored only
 * as its SHA-256; sliding expiry 180 days since last use, refreshed at most hourly; an absolute
 * cap of 400 days. Local-dev mode uses the plain `sid` cookie without `Secure` (06 §4, 08 T19).
 */
import { toBase64Url } from "../base64.js";
import type {
  Repositories,
  SessionCutoffs,
  SessionRecord,
  UserRecord,
} from "../db/repositories.js";

const DAY = 86_400_000;
const SLIDING_EXPIRY_MS = 180 * DAY;
const ABSOLUTE_EXPIRY_MS = 400 * DAY;
const TOUCH_INTERVAL_MS = 3_600_000;
/** 400 days, the browser maximum (06 §4). */
const COOKIE_MAX_AGE_S = 34_560_000;

function cookieName(localDev: boolean): string {
  return localDev ? "sid" : "__Host-sid";
}

/** A fresh 256-bit session token. */
function newSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** SHA-256 of the token, hex: the only form stored (06 §4). */
async function hashSessionToken(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function sessionCookie(token: string, localDev: boolean): string {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${String(COOKIE_MAX_AGE_S)}`];
  if (!localDev) attributes.splice(1, 0, "Secure");
  return [`${cookieName(localDev)}=${token}`, ...attributes].join("; ");
}

export function clearedSessionCookie(localDev: boolean): string {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (!localDev) attributes.splice(1, 0, "Secure");
  return [`${cookieName(localDev)}=`, ...attributes].join("; ");
}

/** The session cookie's value from a `Cookie` header, if present. */
export function readSessionCookie(header: string | undefined, localDev: boolean): string | null {
  if (header === undefined) return null;
  const name = cookieName(localDev);
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = rest.join("=");
      return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : null;
    }
  }
  return null;
}

/** The sliding expiry after use at `now`, never past the absolute cap. */
function slidingExpiry(createdAt: number, now: number): number {
  return Math.min(now + SLIDING_EXPIRY_MS, createdAt + ABSOLUTE_EXPIRY_MS);
}

/**
 * What "live" means at `now` (06 §4): not past its sliding expiry and within the absolute cap. The
 * session check and every query that needs live sessions (push subscriptions, 03 §7) use it.
 */
export function liveSessionCutoffs(now: number): SessionCutoffs {
  return { expiresAfter: now, createdAfter: now - ABSOLUTE_EXPIRY_MS };
}

function isLive(session: SessionRecord, cutoffs: SessionCutoffs): boolean {
  return session.expiresAt > cutoffs.expiresAfter && session.createdAt > cutoffs.createdAfter;
}

export interface ActiveSession {
  readonly session: SessionRecord;
  readonly user: UserRecord;
}

/**
 * The live session for a cookie token, refreshing `last_seen_at` at most hourly. An expired
 * session is deleted and answers null.
 */
export async function loadSession(
  repos: Repositories,
  token: string,
  now: number,
  /** Runs the `last_seen_at` refresh in the background (`waitUntil`, 03 §11). */
  defer: (task: () => Promise<unknown>) => void,
): Promise<ActiveSession | null> {
  const found = await repos.sessions.findByTokenHash(await hashSessionToken(token));
  if (found === null) return null;
  const { session, user } = found;
  if (!isLive(session, liveSessionCutoffs(now))) {
    await repos.sessions.delete(user.id, session.id);
    return null;
  }
  if (now - session.lastSeenAt >= TOUCH_INTERVAL_MS) {
    const expiresAt = slidingExpiry(session.createdAt, now);
    defer(() => repos.sessions.touch(session.id, now, expiresAt));
    return { session: { ...session, lastSeenAt: now, expiresAt }, user };
  }
  return found;
}

/** Creates a session for a user and returns its token (the cookie value). */
export async function createSession(
  repos: Repositories,
  userId: string,
  now: number,
  userAgent: string | undefined,
): Promise<string> {
  const token = newSessionToken();
  await repos.sessions.create({
    id: crypto.randomUUID(),
    userId,
    tokenHash: await hashSessionToken(token),
    createdAt: now,
    lastSeenAt: now,
    expiresAt: slidingExpiry(now, now),
    userAgent: userAgent?.slice(0, 200) ?? null,
  });
  return token;
}
