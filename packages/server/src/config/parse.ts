import { isGameType } from "@your-move/sdk";
import { z } from "zod";

import { DEFAULT_APP_NAME } from "./defaults.js";
import { isEmailAddress, normaliseEmail, parseMailbox } from "./email.js";
import { isLocalDevUrl, LOCAL_DEV_APP_SECRET } from "./local-dev.js";

/**
 * Variables holding secrets (docs/spec/09-operations.md §1). Their values never appear in any
 * error, and on Node each may be supplied as a file through `<NAME>_FILE`.
 */
export const SECRET_VARIABLES = [
  "APP_SECRET",
  "EMAIL_API_KEY",
  "SMTP_URL",
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "GMAIL_REFRESH_TOKEN",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "TURNSTILE_SECRET",
] as const;

const EMAIL_PROVIDERS = [
  "gmail",
  "smtp",
  "resend",
  "postmark",
  "ses",
  "cloudflare",
  "console",
] as const;

const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type Runtime = "node" | "cloudflare";

export type EmailConfig =
  | { readonly provider: "console"; readonly from: string }
  | { readonly provider: "smtp"; readonly from: string; readonly smtpUrl: string }
  | {
      readonly provider: "gmail";
      readonly from: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly refreshToken: string;
      readonly sender: string;
    }
  | {
      readonly provider: "resend" | "postmark" | "ses";
      readonly from: string;
      readonly apiKey: string;
    }
  | { readonly provider: "cloudflare"; readonly from: string };

/** The validated framework configuration (09 §1). Node-only variables are parsed by `apps/node`. */
export interface AppConfig {
  readonly appName: string;
  readonly appShortName: string;
  /** The canonical origin, e.g. `https://play.example.org` (no trailing slash). */
  readonly publicUrl: string;
  /** `APP_SECRET`, decoded: the root of every HKDF subkey (09 §1.1). */
  readonly appSecret: Uint8Array;
  readonly email: EmailConfig;
  readonly vapid: {
    readonly publicKey: string;
    readonly privateKey: string;
    readonly subject: string;
  } | null;
  readonly operatorContact: string;
  readonly minAge: number;
  readonly turnstile: { readonly siteKey: string; readonly secret: string } | null;
  /** `LIMIT_*` overrides, keyed by the name after the prefix, e.g. `DICT_TOTAL_BYTES`. */
  readonly limits: Readonly<Record<string, number>>;
  /** Game types offered for new games (`ENABLED_GAMES`, or the instance default). */
  readonly enabledGames: readonly string[];
  /** Normalised admin addresses; empty disables the Admin API. */
  readonly adminEmails: readonly string[];
  /** Built-in dictionary ids offered for new games; `null` means all bundled ones. */
  readonly dictionariesEnabled: readonly string[] | null;
  readonly dictionaryUploads: boolean;
  readonly dictionariesExtra: readonly string[];
  readonly logLevel: LogLevel;
  /** `GAMES_<TYPE>_*` module config: type → key (prefix stripped) → raw value (02 §2.1 rule 8). */
  readonly gameConfig: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** An installed game type as the config parser needs it (from the generated registry). */
export interface InstalledGameType {
  readonly type: string;
  readonly enabledByDefault: boolean;
}

export interface ParseConfigOptions {
  /** `smtp` works on Node only; the `cloudflare` provider needs a Workers binding. */
  readonly runtime: Runtime;
  readonly installedGames: readonly InstalledGameType[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Thrown when configuration is invalid. `issues` name the variable and rule, never a value. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.issues = issues;
  }
}

const DEFAULT_LIMIT_DICT_TOTAL_BYTES = 2_147_483_648;
const DICTIONARY_ID = /^[a-z][a-z0-9-]{1,31}$/u;
const NO_CONTROL_CHARS = /^[^\p{Cc}]+$/u;
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]{0,15}$/u;
const LIMIT_NAME = /^LIMIT_([A-Z][A-Z0-9_]*)$/u;
/**
 * The limits an operator may override (`LIMIT_<NAME>`, 09 §1). An unknown name refuses to start,
 * like an unknown `GAMES_<TYPE>_*`, so a typo never silently leaves a limit at its default. The
 * rate limits of 08 §4 add their names here with the rate limiter (M2).
 */
const KNOWN_LIMITS: ReadonlySet<string> = new Set(["DICT_TOTAL_BYTES"]);
const GAMES_NAME = /^GAMES_([A-Z][A-Z0-9]*)_([A-Z0-9_]+)$/u;

function required(message = "is required") {
  return z.string({ error: message }).min(1, { error: message });
}

const text = z.string().regex(NO_CONTROL_CHARS, { error: "must not contain control characters" });

function list(value: string | undefined): string[] | null {
  if (value === undefined) return null;
  return value.split(",").map((item) => item.trim());
}

function decodeBase64(value: string): Uint8Array | null {
  if (!STRICT_BASE64.test(value)) return null;
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Every variable the framework reads, as raw strings. Unknown variables are ignored. */
const envSchema = z.looseObject({
  APP_NAME: text.optional(),
  APP_SHORT_NAME: text.optional(),
  PUBLIC_URL: required(),
  APP_SECRET: required(),
  EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS, {
    error: `is required and must be one of ${EMAIL_PROVIDERS.join(", ")}`,
  }),
  EMAIL_FROM: required(),
  EMAIL_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
  GMAIL_CLIENT_ID: z.string().optional(),
  GMAIL_CLIENT_SECRET: z.string().optional(),
  GMAIL_REFRESH_TOKEN: z.string().optional(),
  GMAIL_SENDER: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  OPERATOR_CONTACT: required().pipe(text),
  MIN_AGE: z
    .string()
    .regex(POSITIVE_INTEGER, { error: "must be a whole number of at least 13" })
    .optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),
  ENABLED_GAMES: z.string().optional(),
  ADMIN_EMAILS: z.string().optional(),
  DICTIONARIES_ENABLED: z.string().optional(),
  DICTIONARY_UPLOADS: z.enum(["true", "false"], { error: "must be true or false" }).optional(),
  DICTIONARIES_EXTRA: z.string().optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(", ")}` }).optional(),
});

type RawEnv = z.infer<typeof envSchema>;

/** Cross-variable rules, reported as `NAME: rule`. */
function crossFieldIssues(raw: RawEnv, options: ParseConfigOptions): string[] {
  const issues: string[] = [];
  const localDev = isLocalDevUrl(raw.PUBLIC_URL);

  let url: URL | null = null;
  try {
    url = new URL(raw.PUBLIC_URL);
  } catch {
    issues.push("PUBLIC_URL: must be an absolute URL such as https://play.example.org");
  }
  if (url) {
    if (url.protocol !== "https:" && !localDev) {
      issues.push(
        "PUBLIC_URL: must use https (plain http is allowed only for http://localhost, http://127.0.0.1 or http://[::1])",
      );
    }
    if (url.username !== "" || url.password !== "") {
      issues.push("PUBLIC_URL: must not contain credentials");
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      issues.push("PUBLIC_URL: must be an origin with no path, query or fragment");
    }
  }

  const secret = decodeBase64(raw.APP_SECRET);
  if (!secret || secret.length < 32) {
    issues.push("APP_SECRET: must be base64 of at least 32 random bytes");
  } else if (raw.APP_SECRET === LOCAL_DEV_APP_SECRET && !localDev) {
    issues.push("APP_SECRET: the published local-dev secret may only be used in local-dev mode");
  }

  const from = parseMailbox(raw.EMAIL_FROM);
  if (!from) {
    issues.push('EMAIL_FROM: must be an address or "Name" <address>, on one line');
  }

  switch (raw.EMAIL_PROVIDER) {
    case "console":
      if (!localDev) {
        issues.push(
          "EMAIL_PROVIDER: console is allowed only in local-dev mode (PUBLIC_URL http://localhost)",
        );
      }
      break;
    case "smtp":
      if (options.runtime !== "node") {
        issues.push("EMAIL_PROVIDER: smtp is available only on the Node runtime");
      }
      if (raw.SMTP_URL === undefined) {
        issues.push("SMTP_URL: is required when EMAIL_PROVIDER is smtp");
      } else if (!/^smtps?:\/\/[^\s]+$/u.test(raw.SMTP_URL)) {
        issues.push("SMTP_URL: must be an smtp:// or smtps:// URL");
      }
      break;
    case "gmail":
      for (const name of [
        "GMAIL_CLIENT_ID",
        "GMAIL_CLIENT_SECRET",
        "GMAIL_REFRESH_TOKEN",
        "GMAIL_SENDER",
      ] as const) {
        if (raw[name] === undefined) {
          issues.push(`${name}: is required when EMAIL_PROVIDER is gmail`);
        }
      }
      if (raw.GMAIL_SENDER !== undefined) {
        if (!isEmailAddress(raw.GMAIL_SENDER)) {
          issues.push("GMAIL_SENDER: must be a plain email address");
        } else if (from && normaliseEmail(raw.GMAIL_SENDER) !== normaliseEmail(from.address)) {
          issues.push("GMAIL_SENDER: must equal the address in EMAIL_FROM");
        }
      }
      break;
    case "resend":
    case "postmark":
    case "ses":
      if (raw.EMAIL_API_KEY === undefined) {
        issues.push(`EMAIL_API_KEY: is required when EMAIL_PROVIDER is ${raw.EMAIL_PROVIDER}`);
      }
      break;
    case "cloudflare":
      if (options.runtime !== "cloudflare") {
        issues.push("EMAIL_PROVIDER: cloudflare is available only on the Cloudflare runtime");
      }
      break;
  }

  const vapid = [raw.VAPID_PUBLIC_KEY, raw.VAPID_PRIVATE_KEY, raw.VAPID_SUBJECT];
  if (vapid.some((value) => value !== undefined) && vapid.some((value) => value === undefined)) {
    issues.push(
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT: set all three to enable push, or none",
    );
  }
  if (raw.VAPID_SUBJECT !== undefined && !/^(mailto:|https:\/\/)\S+$/u.test(raw.VAPID_SUBJECT)) {
    issues.push("VAPID_SUBJECT: must be a mailto: or https:// URL");
  }

  if ((raw.TURNSTILE_SITE_KEY === undefined) !== (raw.TURNSTILE_SECRET === undefined)) {
    issues.push("TURNSTILE_SITE_KEY, TURNSTILE_SECRET: set both to enable Turnstile, or neither");
  }

  if (raw.MIN_AGE !== undefined && Number(raw.MIN_AGE) < 13) {
    issues.push("MIN_AGE: must be a whole number of at least 13");
  }

  const installed = new Set(options.installedGames.map((game) => game.type));
  for (const type of list(raw.ENABLED_GAMES) ?? []) {
    if (!isGameType(type)) {
      issues.push("ENABLED_GAMES: each entry must match ^[a-z][a-z0-9]{1,31}$");
    } else if (!installed.has(type)) {
      issues.push(`ENABLED_GAMES: "${type}" is not an installed game type`);
    }
  }

  for (const address of list(raw.ADMIN_EMAILS) ?? []) {
    if (!isEmailAddress(address)) {
      issues.push("ADMIN_EMAILS: each entry must be a plain email address");
    }
  }

  for (const name of ["DICTIONARIES_ENABLED", "DICTIONARIES_EXTRA"] as const) {
    for (const id of list(raw[name]) ?? []) {
      if (!DICTIONARY_ID.test(id)) {
        issues.push(`${name}: each entry must match ^[a-z][a-z0-9-]{1,31}$`);
      }
    }
  }

  for (const [name, value] of Object.entries(raw)) {
    if (name.startsWith("LIMIT_")) {
      const limit = LIMIT_NAME.exec(name)?.[1];
      if (limit === undefined || !KNOWN_LIMITS.has(limit)) {
        issues.push(
          `${name}: not a known limit (the LIMIT_* names are listed in docs/spec/09-operations.md §1)`,
        );
      } else if (!POSITIVE_INTEGER.test(String(value))) {
        issues.push(`${name}: must be a positive whole number`);
      }
    }
    if (name.startsWith("GAMES_")) {
      const match = GAMES_NAME.exec(name);
      const type = match?.[1]?.toLowerCase();
      if (type === undefined || !isGameType(type)) {
        issues.push(`${name}: must be GAMES_<TYPE>_<KEY> for an installed game type`);
      } else if (!installed.has(type)) {
        issues.push(`${name}: "${type}" is not an installed game type`);
      }
    }
  }

  return [...new Set(issues)];
}

/** Placeholder for values the cross-variable rules have already proven present. */
function checked(value: string | undefined): string {
  return value ?? "";
}

function toConfig(raw: RawEnv, options: ParseConfigOptions): AppConfig {
  const appName = raw.APP_NAME ?? DEFAULT_APP_NAME;
  // Validated by crossFieldIssues before this runs.
  const from = parseMailbox(raw.EMAIL_FROM)?.address ?? raw.EMAIL_FROM;
  const fromHeader = raw.EMAIL_FROM.trim();
  const email = ((): EmailConfig => {
    switch (raw.EMAIL_PROVIDER) {
      case "console":
      case "cloudflare":
        return { provider: raw.EMAIL_PROVIDER, from: fromHeader };
      case "smtp":
        return { provider: "smtp", from: fromHeader, smtpUrl: checked(raw.SMTP_URL) };
      case "gmail":
        return {
          provider: "gmail",
          from: fromHeader,
          clientId: checked(raw.GMAIL_CLIENT_ID),
          clientSecret: checked(raw.GMAIL_CLIENT_SECRET),
          refreshToken: checked(raw.GMAIL_REFRESH_TOKEN),
          sender: normaliseEmail(raw.GMAIL_SENDER ?? from),
        };
      case "resend":
      case "postmark":
      case "ses":
        return {
          provider: raw.EMAIL_PROVIDER,
          from: fromHeader,
          apiKey: checked(raw.EMAIL_API_KEY),
        };
    }
  })();

  const limits: Record<string, number> = { DICT_TOTAL_BYTES: DEFAULT_LIMIT_DICT_TOTAL_BYTES };
  const gameConfig: Record<string, Record<string, string>> = {};
  for (const [name, value] of Object.entries(raw)) {
    const limit = LIMIT_NAME.exec(name);
    if (limit?.[1] !== undefined) limits[limit[1]] = Number(value);
    const game = GAMES_NAME.exec(name);
    if (game?.[1] !== undefined && game[2] !== undefined) {
      const type = game[1].toLowerCase();
      gameConfig[type] = { ...gameConfig[type], [game[2]]: String(value) };
    }
  }

  const enabledGames =
    list(raw.ENABLED_GAMES) ??
    options.installedGames.filter((game) => game.enabledByDefault).map((game) => game.type);

  return {
    appName,
    appShortName: raw.APP_SHORT_NAME ?? appName,
    publicUrl: new URL(raw.PUBLIC_URL).origin,
    appSecret: decodeBase64(raw.APP_SECRET) ?? new Uint8Array(),
    email,
    vapid:
      raw.VAPID_PUBLIC_KEY !== undefined &&
      raw.VAPID_PRIVATE_KEY !== undefined &&
      raw.VAPID_SUBJECT !== undefined
        ? {
            publicKey: raw.VAPID_PUBLIC_KEY,
            privateKey: raw.VAPID_PRIVATE_KEY,
            subject: raw.VAPID_SUBJECT,
          }
        : null,
    operatorContact: raw.OPERATOR_CONTACT,
    minAge: raw.MIN_AGE === undefined ? 13 : Number(raw.MIN_AGE),
    turnstile:
      raw.TURNSTILE_SITE_KEY !== undefined && raw.TURNSTILE_SECRET !== undefined
        ? { siteKey: raw.TURNSTILE_SITE_KEY, secret: raw.TURNSTILE_SECRET }
        : null,
    limits,
    enabledGames: [...new Set(enabledGames)],
    adminEmails: [...new Set((list(raw.ADMIN_EMAILS) ?? []).map(normaliseEmail))],
    dictionariesEnabled: list(raw.DICTIONARIES_ENABLED),
    dictionaryUploads: raw.DICTIONARY_UPLOADS !== "false",
    dictionariesExtra: list(raw.DICTIONARIES_EXTRA) ?? [],
    logLevel: raw.LOG_LEVEL ?? "info",
    gameConfig,
  };
}

/** Replaces every secret value that occurs in `text` (belt and braces: no message embeds one). */
export function redactSecrets(text: string, env: Env): string {
  let result = text;
  const secrets = SECRET_VARIABLES.map((name) => env[name]).filter(
    (value): value is string => value !== undefined && value.length >= 4,
  );
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[redacted]");
  }
  return result;
}

/**
 * The one configuration schema (09 §1): per-variable rules, then cross-variable rules (which run
 * only when every variable is individually valid), then the transformation into {@link AppConfig}.
 * Cross-variable issues carry their variable names in the message and an empty path.
 */
function configSchema(options: ParseConfigOptions) {
  return envSchema
    .superRefine((raw, ctx) => {
      for (const message of crossFieldIssues(raw, options)) {
        ctx.addIssue({ code: "custom", message, path: [] });
      }
    })
    .transform((raw) => toConfig(raw, options));
}

/**
 * Parses and validates the configuration. Empty values count as unset. Throws
 * {@link ConfigError} naming each bad variable and rule; no message ever contains a secret's
 * value.
 */
export function parseConfig(env: Env, options: ParseConfigOptions): AppConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ""),
  );
  const result = configSchema(options).safeParse(present);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => {
    const name = issue.path[0];
    const message = typeof name === "string" ? `${name}: ${issue.message}` : issue.message;
    return redactSecrets(message, env);
  });
  throw new ConfigError([...new Set(issues)]);
}
