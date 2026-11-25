/** Helpers shared by this package's tests. Not exported from the package. */
import type { Platform } from "./app.js";
import { resolveClientIp } from "./auth/client-ip.js";
import { LOCAL_DEV_APP_SECRET } from "./config/local-dev.js";
import { parseConfig, type Env } from "./config/parse.js";
import { detachedRepositories } from "./db/detached.js";
import { createConsoleEmailSender } from "./email/sender.js";
import { NO_DICTIONARIES } from "./games/resources.js";
import { createJsonLogger } from "./log.js";
import { DISABLED_PUSH_SENDER } from "./push/sender.js";

/** A minimal valid local-dev environment. */
export const LOCAL_ENV: Env = {
  PUBLIC_URL: "http://localhost:8080",
  APP_SECRET: LOCAL_DEV_APP_SECRET,
  EMAIL_PROVIDER: "console",
  EMAIL_FROM: "no-reply@localhost",
  OPERATOR_CONTACT: "ops@localhost",
};

/** A minimal valid production-like environment (all values are test fixtures). */
export const PROD_ENV: Env = {
  PUBLIC_URL: "https://play.example.org",
  APP_SECRET: btoa("0123456789abcdef0123456789abcdef"),
  EMAIL_PROVIDER: "smtp",
  SMTP_URL: "smtp://user:pass@mail.example.org:587",
  EMAIL_FROM: '"Example" <no-reply@example.org>',
  OPERATOR_CONTACT: "ops@example.org",
};

/**
 * A VAPID key pair for tests: RFC 8291 Appendix A's application server keys, published in the RFC
 * and never used by any deployment.
 */
export const TEST_VAPID = {
  publicKey:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  privateKey: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
} as const;

export interface TestPlatform extends Platform {
  /** Every log line written, parsed. */
  readonly lines: Record<string, unknown>[];
}

export function testPlatform(env: Env = LOCAL_ENV): TestPlatform {
  const lines: Record<string, unknown>[] = [];
  const now = (): Date => new Date(Date.UTC(2026, 0, 1));
  const log = createJsonLogger({
    level: "debug",
    now,
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    repos: detachedRepositories(),
    config: parseConfig(env, { runtime: "node", installedGames: [] }),
    log,
    email: createConsoleEmailSender(log, now),
    push: DISABLED_PUSH_SENDER,
    clientIp: (request) =>
      resolveClientIp(request.headers, {
        mode: "xff",
        socketAddress: null,
        hops: 1,
        trustedPeers: [],
      }),
    dictionaries: NO_DICTIONARIES,
    now,
    lines,
  };
}
