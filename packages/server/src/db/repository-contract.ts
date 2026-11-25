/**
 * The shared repository contract suite (docs/spec/03-architecture.md §4): the same tests run
 * against every adapter — Node's `node:sqlite` in `apps/node`, D1 in `apps/worker` — so both
 * behave identically. Exported as `@your-move/server/testing`; never part of a runtime build.
 *
 * Each adapter provides one migrated database for the whole suite; tests isolate themselves with
 * fresh ids, so the suite also runs against a database that other tests have used.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { address, authRepositoryContract } from "./auth-contract.js";
import { nudgeRepositoryContract } from "./nudge-contract.js";
import { pushRepositoryContract } from "./push-contract.js";
import type {
  GamePlayerRecord,
  GameWriteSet,
  NewGame,
  NewGamePlayer,
  Repositories,
} from "./repositories.js";

export interface ContractTarget {
  readonly repos: Repositories;
  /**
   * Runs one SQL statement on the same database and returns its rows: for arranging and checking
   * rows that no repository writes yet (API tokens, blocks) in tests only.
   */
  sql(statement: string, ...params: (string | number | null)[]): Promise<Record<string, unknown>[]>;
  /** Releases the database after the suite. */
  close(): Promise<void>;
}

const T0 = Date.UTC(2026, 0, 1);

function newGame(overrides: Partial<NewGame> = {}): NewGame {
  return {
    id: crypto.randomUUID(),
    gameType: "contract",
    gameVersion: 1,
    options: "{}",
    status: "lobby",
    seats: 2,
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    lastActionAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function player(overrides: Partial<NewGamePlayer> = {}): NewGamePlayer {
  return { id: crypto.randomUUID(), state: "joined", joinedAt: T0, ...overrides };
}

/** An active two-seat game, its two players seated, seat 0 to act. */
async function activeGame(repos: Repositories): Promise<{
  gameId: string;
  seat0: string;
  seat1: string;
}> {
  const game = newGame({ status: "active", state: '{"turn":0}', startedAt: T0 });
  const seat0 = player({ seat: 0, state: "playing", toAct: 1, toActSince: T0 });
  const seat1 = player({ seat: 1, state: "playing" });
  await repos.games.create(game, [seat0, seat1]);
  return { gameId: game.id, seat0: seat0.id, seat1: seat1.id };
}

/** Seat `seat` plays action number `seq`; the turn passes to the other seat. */
function move(ids: { seat0: string; seat1: string }, seq: number, seat: number, tag: string) {
  const [mover, next] = seat === 0 ? [ids.seat0, ids.seat1] : [ids.seat1, ids.seat0];
  return {
    game: {
      state: JSON.stringify({ turn: 1 - seat, tag }),
      actionCount: seq,
      lastActionAt: T0 + seq,
      updatedAt: T0 + seq,
    },
    updatePlayers: [
      { id: mover, set: { toAct: 0, toActSince: null, actedOnce: 1, score: seq } },
      { id: next, set: { toAct: 1, toActSince: T0 + seq } },
    ],
    insertActions: [
      {
        seq,
        seat,
        kind: "action",
        action: JSON.stringify({ tag }),
        record: JSON.stringify({ tag }),
        describe: JSON.stringify([tag]),
        createdAt: T0 + seq,
      },
    ],
  } satisfies GameWriteSet;
}

function bySeat(players: readonly GamePlayerRecord[]) {
  return players.map((row) => ({
    seat: row.seat,
    toAct: row.toAct,
    toActSince: row.toActSince,
    actedOnce: row.actedOnce,
    score: row.score,
  }));
}

export function repositoryContract(name: string, connect: () => Promise<ContractTarget>): void {
  describe(`repository contract: ${name}`, () => {
    let target: ContractTarget;
    let repos: Repositories;

    beforeAll(async () => {
      target = await connect();
      repos = target.repos;
    });

    afterAll(async () => {
      await target.close();
    });

    authRepositoryContract(() => target);
    nudgeRepositoryContract(() => target);
    pushRepositoryContract(() => target);

    describe("users", () => {
      it("creates and finds a user by id and by email", async () => {
        const id = crypto.randomUUID();
        const email = address(id);
        await repos.users.create({ id, email, createdAt: T0, updatedAt: T0 });
        const byId = await repos.users.findById(id);
        expect(byId).toMatchObject({
          id,
          email,
          kind: "human",
          settings: "{}",
          displayName: null,
          onboardedAt: null,
        });
        expect(await repos.users.findByEmail(email)).toEqual(byId);
        expect(await repos.users.findById(crypto.randomUUID())).toBeNull();
        expect(await repos.users.findByEmail(address(crypto.randomUUID()))).toBeNull();
      });

      it("refuses a second user with the same email", async () => {
        const email = address(crypto.randomUUID());
        await repos.users.create({ id: crypto.randomUUID(), email, createdAt: T0, updatedAt: T0 });
        await expect(
          repos.users.create({ id: crypto.randomUUID(), email, createdAt: T0, updatedAt: T0 }),
        ).rejects.toThrow();
      });

      it("allows any number of users without an email (AI accounts)", async () => {
        const owner = crypto.randomUUID();
        await repos.users.create({
          id: owner,
          email: address(owner),
          createdAt: T0,
          updatedAt: T0,
        });
        for (let i = 0; i < 2; i++) {
          await repos.users.create({
            id: crypto.randomUUID(),
            kind: "agent",
            ownerUserId: owner,
            createdAt: T0,
            updatedAt: T0,
          });
        }
      });

      it("remembers game options by changing only those keys (A2 review S-3)", async () => {
        const id = crypto.randomUUID();
        const settings = async () =>
          JSON.parse((await repos.users.findById(id))?.settings ?? "null") as unknown;
        await repos.users.create({
          id,
          email: address(id),
          settings: JSON.stringify({ whoCanAddMe: "nobody", lastOptions: { example: { x: 2 } } }),
          createdAt: T0,
          updatedAt: T0,
        });
        await repos.users.rememberGameOptions(id, {
          gameType: "words",
          input: JSON.stringify({ ruleset: "casual", n: [1, "two"] }),
          updatedAt: T0 + 1,
        });
        expect(await settings()).toEqual({
          whoCanAddMe: "nobody",
          lastOptions: { example: { x: 2 }, words: { ruleset: "casual", n: [1, "two"] } },
          lastGameType: "words",
        });
        expect((await repos.users.findById(id))?.updatedAt).toBe(T0 + 1);
        await repos.users.rememberGameOptions(id, {
          gameType: "example",
          input: null,
          updatedAt: T0 + 2,
        });
        expect(await settings()).toMatchObject({
          lastOptions: { example: { x: 2 } },
          lastGameType: "example",
        });
        // Settings that aren't an object, or a lastOptions that isn't one, count as empty.
        for (const stored of ["{", "[1]", JSON.stringify({ lastOptions: 5, keep: true })]) {
          const other = crypto.randomUUID();
          await repos.users.create({
            id: other,
            email: address(other),
            settings: stored,
            createdAt: T0,
            updatedAt: T0,
          });
          await repos.users.rememberGameOptions(other, {
            gameType: "words",
            input: "{}",
            updatedAt: T0,
          });
          expect(JSON.parse((await repos.users.findById(other))?.settings ?? "")).toEqual({
            ...(stored.includes("keep") ? { keep: true } : {}),
            lastOptions: { words: {} },
            lastGameType: "words",
          });
        }
      });
    });

    describe("games", () => {
      it("creates a game with its players, at version 0 with no write token", async () => {
        const game = newGame();
        const creator = player({ joinedVia: "creator" });
        const invited = player({ state: "invited", inviteEmail: "friend@example.org" });
        await repos.games.create(game, [creator, invited]);

        expect(await repos.games.get(game.id)).toMatchObject({
          ...game,
          version: 0,
          writeToken: null,
          actionCount: 0,
          state: null,
          finalViews: null,
        });
        const rows = await repos.games.players(game.id);
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === invited.id)).toMatchObject({
          gameId: game.id,
          seat: null,
          state: "invited",
          delivery: "normal",
          toAct: 0,
          actedOnce: 0,
          lastSeenVersion: 0,
          timeoutRemindersSent: 0,
        });
        expect(await repos.games.get(crypto.randomUUID())).toBeNull();
      });

      it("creates nothing when one row of the game is refused", async () => {
        const game = newGame();
        const user = crypto.randomUUID();
        await repos.users.create({
          id: user,
          email: address(user),
          createdAt: T0,
          updatedAt: T0,
        });
        // The same user twice in one game breaks the unique (game_id, user_id) index.
        await expect(
          repos.games.create(game, [player({ userId: user }), player({ userId: user })]),
        ).rejects.toThrow();
        expect(await repos.games.get(game.id)).toBeNull();
        expect(await repos.games.players(game.id)).toEqual([]);
      });

      it("enforces foreign keys", async () => {
        const game = newGame({ createdBy: crypto.randomUUID() });
        await expect(repos.games.create(game, [])).rejects.toThrow();
        expect(await repos.games.get(game.id)).toBeNull();
      });

      it("allows many seatless rows but only one row per seat", async () => {
        await repos.games.create(newGame(), [player(), player(), player()]);
        const game = newGame({ status: "active" });
        await expect(
          repos.games.create(game, [player({ seat: 0 }), player({ seat: 0 })]),
        ).rejects.toThrow();
      });

      it("lists live games: lobby and active only", async () => {
        const type = `t${crypto.randomUUID().slice(0, 8)}`;
        const created = await Promise.all(
          (["lobby", "active", "finished", "cancelled", "expired", "declined"] as const).map(
            async (status, index) => {
              const game = newGame({ gameType: type, gameVersion: index + 1, status });
              await repos.games.create(game, []);
              return game;
            },
          ),
        );
        const live = (await repos.games.liveGames()).filter((game) => game.gameType === type);
        expect(live.sort((a, b) => a.gameVersion - b.gameVersion)).toEqual([
          { id: created[0]?.id, gameType: type, gameVersion: 1 },
          { id: created[1]?.id, gameType: type, gameVersion: 2 },
        ]);
      });
    });

    describe("games: reads for the framework (A2)", () => {
      const human = async () => {
        const id = crypto.randomUUID();
        await repos.users.create({ id, email: address(id), createdAt: T0, updatedAt: T0 });
        return id;
      };

      it("tells which candidates are a user's past opponents", async () => {
        const user = await human();
        const [past, other, onlyTheirs] = [await human(), await human(), await human()];
        await target.sql(
          "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?), (?, ?, ?)",
          user,
          past,
          T0,
          onlyTheirs,
          user,
          T0,
        );
        expect(await repos.users.pastOpponentsOf(user, [past, other, onlyTheirs, ""])).toEqual([
          past,
        ]);
        expect(await repos.users.pastOpponentsOf(user, [])).toEqual([]);
      });

      it("finds a user's overdue lobbies, oldest first (lazy expiry)", async () => {
        const user = await human();
        const other = await human();
        const make = async (
          createdAt: number,
          status: NewGame["status"],
          rows: NewGamePlayer[],
        ) => {
          const game = newGame({ createdAt, status, createdBy: other });
          await repos.games.create(game, rows);
          return game.id;
        };
        const older = await make(T0 - 2, "lobby", [
          player({ userId: user, state: "invited", joinedAt: null }),
        ]);
        const old = await make(T0 - 1, "lobby", [player({ userId: user })]);
        // Rows giving no access are not the user's lobbies: they never expire for them (A2-R3-1).
        await make(T0 - 1, "lobby", [player({ userId: user, state: "declined" })]);
        await make(T0 - 1, "lobby", [player({ userId: user, state: "left" })]);
        await make(T0 - 1, "lobby", [player({ userId: user, state: "removed" })]);
        await make(T0 - 1, "lobby", [
          player({ userId: user, state: "invited", delivery: "inert", joinedAt: null }),
        ]);
        await make(T0 + 1, "lobby", [player({ userId: user })]); // not overdue yet
        await make(T0 - 3, "cancelled", [player({ userId: user })]); // not a lobby
        await make(T0 - 4, "lobby", [player({ userId: other })]); // not the user's
        expect(await repos.games.overdueLobbies(user, T0, 10)).toEqual([older, old]);
        expect(await repos.games.overdueLobbies(user, T0, 1)).toEqual([older]);
      });

      it("creates resources and invites with the game, and reads the game with its players at once", async () => {
        const creator = await human();
        const game = newGame({ createdBy: creator });
        const rows = [
          player({ userId: creator, joinedVia: "creator" }),
          player({ state: "invited", inviteEmail: "z@example.org", joinedAt: null }),
          player({ state: "invited", inviteEmail: "a@example.org", joinedAt: null }),
        ];
        await repos.games.create(game, rows, {
          resources: [{ kind: "dictionary", resourceId: "enable", version: 2 }],
          invites: [
            { id: crypto.randomUUID(), inviterId: creator, emailHash: "h1", expiresAt: T0 + 1 },
          ],
        });
        const loaded = await repos.games.load(game.id);
        expect(loaded?.game.id).toBe(game.id);
        // In the order the rows were added: the creator, then the invitees as typed.
        expect(loaded?.players.map((row) => row.id)).toEqual(rows.map((row) => row.id));
        expect(await repos.games.resources(game.id)).toEqual([
          { kind: "dictionary", resourceId: "enable", version: 2 },
        ]);
        expect(await repos.games.load(crypto.randomUUID())).toBeNull();
        expect(await repos.users.findByIds([creator, crypto.randomUUID()])).toEqual([
          expect.objectContaining({ id: creator }),
        ]);
        expect(await repos.users.findByIds([])).toEqual([]);
      });

      it("creates nothing when an invite of the game is refused", async () => {
        const game = newGame();
        await expect(
          repos.games.create(game, [player()], {
            invites: [
              {
                id: crypto.randomUUID(),
                inviterId: crypto.randomUUID(),
                emailHash: "h",
                expiresAt: T0,
              },
            ],
          }),
        ).rejects.toThrow();
        expect(await repos.games.get(game.id)).toBeNull();
      });

      it("reads history without the secret columns, and each game's newest action", async () => {
        const ids = await activeGame(repos);
        for (let seq = 1; seq <= 3; seq++) {
          await repos.games.applyTransition(
            ids.gameId,
            seq - 1,
            move(ids, seq, (seq - 1) % 2, `m${String(seq)}`),
          );
        }
        const history = await repos.games.history(ids.gameId, 1, 10);
        expect(history.map((row) => row.seq)).toEqual([2, 3]);
        for (const row of history) {
          expect(Object.keys(row).sort()).toEqual(
            ["createdAt", "describe", "gameId", "kind", "record", "seat", "seq", "via"].sort(),
          );
        }
        expect((await repos.games.history(ids.gameId, 0, 1)).map((row) => row.seq)).toEqual([1]);
        const other = await activeGame(repos);
        const last = await repos.games.lastActions([ids.gameId, other.gameId]);
        expect(last.map((row) => [row.gameId, row.seq])).toEqual([[ids.gameId, 3]]);
        expect(await repos.games.lastActions([])).toEqual([]);
      });

      it("lists a user's games newest first, by membership, retention and filters, with a cursor", async () => {
        const user = await human();
        const make = async (overrides: Partial<NewGame>, row: Partial<NewGamePlayer>) => {
          const game = newGame({ gameType: "listed", ...overrides });
          await repos.games.create(game, [player({ userId: user, ...row })]);
          return game.id;
        };
        const lobby = await make({ lastActionAt: T0 + 5 }, {});
        const invited = await make({ lastActionAt: T0 + 4 }, { state: "invited", joinedAt: null });
        const hidden = await make(
          { lastActionAt: T0 + 3 },
          { state: "invited", delivery: "hidden", joinedAt: null },
        );
        await make(
          { lastActionAt: T0 + 2 },
          { state: "invited", delivery: "inert", joinedAt: null },
        );
        await make({ lastActionAt: T0 + 1 }, { state: "declined" });
        const finishedOld = await make(
          { status: "finished", lastActionAt: T0, endedAt: T0 },
          { state: "out" },
        );
        const query = { userId: user, finishedSince: T0 + 1, endedSince: T0 + 1, limit: 10 };
        const listed = async (q: Partial<Parameters<typeof repos.games.listForUser>[0]> = {}) =>
          (await repos.games.listForUser({ ...query, ...q })).map((row) => row.game.id);
        expect(await listed()).toEqual([lobby, invited]);
        expect(await listed({ invitations: "normal" })).toEqual([invited]);
        expect(await listed({ invitations: "hidden" })).toEqual([hidden]);
        expect(await listed({ finishedSince: T0 })).toEqual([lobby, invited, finishedOld]);
        expect(await listed({ status: "finished", finishedSince: T0 })).toEqual([finishedOld]);
        expect(await listed({ gameType: "other" })).toEqual([]);
        expect(await listed({ limit: 1 })).toEqual([lobby]);
        expect(await listed({ after: { lastActionAt: T0 + 5, id: lobby } })).toEqual([invited]);
        const [row] = await repos.games.listForUser({ ...query, limit: 1 });
        expect(row?.member.userId).toBe(user);
        expect((await repos.games.playersOf([lobby, invited])).map((p) => p.gameId)).toEqual(
          [lobby, invited].sort(),
        );
        expect(await repos.games.playersOf([])).toEqual([]);
      });

      it("lists only the columns the list shows: the state while active, the own final summary", async () => {
        const user = await human();
        const at = T0 + 100;
        const active = newGame({
          status: "active",
          state: '{"secret":1}',
          setupRng: "[[2,1]]",
          lastActionAt: at + 1,
        });
        await repos.games.create(active, [player({ userId: user, seat: 1, state: "playing" })]);
        const finalViews = {
          seats: [
            { view: { hand: [7] }, summary: { headline: ["Seat 0's line"] } },
            { view: { hand: [9] }, summary: { headline: ["Your line"], scores: [1, 2] } },
          ],
          public: { view: null, summary: { headline: ["Public"] } },
        };
        const finished = newGame({
          status: "finished",
          state: '{"secret":2}',
          finalViews: JSON.stringify(finalViews),
          endedAt: at,
          lastActionAt: at,
        });
        await repos.games.create(finished, [player({ userId: user, seat: 1, state: "out" })]);
        const rows = await repos.games.listForUser({
          userId: user,
          finishedSince: T0,
          endedSince: T0,
          limit: 10,
        });
        expect(rows.map((row) => row.game)).toEqual([
          expect.objectContaining({ id: active.id, state: '{"secret":1}', finalSummary: null }),
          expect.objectContaining({ id: finished.id, state: null }),
        ]);
        expect(JSON.parse(rows[1]?.game.finalSummary ?? "null")).toEqual(
          finalViews.seats[1]?.summary,
        );
        for (const row of rows) {
          expect(Object.keys(row.game)).not.toContain("setupRng");
          expect(Object.keys(row.game)).not.toContain("finalViews");
          expect(Object.keys(row.game)).not.toContain("writeToken");
        }
      });

      it("raises a user's unread marker, never past the game's version and never down", async () => {
        const user = await human();
        const game = newGame();
        await repos.games.create(game, [player({ userId: user })]);
        await repos.games.applyTransition(game.id, 0, { game: { updatedAt: T0 + 1 } });
        await repos.games.markSeen(game.id, user, 5);
        const seen = async () => (await repos.games.players(game.id))[0]?.lastSeenVersion;
        expect(await seen()).toBe(1);
        await repos.games.markSeen(game.id, user, 0);
        expect(await seen()).toBe(1);
      });

      it("counts the live games a user created, in total and per typed address", async () => {
        const user = await human();
        const create = async (status: NewGame["status"], hash: string) => {
          const game = newGame({ status, createdBy: user });
          await repos.games.create(game, [player({ userId: user })], {
            invites: [{ id: crypto.randomUUID(), inviterId: user, emailHash: hash, expiresAt: T0 }],
          });
        };
        await create("lobby", "pair");
        await create("active", "pair");
        await create("finished", "pair");
        await create("lobby", "other");
        expect(await repos.games.countLiveCreated(user)).toBe(3);
        expect(await repos.games.countLiveCreatedWithInvite(user, "pair")).toBe(2);
        expect(await repos.games.countLiveCreatedWithInvite(user, "none")).toBe(0);
      });

      it("writes past opponents only with the winning transition, and never for a blocked pair", async () => {
        const [a, b, c] = [await human(), await human(), await human()];
        await target.sql(
          "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
          c,
          a,
          T0,
        );
        const game = newGame();
        await repos.games.create(game, []);
        const pairs = [
          { userId: a, otherId: b, lastFinishedAt: T0 },
          { userId: b, otherId: a, lastFinishedAt: T0 },
          { userId: a, otherId: c, lastFinishedAt: T0 },
          { userId: c, otherId: a, lastFinishedAt: T0 },
        ];
        expect(
          await repos.games.applyTransition(game.id, 0, {
            game: { updatedAt: T0 },
            pastOpponents: pairs,
          }),
        ).toBe("ok");
        expect(
          await repos.games.applyTransition(game.id, 0, {
            game: { updatedAt: T0 },
            pastOpponents: pairs.map((p) => ({ ...p, lastFinishedAt: T0 + 9 })),
          }),
        ).toBe("stale");
        const rows = await target.sql(
          "SELECT user_id, other_id, last_finished_at FROM past_opponents WHERE user_id IN (?, ?, ?) ORDER BY user_id, other_id",
          a,
          b,
          c,
        );
        expect(rows).toEqual(
          [
            { user_id: a, other_id: b, last_finished_at: T0 },
            { user_id: b, other_id: a, last_finished_at: T0 },
          ].sort((x, y) => (x.user_id < y.user_id ? -1 : 1)),
        );
        // A later finish refreshes the pair.
        expect(
          await repos.games.applyTransition(game.id, 1, {
            game: { updatedAt: T0 },
            pastOpponents: pairs.slice(0, 1).map((p) => ({ ...p, lastFinishedAt: T0 + 5 })),
          }),
        ).toBe("ok");
        const [refreshed] = await target.sql(
          "SELECT last_finished_at FROM past_opponents WHERE user_id = ? AND other_id = ?",
          a,
          b,
        );
        expect(refreshed?.["last_finished_at"]).toBe(T0 + 5);
      });
    });

    describe("write_token transitions (03 §5.2)", () => {
      it("applies a transition and every dependent write", async () => {
        const ids = await activeGame(repos);
        const writes = move(ids, 1, 0, "first");
        expect(await repos.games.applyTransition(ids.gameId, 0, writes)).toBe("ok");

        const game = await repos.games.get(ids.gameId);
        expect(game).toMatchObject({ ...writes.game, version: 1 });
        expect(game?.writeToken).toMatch(/^[0-9a-f-]{36}$/u);
        expect(bySeat(await repos.games.players(ids.gameId))).toEqual([
          { seat: 0, toAct: 0, toActSince: null, actedOnce: 1, score: 1 },
          { seat: 1, toAct: 1, toActSince: T0 + 1, actedOnce: 0, score: null },
        ]);
        expect(await repos.games.actions(ids.gameId)).toEqual([
          { ...writes.insertActions[0], gameId: ids.gameId, rng: null, via: "app" },
        ]);
      });

      it("inserts players only with the winning transition", async () => {
        const game = newGame();
        await repos.games.create(game, [player({ joinedVia: "creator" })]);
        const joiner = player({ joinedVia: "join_link" });
        const writes = { game: { updatedAt: T0 + 1 }, insertPlayers: [joiner] };
        expect(await repos.games.applyTransition(game.id, 0, writes)).toBe("ok");
        const again = { game: { updatedAt: T0 + 2 }, insertPlayers: [player()] };
        expect(await repos.games.applyTransition(game.id, 0, again)).toBe("stale");
        const rows = await repos.games.players(game.id);
        expect(rows.map((row) => row.id)).toContain(joiner.id);
        expect(rows).toHaveLength(2);
      });

      it("increases the version by exactly one per accepted transition", async () => {
        const ids = await activeGame(repos);
        for (let seq = 1; seq <= 4; seq++) {
          const result = await repos.games.applyTransition(
            ids.gameId,
            seq - 1,
            move(ids, seq, (seq - 1) % 2, `m${String(seq)}`),
          );
          expect(result).toBe("ok");
          expect((await repos.games.get(ids.gameId))?.version).toBe(seq);
        }
        expect((await repos.games.actions(ids.gameId)).map((action) => action.seq)).toEqual([
          1, 2, 3, 4,
        ]);
      });

      it("a stale transition writes nothing", async () => {
        const ids = await activeGame(repos);
        expect(await repos.games.applyTransition(ids.gameId, 0, move(ids, 1, 0, "a"))).toBe("ok");
        const before = {
          game: await repos.games.get(ids.gameId),
          players: await repos.games.players(ids.gameId),
          actions: await repos.games.actions(ids.gameId),
        };
        expect(await repos.games.applyTransition(ids.gameId, 0, move(ids, 2, 1, "late"))).toBe(
          "stale",
        );
        expect({
          game: await repos.games.get(ids.gameId),
          players: await repos.games.players(ids.gameId),
          actions: await repos.games.actions(ids.gameId),
        }).toEqual(before);
      });

      it("a transition on an unknown game is stale", async () => {
        const result = await repos.games.applyTransition(crypto.randomUUID(), 0, {
          game: { updatedAt: T0 },
          insertPlayers: [player()],
        });
        expect(result).toBe("stale");
      });

      // On Node the four calls interleave only at await points (one connection); on D1 they are
      // real concurrent requests. Either way the version check and token guard decide the race.
      it("of transitions started together from one version, exactly one wins, and the database matches it exactly", async () => {
        for (let round = 0; round < 10; round++) {
          const ids = await activeGame(repos);
          const contenders = [0, 1, 2, 3].map((n) => move(ids, 1, 0, `contender-${String(n)}`));
          const results = await Promise.all(
            contenders.map((writes) => repos.games.applyTransition(ids.gameId, 0, writes)),
          );
          expect(results.filter((result) => result === "ok")).toHaveLength(1);
          const winner = contenders[results.indexOf("ok")];

          const game = await repos.games.get(ids.gameId);
          expect(game).toMatchObject({ ...winner?.game, version: 1 });
          const actions = await repos.games.actions(ids.gameId);
          expect(actions).toEqual([
            { ...winner?.insertActions[0], gameId: ids.gameId, rng: null, via: "app" },
          ]);
          expect(bySeat(await repos.games.players(ids.gameId))).toEqual([
            { seat: 0, toAct: 0, toActSince: null, actedOnce: 1, score: 1 },
            { seat: 1, toAct: 1, toActSince: T0 + 1, actedOnce: 0, score: null },
          ]);
        }
      });

      it("a duplicate action aborts the whole transition", async () => {
        const ids = await activeGame(repos);
        expect(await repos.games.applyTransition(ids.gameId, 0, move(ids, 1, 0, "a"))).toBe("ok");
        const before = await repos.games.get(ids.gameId);
        // Right version, but seq 1 again: PRIMARY KEY(game_id, seq) refuses it, and the version
        // bump in the same batch rolls back with it.
        await expect(
          repos.games.applyTransition(ids.gameId, 1, move(ids, 1, 1, "dup")),
        ).rejects.toThrow();
        expect(await repos.games.get(ids.gameId)).toEqual(before);
        expect(await repos.games.actions(ids.gameId)).toHaveLength(1);
      });

      it("never touches another game's players", async () => {
        const ids = await activeGame(repos);
        const other = await activeGame(repos);
        const before = await repos.games.players(other.gameId);
        const writes = {
          game: { updatedAt: T0 + 1 },
          updatePlayers: [{ id: other.seat0, set: { score: 99 } }],
        };
        expect(await repos.games.applyTransition(ids.gameId, 0, writes)).toBe("ok");
        expect(await repos.games.players(other.gameId)).toEqual(before);
      });
    });
  });
}
