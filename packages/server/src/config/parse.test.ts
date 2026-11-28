import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { LOCAL_ENV, PROD_ENV, TEST_VAPID } from "../test-support.js";
import { DEFAULT_APP_NAME } from "./defaults.js";
import { LOCAL_DEV_APP_SECRET } from "./local-dev.js";
import {
  ConfigError,
  parseConfig,
  redactSecrets,
  SECRET_VARIABLES,
  type Env,
  type ParseConfigOptions,
} from "./parse.js";

const NODE: ParseConfigOptions = { runtime: "node", installedGames: [] };
const GAMES: ParseConfigOptions = {
  runtime: "node",
  installedGames: [
    { type: "words", enabledByDefault: true },
    { type: "paths", enabledByDefault: true },
    { type: "example", enabledByDefault: false },
  ],
};

function issuesOf(env: Env, options: ParseConfigOptions = NODE): readonly string[] {
  try {
    parseConfig(env, options);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

const GMAIL_ENV: Env = {
  ...PROD_ENV,
  EMAIL_PROVIDER: "gmail",
  SMTP_URL: undefined,
  EMAIL_FROM: '"Example" <No-Reply@example.org>',
  GMAIL_CLIENT_ID: "client-id-value",
  GMAIL_CLIENT_SECRET: "client-secret-value",
  GMAIL_REFRESH_TOKEN: "refresh-token-value",
  GMAIL_SENDER: "no-reply@example.org",
};

describe("parseConfig: valid configurations", () => {
  it("applies the documented defaults", () => {
    const config = parseConfig(PROD_ENV, NODE);
    expect(config).toMatchObject({
      appName: DEFAULT_APP_NAME,
      appShortName: DEFAULT_APP_NAME,
      publicUrl: "https://play.example.org",
      minAge: 13,
      vapid: null,
      turnstile: null,
      enabledGames: [],
      adminEmails: [],
      dictionariesEnabled: null,
      dictionaryUploads: true,
      dictionariesExtra: [],
      logLevel: "info",
      limits: { DICT_TOTAL_BYTES: 2_147_483_648 },
      gameConfig: {},
    });
    expect(config.appSecret).toHaveLength(32);
    expect(config.email).toEqual({
      provider: "smtp",
      from: '"Example" <no-reply@example.org>',
      smtpUrl: "smtp://user:pass@mail.example.org:587",
    });
  });

  it("accepts local-dev mode with the console provider and the published dev secret", () => {
    const config = parseConfig(LOCAL_ENV, NODE);
    expect(config.email.provider).toBe("console");
    expect(config.publicUrl).toBe("http://localhost:8080");
  });

  it.each(["http://127.0.0.1:8080", "http://[::1]:8080", "http://localhost"])(
    "treats %s as local dev",
    (url) => {
      expect(issuesOf({ ...LOCAL_ENV, PUBLIC_URL: url })).toEqual([]);
    },
  );

  it("normalises PUBLIC_URL to its origin", () => {
    expect(
      parseConfig({ ...PROD_ENV, PUBLIC_URL: "https://Play.Example.org/" }, NODE).publicUrl,
    ).toBe("https://play.example.org");
  });

  it("reads optional values", () => {
    const config = parseConfig(
      {
        ...PROD_ENV,
        APP_NAME: "Family Games",
        APP_SHORT_NAME: "Games",
        MIN_AGE: "16",
        VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
        VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
        VAPID_SUBJECT: "mailto:ops@example.org",
        ADMIN_EMAILS: " Admin@Example.org ,other@example.org,admin@example.org",
        DICTIONARIES_ENABLED: "enable",
        DICTIONARY_UPLOADS: "false",
        DICTIONARIES_EXTRA: "nwl-2023,club-list",
        LOG_LEVEL: "debug",
        LIMIT_DICT_TOTAL_BYTES: "1000",
        GAMES_WORDS_DEFAULT_RULESET: "casual",
        GAMES_WORDS_ENABLED_RULESETS: "classic,casual",
        ENABLED_GAMES: "words",
      },
      GAMES,
    );
    expect(config).toMatchObject({
      appName: "Family Games",
      appShortName: "Games",
      minAge: 16,
      vapid: {
        publicKey: TEST_VAPID.publicKey,
        privateKey: TEST_VAPID.privateKey,
        subject: "mailto:ops@example.org",
      },
      turnstile: null,
      adminEmails: ["admin@example.org", "other@example.org"],
      dictionariesEnabled: ["enable"],
      dictionaryUploads: false,
      dictionariesExtra: ["nwl-2023", "club-list"],
      logLevel: "debug",
      limits: { DICT_TOTAL_BYTES: 1000 },
      gameConfig: { words: { DEFAULT_RULESET: "casual", ENABLED_RULESETS: "classic,casual" } },
      enabledGames: ["words"],
    });
  });

  it("enables installed games not marked enabled: false by default", () => {
    expect(parseConfig(PROD_ENV, GAMES).enabledGames).toEqual(["words", "paths"]);
  });

  it("treats empty values as unset", () => {
    expect(
      parseConfig({ ...PROD_ENV, APP_NAME: "", MIN_AGE: "", PRIVACY_RETENTION: "" }, NODE),
    ).toMatchObject({ appName: DEFAULT_APP_NAME, minAge: 13, privacyRetention: null });
  });

  it("counts PRIVACY_RETENTION in code points, not UTF-16 units (A21-P-14)", () => {
    // 1000 emoji are 2000 UTF-16 units: still within the limit; one more is over it.
    const emoji = "🙂".repeat(1000);
    expect(parseConfig({ ...PROD_ENV, PRIVACY_RETENTION: emoji }, NODE).privacyRetention).toBe(
      emoji,
    );
    expect(() => parseConfig({ ...PROD_ENV, PRIVACY_RETENTION: `${emoji}🙂` }, NODE)).toThrow(
      /PRIVACY_RETENTION: must be at most 1000 characters/u,
    );
  });

  it("keeps PRIVACY_RETENTION as written, up to 1000 characters", () => {
    const text = "Logs are kept 14 days. ".repeat(43).slice(0, 1000);
    expect(parseConfig({ ...PROD_ENV, PRIVACY_RETENTION: text }, NODE).privacyRetention).toBe(text);
  });

  it("accepts gmail when GMAIL_SENDER equals the EMAIL_FROM address", () => {
    const config = parseConfig(GMAIL_ENV, NODE);
    expect(config.email).toMatchObject({ provider: "gmail", sender: "no-reply@example.org" });
  });

  it.each(["resend", "postmark", "ses"])("accepts %s with an API key", (provider) => {
    const config = parseConfig(
      { ...PROD_ENV, EMAIL_PROVIDER: provider, EMAIL_API_KEY: "api-key-value" },
      NODE,
    );
    expect(config.email).toMatchObject({ provider, apiKey: "api-key-value" });
  });

  it("accepts the cloudflare email provider on Cloudflare", () => {
    const config = parseConfig(
      { ...PROD_ENV, EMAIL_PROVIDER: "cloudflare" },
      { runtime: "cloudflare", installedGames: [] },
    );
    expect(config.email.provider).toBe("cloudflare");
  });
});

describe("parseConfig: invalid configurations", () => {
  it.each<[string, Env, string, ParseConfigOptions?]>([
    ["missing PUBLIC_URL", { ...PROD_ENV, PUBLIC_URL: undefined }, "PUBLIC_URL: is required"],
    ["missing APP_SECRET", { ...PROD_ENV, APP_SECRET: undefined }, "APP_SECRET: is required"],
    ["missing EMAIL_FROM", { ...PROD_ENV, EMAIL_FROM: undefined }, "EMAIL_FROM: is required"],
    [
      "missing OPERATOR_CONTACT",
      { ...PROD_ENV, OPERATOR_CONTACT: undefined },
      "OPERATOR_CONTACT: is required",
    ],
    [
      "unknown EMAIL_PROVIDER",
      { ...PROD_ENV, EMAIL_PROVIDER: "pigeon" },
      "EMAIL_PROVIDER: is required and must be one of",
    ],
    [
      "relative PUBLIC_URL",
      { ...PROD_ENV, PUBLIC_URL: "play.example.org" },
      "PUBLIC_URL: must be an absolute URL",
    ],
    [
      "http PUBLIC_URL off localhost",
      { ...PROD_ENV, PUBLIC_URL: "http://play.example.org" },
      "PUBLIC_URL: must use https",
    ],
    [
      "PUBLIC_URL with a path",
      { ...PROD_ENV, PUBLIC_URL: "https://example.org/play" },
      "PUBLIC_URL: must be an origin",
    ],
    [
      "PUBLIC_URL with credentials",
      { ...PROD_ENV, PUBLIC_URL: "https://u:p@example.org" },
      "PUBLIC_URL: must not contain credentials",
    ],
    [
      "short APP_SECRET",
      { ...PROD_ENV, APP_SECRET: btoa("too short") },
      "APP_SECRET: must be base64 of at least 32",
    ],
    [
      "non-base64 APP_SECRET",
      { ...PROD_ENV, APP_SECRET: "not base64 at all!".repeat(4) },
      "APP_SECRET: must be base64",
    ],
    [
      "dev secret in production",
      { ...PROD_ENV, APP_SECRET: LOCAL_DEV_APP_SECRET },
      "APP_SECRET: the published local-dev secret",
    ],
    [
      "console outside local dev",
      { ...PROD_ENV, EMAIL_PROVIDER: "console" },
      "EMAIL_PROVIDER: console is allowed only in local-dev mode",
    ],
    [
      "malformed EMAIL_FROM",
      { ...PROD_ENV, EMAIL_FROM: "not an address" },
      "EMAIL_FROM: must be an address",
    ],
    [
      "non-ASCII EMAIL_FROM",
      { ...PROD_ENV, EMAIL_FROM: "ü@example.org" },
      "EMAIL_FROM: the address must be one mail can be sent to and from",
    ],
    [
      "EMAIL_FROM with consecutive dots",
      { ...PROD_ENV, EMAIL_FROM: "Example <a..b@example.org>" },
      "EMAIL_FROM: the address must be one mail can be sent to and from",
    ],
    [
      "EMAIL_FROM with a numeric top-level label",
      { ...PROD_ENV, EMAIL_FROM: "a@127.0.0.1" },
      "EMAIL_FROM: the address must be one mail can be sent to and from",
    ],
    [
      "EMAIL_FROM with a line break",
      { ...PROD_ENV, EMAIL_FROM: "a@example.org\r\nBcc: x@example.org" },
      "EMAIL_FROM: must be an address",
    ],
    [
      "smtp without SMTP_URL",
      { ...PROD_ENV, SMTP_URL: undefined },
      "SMTP_URL: is required when EMAIL_PROVIDER is smtp",
    ],
    [
      "smtp with a bad URL",
      { ...PROD_ENV, SMTP_URL: "https://mail.example.org" },
      "SMTP_URL: must be an smtp:// or smtps:// URL",
    ],
    [
      "smtp on Cloudflare",
      PROD_ENV,
      "EMAIL_PROVIDER: smtp is available only on the Node runtime",
      { runtime: "cloudflare", installedGames: [] },
    ],
    [
      "cloudflare email on Node",
      { ...PROD_ENV, EMAIL_PROVIDER: "cloudflare" },
      "EMAIL_PROVIDER: cloudflare is available only on the Cloudflare runtime",
    ],
    [
      "resend without a key",
      { ...PROD_ENV, EMAIL_PROVIDER: "resend" },
      "EMAIL_API_KEY: is required when EMAIL_PROVIDER is resend",
    ],
    [
      "gmail without a refresh token",
      { ...GMAIL_ENV, GMAIL_REFRESH_TOKEN: undefined },
      "GMAIL_REFRESH_TOKEN: is required when EMAIL_PROVIDER is gmail",
    ],
    [
      "gmail sender mismatch",
      { ...GMAIL_ENV, GMAIL_SENDER: "admin@example.org" },
      "GMAIL_SENDER: must equal the address in EMAIL_FROM",
    ],
    [
      "gmail sender malformed",
      { ...GMAIL_ENV, GMAIL_SENDER: "Admin <admin@example.org>" },
      "GMAIL_SENDER: must be a plain email address",
    ],
    ["partial VAPID", { ...PROD_ENV, VAPID_PUBLIC_KEY: "k" }, "set all three to enable push"],
    [
      "bad VAPID_SUBJECT",
      {
        ...PROD_ENV,
        VAPID_PUBLIC_KEY: TEST_VAPID.publicKey,
        VAPID_PRIVATE_KEY: TEST_VAPID.privateKey,
        VAPID_SUBJECT: "ops@example.org",
      },
      "VAPID_SUBJECT: must be a mailto: or https:// URL",
    ],
    [
      "VAPID keys not a P-256 pair",
      {
        ...PROD_ENV,
        VAPID_PUBLIC_KEY: "k",
        VAPID_PRIVATE_KEY: "p",
        VAPID_SUBJECT: "mailto:ops@example.org",
      },
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: must be an unpadded base64url P-256 key pair",
    ],
    [
      "VAPID keys swapped",
      {
        ...PROD_ENV,
        VAPID_PUBLIC_KEY: TEST_VAPID.privateKey,
        VAPID_PRIVATE_KEY: TEST_VAPID.publicKey,
        VAPID_SUBJECT: "mailto:ops@example.org",
      },
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY: must be an unpadded base64url P-256 key pair",
    ],
    ["partial Turnstile", { ...PROD_ENV, TURNSTILE_SITE_KEY: "k" }, "set both to enable Turnstile"],
    [
      "Turnstile before enforcement exists (M2b review S-3)",
      { ...PROD_ENV, TURNSTILE_SITE_KEY: "k", TURNSTILE_SECRET: "s" },
      "Turnstile enforcement is not built yet",
    ],
    [
      "MIN_AGE below 13",
      { ...PROD_ENV, MIN_AGE: "12" },
      "MIN_AGE: must be a whole number of at least 13",
    ],
    [
      "PRIVACY_RETENTION over 1000 characters",
      { ...PROD_ENV, PRIVACY_RETENTION: "a".repeat(1001) },
      "PRIVACY_RETENTION: must be at most 1000 characters",
    ],
    [
      "PRIVACY_RETENTION with a control character",
      { ...PROD_ENV, PRIVACY_RETENTION: "Logs 14 days.\nBackups 30." },
      "PRIVACY_RETENTION: must not contain control characters",
    ],
    [
      "MIN_AGE not a number",
      { ...PROD_ENV, MIN_AGE: "thirteen" },
      "MIN_AGE: must be a whole number",
    ],
    [
      "ENABLED_GAMES bad id",
      { ...PROD_ENV, ENABLED_GAMES: "Words" },
      "ENABLED_GAMES: each entry must match",
    ],
    [
      "ENABLED_GAMES not installed",
      { ...PROD_ENV, ENABLED_GAMES: "words,chess" },
      'ENABLED_GAMES: "chess" is not an installed game type',
      GAMES,
    ],
    [
      "ADMIN_EMAILS malformed",
      { ...PROD_ENV, ADMIN_EMAILS: "admin" },
      "ADMIN_EMAILS: each entry must be an email address sign-in accepts",
    ],
    [
      "ADMIN_EMAILS an address sign-in would refuse (M2b review P-15)",
      { ...PROD_ENV, ADMIN_EMAILS: "admin@localhost" },
      "ADMIN_EMAILS: each entry must be an email address sign-in accepts",
    ],
    [
      "DICTIONARIES_EXTRA bad id",
      { ...PROD_ENV, DICTIONARIES_EXTRA: "u_123" },
      "DICTIONARIES_EXTRA: each entry must match",
    ],
    [
      "DICTIONARY_UPLOADS not boolean",
      { ...PROD_ENV, DICTIONARY_UPLOADS: "yes" },
      "DICTIONARY_UPLOADS: must be true or false",
    ],
    ["LOG_LEVEL unknown", { ...PROD_ENV, LOG_LEVEL: "trace" }, "LOG_LEVEL: must be one of"],
    [
      "LIMIT_ not a number",
      { ...PROD_ENV, LIMIT_DICT_TOTAL_BYTES: "lots" },
      "LIMIT_DICT_TOTAL_BYTES: must be a positive whole number",
    ],
    [
      "LIMIT_ zero",
      { ...PROD_ENV, LIMIT_DICT_TOTAL_BYTES: "0" },
      "LIMIT_DICT_TOTAL_BYTES: must be a positive whole number",
    ],
    [
      "LIMIT_ with an unknown name",
      { ...PROD_ENV, LIMIT_MOVES_PER_MINUTE: "60" },
      "LIMIT_MOVES_PER_MINUTE: not a known limit",
    ],
    ["LIMIT_ with a malformed name", { ...PROD_ENV, LIMIT_: "60" }, "LIMIT_: not a known limit"],
    [
      "GAMES_ for an unknown type",
      { ...PROD_ENV, GAMES_CHESS_X: "1" },
      'GAMES_CHESS_X: "chess" is not an installed game type',
      GAMES,
    ],
    [
      "GAMES_ malformed",
      { ...PROD_ENV, GAMES_WORDS: "1" },
      "GAMES_WORDS: must be GAMES_<TYPE>_<KEY>",
      GAMES,
    ],
    [
      "APP_NAME with a control character",
      { ...PROD_ENV, APP_NAME: "Games\n" },
      "APP_NAME: must not contain control characters",
    ],
  ])("%s", (_label, env, expected, options = NODE) => {
    const issues = issuesOf(env, options);
    expect(
      issues.some((issue) => issue.includes(expected)),
      issues.join("\n"),
    ).toBe(true);
  });

  it("reports every invalid variable at once", () => {
    const issues = issuesOf({ PUBLIC_URL: "https://example.org" });
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^APP_SECRET: /u),
        expect.stringMatching(/^EMAIL_PROVIDER: /u),
        expect.stringMatching(/^EMAIL_FROM: /u),
        expect.stringMatching(/^OPERATOR_CONTACT: /u),
      ]),
    );
  });

  it("puts every issue in the error message", () => {
    expect(() => parseConfig({}, NODE)).toThrow(/Invalid configuration:\n {2}- /u);
  });
});

describe("parseConfig: the outbound email budget (08 §4.2)", () => {
  it("accepts gmail's defaults: 2 × (500 + 100 + 150) = 1,500 in any 24 hours, under 2,000", () => {
    expect(issuesOf(GMAIL_ENV)).toEqual([]);
  });

  it.each<[string, Env, string]>([
    ["sign-in codes", { LIMIT_OTP_EMAIL_GLOBAL_DAY: "751" }, "751 + 100 + 150"],
    ["invite emails", { LIMIT_INVITE_EMAILS_GLOBAL_DAY: "351" }, "500 + 351 + 150"],
    ["nudges", { LIMIT_NUDGE_EMAILS_PER_DAY: "401" }, "500 + 100 + 401"],
  ])("refuses gmail when raising %s takes twice the sum past 2,000", (_label, raised, sum) => {
    const [otp = "", invites = "", nudges = ""] = sum.split(" + ");
    expect(issuesOf({ ...GMAIL_ENV, ...raised })).toEqual([
      `LIMIT_OTP_EMAIL_GLOBAL_DAY=${otp}, LIMIT_INVITE_EMAILS_GLOBAL_DAY=${invites}, ` +
        `LIMIT_NUDGE_EMAILS_PER_DAY=${nudges}: they can send W = 2 × (${sum}) = 2002 in some 24 ` +
        "hours, more than EMAIL_DAILY_QUOTA 2000 (gmail default); lower them, or set " +
        "EMAIL_DAILY_QUOTA to the provider's real limit (docs/spec/08-security.md §4.2)",
    ]);
  });

  it("treats the budget's variables given empty (as the tunnel compose file does) as unset", () => {
    const empty = {
      EMAIL_DAILY_QUOTA: "",
      LIMIT_OTP_EMAIL_GLOBAL_DAY: "",
      LIMIT_INVITE_EMAILS_GLOBAL_DAY: "",
      LIMIT_NUDGE_EMAILS_PER_DAY: "",
    };
    expect(issuesOf({ ...GMAIL_ENV, ...empty })).toEqual([]);
    expect(parseConfig({ ...GMAIL_ENV, ...empty }, NODE).limits).toEqual({
      DICT_TOTAL_BYTES: 2_147_483_648,
    });
    // The gmail default still applies: an empty quota isn't "no quota".
    expect(issuesOf({ ...GMAIL_ENV, ...empty, LIMIT_OTP_EMAIL_GLOBAL_DAY: "751" })).toHaveLength(1);
  });

  it("accepts gmail at exactly the quota", () => {
    expect(issuesOf({ ...GMAIL_ENV, LIMIT_OTP_EMAIL_GLOBAL_DAY: "750" })).toEqual([]);
  });

  it("judges an explicit EMAIL_DAILY_QUOTA, e.g. a Workspace trial's 500, and names it", () => {
    const trial = { ...GMAIL_ENV, EMAIL_DAILY_QUOTA: "500" };
    expect(issuesOf(trial)).toEqual([
      expect.stringContaining("W = 2 × (500 + 100 + 150) = 1500 in some 24 hours"),
    ]);
    expect(issuesOf(trial)[0]).toContain("more than EMAIL_DAILY_QUOTA 500 (set)");
    expect(
      issuesOf({
        ...trial,
        LIMIT_OTP_EMAIL_GLOBAL_DAY: "150",
        LIMIT_INVITE_EMAILS_GLOBAL_DAY: "50",
        LIMIT_NUDGE_EMAILS_PER_DAY: "50",
      }),
    ).toEqual([]);
    // A larger plan lets the caps go up with it.
    expect(
      issuesOf({ ...GMAIL_ENV, EMAIL_DAILY_QUOTA: "10000", LIMIT_OTP_EMAIL_GLOBAL_DAY: "4000" }),
    ).toEqual([]);
  });

  it("checks nothing for a provider with no known quota and EMAIL_DAILY_QUOTA unset", () => {
    expect(issuesOf({ ...PROD_ENV, LIMIT_OTP_EMAIL_GLOBAL_DAY: "100000" })).toEqual([]);
    expect(issuesOf({ ...LOCAL_ENV, LIMIT_NUDGE_EMAILS_PER_DAY: "100000" })).toEqual([]);
  });

  it("checks another provider against the EMAIL_DAILY_QUOTA it is given", () => {
    expect(issuesOf({ ...PROD_ENV, EMAIL_DAILY_QUOTA: "1499" })).toEqual([
      expect.stringContaining("= 1500 in some 24 hours, more than EMAIL_DAILY_QUOTA 1499 (set)"),
    ]);
    expect(issuesOf({ ...PROD_ENV, EMAIL_DAILY_QUOTA: "1500" })).toEqual([]);
  });

  it.each(["0", "-1", "2k", "1.5", " 2000"])("refuses EMAIL_DAILY_QUOTA=%j", (value) => {
    expect(issuesOf({ ...PROD_ENV, EMAIL_DAILY_QUOTA: value })).toEqual([
      "EMAIL_DAILY_QUOTA: must be a positive whole number",
    ]);
  });

  it("reports an invalid cap on its own and judges the budget on the valid ones", () => {
    expect(issuesOf({ ...GMAIL_ENV, LIMIT_OTP_EMAIL_GLOBAL_DAY: "lots" })).toEqual([
      "LIMIT_OTP_EMAIL_GLOBAL_DAY: must be a positive whole number",
    ]);
  });
});

describe("secret redaction", () => {
  const secretValue = fc
    .string({ minLength: 8, maxLength: 40 })
    .filter((value) => value.trim() !== "" && !"[redacted]".includes(value));

  it("never includes a secret's value in any configuration error", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SECRET_VARIABLES),
        secretValue,
        fc.constantFrom<Env>(
          {},
          PROD_ENV,
          { ...PROD_ENV, EMAIL_PROVIDER: "gmail" },
          { ...PROD_ENV, PUBLIC_URL: "http://example.org" },
        ),
        (name, value, base) => {
          const env = { ...base, [name]: value };
          let message = "";
          try {
            parseConfig(env, NODE);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
          expect(message).not.toContain(value);
        },
      ),
    );
  });

  it("replaces secret values wherever they occur", () => {
    const env = { APP_SECRET: "super-secret-value", EMAIL_API_KEY: "abc" };
    expect(redactSecrets("x super-secret-value y abc", env)).toBe("x [redacted] y abc");
  });
});
