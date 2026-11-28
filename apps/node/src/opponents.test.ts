/**
 * Past opponents picked from the list (alpha A12; docs/spec/06-auth.md §6.1, §6.2, §6.7, §6.9,
 * 02 §4, 05 `POST /api/v1/games` and `GET /api/v1/players/recent`): the list, adding a past
 * opponent by `userId` at once or by invitation, the start at creation, the refusals, the limits
 * and the blocks. The real app on a real SQLite database with the installed games.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  call,
  createGame,
  type ErrorBody,
  freshEmail,
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

const code = (body: unknown): string | undefined => (body as Partial<ErrorBody>).error?.code;

interface Recent {
  readonly players: readonly { userId: string; displayName: string; lastPlayedAt: number }[];
}

const recent = (player: Player) => call<Recent>(h, player, "GET", "/api/v1/players/recent");

/** Records `a` and `b` as past opponents, as a finished game would (04 `past_opponents`). */
function pastOpponents(a: Player, b: Player, at = now()): void {
  h.exec(
    "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?), (?, ?, ?)",
    a.id,
    b.id,
    at,
    b.id,
    a.id,
    at,
  );
}

/** `blocker` blocks `blocked` (04 `blocks`; nothing writes one through the API before M4). */
function block(blocker: Player, blocked: Player): void {
  h.exec(
    "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)",
    blocker.id,
    blocked.id,
    now(),
  );
}

const gameCount = (): unknown => h.query("SELECT count(*) AS n FROM games")[0]?.["n"];

const rowsOf = (gameId: string) =>
  h.query(
    "SELECT user_id, invite_email, state, joined_via, delivery, seat, last_seen_version FROM game_players WHERE game_id = ? ORDER BY rowid",
    gameId,
  );

describe("GET /api/v1/players/recent (05)", () => {
  it("lists the people you finished a game with, both having acted, once the game is over", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    expect((await recent(a)).body).toEqual({ players: [] });
    const created = await createGame(h, a, {
      gameType: "example",
      invitees: [{ email: b.email }],
    });
    await transition(h, b, created.id, "accept");
    expect((await recent(a)).body).toEqual({ players: [] });
    const finishedAt = now();
    await playExampleToEnd(h, created.id, [a, b]);
    expect((await getGame(h, a, created.id)).game.status).toBe("finished");
    expect((await recent(a)).body).toEqual({
      players: [{ userId: b.id, displayName: "Bo", lastPlayedAt: finishedAt }],
    });
    expect((await recent(b)).body).toEqual({
      players: [{ userId: a.id, displayName: "Ada", lastPlayedAt: finishedAt }],
    });
  });

  it("lists only the viewer's own pairs, newest first, at most 50", async () => {
    const a = await signUp(h, "Ada");
    const others: Player[] = [];
    // Inserted directly: signing 51 people in from one address would meet the per-IP limits.
    for (let i = 0; i < 51; i++) {
      const id = crypto.randomUUID();
      h.exec(
        "INSERT INTO users (id, email, display_name, onboarded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        freshEmail(),
        `P${String(i)}`,
        now(),
        now(),
        now(),
      );
      const other: Player = { id, email: "", cookie: "", name: `P${String(i)}` };
      pastOpponents(a, other, now() + i);
      others.push(other);
    }
    // Two other people's pair, which neither list of a's shows.
    const [c, d] = [await signUp(h, "Cy"), await signUp(h, "Di")];
    pastOpponents(c, d);
    const listed = (await recent(a)).body.players;
    expect(listed).toHaveLength(50);
    expect(listed.map((row) => row.userId)).toEqual(
      others
        .slice(1)
        .reverse()
        .map((other) => other.id),
    );
    expect(listed.map((row) => row.userId)).not.toContain(c.id);
    expect((await recent(c)).body.players.map((row) => row.userId)).toEqual([d.id]);
  });

  it("never lists anyone with a block between you, either way (06 §6.9)", async () => {
    const a = await signUp(h, "Ada");
    const [b, c, d] = [await signUp(h, "Bo"), await signUp(h, "Cy"), await signUp(h, "Di")];
    for (const other of [b, c, d]) pastOpponents(a, other);
    block(a, b);
    block(c, a);
    expect((await recent(a)).body.players.map((row) => row.userId)).toEqual([d.id]);
    expect((await recent(b)).body.players).toEqual([]);
  });

  it("needs a session and a finished onboarding", async () => {
    const response = await h.request("GET", "/api/v1/players/recent");
    expect(response.status).toBe(401);
    const halfway = await signUp(h, null);
    const answer = await recent(halfway);
    expect(answer.status).toBe(403);
    expect(code(answer.body)).toBe("ONBOARDING_REQUIRED");
  });
});

describe("adding a past opponent by userId (06 §6.1, §6.2)", () => {
  it("adds them at once and starts a game whose seats are all filled (05 Created)", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    const game = await createGame(h, a, { gameType: "words", invitees: [{ userId: b.id }] });
    expect(game).toMatchObject({ status: "active", version: 1, yourSeat: 0 });
    expect(game.players).toEqual([
      expect.objectContaining({ userId: a.id, state: "playing", seat: 0, isYou: true }),
      expect.objectContaining({ userId: b.id, displayName: "Bo", state: "playing", seat: 1 }),
    ]);
    expect(rowsOf(game.id)).toEqual([
      expect.objectContaining({ user_id: a.id, joined_via: "creator", last_seen_version: 1 }),
      // Unread for the added player until they open it.
      expect.objectContaining({ user_id: b.id, joined_via: "added", last_seen_version: -1 }),
    ]);
    const seen = await getGame(h, b, game.id);
    expect(seen.game.yourSeat).toBe(1);
    expect(seen.view).not.toBeNull();
    const listed = await call<{ games: { id: string; unread: boolean }[] }>(
      h,
      b,
      "GET",
      "/api/v1/games",
    );
    expect(listed.body.games).toEqual([expect.objectContaining({ id: game.id, unread: true })]);
    // The start is logged like any other: the state replays from the recorded draws.
    expect(h.query("SELECT setup_rng FROM games WHERE id = ?", game.id)[0]?.["setup_rng"]).not.toBe(
      null,
    );
  });

  it("seats past opponents in the order listed, creator first, and starts when all are in", async () => {
    const a = await signUp(h, "Ada");
    const [b, c] = [await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    pastOpponents(a, c);
    for (const order of [
      [c, b],
      [b, c],
    ]) {
      const game = await createGame(h, a, {
        gameType: "example",
        seats: 3,
        invitees: order.map((player) => ({ userId: player.id })),
      });
      expect(game.status).toBe("active");
      expect(game.players.map((player) => player.userId)).toEqual([
        a.id,
        ...order.map((p) => p.id),
      ]);
      h.advance(DAY);
    }
  });

  it("waits in the lobby while a typed address's seat is open: the picked one joined, the other invited", async () => {
    const a = await signUp(h, "Ada");
    const [b, c] = [await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: c.email }, { userId: b.id }],
    });
    expect(game.status).toBe("lobby");
    expect(game.players).toEqual([
      expect.objectContaining({ userId: a.id, state: "joined" }),
      expect.objectContaining({ userId: b.id, displayName: "Bo", state: "joined" }),
      expect.objectContaining({ userId: null, state: "invited", invitedAs: c.email }),
    ]);
    // c's accept fills the last seat, and the game starts by itself.
    const accepted = await transition(h, c, game.id, "accept");
    expect(accepted.body.game.status).toBe("active");
  });

  it("makes it an invitation when AI assistance is allowed: everyone accepts knowingly (02 §4)", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    const game = await createGame(h, a, {
      gameType: "words",
      aiAssistance: "allowed",
      invitees: [{ userId: b.id }],
    });
    expect(game.status).toBe("lobby");
    // The creator sees the name they picked; the row shows no name or id (05 §Who sees what).
    expect(game.players[1]).toEqual(
      expect.objectContaining({
        userId: null,
        displayName: null,
        state: "invited",
        invitedAs: "Bo",
      }),
    );
    expect(rowsOf(game.id)[1]).toMatchObject({
      user_id: b.id,
      state: "invited",
      delivery: "normal",
      joined_via: null,
      invite_email: null,
    });
    const seen = await getGame(h, b, game.id);
    expect(seen.game.yourInvitation).toBe("normal");
    // invitedAs is the creator's alone.
    expect(seen.game.players.every((p) => p.invitedAs === undefined)).toBe(true);
    // Accepting doesn't start it either: the creator presses Start (02 §4).
    const accepted = await transition(h, b, game.id, "accept");
    expect(accepted.body.game.status).toBe("lobby");
    expect((await transition(h, a, game.id, "start")).body.game.status).toBe("active");
  });

  it("makes it an invitation when their stored whoCanAddMe is nobody (A12-P-3, 06 §6.2)", async () => {
    const a = await signUp(h, "Ada");
    const [b, c] = [await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    pastOpponents(a, c);
    h.exec("UPDATE users SET settings = ? WHERE id = ?", '{"whoCanAddMe":"nobody"}', b.id);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ userId: b.id }, { userId: c.id }],
    });
    expect(game.status).toBe("lobby");
    expect(rowsOf(game.id).slice(1)).toEqual([
      expect.objectContaining({ user_id: b.id, state: "invited", delivery: "normal" }),
      expect.objectContaining({ user_id: c.id, state: "joined", joined_via: "added" }),
    ]);
    expect((await getGame(h, b, game.id)).game.yourInvitation).toBe("normal");
    // b's accept fills the last seat: the game starts.
    expect((await transition(h, b, game.id, "accept")).body.game.status).toBe("active");
  });

  it("shows nothing but the state once a picked invitation's lobby has ended", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    const game = await createGame(h, a, {
      gameType: "words",
      aiAssistance: "allowed",
      invitees: [{ userId: b.id }],
    });
    const cancelled = await transition(h, a, game.id, "cancel");
    expect(cancelled.body.game.status).toBe("cancelled");
    expect(cancelled.body.game.players[1]).toEqual(
      expect.objectContaining({ userId: null, displayName: null, state: "invited" }),
    );
    expect(cancelled.body.game.players[1]?.invitedAs).toBeUndefined();
  });

  it.each<[string, (a: Player, b: Player) => void]>([
    ["isn't a past opponent", () => undefined],
    [
      "is someone else's past opponent only",
      (_a, b) => {
        h.exec(
          "INSERT INTO past_opponents (user_id, other_id, last_finished_at) VALUES (?, ?, ?)",
          b.id,
          _a.id,
          now(),
        );
      },
    ],
    [
      "was blocked by the creator",
      (a, b) => {
        pastOpponents(a, b);
        block(a, b);
      },
    ],
    [
      "has blocked the creator",
      (a, b) => {
        pastOpponents(a, b);
        block(b, a);
      },
    ],
    [
      "hasn't finished onboarding",
      (a, b) => {
        pastOpponents(a, b);
        h.exec("UPDATE users SET onboarded_at = NULL WHERE id = ?", b.id);
      },
    ],
  ])(
    "refuses a userId that %s: INVALID_INVITEES, the same answer, nothing created",
    async (_name, arrange) => {
      const a = await signUp(h, "Ada");
      const b = await signUp(h, "Bo");
      arrange(a, b);
      const answer = await call(h, a, "POST", "/api/v1/games", {
        gameType: "words",
        invitees: [{ userId: b.id }],
      });
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({
        error: { code: "INVALID_INVITEES", message: expect.any(String) as string },
      });
      expect(gameCount()).toBe(0);
      // Refused before any limit is counted.
      expect(h.query("SELECT key FROM rate_limits WHERE key LIKE 'GAMES_CREATED%'")).toEqual([]);
    },
  );

  it("refuses an unknown id and a literal duplicate as INVALID_INVITEES, and the creator's own id as CANNOT_PLAY_SELF", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    for (const [invitees, expected] of [
      [[{ userId: crypto.randomUUID() }], "INVALID_INVITEES"],
      [[{ userId: b.id }, { userId: b.id }], "INVALID_INVITEES"],
      [[{ userId: a.id }], "CANNOT_PLAY_SELF"],
      [[{ userId: b.id }, { userId: b.id, email: b.email }], "BAD_REQUEST"],
    ] as const) {
      const answer = await call(h, a, "POST", "/api/v1/games", {
        gameType: "example",
        seats: 3,
        invitees,
      });
      expect([answer.status, code(answer.body)]).toEqual([400, expected]);
    }
    expect(gameCount()).toBe(0);
  });

  it("gives an address that resolves to a picked past opponent an inert email-only seat, whatever the order (06 §6.1)", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    for (const invitees of [
      [{ userId: b.id }, { email: b.email }],
      [{ email: b.email }, { userId: b.id }],
    ]) {
      const game = await createGame(h, a, { gameType: "example", seats: 3, invitees });
      // b is in by id; the typed address's seat looks like any other invitation to the creator.
      expect(game.status).toBe("lobby");
      const typed = game.players.find((player) => player.invitedAs === b.email);
      const unknown = await createGame(h, a, {
        gameType: "example",
        seats: 3,
        invitees: [{ userId: b.id }, { email: freshEmail() }],
      });
      const other = unknown.players.find((player) => player.invitedAs !== undefined);
      expect({ ...typed, playerId: undefined, invitedAs: undefined }).toEqual({
        ...other,
        playerId: undefined,
        invitedAs: undefined,
      });
      expect(rowsOf(game.id).slice(1)).toEqual([
        expect.objectContaining({ user_id: b.id, state: "joined", joined_via: "added" }),
        expect.objectContaining({
          user_id: null,
          invite_email: b.email,
          state: "invited",
          delivery: "inert",
        }),
      ]);
      // b holds one row, and the inert one gives nobody access.
      expect((await getGame(h, b, game.id)).game.yourInvitation).toBeNull();
      h.advance(DAY);
    }
  });
});

describe("blocks among the people added (06 §6.1)", () => {
  it("gives a typed address whose user has a block with a picked one an inert seat, the response unchanged", async () => {
    const a = await signUp(h, "Ada");
    const [b, d] = [await signUp(h, "Bo"), await signUp(h, "Di")];
    pastOpponents(a, b);
    block(d, b);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: d.email }, { userId: b.id }],
    });
    const control = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ email: freshEmail() }, { userId: b.id }],
    });
    const shape = (players: typeof game.players) =>
      players.map((player) => ({ ...player, playerId: undefined, invitedAs: undefined }));
    expect(shape(game.players)).toEqual(shape(control.players));
    expect(rowsOf(game.id)[2]).toMatchObject({
      user_id: d.id,
      state: "invited",
      delivery: "inert",
    });
    // d never sees it.
    const seen = await call(h, d, "GET", `/api/v1/games/${game.id}`);
    expect(seen.status).toBe(404);
  });

  // The creator's block makes d's seat inert; one between d and e makes the later one's.
  it.each<[string, (a: Player, d: Player, e: Player) => void, string[]]>([
    [
      "between the creator and the typed address's user",
      (a, d) => {
        block(d, a);
      },
      ["inert", "normal"],
    ],
    [
      "between the creator and the typed address's user, the creator blocking",
      (a, d) => {
        block(a, d);
      },
      ["inert", "normal"],
    ],
    [
      "between two typed addresses' users",
      (_a, d, e) => {
        block(e, d);
      },
      ["normal", "inert"],
    ],
  ])(
    "gives a typed address an inert seat for a block %s, the response unchanged (A12-P-2)",
    async (_name, arrange, deliveries) => {
      const a = await signUp(h, "Ada");
      const [d, e] = [await signUp(h, "Di"), await signUp(h, "Ed")];
      arrange(a, d, e);
      const game = await createGame(h, a, {
        gameType: "example",
        seats: 3,
        invitees: [{ email: d.email }, { email: e.email }],
      });
      const control = await createGame(h, a, {
        gameType: "example",
        seats: 3,
        invitees: [{ email: freshEmail() }, { email: freshEmail() }],
      });
      const shape = (players: typeof game.players) =>
        players.map((player) => ({ ...player, playerId: undefined, invitedAs: undefined }));
      expect(shape(game.players)).toEqual(shape(control.players));
      expect(game.players.map((player) => player.invitedAs)).toEqual([undefined, d.email, e.email]);
      expect(rowsOf(game.id).map((row) => row["delivery"])).toEqual(["normal", ...deliveries]);
      h.advance(DAY);
    },
  );

  // Today's behaviour, which tells the creator about a block between two people they picked
  // (06 §6.1, open-questions Q29). It MUST change in M4 before anything can write `blocks`:
  // the default there makes every pick an invitation when a request picks two or more.
  it("gives the later of two picked past opponents with a block between them an inert invitation", async () => {
    const a = await signUp(h, "Ada");
    const [b, c] = [await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    pastOpponents(a, c);
    block(b, c);
    const game = await createGame(h, a, {
      gameType: "example",
      seats: 3,
      invitees: [{ userId: b.id }, { userId: c.id }],
    });
    expect(game.status).toBe("lobby");
    expect(rowsOf(game.id).slice(1)).toEqual([
      expect.objectContaining({ user_id: b.id, state: "joined" }),
      expect.objectContaining({ user_id: c.id, state: "invited", delivery: "inert" }),
    ]);
    expect((await call(h, c, "GET", `/api/v1/games/${game.id}`)).status).toBe(404);
  });
});

describe("limits for picked past opponents (06 §6.7, 08 T20)", () => {
  it("caps live games per pair (creator, userId): TOO_MANY_GAMES past 5", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    for (let i = 0; i < 5; i++) {
      await createGame(h, a, { gameType: "words", invitees: [{ userId: b.id }] });
      h.advance(DAY);
    }
    const over = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ userId: b.id }],
    });
    expect([over.status, code(over.body)]).toEqual([409, "TOO_MANY_GAMES"]);
  });

  it("doesn't count invitations to b's typed address against the (creator, userId) pair (Q3)", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    for (let i = 0; i < 5; i++) {
      await createGame(h, a, { gameType: "words", invitees: [{ email: b.email }] });
      h.advance(DAY);
    }
    // Five live games with b's address: its emailId pair is full, the userId pair isn't.
    const typed = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ email: b.email }],
    });
    expect(code(typed.body)).toBe("TOO_MANY_GAMES");
    await createGame(h, a, { gameType: "words", invitees: [{ userId: b.id }] });
  });

  it("limits games created per pair per day, counted per userId", async () => {
    h.close();
    h = gameHarness({ LIMIT_GAMES_CREATED_PAIR_DAY: "2" });
    const a = await signUp(h, "Ada");
    const [b, c] = [await signUp(h, "Bo"), await signUp(h, "Cy")];
    pastOpponents(a, b);
    pastOpponents(a, c);
    for (let i = 0; i < 2; i++) {
      await createGame(h, a, { gameType: "words", invitees: [{ userId: b.id }] });
    }
    const over = await call(h, a, "POST", "/api/v1/games", {
      gameType: "words",
      invitees: [{ userId: b.id }],
    });
    expect([over.status, code(over.body)]).toEqual([429, "RATE_LIMITED"]);
    // Another pair is unaffected.
    await createGame(h, a, { gameType: "words", invitees: [{ userId: c.id }] });
  });

  it("counts no email invitee and no inbound invitation for a picked past opponent", async () => {
    const a = await signUp(h, "Ada");
    const b = await signUp(h, "Bo");
    pastOpponents(a, b);
    await createGame(h, a, { gameType: "words", invitees: [{ userId: b.id }] });
    const keys = h
      .query("SELECT key FROM rate_limits ORDER BY key")
      .map((row) => String(row["key"]).replace(/:.*$/u, ""));
    expect(keys.filter((key) => /EMAIL_INVITEES|INVITATIONS_RECEIVED/u.test(key))).toEqual([]);
    expect(keys).toContain("GAMES_CREATED_PAIR_DAY");
  });
});
