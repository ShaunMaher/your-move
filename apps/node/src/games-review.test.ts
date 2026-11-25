/**
 * Tests from the review of alpha slice A2 (docs/reviews/alpha-a2.md), each named by its finding:
 * the real app on a real SQLite database with the installed games, like `games.test.ts`.
 */
import type { AnyGameDefinition, GameEnvelope } from "@your-move/sdk";
import type { InstalledGame, Repositories } from "@your-move/server";
import { seededRandom } from "@your-move/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { installedGames } from "../../../generated/server-registry.js";
import {
  act,
  call,
  createGame,
  gameHarness,
  getGame,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { createHarness, DAY, type Harness, MINUTE, PROD_ENV, T0 } from "./test-harness.js";

const open: Harness[] = [];
afterEach(() => {
  for (const harness of open.splice(0)) harness.close();
});

/** A harness closed after the test. */
function harness(...args: Parameters<typeof gameHarness>): Harness {
  const h = gameHarness(...args);
  open.push(h);
  return h;
}

function installed(type: string): InstalledGame {
  const game = installedGames.find((candidate) => candidate.manifest.type === type);
  if (game === undefined) throw new Error(`${type} isn't installed`);
  return game;
}

/** The installed games with some of the example game's version 1 members replaced. */
function exampleWith(overrides: Partial<AnyGameDefinition>): InstalledGame[] {
  const example = installed("example");
  const engine = example.engines[1];
  if (engine === undefined) throw new Error("no example engine");
  return [installed("words"), { ...example, engines: { 1: { ...engine, ...overrides } } }];
}

/** A two-player example game between `a` and `b`, started by b's accept. */
async function startedExample(h: Harness, a: Player, b: Player) {
  const created = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
  const accepted = await transition(h, b, created.id, "accept");
  expect(accepted.status).toBe(200);
  return accepted.body.game;
}

describe("S-5: a module's exception never reaches the log with its message", () => {
  it("logs the game type, the member, the original's class and its frames, and answers 500", async () => {
    const throwing = exampleWith({
      apply: () => {
        throw new Error("the hidden hand is 7,8,9 secret-xyz");
      },
    });
    const h = harness({}, { games: throwing });
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(h, a, b);
    const seat = game.toAct[0];
    const player = game.players.find((row) => row.seat === seat)?.userId === a.id ? a : b;
    const { view } = await getGame(h, player, game.id);
    const card = (view as { seats: { hand: number[] | null }[] }).seats[seat ?? 0]?.hand?.[0];
    const moved = await act(h, player, game.id, { card });
    expect(moved.status).toBe(500);
    const fault = h.logs.find((entry) => entry["msg"] === "unhandled error");
    expect(fault).toMatchObject({
      errorClass: "EngineFault",
      gameType: "example",
      member: "apply",
      causeClass: "Error",
    });
    expect(String(fault?.["stack"])).toMatch(/^\s+at /u);
    expect(JSON.stringify(h.logs)).not.toContain("secret-xyz");
    expect(JSON.stringify(moved.body)).not.toContain("secret-xyz");
  });
});

describe("P-5: the games' randomness is injected", () => {
  it("plays the same deal from the same seed, and another from another", async () => {
    const deal = async (seed: number) => {
      const h = createHarness(
        { ...PROD_ENV, ENABLED_GAMES: "words,example" },
        { games: installedGames, random: () => source },
      );
      const source = seededRandom(seed);
      open.push(h);
      const a = await signUp(h, "Ada");
      const b = await signUp(h, "Bo");
      const game = await startedExample(h, a, b);
      return h.query("SELECT state, setup_rng FROM games WHERE id = ?", game.id)[0];
    };
    const first = await deal(7);
    expect(await deal(7)).toEqual(first);
    expect(await deal(8)).not.toEqual(first);
  });
});

describe("S-3: creating a game changes only the remembered options in users.settings", () => {
  it("keeps a setting changed while the game was being created", async () => {
    const hook: { during?: () => void } = {};
    const h = harness(
      {},
      {
        wrapRepos: (repos) => ({
          ...repos,
          games: {
            ...repos.games,
            async create(...args) {
              await repos.games.create(...args);
              hook.during?.();
            },
          },
        }),
      },
    );
    const a = await signUp(h, "Ada");
    // Another request changes a setting after this one loaded the session's copy of the user.
    hook.during = () => {
      h.exec(
        "UPDATE users SET settings = json_set(settings, '$.whoCanAddMe', 'nobody') WHERE id = ?",
        a.id,
      );
    };
    await createGame(h, a, { gameType: "example", options: { lives: 2 }, invitees: [] });
    const [row] = h.query("SELECT settings FROM users WHERE id = ?", a.id);
    expect(JSON.parse(String(row?.["settings"]))).toEqual({
      whoCanAddMe: "nobody",
      lastOptions: { example: { lives: 2 } },
      lastGameType: "example",
    });
  });
});

interface Listed {
  readonly id: string;
  readonly yourInvitation: string | null;
  readonly unread: boolean;
}

async function list(h: Harness, player: Player, query = ""): Promise<Listed[]> {
  const listed = await call<{ games: Listed[] }>(h, player, "GET", `/api/v1/games${query}`);
  expect(listed.status).toBe(200);
  return listed.body.games;
}

describe("P-1: an invitation is one only while its lobby is open", () => {
  it("drops yourInvitation and the invitations filter once the lobby is cancelled", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    expect((await list(h, b, "?invitations=true")).map((row) => row.id)).toEqual([game.id]);
    expect((await transition(h, a, game.id, "cancel")).status).toBe(200);
    expect((await getGame(h, b, game.id)).game.yourInvitation).toBeNull();
    expect(await list(h, b, "?invitations=true")).toEqual([]);
    // Still listed among b's games for a week, as an ending, not an invitation.
    expect((await list(h, b)).find((row) => row.id === game.id)?.yourInvitation).toBeNull();
  });

  it("drops a hidden one from the hidden list too", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    h.exec("UPDATE game_players SET delivery = 'hidden' WHERE user_id = ?", b.id);
    expect((await list(h, b, "?invitations=hidden")).map((row) => row.id)).toEqual([game.id]);
    expect((await transition(h, a, game.id, "cancel")).status).toBe(200);
    expect(await list(h, b, "?invitations=hidden")).toEqual([]);
  });
});

describe("P-6: unread markers", () => {
  it("shows a new invitation unread, and never one's own transitions", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "example", invitees: [{ email: b.email }] });
    const unread = async (player: Player) =>
      (await list(h, player)).find((row) => row.id === game.id)?.unread;
    expect(await unread(a)).toBe(false);
    expect(await unread(b)).toBe(true);
    const accepted = await transition(h, b, game.id, "accept");
    expect(accepted.body.game.status).toBe("active");
    expect(await unread(b)).toBe(false);
    expect(await unread(a)).toBe(true);
    const seat = accepted.body.game.toAct[0];
    const mover = accepted.body.game.players.find((row) => row.seat === seat)?.userId;
    const player = mover === a.id ? a : b;
    const other = player === a ? b : a;
    const { view } = await getGame(h, player, game.id);
    const card = (view as { seats: { hand: number[] | null }[] }).seats[seat ?? 0]?.hand?.[0];
    expect((await act(h, player, game.id, { card })).status).toBe(200);
    expect(await unread(player)).toBe(false);
    expect(await unread(other)).toBe(true);
  });
});

describe("S-4: an overdue lobby expires when it is next read or written", () => {
  const LIFETIME = 14 * DAY;

  it("is still a lobby a moment before its 14 days, and expired on the next read after", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: "nobody-yet@example.org" }],
    });
    h.advance(LIFETIME - 1);
    expect((await getGame(h, a, game.id)).game.status).toBe("lobby");
    h.advance(1);
    const expired = await getGame(h, b, game.id);
    expect(expired.game).toMatchObject({
      status: "expired",
      endReason: "expired",
      version: game.version + 1,
      yourInvitation: null,
    });
    // Typed addresses are cleared at once (06 §6.5): no row keeps one.
    expect(h.query("SELECT invite_email FROM game_players WHERE game_id = ?", game.id)).toEqual([
      { invite_email: null },
      { invite_email: null },
      { invite_email: null },
    ]);
    expect(h.query("SELECT ended_at FROM games WHERE id = ?", game.id)).toEqual([
      { ended_at: game.createdAt + LIFETIME },
    ]);
  });

  it("can't be accepted or started once overdue, whichever version the client sends", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const c = await signUp(h, "Cy");
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: b.email }, { email: c.email }],
    });
    expect((await transition(h, b, game.id, "accept", game.version)).status).toBe(200);
    h.advance(LIFETIME);
    const accepted = await transition(h, c, game.id, "accept", game.version + 1);
    expect([accepted.status, accepted.body.error.code]).toEqual([409, "STALE_GAME"]);
    const started = await transition(h, a, game.id, "start");
    expect([started.status, started.body.error.code]).toEqual([409, "WRONG_STATUS"]);
    expect((await getGame(h, a, game.id)).game.status).toBe("expired");
  });

  it("is listed as expired, and no longer as an invitation", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
    h.advance(LIFETIME);
    expect(await list(h, b, "?invitations=true")).toEqual([]);
    const listed = await call<{ games: { id: string; status: string }[] }>(
      h,
      a,
      "GET",
      "/api/v1/games?status=lobby",
    );
    expect(listed.body.games).toEqual([]);
    expect(
      (await call<{ games: { id: string; status: string }[] }>(h, a, "GET", "/api/v1/games")).body
        .games,
    ).toEqual([expect.objectContaining({ id: game.id, status: "expired" })]);
  });

  it("no longer counts toward the creator's live games", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID();
      h.exec(
        "INSERT INTO games (id, game_type, game_version, options, status, created_by, seats, turn_timeout_days, seat_order, ai_assistance, last_action_at, created_at, updated_at) VALUES (?, 'words', 1, '{}', 'lobby', ?, 2, 14, 'join', 'off', ?, ?, ?)",
        id,
        a.id,
        T0,
        T0,
        T0,
      );
      h.exec(
        "INSERT INTO game_players (id, game_id, user_id, state, joined_via, joined_at) VALUES (?, ?, ?, 'joined', 'creator', ?)",
        crypto.randomUUID(),
        id,
        a.id,
        T0,
      );
    }
    const refused = await call<{ error: { code: string } }>(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [],
    });
    expect([refused.status, refused.body.error.code]).toEqual([409, "TOO_MANY_GAMES"]);
    h.advance(LIFETIME);
    await createGame(h, a, { gameType: "words", invitees: [] });
    expect(h.query("SELECT count(*) AS n FROM games WHERE status = 'expired'")).toEqual([
      { n: 50 },
    ]);
  });
});

describe("S-1: the inbound invitation cap (06 §6.7, 08 T20)", () => {
  /** Invites `target` to a new words game and returns the creator's response body. */
  const invite = async (h: Harness, creator: Player, email: string) => {
    const created = await call<{ game: GameEnvelope }>(h, creator, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ email }],
    });
    expect(created.status).toBe(201);
    return created.body;
  };

  /** The response with what differs between any two games blanked out. */
  const shape = (body: { game: GameEnvelope }) =>
    JSON.parse(
      JSON.stringify(body)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, "<id>")
        .replace(/"invitedAs":"[^"]*"/gu, '"invitedAs":"<address>"')
        .replace(/"(createdAt|lastActionAt)":[0-9]+/gu, '"$1":0'),
    ) as unknown;

  const delivery = (h: Harness, gameId: string, userId: string) =>
    h.query(
      "SELECT delivery FROM game_players WHERE game_id = ? AND user_id = ?",
      gameId,
      userId,
    )[0]?.["delivery"];

  it("hides a second invitation from the same creator within a day, the response unchanged", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const first = await invite(h, a, b.email);
    h.advance(MINUTE);
    const second = await invite(h, a, b.email);
    expect(delivery(h, first.game.id, b.id)).toBe("normal");
    expect(delivery(h, second.game.id, b.id)).toBe("hidden");
    expect(shape(second)).toEqual(shape(first));
    // Only in the collapsed list, never badged, and still b's to accept.
    expect((await list(h, b)).map((row) => row.id)).toEqual([first.game.id]);
    expect((await list(h, b, "?invitations=true")).map((row) => row.id)).toEqual([first.game.id]);
    const hidden = await list(h, b, "?invitations=hidden");
    expect(hidden).toEqual([
      expect.objectContaining({ id: second.game.id, yourInvitation: "hidden", unread: false }),
    ]);
    expect((await transition(h, b, second.game.id, "accept")).body.game.status).toBe("active");
    // A day later the same creator's invitation is delivered again.
    h.advance(2 * DAY);
    const later = await invite(h, a, b.email);
    expect(delivery(h, later.game.id, b.id)).toBe("normal");
  });

  it("hides the fourth invitation in a day from different creators", async () => {
    const h = harness();
    const b = await signUp(h, "Bo");
    const games: string[] = [];
    for (const name of ["Ada", "Cy", "Di", "Ed"]) {
      games.push((await invite(h, await signUp(h, name), b.email)).game.id);
    }
    expect(games.map((id) => delivery(h, id, b.id))).toEqual([
      "normal",
      "normal",
      "normal",
      "hidden",
    ]);
  });

  it("never caps a past opponent, and a past opponent's invitations don't count", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    for (const [userId, otherId] of [
      [a.id, b.id],
      [b.id, a.id],
    ]) {
      h.exec(
        "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?)",
        userId ?? "",
        otherId ?? "",
        T0,
      );
    }
    const fromA: string[] = [];
    for (let i = 0; i < 4; i++) fromA.push((await invite(h, a, b.email)).game.id);
    expect(fromA.map((id) => delivery(h, id, b.id))).toEqual([
      "normal",
      "normal",
      "normal",
      "normal",
    ]);
    const strangers: string[] = [];
    for (const name of ["Cy", "Di", "Ed", "Flo"]) {
      strangers.push((await invite(h, await signUp(h, name), b.email)).game.id);
    }
    expect(strangers.map((id) => delivery(h, id, b.id))).toEqual([
      "normal",
      "normal",
      "normal",
      "hidden",
    ]);
  });

  it("does the same reads and writes, and answers the same, whatever the address is (Q3)", async () => {
    const calls: string[] = [];
    const h = harness({}, { wrapRepos: (repos) => recording(repos, calls) });
    const a = await signUp(h, "Ada");
    const fresh = await signUp(h, "Bo");
    const capped = await signUp(h, "Cy");
    const opponent = await signUp(h, "Di");
    const unOnboarded = await signUp(h, null);
    h.exec(
      "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?)",
      opponent.id,
      a.id,
      T0,
    );
    await invite(h, await signUp(h, "Ed"), capped.email);
    await invite(h, await signUp(h, "Flo"), capped.email);
    await invite(h, await signUp(h, "Gus"), capped.email);
    const seen: { calls: string[]; shape: unknown }[] = [];
    for (const email of [
      fresh.email,
      capped.email,
      opponent.email,
      unOnboarded.email,
      "no-account@example.org",
    ]) {
      calls.length = 0;
      const body = await invite(h, a, email);
      seen.push({ calls: [...calls], shape: shape(body) });
      h.advance(MINUTE);
    }
    // The capped address really was over the cap: its invitation is the hidden one.
    expect(
      h.query(
        "SELECT delivery FROM game_players WHERE user_id = ? AND delivery = 'hidden'",
        capped.id,
      ),
    ).toHaveLength(1);
    for (const other of seen.slice(1)) expect(other).toEqual(seen[0]);
  });
});

/** The repositories, each call's name (and for rate limits, how many counters) recorded. */
function recording(repos: Repositories, calls: string[]): Repositories {
  const wrap = <T extends object>(group: string, repo: T): T =>
    new Proxy(repo, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const first = args[0];
          calls.push(
            `${group}.${String(key)}${Array.isArray(first) ? `(${String(first.length)})` : ""}`,
          );
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return Object.fromEntries(
    Object.entries(repos).map(([group, repo]) => [group, wrap(group, repo as object)]),
  ) as unknown as Repositories;
}

describe("P-19: history says which transitions the server made", () => {
  it("shows via as stored: app, token or system", async () => {
    const h = harness();
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    const game = await startedExample(h, a, b);
    expect((await transition(h, b, game.id, "resign")).status).toBe(200);
    h.exec("UPDATE game_actions SET via = 'system' WHERE game_id = ?", game.id);
    const history = await call<{ items: { via: string }[] }>(
      h,
      a,
      "GET",
      `/api/v1/games/${game.id}/history`,
    );
    expect(history.body.items.map((item) => item.via)).toEqual(["system"]);
  });
});
