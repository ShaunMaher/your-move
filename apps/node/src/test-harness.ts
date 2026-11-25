/**
 * An in-process app on a real, migrated SQLite file, for the sign-in integration tests: a
 * controllable clock, client addresses through a trusted `X-Forwarded-For`, captured emails and
 * tracked background work. Test-only; never part of the build.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type CapturedEmail,
  createApp,
  createConsoleEmailSender,
  createJsonLogger,
  type EmailSender,
  type Env,
  parseConfig,
  type Platform,
  type Repositories,
} from "@your-move/server";

import { migrate } from "./db/migrate.js";
import { nodeRepositories, openSqlite } from "./db/sqlite.js";
import type { NodeConfig } from "./node-config.js";
import { createBackgroundTracker, createNodePlatform } from "./platform.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));

export const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const PROD_ENV: Env = {
  APP_NAME: "Family Games",
  PUBLIC_URL: "https://play.example.org",
  APP_SECRET: btoa("integration-tests-only-0123456789abcdef"),
  EMAIL_PROVIDER: "smtp",
  SMTP_URL: "smtp://mail.example.org:587",
  EMAIL_FROM: "no-reply@example.org",
  OPERATOR_CONTACT: "ops@example.org",
  ADMIN_EMAILS: "admin@example.org",
};

export const LOCAL_ENV: Env = {
  APP_NAME: "Family Games",
  PUBLIC_URL: "http://localhost:8080",
  APP_SECRET: "bG9jYWwtZGV2LW9ubHktbm90LWEtc2VjcmV0LWRvLW5vdC11c2U=",
  EMAIL_PROVIDER: "console",
  EMAIL_FROM: "no-reply@localhost",
  OPERATOR_CONTACT: "ops@localhost",
};

interface SendOptions {
  /** The client address (the rightmost `X-Forwarded-For` entry). Default `203.0.113.1`. */
  readonly ip?: string | null;
  /** A raw `X-Forwarded-For` value, overriding `ip`. */
  readonly xff?: string;
  /** The socket peer; default loopback (trusted). */
  readonly peer?: string;
  readonly cookie?: string | null;
  /** `Origin`; default the instance's own, `null` to omit. */
  readonly origin?: string | null;
  readonly headers?: Record<string, string>;
}

export interface Harness {
  readonly platform: Platform;
  readonly origin: string;
  /** Moves the clock. */
  advance(ms: number): void;
  setTime(ms: number): void;
  request(method: string, path: string, body?: unknown, options?: SendOptions): Promise<Response>;
  /** Captured emails, after all background work has finished. */
  emails(): Promise<readonly CapturedEmail[]>;
  /** The newest email to `to`, or undefined. */
  lastEmail(to: string): Promise<CapturedEmail | undefined>;
  /** Requests a sign-in code and returns it (from the captured email). */
  requestCode(email: string, options?: SendOptions): Promise<string>;
  /** Signs in and returns the cookie pair (`name=value`). */
  signIn(email: string, options?: SendOptions): Promise<string>;
  readonly logs: Record<string, unknown>[];
  /** Runs one SQL statement directly, for state no endpoint sets yet (e.g. suspension, M3). */
  exec(sql: string, ...params: (string | number | null)[]): void;
  close(): void;
}

/** The 8-digit code in a sign-in or step-up email's text. */
export function codeOf(email: CapturedEmail | undefined): string {
  const match = /(\d{4}) (\d{4})/u.exec(email?.text ?? "");
  if (match === null) throw new Error("no code in the email");
  return `${match[1] ?? ""}${match[2] ?? ""}`;
}

/** `name=value` of the session cookie a response sets. */
export function cookieOf(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  const pair = header.split(";")[0] ?? "";
  if (!pair.includes("=") || pair.endsWith("=")) throw new Error("no session cookie set");
  return pair;
}

export interface HarnessOptions {
  /** Proxy settings instead of the default `xff` from loopback. */
  readonly nodeConfig?: Pick<NodeConfig, "trustProxy" | "trustProxyHops" | "trustProxyPeers">;
  /** Wraps the repositories, e.g. to slow one path down in a test of the timing test itself. */
  readonly wrapRepos?: (repos: Repositories) => Repositories;
  /** Replaces the capturing email sender (e.g. one that fails). */
  readonly sender?: EmailSender;
}

export function createHarness(env: Env = PROD_ENV, options: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "auth-it-"));
  const sqlite = openSqlite(join(dir, "app.sqlite"));
  migrate(sqlite, MIGRATIONS);
  let clock = T0;
  const now = (): Date => new Date(clock);
  const logs: Record<string, unknown>[] = [];
  const log = createJsonLogger({
    level: "debug",
    now,
    sink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const config = parseConfig(env, { runtime: "node", installedGames: [] });
  const capture = createConsoleEmailSender(log, now);
  const platform = createNodePlatform({
    repos: (options.wrapRepos ?? ((repos) => repos))(nodeRepositories(sqlite)),
    config,
    nodeConfig: options.nodeConfig ?? {
      trustProxy: "xff",
      trustProxyHops: 1,
      trustProxyPeers: ["127.0.0.0/8"],
    },
    log,
    now,
    smtp: options.sender ?? capture,
  });
  const app = createApp({ platform, games: [] });
  const background = createBackgroundTracker();
  const origin = config.publicUrl;
  const captured = (): readonly CapturedEmail[] => (platform.email.captured ?? capture.captured)();

  const request: Harness["request"] = async (method, path, body, options = {}) => {
    const headers: Record<string, string> = { ...options.headers };
    const ip = options.ip === undefined ? "203.0.113.1" : options.ip;
    if (options.xff !== undefined) headers["X-Forwarded-For"] = options.xff;
    else if (ip !== null) headers["X-Forwarded-For"] = ip;
    if (options.origin !== null) headers["Origin"] = options.origin ?? origin;
    if (options.cookie) headers["Cookie"] = options.cookie;
    let payload: string | undefined;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] ??= "application/json";
    }
    return app.request(
      path,
      { method, headers, ...(payload === undefined ? {} : { body: payload }) },
      { incoming: { socket: { remoteAddress: options.peer ?? "127.0.0.1" } } },
      background.context(),
    );
  };

  const emails = async (): Promise<readonly CapturedEmail[]> => {
    await background.drain();
    return captured();
  };
  const lastEmail = async (to: string) => (await emails()).filter((e) => e.to === to).at(-1);

  const harness: Harness = {
    platform,
    origin,
    advance: (ms) => {
      clock += ms;
    },
    setTime: (ms) => {
      clock = ms;
    },
    request,
    emails,
    lastEmail,
    async requestCode(email, options) {
      // By identity, not index: the capture keeps only the newest 200 messages.
      const to = email.trim().toLowerCase();
      const before = new Set((await emails()).filter((e) => e.to === to));
      const response = await request("POST", "/api/v1/auth/otp/request", { email }, options);
      if (response.status !== 202) throw new Error(`request answered ${String(response.status)}`);
      const fresh = (await emails()).filter((e) => e.to === to && !before.has(e));
      return codeOf(fresh.at(-1));
    },
    async signIn(email, options) {
      const code = await harness.requestCode(email, options);
      const response = await request("POST", "/api/v1/auth/otp/verify", { email, code }, options);
      if (response.status !== 200) throw new Error(`verify answered ${String(response.status)}`);
      return cookieOf(response);
    },
    logs,
    exec(sql, ...params) {
      sqlite.prepare(sql).run(...params);
    },
    close() {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
