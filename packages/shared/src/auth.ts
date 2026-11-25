/**
 * Sign-in and account endpoints (docs/spec/05-api.md §Auth & account, 06 §3–§5, §7). One schema
 * per endpoint; each operation's `x-scope` says which credential may call it (05 §Token scopes).
 */
import { createRoute, z } from "@hono/zod-openapi";

import { ErrorResponseSchema } from "./errors.js";
import { API_V1 } from "./routes.js";

const errorContent = { "application/json": { schema: ErrorResponseSchema } } as const;

/** Routes that need the session cookie (the `sessionCookie` scheme the server registers). */
const SESSION = [{ sessionCookie: [] }];

/** The session cookie's security scheme (06 §4), registered once by the server. */
export const SESSION_COOKIE_SCHEME = {
  type: "apiKey",
  in: "cookie",
  name: "__Host-sid",
  description:
    "The session cookie set by `POST /api/v1/auth/otp/verify` (`sid` in local-dev mode, 06 §4).",
} as const;

/** Error responses by status, each with the shared error body (05 §Errors). */
function errors<const T extends Readonly<Record<number, string>>>(
  descriptions: T,
): { [K in keyof T]: { description: string; content: typeof errorContent } } {
  return Object.fromEntries(
    Object.entries(descriptions).map(([status, description]) => [
      status,
      { description, content: errorContent },
    ]),
  ) as { [K in keyof T]: { description: string; content: typeof errorContent } };
}

const REQUEST_ERRORS = {
  400: "Invalid request (`BAD_REQUEST`).",
  413: "Body over 16 kB (`TOO_LARGE`).",
  415: "A body that isn't `application/json` (`UNSUPPORTED_MEDIA_TYPE`).",
  500: "Unexpected error.",
} as const;

const SESSION_ERRORS = {
  ...REQUEST_ERRORS,
  401: "No valid session (`UNAUTHENTICATED`).",
  403: "`BAD_ORIGIN` (cookie request without this instance's `Origin`), or `SUSPENDED`.",
} as const;

const EmailInput = z.string().max(320).openapi({
  description: "The address to sign in with. Normalised by the server.",
  example: "sam@example.org",
});

const CodeInput = z.string().max(32).openapi({
  description: "The 8-digit code from the email; spaces and dashes are ignored.",
  example: "1234 5678",
});

/** An empty JSON object, for endpoints that take no input (05 §Conventions). */
export const EmptyObjectSchema = z.object({}).strict().openapi("EmptyObject");

const jsonBody = <T extends z.ZodType>(schema: T, required = true) => ({
  required,
  content: { "application/json": { schema } },
});

const EmailNudgesSetting = z.boolean().openapi({
  description:
    'Email me "It\'s your turn" after a game has waited 24 hours for me, at most once a day per game (03 §7). Off by default.',
});

export const UserSettingsSchema = z
  .object({
    whoCanAddMe: z
      .enum(["pastOpponents", "nobody"])
      .openapi({ description: "Who can add me to games (06 §6.2)." }),
    emailNudges: EmailNudgesSetting,
  })
  .openapi("UserSettings");

/** The settings `PATCH /api/v1/me` changes: each key optional, only the keys given change. */
const UserSettingsPatchSchema = z
  .object({ emailNudges: EmailNudgesSetting.optional() })
  .strict()
  .openapi("UserSettingsPatch");

/** `GET /api/v1/me` and the `user` of a successful verify (05 §Auth & account). */
export const MeSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["human", "agent"]),
    email: z.string().nullable().openapi({ description: "Null for an AI account." }),
    displayName: z.string().nullable().openapi({ description: "Null until onboarding." }),
    settings: UserSettingsSchema,
    ageAttested: z
      .boolean()
      .openapi({ description: "Whether the age confirmation for the current MIN_AGE is given." }),
    needsOnboarding: z.boolean().openapi({
      description:
        "True until onboarding is complete (06 §5); gated endpoints answer 403 until then.",
    }),
    isAdmin: z
      .boolean()
      .openapi({ description: "Lets the client show admin links; grants nothing." }),
  })
  .strict()
  .openapi("Me");

export type Me = z.infer<typeof MeSchema>;

export const OtpRequestBodySchema = z.object({ email: EmailInput }).strict().openapi("OtpRequest");

export const otpRequestRoute = createRoute({
  operationId: "requestOtp",
  "x-scope": "public",
  method: "post",
  path: `${API_V1}/auth/otp/request`,
  tags: ["Auth"],
  summary: "Email a sign-in code",
  description:
    "Public. Always `202 {}`, whether or not the address has an account, is rate-limited or suspended (06 §3). Only a rate-limited client IP is reported (`429`).",
  request: { body: jsonBody(OtpRequestBodySchema) },
  responses: {
    202: {
      description: "Accepted; a code is emailed if the address may receive one.",
      content: { "application/json": { schema: EmptyObjectSchema } },
    },
    ...errors({
      ...REQUEST_ERRORS,
      400: "Invalid request or address (`BAD_REQUEST`), or a client IP is required but missing.",
      403: "`BAD_ORIGIN`.",
      429: "This client IP has made too many requests (`RATE_LIMITED`).",
    }),
  },
});

export const OtpVerifyBodySchema = z
  .object({ email: EmailInput, code: CodeInput })
  .strict()
  .openapi("OtpVerify");

export const OtpVerifyResponseSchema = z
  .object({ user: MeSchema, needsOnboarding: z.boolean() })
  .strict()
  .openapi("OtpVerifyResponse");

export const otpVerifyRoute = createRoute({
  operationId: "verifyOtp",
  "x-scope": "public",
  method: "post",
  path: `${API_V1}/auth/otp/verify`,
  tags: ["Auth"],
  summary: "Sign in with an emailed code",
  description:
    "Public. On success, creates the account if new, sets the session cookie and answers the user. A wrong, expired, consumed or unknown code is `400 INVALID_CODE`, indistinguishably (06 §3).",
  request: { body: jsonBody(OtpVerifyBodySchema) },
  responses: {
    200: {
      description: "Signed in; the response sets the session cookie.",
      headers: z.object({
        "Set-Cookie": z.string().openapi({
          description:
            "`__Host-sid=…; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000` (`sid` without `Secure` in local-dev mode, 06 §4).",
        }),
      }),
      content: { "application/json": { schema: OtpVerifyResponseSchema } },
    },
    ...errors({
      ...REQUEST_ERRORS,
      400: "`INVALID_CODE` or `BAD_REQUEST`.",
      403: "`BAD_ORIGIN`.",
      429: "Too many attempts for this address or client IP (`RATE_LIMITED`).",
    }),
  },
});

export const logoutRoute = createRoute({
  operationId: "logout",
  "x-scope": "session",
  security: SESSION,
  method: "post",
  path: `${API_V1}/auth/logout`,
  tags: ["Auth"],
  summary: "Sign out this session",
  description: "Session only. Deletes this session and clears the cookie.",
  request: { body: jsonBody(EmptyObjectSchema, false) },
  responses: {
    204: { description: "Signed out." },
    ...errors(SESSION_ERRORS),
  },
});

export const LogoutAllBodySchema = z
  .object({
    revokeTokens: z.boolean().optional().openapi({
      description: "Also revoke every API token of the user and their AI accounts (06 §4).",
    }),
  })
  .strict()
  .openapi("LogoutAll");

export const logoutAllRoute = createRoute({
  operationId: "logoutAll",
  "x-scope": "session",
  security: SESSION,
  method: "post",
  path: `${API_V1}/auth/logout-all`,
  tags: ["Auth"],
  summary: "Sign out everywhere",
  description: "Session only. Deletes every session of the user and clears the cookie.",
  request: { body: jsonBody(LogoutAllBodySchema, false) },
  responses: {
    204: { description: "Signed out everywhere." },
    ...errors(SESSION_ERRORS),
  },
});

export const getMeRoute = createRoute({
  operationId: "getMe",
  "x-scope": "read",
  security: SESSION,
  method: "get",
  path: `${API_V1}/me`,
  tags: ["Account"],
  summary: "The signed-in user",
  responses: {
    200: { description: "The user.", content: { "application/json": { schema: MeSchema } } },
    ...errors({
      400: "A session cookie and a bearer token together (`BAD_REQUEST`).",
      401: SESSION_ERRORS[401],
      403: "`SUSPENDED`.",
      500: "Unexpected error.",
    }),
  },
});

export const PatchMeBodySchema = z
  .object({
    displayName: z.string().max(256).optional().openapi({
      description:
        "1–24 characters; no links, addresses, long digit runs or reserved words (06 §5.1). Setting it completes onboarding.",
    }),
    settings: UserSettingsPatchSchema.optional(),
  })
  .strict()
  .openapi("PatchMe");

export const patchMeRoute = createRoute({
  operationId: "updateMe",
  "x-scope": "session",
  security: SESSION,
  method: "patch",
  path: `${API_V1}/me`,
  tags: ["Account"],
  summary: "Change the display name or settings; completes onboarding",
  description:
    "Session only. The first display name completes onboarding (06 §5). After onboarding, at most 3 changes per 30 days (`429`). `settings` changes only the keys given.",
  request: { body: jsonBody(PatchMeBodySchema) },
  responses: {
    200: {
      description: "The updated user.",
      content: { "application/json": { schema: MeSchema } },
    },
    ...errors({
      ...SESSION_ERRORS,
      400: "A display name breaking the rules, or an invalid request (`BAD_REQUEST`).",
      429: "Too many display-name changes (`RATE_LIMITED`).",
    }),
  },
});

export const deleteOtpRoute = createRoute({
  operationId: "requestDeleteAccountCode",
  "x-scope": "session",
  security: SESSION,
  method: "post",
  path: `${API_V1}/me/delete/otp`,
  tags: ["Account"],
  summary: "Email a code to delete the account",
  description: "Session only. Emails a `delete_account` step-up code (06 §7).",
  request: { body: jsonBody(EmptyObjectSchema, false) },
  responses: {
    202: {
      description: "Accepted; the code is emailed.",
      content: { "application/json": { schema: EmptyObjectSchema } },
    },
    ...errors({ ...SESSION_ERRORS, 429: "Too many step-up codes (`RATE_LIMITED`)." }),
  },
});

export const DeleteMeBodySchema = z.object({ code: CodeInput }).strict().openapi("DeleteMe");

export const deleteMeRoute = createRoute({
  operationId: "deleteMe",
  "x-scope": "session",
  security: SESSION,
  method: "delete",
  path: `${API_V1}/me`,
  tags: ["Account"],
  summary: "Delete the account",
  description:
    "Session only, with a fresh `delete_account` code (06 §7). Immediate and irreversible; clears the cookie and emails a confirmation.",
  request: { body: jsonBody(DeleteMeBodySchema) },
  responses: {
    204: { description: "The account is deleted." },
    ...errors({
      ...SESSION_ERRORS,
      400: "`INVALID_CODE` or `BAD_REQUEST`.",
      429: "Too many attempts (`RATE_LIMITED`).",
    }),
  },
});
