/**
 * The push subscription half of the repository contract suite (docs/spec/04-data-model.md
 * `push_subscriptions`, alpha A8): the upsert bound to a session and its checks when an endpoint
 * changes hands, the per-user cap with the least useful evicted, removal, delivery marks, live
 * sessions only, and the cascade from sessions, run against every adapter. The database is
 * shared with other tests, so every check looks only at its own rows.
 */
import { describe, expect, it } from "vitest";

import { liveSessionCutoffs } from "../auth/session.js";
import { address } from "./auth-contract.js";
import type { NewPushSubscription, Repositories } from "./repositories.js";

const T0 = Date.UTC(2026, 0, 1);
const DAY = 86_400_000;
const MAX = 10;
/** What the session check calls live at T0. */
const LIVE = liveSessionCutoffs(T0);
const RULES = { maxPerUser: MAX, live: LIVE };

interface PushTarget {
  readonly repos: Repositories;
  sql(statement: string, ...params: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

export function pushRepositoryContract(target: () => PushTarget): void {
  const repos = (): Repositories => target().repos;

  async function user(): Promise<string> {
    const id = crypto.randomUUID();
    await repos().users.create({ id, email: address(id), createdAt: T0, updatedAt: T0 });
    return id;
  }

  async function session(
    userId: string,
    times: { createdAt: number; expiresAt: number } = { createdAt: T0, expiresAt: T0 + DAY },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await repos().sessions.create({
      id,
      userId,
      tokenHash: crypto.randomUUID(),
      lastSeenAt: times.createdAt,
      ...times,
    });
    return id;
  }

  function subscription(
    userId: string,
    sessionId: string,
    overrides: Partial<NewPushSubscription> = {},
  ): NewPushSubscription {
    return {
      id: crypto.randomUUID(),
      userId,
      sessionId,
      endpoint: `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`,
      p256dh: "p256dh",
      auth: "auth",
      createdAt: T0,
      ...overrides,
    };
  }

  const endpointsOf = async (userId: string): Promise<string[]> =>
    (await repos().pushSubscriptions.forUsers([userId], LIVE)).map((row) => row.endpoint).sort();

  describe("push subscriptions (04, alpha A8)", () => {
    it("saves a subscription and lists it for its user only", async () => {
      const [alice, bob] = [await user(), await user()];
      const saved = subscription(alice, await session(alice));
      await repos().pushSubscriptions.save(saved, RULES);
      expect(await repos().pushSubscriptions.forUsers([alice], LIVE)).toEqual([
        { ...saved, lastSuccessAt: null },
      ]);
      expect(await repos().pushSubscriptions.forUsers([bob], LIVE)).toEqual([]);
      expect(await repos().pushSubscriptions.forUsers([], LIVE)).toEqual([]);
    });

    it("updates in place when the same session saves it again, keeping its history", async () => {
      const alice = await user();
      const sessionId = await session(alice);
      const first = subscription(alice, sessionId);
      await repos().pushSubscriptions.save(first, RULES);
      await repos().pushSubscriptions.delivered([first.id], T0 + 5);
      await repos().pushSubscriptions.save(
        subscription(alice, sessionId, {
          endpoint: first.endpoint,
          p256dh: "new",
          auth: "new",
          createdAt: T0 + 9,
        }),
        RULES,
      );
      expect(await repos().pushSubscriptions.forUsers([alice], LIVE)).toEqual([
        { ...first, p256dh: "new", auth: "new", lastSuccessAt: T0 + 5 },
      ]);
    });

    it("moves to the same user's new session only with the same keys (A8-S-1)", async () => {
      const alice = await user();
      const first = subscription(alice, await session(alice));
      await repos().pushSubscriptions.save(first, RULES);
      await repos().pushSubscriptions.delivered([first.id], T0 + 5);
      const later = await session(alice);
      await repos().pushSubscriptions.save(
        subscription(alice, later, {
          endpoint: first.endpoint,
          p256dh: "other",
          createdAt: T0 + 9,
        }),
        RULES,
      );
      expect(await repos().pushSubscriptions.forUsers([alice], LIVE)).toEqual([
        { ...first, lastSuccessAt: T0 + 5 },
      ]);
      await repos().pushSubscriptions.save(
        subscription(alice, later, { endpoint: first.endpoint, createdAt: T0 + 9 }),
        RULES,
      );
      expect(await repos().pushSubscriptions.forUsers([alice], LIVE)).toEqual([
        { ...first, sessionId: later, lastSuccessAt: T0 + 5 },
      ]);
    });

    it("moves to another user only with the same keys, starting afresh (A8-S-1)", async () => {
      const [alice, bob] = [await user(), await user()];
      const first = subscription(alice, await session(alice));
      await repos().pushSubscriptions.save(first, RULES);
      await repos().pushSubscriptions.delivered([first.id], T0 + 5);
      const bobSession = await session(bob);
      for (const keys of [{ p256dh: "guess" }, { auth: "guess" }]) {
        await repos().pushSubscriptions.save(
          subscription(bob, bobSession, { endpoint: first.endpoint, ...keys, createdAt: T0 + 9 }),
          RULES,
        );
      }
      expect(await repos().pushSubscriptions.forUsers([alice], LIVE)).toEqual([
        { ...first, lastSuccessAt: T0 + 5 },
      ]);
      expect(await repos().pushSubscriptions.forUsers([bob], LIVE)).toEqual([]);
      await repos().pushSubscriptions.save(
        subscription(bob, bobSession, { endpoint: first.endpoint, createdAt: T0 + 9 }),
        RULES,
      );
      expect(await repos().pushSubscriptions.forUsers([alice], LIVE)).toEqual([]);
      expect(await repos().pushSubscriptions.forUsers([bob], LIVE)).toEqual([
        { ...first, userId: bob, sessionId: bobSession, createdAt: T0 + 9, lastSuccessAt: null },
      ]);
    });

    it("moves, whatever the keys, once the stored row's session isn't live (A8-R2-2)", async () => {
      const [alice, bob] = [await user(), await user()];
      const dead = await session(alice, { createdAt: T0 - DAY, expiresAt: T0 });
      const first = subscription(alice, dead);
      await repos().pushSubscriptions.save(first, RULES);
      const bobSession = await session(bob);
      await repos().pushSubscriptions.save(
        subscription(bob, bobSession, {
          endpoint: first.endpoint,
          p256dh: "fresh",
          auth: "fresh",
          createdAt: T0 + 9,
        }),
        RULES,
      );
      expect(await endpointsOf(bob)).toEqual([first.endpoint]);
      const [row] = await repos().pushSubscriptions.forUsers([bob], LIVE);
      expect(row).toMatchObject({ id: first.id, sessionId: bobSession, p256dh: "fresh" });
    });

    it("evicts the rows of sessions that aren't live first (A8-R2-2)", async () => {
      const alice = await user();
      const liveSession = await session(alice);
      const dead = await session(alice, { createdAt: T0 - DAY, expiresAt: T0 });
      // The newest and most recently delivered row, but its session has expired.
      const stale = subscription(alice, dead, { createdAt: T0 + 500 });
      await repos().pushSubscriptions.save(stale, RULES);
      await repos().pushSubscriptions.delivered([stale.id], T0 + 600);
      const lives: NewPushSubscription[] = [];
      for (let index = 0; index < MAX; index++) {
        const next = subscription(alice, liveSession, { createdAt: T0 + index });
        lives.push(next);
        await repos().pushSubscriptions.save(next, RULES);
      }
      const stored = (
        await target().sql(
          "SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY endpoint",
          alice,
        )
      ).map((row) => row["endpoint"]);
      expect(stored).toEqual(lives.map((row) => row.endpoint).sort());
    });

    it("lists only subscriptions whose session is live (A8-S-2)", async () => {
      const alice = await user();
      const live = subscription(alice, await session(alice));
      const idle = subscription(
        alice,
        await session(alice, { createdAt: T0 - DAY, expiresAt: T0 }),
      );
      const tooOld = subscription(
        alice,
        await session(alice, { createdAt: T0 - 400 * DAY, expiresAt: T0 + DAY }),
      );
      for (const row of [live, idle, tooOld]) await repos().pushSubscriptions.save(row, RULES);
      expect(await endpointsOf(alice)).toEqual([live.endpoint]);
    });

    it("keeps at most ten per user, evicting the least recently useful (A8-P-5)", async () => {
      const [alice, bob] = [await user(), await user()];
      const sessionId = await session(alice);
      const bobs = subscription(bob, await session(bob));
      await repos().pushSubscriptions.save(bobs, RULES);
      const saved: NewPushSubscription[] = [];
      for (let index = 0; index < 12; index++) {
        const next = subscription(alice, sessionId, { createdAt: T0 + index });
        saved.push(next);
        await repos().pushSubscriptions.save(next, RULES);
      }
      expect(await endpointsOf(alice)).toEqual(
        saved
          .slice(2)
          .map((row) => row.endpoint)
          .sort(),
      );
      // A delivery makes the oldest the most useful: the next save evicts the next oldest.
      const [, , oldest, nextOldest] = saved;
      await repos().pushSubscriptions.delivered([oldest?.id ?? ""], T0 + 100);
      const latest = subscription(alice, sessionId, { createdAt: T0 + 50 });
      await repos().pushSubscriptions.save(latest, RULES);
      const endpoints = await endpointsOf(alice);
      expect(endpoints).toContain(oldest?.endpoint);
      expect(endpoints).toContain(latest.endpoint);
      expect(endpoints).not.toContain(nextOldest?.endpoint);
      // Another user's subscriptions are untouched.
      expect(await endpointsOf(bob)).toEqual([bobs.endpoint]);
    });

    it("never evicts the subscription it has just saved, however old", async () => {
      const alice = await user();
      const sessionId = await session(alice);
      for (let index = 0; index < MAX; index++) {
        await repos().pushSubscriptions.save(
          subscription(alice, sessionId, { createdAt: T0 + 100 + index }),
          RULES,
        );
      }
      const oldest = subscription(alice, sessionId, { createdAt: T0 });
      await repos().pushSubscriptions.save(oldest, RULES);
      const endpoints = await endpointsOf(alice);
      expect(endpoints).toHaveLength(MAX);
      expect(endpoints).toContain(oldest.endpoint);
    });

    it("removes a subscription only for the user it belongs to", async () => {
      const [alice, bob] = [await user(), await user()];
      const saved = subscription(alice, await session(alice));
      await repos().pushSubscriptions.save(saved, RULES);
      await repos().pushSubscriptions.remove(bob, saved.endpoint);
      expect(await endpointsOf(alice)).toEqual([saved.endpoint]);
      await repos().pushSubscriptions.remove(alice, saved.endpoint);
      expect(await endpointsOf(alice)).toEqual([]);
    });

    it("deletes gone subscriptions by id and records deliveries, several at once", async () => {
      const alice = await user();
      const sessionId = await session(alice);
      const rows = [1, 2, 3, 4].map(() => subscription(alice, sessionId));
      for (const row of rows) await repos().pushSubscriptions.save(row, RULES);
      const [kept, alsoKept, gone, alsoGone] = rows as [
        NewPushSubscription,
        NewPushSubscription,
        NewPushSubscription,
        NewPushSubscription,
      ];
      await repos().pushSubscriptions.delete([gone.id, alsoGone.id]);
      await repos().pushSubscriptions.delete([]);
      await repos().pushSubscriptions.delivered([kept.id, alsoKept.id], T0 + 7);
      await repos().pushSubscriptions.delivered([], T0 + 9);
      const stored = await repos().pushSubscriptions.forUsers([alice], LIVE);
      expect(stored.sort((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
        [kept, alsoKept]
          .map((row) => ({ ...row, lastSuccessAt: T0 + 7 }))
          .sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
    });

    it("dies with its session, on sign-out and on sign-out everywhere (06 §4)", async () => {
      const alice = await user();
      const [one, two, three] = [await session(alice), await session(alice), await session(alice)];
      const first = subscription(alice, one);
      await repos().pushSubscriptions.save(first, RULES);
      const second = subscription(alice, two);
      await repos().pushSubscriptions.save(second, RULES);
      await repos().pushSubscriptions.save(subscription(alice, three), RULES);
      await repos().sessions.delete(alice, one);
      expect(await endpointsOf(alice)).not.toContain(first.endpoint);
      expect(await endpointsOf(alice)).toContain(second.endpoint);
      await repos().sessions.deleteAll(alice);
      expect(await endpointsOf(alice)).toEqual([]);
    });
  });
}
