/**
 * The sign-in and account calls the app makes, each settled into a result the screens can show
 * without knowing HTTP: a network failure, a rate limit, a rejected input or success. Only the
 * typed API client is used (03 §1 principle 6). Nothing here distinguishes "this address has no
 * account" from anything else, because the API doesn't (06 §6.1).
 */
import type { ApiClient, Schema } from "@your-move/api-client";

import type { Theme } from "./theme.js";

export type Me = Schema<"Me">;
export type ClientConfig = Schema<"ClientConfig">;

export type Failure =
  | "offline" // the request never got an answer
  | "rate-limited" // 429
  | "invalid-code" // 400 INVALID_CODE (wrong, expired, used or unknown: indistinguishable)
  | "rejected" // any other 400: the input was refused
  | "unauthenticated" // 401: the session is gone
  | "failed"; // anything else

export type Outcome<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly failure: Failure };

interface Settled<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("error" in error)) return undefined;
  const inner = error.error;
  if (typeof inner !== "object" || inner === null || !("code" in inner)) return undefined;
  const { code } = inner;
  return typeof code === "string" ? code : undefined;
}

function classify(status: number, error: unknown): Failure {
  const code = errorCode(error);
  if (status === 429 || code === "RATE_LIMITED") return "rate-limited";
  if (code === "INVALID_CODE") return "invalid-code";
  if (status === 401) return "unauthenticated";
  if (status === 400) return "rejected";
  return "failed";
}

async function settle<T>(request: Promise<Settled<T>>): Promise<Outcome<T | undefined>> {
  try {
    const { data, error, response } = await request;
    if (response.ok) return { ok: true, data };
    return { ok: false, failure: classify(response.status, error) };
  } catch {
    return { ok: false, failure: "offline" };
  }
}

export async function loadConfig(api: ApiClient): Promise<Outcome<ClientConfig>> {
  const outcome = await settle(api.GET("/api/v1/config"));
  if (!outcome.ok) return outcome;
  return outcome.data === undefined
    ? { ok: false, failure: "failed" }
    : { ok: true, data: outcome.data };
}

/** `data` is null when nobody is signed in (401). */
export async function loadSession(api: ApiClient): Promise<Outcome<Me | null>> {
  const outcome = await settle(api.GET("/api/v1/me"));
  if (outcome.ok) {
    return outcome.data === undefined
      ? { ok: false, failure: "failed" }
      : { ok: true, data: outcome.data };
  }
  return outcome.failure === "unauthenticated" ? { ok: true, data: null } : outcome;
}

export async function requestCode(api: ApiClient, email: string): Promise<Outcome<unknown>> {
  return settle(api.POST("/api/v1/auth/otp/request", { body: { email } }));
}

export async function verifyCode(
  api: ApiClient,
  email: string,
  code: string,
): Promise<Outcome<Me>> {
  const outcome = await settle(api.POST("/api/v1/auth/otp/verify", { body: { email, code } }));
  if (!outcome.ok) return outcome;
  if (outcome.data === undefined) return { ok: false, failure: "failed" };
  return {
    ok: true,
    data: { ...outcome.data.user, needsOnboarding: outcome.data.needsOnboarding },
  };
}

/**
 * Onboarding's answers (06 §5): the display name, the age confirmation, or both; the server
 * completes onboarding once both are done.
 */
export async function saveOnboarding(
  api: ApiClient,
  answers: { readonly displayName?: string; readonly ageAttested?: true },
): Promise<Outcome<Me>> {
  const outcome = await settle(api.PATCH("/api/v1/me", { body: answers }));
  if (!outcome.ok) return outcome;
  return outcome.data === undefined
    ? { ok: false, failure: "failed" }
    : { ok: true, data: outcome.data };
}

/**
 * "I'm under MIN_AGE" (06 §5): the server deletes a new account, or signs a re-prompted one out
 * of this session; either way the session is over when it answers.
 */
export async function leaveUnderAge(api: ApiClient): Promise<Outcome<undefined>> {
  return settle(api.POST("/api/v1/me/under-age", { body: {} }));
}

/** Turns the "It's your turn" email nudges on or off (03 §7); answers the updated user. */
export async function saveEmailNudges(api: ApiClient, emailNudges: boolean): Promise<Outcome<Me>> {
  const outcome = await settle(api.PATCH("/api/v1/me", { body: { settings: { emailNudges } } }));
  if (!outcome.ok) return outcome;
  return outcome.data === undefined
    ? { ok: false, failure: "failed" }
    : { ok: true, data: outcome.data };
}

/** Sets the colour theme (07 §5); answers the updated user. */
export async function saveTheme(api: ApiClient, theme: Theme): Promise<Outcome<Me>> {
  const outcome = await settle(api.PATCH("/api/v1/me", { body: { settings: { theme } } }));
  if (!outcome.ok) return outcome;
  return outcome.data === undefined
    ? { ok: false, failure: "failed" }
    : { ok: true, data: outcome.data };
}

export async function signOut(api: ApiClient): Promise<Outcome<undefined>> {
  return settle(api.POST("/api/v1/auth/logout", { body: {} }));
}

export async function signOutEverywhere(
  api: ApiClient,
  revokeTokens: boolean,
): Promise<Outcome<undefined>> {
  return settle(api.POST("/api/v1/auth/logout-all", { body: { revokeTokens } }));
}
