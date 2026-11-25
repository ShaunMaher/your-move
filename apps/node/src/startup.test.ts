import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, GmailTokenRefused, type Installed } from "@your-move/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lockPath } from "./db/instance-lock.js";
import { SecretFileError } from "./env.js";
import { isRefusal, startup, verifyEmail } from "./startup.js";

const MIGRATIONS = fileURLToPath(new URL("../../../packages/server/migrations", import.meta.url));
/** Every committed migration: a new database applies them all. */
const KNOWN = (
  JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as {
    entries: unknown[];
  }
).entries.length;
const INSTALLED: Installed = {};

let dir: string;
let databasePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "startup-"));
  databasePath = join(dir, "data", "app.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = {
  PUBLIC_URL: "https://play.example.org",
  APP_SECRET: btoa("0123456789abcdef0123456789abcdef"),
  EMAIL_PROVIDER: "smtp",
  SMTP_URL: "smtp://mail.example.org:587",
  EMAIL_FROM: "no-reply@example.org",
  OPERATOR_CONTACT: "ops@example.org",
};

function noFiles(): string {
  throw new Error("no secret files in this test");
}

describe("startup (02 §7.3, M2a review S-6)", () => {
  it.each([
    ["an invalid framework variable", { ...VALID, PUBLIC_URL: "ftp://x" }, ConfigError],
    ["an invalid Node variable", { ...VALID, PORT: "0" }, ConfigError],
    ["an unreadable secret file", { ...VALID, APP_SECRET_FILE: "/nope" }, SecretFileError],
  ])("refuses %s before touching the database", async (_name, env, kind) => {
    const start = startup({
      env: { ...env, DATABASE_PATH: databasePath },
      readFile: noFiles,
      installed: INSTALLED,
      migrationsFolder: MIGRATIONS,
    });
    await expect(start).rejects.toThrow(kind);
    await start.catch((error: unknown) => {
      expect(isRefusal(error)).toBe(true);
    });
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(lockPath(databasePath))).toBe(false);
  });

  it("validates, then migrates, with secret files resolved", async () => {
    const { APP_SECRET, ...rest } = VALID;
    const started = await startup({
      env: { ...rest, APP_SECRET_FILE: "/run/secrets/app", DATABASE_PATH: databasePath },
      readFile: (path) => (path === "/run/secrets/app" ? `${APP_SECRET}\n` : noFiles()),
      installed: INSTALLED,
      migrationsFolder: MIGRATIONS,
    });
    expect(started.env["APP_SECRET"]).toBe(APP_SECRET);
    expect(started.storage.migrations).toEqual({ applied: KNOWN, known: KNOWN });
    started.storage.close();
  });

  it("refuses a relative DATABASE_PATH outside local-dev mode", async () => {
    await expect(
      startup({
        env: { ...VALID, DATABASE_PATH: "data/app.sqlite" },
        readFile: noFiles,
        installed: INSTALLED,
        migrationsFolder: MIGRATIONS,
      }),
    ).rejects.toThrow("DATABASE_PATH: must be an absolute file path");
  });

  it("treats other errors as crashes, not refusals", () => {
    expect(isRefusal(new Error("boom"))).toBe(false);
  });
});

describe("verifyEmail (09 §2)", () => {
  const sender = { send: () => Promise.resolve() };

  it("passes providers without a check and a token that checks out", async () => {
    await expect(verifyEmail(sender)).resolves.toBeUndefined();
    await expect(
      verifyEmail({ ...sender, verifyCredentials: () => Promise.resolve() }),
    ).resolves.toBeUndefined();
  });

  it("refuses to start for a token that isn't send-only or isn't the sender's", async () => {
    const refusal = verifyEmail({
      ...sender,
      verifyCredentials: () => Promise.reject(new GmailTokenRefused("wrong scope")),
    });
    await expect(refusal).rejects.toThrow("wrong scope (09 §2)");
    await refusal.catch((error: unknown) => {
      expect(isRefusal(error)).toBe(true);
    });
  });

  it("passes other failures through", async () => {
    await expect(
      verifyEmail({ ...sender, verifyCredentials: () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow("boom");
  });
});
