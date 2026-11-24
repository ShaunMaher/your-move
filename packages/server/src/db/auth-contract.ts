/**
 * The sign-in half of the repository contract suite (docs/spec/03-architecture.md §4, 06 §3.1):
 * OTP challenges, sessions, rate limits and account deletion, run against every adapter. Includes
 * the M2 race test: 50 attempts fired in parallel at one challenge are counted atomically on both
 * drivers (10 M2).
 */
import { describe, expect, it } from "vitest";

import { type NormalisedEmail, normaliseAddress } from "../accounts/email.js";
import type { NewOtpChallenge, Repositories } from "./repositories.js";

const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

/** A fresh normalised address. */
export function address(local: string = crypto.randomUUID()): NormalisedEmail {
  const email = normaliseAddress(`${local}@example.org`);
  if (email === null) throw new Error("test address is invalid");
  return email;
}

function challenge(email: NormalisedEmail, overrides: Partial<NewOtpChallenge> = {}) {
  return {
    id: crypto.randomUUID(),
    email,
    purpose: "signin" as const,
    codeHash: "hash",
    createdAt: T0,
    expiresAt: T0 + 10 * MINUTE,
    emailed: 1,
    ...overrides,
  };
}

const ISSUE = { create: true, maxLive: 3, maxAttempts: 5 } as const;

async function newUser(repos: Repositories): Promise<{ id: string; email: NormalisedEmail }> {
  const id = crypto.randomUUID();
  const email = address(id);
  await repos.users.create({ id, email, createdAt: T0, updatedAt: T0 });
  return { id, email };
}

export function authRepositoryContract(repos: () => Repositories): void {
  describe("users (sign-in)", () => {
    it("createOrGetByEmail creates once and then returns the same row", async () => {
      const email = address();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          repos().users.createOrGetByEmail({
            id: crypto.randomUUID(),
            email,
            createdAt: T0,
            updatedAt: T0,
          }),
        ),
      );
      expect(new Set(results.map((user) => user.id)).size).toBe(1);
      expect(results[0]?.email).toBe(email);
    });

    it("update sets the display name and onboarding time", async () => {
      const user = await newUser(repos());
      await repos().users.update(user.id, {
        displayName: "Sam",
        onboardedAt: T0 + 1,
        updatedAt: T0 + 1,
      });
      expect(await repos().users.findById(user.id)).toMatchObject({
        displayName: "Sam",
        onboardedAt: T0 + 1,
        updatedAt: T0 + 1,
      });
    });

    it("deleteAccount removes the user, sessions and challenges, and is safe to repeat", async () => {
      const user = await newUser(repos());
      const tokenHash = crypto.randomUUID();
      await repos().sessions.create({
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash,
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + MINUTE,
      });
      await repos().otp.issue(challenge(user.email), ISSUE);
      const event = {
        userId: user.id,
        type: "account_deleted",
        ipHash: null,
        createdAt: T0,
      } as const;
      await repos().users.deleteAccount(user, event);
      await repos().users.deleteAccount(user, event);
      expect(await repos().users.findById(user.id)).toBeNull();
      expect(await repos().sessions.findByTokenHash(tokenHash)).toBeNull();
      expect(await repos().otp.live(user.email, "signin", T0, 5)).toEqual([]);
    });
  });

  describe("otp challenges", () => {
    it("keeps at most 3 live challenges: issuing a 4th burns the oldest", async () => {
      const email = address();
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const next = challenge(email, { createdAt: T0 + i });
        ids.push(next.id);
        await repos().otp.issue(next, ISSUE);
      }
      expect(await repos().otp.live(email, "signin", T0 + 4, 5)).toEqual([ids[3], ids[2], ids[1]]);
    });

    it("orders challenges issued in the same millisecond by insertion", async () => {
      const email = address();
      const first = challenge(email);
      const second = challenge(email);
      await repos().otp.issue(first, ISSUE);
      await repos().otp.issue(second, ISSUE);
      expect(await repos().otp.live(email, "signin", T0, 5)).toEqual([second.id, first.id]);
    });

    it("with create false inserts nothing and touches no existing challenge", async () => {
      const email = address();
      const kept = [challenge(email), challenge(email), challenge(email)];
      for (const one of kept) await repos().otp.issue(one, ISSUE);
      await repos().otp.issue(challenge(email), { ...ISSUE, create: false });
      const live = await repos().otp.live(email, "signin", T0, 5);
      expect(new Set(live)).toEqual(new Set(kept.map((one) => one.id)));
    });

    it("keeps purposes apart", async () => {
      const email = address();
      await repos().otp.issue(challenge(email, { purpose: "delete_account" }), ISSUE);
      expect(await repos().otp.live(email, "signin", T0, 5)).toEqual([]);
      expect(await repos().otp.live(email, "delete_account", T0, 5)).toHaveLength(1);
    });

    it("an expired challenge is neither live nor attemptable", async () => {
      const email = address();
      const one = challenge(email);
      await repos().otp.issue(one, ISSUE);
      const expired = T0 + 10 * MINUTE;
      expect(await repos().otp.live(email, "signin", expired, 5)).toEqual([]);
      expect(await repos().otp.attempt(one.id, expired, 5)).toBeNull();
    });

    it("counts attempts, returns the hash and emailed flag, and burns after 5", async () => {
      const email = address();
      const one = challenge(email, { emailed: 0, codeHash: "abc" });
      await repos().otp.issue(one, ISSUE);
      for (let i = 0; i < 5; i++) {
        expect(await repos().otp.attempt(one.id, T0, 5)).toEqual({
          codeHash: "abc",
          emailed: false,
        });
      }
      expect(await repos().otp.attempt(one.id, T0, 5)).toBeNull();
      expect(await repos().otp.live(email, "signin", T0, 5)).toEqual([]);
    });

    it("consumes once", async () => {
      const one = challenge(address());
      await repos().otp.issue(one, ISSUE);
      const results = await Promise.all([1, 2, 3].map(() => repos().otp.consume(one.id, T0)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await repos().otp.attempt(one.id, T0, 5)).toBeNull();
    });

    it("50 parallel attempts at one challenge: exactly 5 are counted, 1 consume wins (06 §3.1)", async () => {
      const one = challenge(address());
      await repos().otp.issue(one, ISSUE);
      const results = await Promise.all(
        Array.from({ length: 50 }, () => repos().otp.attempt(one.id, T0, 5)),
      );
      expect(results.filter((result) => result !== null)).toHaveLength(5);
      const consumed = await Promise.all(
        Array.from({ length: 50 }, () => repos().otp.consume(one.id, T0)),
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
    });
  });

  describe("sessions", () => {
    it("creates, finds with its user, touches and deletes, scoped by user", async () => {
      const user = await newUser(repos());
      const other = await newUser(repos());
      const session = {
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: crypto.randomUUID(),
        createdAt: T0,
        lastSeenAt: T0,
        expiresAt: T0 + MINUTE,
        userAgent: "test",
      };
      await repos().sessions.create(session);
      const found = await repos().sessions.findByTokenHash(session.tokenHash);
      expect(found?.session).toEqual(session);
      expect(found?.user.id).toBe(user.id);
      await repos().sessions.touch(session.id, T0 + 5, T0 + 10);
      expect((await repos().sessions.findByTokenHash(session.tokenHash))?.session).toMatchObject({
        lastSeenAt: T0 + 5,
        expiresAt: T0 + 10,
      });
      await repos().sessions.delete(other.id, session.id);
      expect(await repos().sessions.findByTokenHash(session.tokenHash)).not.toBeNull();
      await repos().sessions.delete(user.id, session.id);
      expect(await repos().sessions.findByTokenHash(session.tokenHash)).toBeNull();
    });

    it("deleteAll removes every session of one user only", async () => {
      const user = await newUser(repos());
      const other = await newUser(repos());
      const owners = [user.id, user.id, other.id];
      const hashes = owners.map(() => crypto.randomUUID());
      for (const [i, tokenHash] of hashes.entries()) {
        await repos().sessions.create({
          id: crypto.randomUUID(),
          userId: owners[i] ?? user.id,
          tokenHash,
          createdAt: T0,
          lastSeenAt: T0,
          expiresAt: T0 + MINUTE,
        });
      }
      await repos().sessions.deleteAll(user.id);
      const left = await Promise.all(hashes.map((hash) => repos().sessions.findByTokenHash(hash)));
      expect(left.map((row) => row !== null)).toEqual([false, false, true]);
    });
  });

  describe("rate limits", () => {
    it("adds to the current window atomically and reads the previous one", async () => {
      const key = `test:${crypto.randomUUID()}`;
      await repos().rateLimits.hit([{ key, windowStart: 0, previousWindowStart: -1, amount: 3 }]);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          repos().rateLimits.hit([{ key, windowStart: 1, previousWindowStart: 0, amount: 1 }]),
        ),
      );
      const currents = results.map((result) => result[0]?.current ?? 0).sort((a, b) => a - b);
      expect(currents).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      expect(results.every((result) => result[0]?.previous === 3)).toBe(true);
      const [peek] = await repos().rateLimits.hit([
        { key, windowStart: 1, previousWindowStart: 0, amount: 0 },
      ]);
      expect(peek).toEqual({ current: 20, previous: 3 });
    });

    it("answers several counters in one call, in order", async () => {
      const a = `test:${crypto.randomUUID()}`;
      const b = `test:${crypto.randomUUID()}`;
      const counts = await repos().rateLimits.hit([
        { key: a, windowStart: 5, previousWindowStart: 4, amount: 2 },
        { key: b, windowStart: 5, previousWindowStart: 4, amount: 0 },
      ]);
      expect(counts).toEqual([
        { current: 2, previous: 0 },
        { current: 0, previous: 0 },
      ]);
    });
  });

  describe("auth events and tokens", () => {
    it("records an event and revokes tokens", async () => {
      const user = await newUser(repos());
      await repos().authEvents.record({
        userId: user.id,
        type: "signed_in",
        ipHash: "ip",
        createdAt: T0,
      });
      await expect(repos().apiTokens.revokeAll(user.id, T0)).resolves.toBeUndefined();
    });
  });
}
