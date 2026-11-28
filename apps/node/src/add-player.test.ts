/**
 * Adding a link joiner to your players (alpha A19; docs/spec/05-api.md `canAddPlayers` and
 * `POST /api/v1/games/:id/add-player`, 02 §4, 06 §6.9, 04 `past_opponents`, 08 T20): who sees the
 * question and whom it lists, who may answer it and for whom (one `404` body for everyone else),
 * the pair it writes (both ways, never the other players), its silent `204` across a block, and a
 * rematch after it. The real app on a real SQLite database.
 */
import type { GameEnvelope } from "@your-move/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  call,
  type ErrorBody,
  gameHarness,
  getGame,
  playExampleToEnd,
  type Player,
  signUp,
  transition,
} from "./games-support.js";
import { DAY, type Harness } from "./test-harness.js";

let h: Harness;
beforeEach(() => {
  h = gameHarness();
});
afterEach(() => {
  h.close();
});

const now = (): number => h.platform.now().getTime();

/** The `404` every refusal gives: one body, whatever the reason. */
const NOT_FOUND = { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };

const addPlayer = (player: Player, gameId: string, userId: string) =>
  call<ErrorBody | null>(h, player, "POST", `/api/v1/games/${gameId}/add-player`, { userId });

const rematch = (player: Player, gameId: string) =>
  call<{ game: GameEnvelope } & ErrorBody>(
    h,
    player,
    "POST",
    `/api/v1/games/${gameId}/rematch`,
    {},
  );

const canAdd = async (player: Player, gameId: string) =>
  (await getGame(h, player, gameId)).game.canAddPlayers;

/** Every past-opponent pair touching these users, as `user>other`, sorted. */
function pairsOf(...players: Player[]): string[] {
  const ids = players.map((player) => player.id);
  return h
    .query("SELECT user_id, other_id FROM past_opponents")
    .filter((row) => ids.includes(String(row["user_id"])) || ids.includes(String(row["other_id"])))
    .map((row) => `${String(row["user_id"])}>${String(row["other_id"])}`)
    .sort();
}

const both = (a: Player, b: Player): string[] => [`${a.id}>${b.id}`, `${b.id}>${a.id}`].sort();

/** `blocker` blocks `blocked` (04 `blocks`; nothing writes one through the API before M4). */
function block(blocker: Player, blocked: Player): void {
  h.exec(
    "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
    blocker.id,
    blocked.id,
    now(),
  );
}

/**
 * A started example game: `creator` made it with a join link, `invited` accepted an email
 * invitation and `joiners` joined through the link, in that order.
 */
async function startedLinkGame(
  creator: Player,
  joiners: readonly Player[],
  invited: readonly Player[] = [],
): Promise<string> {
  const created = await call<{ game: GameEnvelope; joinLinkUrl?: string }>(
    h,
    creator,
    "POST",
    "/api/v1/games",
    {
      gameType: "example",
      seats: 1 + joiners.length + invited.length,
      invitees: invited.map((player) => ({ email: player.email })),
      joinLink: true,
    },
  );
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const gameId = created.body.game.id;
  const token = /#([A-Za-z0-9_-]{22})$/u.exec(created.body.joinLinkUrl ?? "")?.[1] ?? "";
  for (const player of invited) {
    expect((await transition(h, player, gameId, "accept")).status).toBe(200);
  }
  for (const player of joiners) {
    const joined = await call(h, player, "POST", "/api/v1/join", { token });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
  }
  const started = await transition(h, creator, gameId, "start");
  expect(started.body.game.status).toBe("active");
  return gameId;
}

/** A finished link game in which everyone acted; the day moves on so limits start afresh. */
async function finishedLinkGame(
  creator: Player,
  joiners: readonly Player[],
  invited: readonly Player[] = [],
): Promise<string> {
  const gameId = await startedLinkGame(creator, joiners, invited);
  await playExampleToEnd(h, gameId, [creator, ...invited, ...joiners]);
  expect((await getGame(h, creator, gameId)).game.status).toBe("finished");
  h.advance(DAY);
  return gameId;
}

describe("canAddPlayers (05, 06 §6.9)", () => {
  it("lists the creator's link joiners who acted, by name, and only to the creator", async () => {
    const [a, b, c, d] = [
      await signUp(h, "Ann"),
      await signUp(h, "Bob"),
      await signUp(h, "Cy"),
      await signUp(h, "Di"),
    ];
    const gameId = await finishedLinkGame(a, [b, d], [c]);
    expect(await canAdd(a, gameId)).toEqual([
      { userId: b.id, displayName: "Bob" },
      { userId: d.id, displayName: "Di" },
    ]);
    for (const other of [b, c, d]) {
      expect((await getGame(h, other, gameId)).game).not.toHaveProperty("canAddPlayers");
    }
    // The invited player was paired with the creator at the finish, as before (A18).
    expect(pairsOf(a, b, c, d)).toEqual(both(a, c));
  });

  it("is shown only on a finished game", async () => {
    const [a, b] = [await signUp(h, "Ann"), await signUp(h, "Bob")];
    const gameId = await startedLinkGame(a, [b]);
    expect((await getGame(h, a, gameId)).game).not.toHaveProperty("canAddPlayers");
    expect(await addPlayer(a, gameId, b.id)).toEqual(NOT_FOUND);
    await playExampleToEnd(h, gameId, [a, b]);
    expect(await canAdd(a, gameId)).toEqual([{ userId: b.id, displayName: "Bob" }]);
  });

  it("is empty with no link joiner, and leaves out one already a past opponent", async () => {
    const [a, b, c] = [await signUp(h, "Ann"), await signUp(h, "Bob"), await signUp(h, "Cy")];
    // Invited only: paired at the finish, nobody to ask about.
    const invitedOnly = await finishedLinkGame(a, [], [c]);
    expect(await canAdd(a, invitedOnly)).toEqual([]);
    // c joins a later game by link, already a's past opponent: nothing to ask either.
    const later = await finishedLinkGame(a, [c, b]);
    expect(await canAdd(a, later)).toEqual([{ userId: b.id, displayName: "Bob" }]);
  });

  it("leaves out a link joiner who never acted, and lists no one when the creator never acted", async () => {
    const [a, b, c] = [await signUp(h, "Ann"), await signUp(h, "Bob"), await signUp(h, "Cy")];
    // b declines before a first action; a and c play on to the end.
    const bDeclined = await startedLinkGame(a, [b, c]);
    expect((await transition(h, b, bDeclined, "decline")).status).toBe(200);
    await playExampleToEnd(h, bDeclined, [a, c]);
    expect((await getGame(h, a, bDeclined)).game.status).toBe("finished");
    expect(await canAdd(a, bDeclined)).toEqual([{ userId: c.id, displayName: "Cy" }]);
    expect(await addPlayer(a, bDeclined, b.id)).toEqual(NOT_FOUND);

    // The creator declines: no pair can form with anyone, so there is nothing to ask.
    h.advance(DAY);
    const aDeclined = await startedLinkGame(a, [b, c]);
    expect((await transition(h, a, aDeclined, "decline")).status).toBe(200);
    await playExampleToEnd(h, aDeclined, [b, c]);
    expect((await getGame(h, a, aDeclined)).game.status).toBe("finished");
    expect(await canAdd(a, aDeclined)).toEqual([]);
    expect(await addPlayer(a, aDeclined, c.id)).toEqual(NOT_FOUND);
    expect(pairsOf(a, b, c)).toEqual([]);
  });

  it("still lists a link joiner with a block either way, so the question reveals nothing (06 §6.9)", async () => {
    const [a, b, c] = [await signUp(h, "Ann"), await signUp(h, "Bob"), await signUp(h, "Cy")];
    const gameId = await finishedLinkGame(a, [b, c]);
    const before = await getGame(h, a, gameId);
    block(b, a);
    block(a, c);
    expect(await getGame(h, a, gameId)).toEqual(before);
  });
});

describe("POST /api/v1/games/:id/add-player (05)", () => {
  it("writes creator <-> that joiner both ways at the game's end, never the other players", async () => {
    const [a, b, c] = [await signUp(h, "Ann"), await signUp(h, "Bob"), await signUp(h, "Cy")];
    const gameId = await finishedLinkGame(a, [b, c]);
    const before = await getGame(h, a, gameId);
    const answer = await addPlayer(a, gameId, b.id);
    expect(answer).toEqual({ status: 204, body: null });
    expect(pairsOf(a, b, c)).toEqual(both(a, b));
    const endedAt = h.query("SELECT ended_at FROM games WHERE id = ?", gameId)[0]?.["ended_at"];
    expect(
      h.query(
        "SELECT DISTINCT last_finished_at FROM past_opponents WHERE user_id IN (?, ?)",
        a.id,
        b.id,
      ),
    ).toEqual([{ last_finished_at: endedAt }]);
    // Not a transition: the game is as it was, but for the question about b.
    const after = (await getGame(h, a, gameId)).game;
    expect(after.version).toBe(before.game.version);
    expect(after.canAddPlayers).toEqual([{ userId: c.id, displayName: "Cy" }]);
    // Each now finds the other under "People you've played".
    for (const [viewer, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const recent = await call<{ players: { userId: string }[] }>(
        h,
        viewer,
        "GET",
        "/api/v1/players/recent",
      );
      expect(recent.body.players.map((player) => player.userId)).toEqual([other.id]);
    }
  });

  it("is idempotent: a repeat is the same 204 and writes nothing more", async () => {
    const [a, b] = [await signUp(h, "Ann"), await signUp(h, "Bob")];
    const gameId = await finishedLinkGame(a, [b]);
    expect((await addPlayer(a, gameId, b.id)).status).toBe(204);
    const stored = h.query("SELECT * FROM past_opponents ORDER BY user_id");
    expect(await addPlayer(a, gameId, b.id)).toEqual({ status: 204, body: null });
    expect(h.query("SELECT * FROM past_opponents ORDER BY user_id")).toEqual(stored);
  });

  it("answers a block in either direction with the same 204 and writes no pair (04 invariant 6)", async () => {
    const [a, b, c, d] = [
      await signUp(h, "Ann"),
      await signUp(h, "Bob"),
      await signUp(h, "Cy"),
      await signUp(h, "Di"),
    ];
    const gameId = await finishedLinkGame(a, [b, c, d]);
    block(b, a);
    block(a, c);
    const answers = [];
    for (const player of [b, c, d]) answers.push(await addPlayer(a, gameId, player.id));
    // Blocked or not, added the first time or again: one answer.
    for (const player of [b, c, d]) answers.push(await addPlayer(a, gameId, player.id));
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([JSON.stringify({ status: 204, body: null })]),
    );
    expect(pairsOf(a, b, c, d)).toEqual(both(a, d));
    expect(
      h.query(
        "SELECT 1 FROM blocks b JOIN past_opponents p ON (p.user_id = b.blocker_id AND p.other_id = b.blocked_id) OR (p.user_id = b.blocked_id AND p.other_id = b.blocker_id)",
      ),
    ).toEqual([]);
  });

  it("refuses everyone and everything else with the one 404 body, writing nothing", async () => {
    const [a, b, c, e] = [
      await signUp(h, "Ann"),
      await signUp(h, "Bob"),
      await signUp(h, "Cy"),
      await signUp(h, "Eve"),
    ];
    const stranger = await signUp(h, "Stranger");
    const gameId = await finishedLinkGame(a, [b], [c]);
    // Another game of a's, with e joining by link: e is no player of this one.
    const other = await finishedLinkGame(a, [e]);
    const refused = [
      // A non-member, even naming a real link joiner.
      await addPlayer(stranger, gameId, b.id),
      // A player who isn't the creator: the joiner naming the creator, or the other player.
      await addPlayer(b, gameId, a.id),
      await addPlayer(c, gameId, b.id),
      // The creator naming someone invited rather than joined by link, themselves, another
      // game's link joiner (IDOR), or no one.
      await addPlayer(a, gameId, c.id),
      await addPlayer(a, gameId, a.id),
      await addPlayer(a, gameId, e.id),
      await addPlayer(a, gameId, crypto.randomUUID()),
      // A game that doesn't exist.
      await addPlayer(a, crypto.randomUUID(), b.id),
    ];
    for (const answer of refused) expect(answer).toEqual(NOT_FOUND);
    expect(pairsOf(b, e)).toEqual([]);
    expect(await canAdd(a, other)).toEqual([{ userId: e.id, displayName: "Eve" }]);
  });

  it("refuses a malformed body as 400", async () => {
    const [a, b] = [await signUp(h, "Ann"), await signUp(h, "Bob")];
    const gameId = await finishedLinkGame(a, [b]);
    for (const body of [
      {},
      { userId: "" },
      { userId: b.id, extra: 1 },
      { userId: "x".repeat(65) },
    ]) {
      const answer = await call<ErrorBody>(
        h,
        a,
        "POST",
        `/api/v1/games/${gameId}/add-player`,
        body,
      );
      expect([answer.status, answer.body.error.code]).toEqual([400, "BAD_REQUEST"]);
    }
    expect(pairsOf(a, b)).toEqual([]);
  });
});

describe("a rematch with a link joiner (06 §6.11, alpha A15)", () => {
  it("is INVALID_INVITEES for the creator until they add the joiner, then starts with them", async () => {
    const [a, b] = [await signUp(h, "Ann"), await signUp(h, "Bob")];
    const gameId = await finishedLinkGame(a, [b]);
    const refused = await rematch(a, gameId);
    expect([refused.status, refused.body.error.code]).toEqual([400, "INVALID_INVITEES"]);
    expect((await addPlayer(a, gameId, b.id)).status).toBe(204);
    const asked = await rematch(a, gameId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    // b is a past opponent now and auto-joins under the default whoCanAddMe: it starts at once.
    expect(asked.body.game.status).toBe("active");
    expect((await getGame(h, b, gameId)).game.rematch).toEqual({
      gameId: asked.body.game.id,
      you: "joined",
    });
  });

  it("is INVALID_INVITEES for the joiner until the creator adds them; then the joiner's works too", async () => {
    const [a, b] = [await signUp(h, "Ann"), await signUp(h, "Bob")];
    const gameId = await finishedLinkGame(a, [b]);
    const refused = await rematch(b, gameId);
    expect([refused.status, refused.body.error.code]).toEqual([400, "INVALID_INVITEES"]);
    expect((await addPlayer(a, gameId, b.id)).status).toBe(204);
    const asked = await rematch(b, gameId);
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(asked.body.game.status).toBe("active");
  });

  it("stays INVALID_INVITEES for another player: adding pairs the joiner with the creator only", async () => {
    const [a, b, c] = [await signUp(h, "Ann"), await signUp(h, "Bob"), await signUp(h, "Cy")];
    const gameId = await finishedLinkGame(a, [b], [c]);
    expect((await addPlayer(a, gameId, b.id)).status).toBe(204);
    const refused = await rematch(c, gameId);
    expect([refused.status, refused.body.error.code]).toEqual([400, "INVALID_INVITEES"]);
    expect(pairsOf(b, c)).toEqual(both(a, b).concat(both(a, c)).sort());
  });

  it("stays INVALID_INVITEES after a yes across a block: the add wrote nothing", async () => {
    const [a, b] = [await signUp(h, "Ann"), await signUp(h, "Bob")];
    const gameId = await finishedLinkGame(a, [b]);
    block(b, a);
    expect((await addPlayer(a, gameId, b.id)).status).toBe(204);
    const refused = await rematch(a, gameId);
    expect([refused.status, refused.body.error.code]).toEqual([400, "INVALID_INVITEES"]);
  });
});
