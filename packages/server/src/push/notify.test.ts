/**
 * Who a transition pushes to, and what the push says (03 §7, 02 §8, 08 T18): "your turn" for seats
 * whose clock started, "game over" when an `active` game ends, never the actor, never a lobby
 * event; text from `describe` and display names only.
 */
import type { Text } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import type { GamePlayerRecord, GameRecord, GameWriteSet, LoadedGame } from "../db/repositories.js";
import type { Platform } from "../platform.js";
import {
  addedMessage,
  interleaveByRecipient,
  type PushedTransition,
  pushMessage,
  sendTransitionPushes,
  transitionPushes,
} from "./notify.js";

const T0 = Date.UTC(2026, 0, 1);

function game(status: GameRecord["status"]): GameRecord {
  return {
    id: "game-1",
    gameType: "words",
    gameVersion: 1,
    options: "{}",
    status,
    createdBy: "alice",
    seats: 3,
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    state: '{"secret":"QUIZ rack"}',
    setupRng: null,
    finalViews: null,
    version: 4,
    writeToken: null,
    actionCount: 3,
    lastActionAt: T0,
    endReason: null,
    createdAt: T0,
    updatedAt: T0,
    startedAt: T0,
    endedAt: null,
    rematchGameId: null,
  };
}

function row(id: string, overrides: Partial<GamePlayerRecord>): GamePlayerRecord {
  return {
    id,
    gameId: "game-1",
    seat: null,
    userId: id,
    inviteEmail: null,
    state: "playing",
    outReason: null,
    joinedVia: "added",
    delivery: "normal",
    removedAt: null,
    joinedAt: T0,
    toAct: 0,
    toActSince: null,
    actedOnce: 1,
    rank: null,
    score: null,
    lastSeenVersion: 0,
    lastNudgedAt: null,
    timeoutRemindersSent: 0,
    ...overrides,
  };
}

/** Alice (seat 0, to act), Bob (seat 1) and Cara (seat 2) in an active game. */
const ACTIVE: LoadedGame = {
  game: game("active"),
  players: [
    row("alice", { seat: 0, toAct: 1, toActSince: T0, joinedVia: "creator" }),
    row("bob", { seat: 1 }),
    row("cara", { seat: 2 }),
  ],
  joinLink: null,
};

const PLAYED: Text = [{ seat: 0 }, " played QUIZ for 64"];

function transition(
  before: LoadedGame,
  writes: GameWriteSet,
  actorUserId: string,
  describe: Text | null = null,
): PushedTransition {
  return { before, writes, actorUserId, describe };
}

/** Alice moves; the turn passes to Bob. */
const MOVE = transition(
  ACTIVE,
  {
    game: { updatedAt: T0 + 1 },
    updatePlayers: [
      { id: "alice", set: { toAct: 0, toActSince: null } },
      { id: "bob", set: { toAct: 1, toActSince: T0 + 1, timeoutRemindersSent: 0 } },
    ],
  },
  "alice",
  PLAYED,
);

const USERS = new Map([
  ["alice", { displayName: "Alice" }],
  ["bob", { displayName: "Bob" }],
  ["cara", { displayName: null }],
]);

describe("transitionPushes", () => {
  it("tells the seat whose clock started that it's their turn, and nobody else", () => {
    expect(transitionPushes(MOVE)).toEqual([{ userId: "bob", seat: 1, kind: "turn" }]);
  });

  it("never pushes to the actor, even when their own clock restarts (a phase)", () => {
    const restart = transition(
      ACTIVE,
      {
        game: { updatedAt: T0 + 1 },
        updatePlayers: [
          { id: "alice", set: { toAct: 1, toActSince: T0 + 1 } },
          { id: "cara", set: { toAct: 1, toActSince: T0 + 1 } },
        ],
      },
      "alice",
      PLAYED,
    );
    expect(transitionPushes(restart)).toEqual([{ userId: "cara", seat: 2, kind: "turn" }]);
  });

  it("doesn't push to a seat that stays in toAct with its clock running", () => {
    const stays = transition(
      {
        ...ACTIVE,
        players: ACTIVE.players.map((p) =>
          p.id === "cara" ? { ...p, toAct: 1, toActSince: T0 } : p,
        ),
      },
      {
        game: { updatedAt: T0 + 1 },
        updatePlayers: [{ id: "alice", set: { toAct: 0, toActSince: null } }],
      },
      "alice",
      PLAYED,
    );
    expect(transitionPushes(stays)).toEqual([]);
  });

  it("tells every seated player but the actor when an active game finishes", () => {
    const finish = transition(
      {
        ...ACTIVE,
        players: [
          ...ACTIVE.players.slice(0, 2),
          row("cara", { seat: 2, state: "out", outReason: "resigned" }),
        ],
      },
      {
        game: { status: "finished", endReason: "outOfTiles", updatedAt: T0 + 1 },
        updatePlayers: [{ id: "alice", set: { toAct: 0, toActSince: null } }],
      },
      "alice",
      PLAYED,
    );
    expect(transitionPushes(finish)).toEqual([
      { userId: "bob", seat: 1, kind: "ended" },
      { userId: "cara", seat: 2, kind: "ended" },
    ]);
  });

  it("tells the others when a decline before a first action ends the game", () => {
    const declined = transition(
      ACTIVE,
      {
        game: { status: "declined", endReason: "declined", updatedAt: T0 + 1 },
        updatePlayers: [{ id: "bob", set: { state: "out", outReason: "declined" } }],
      },
      "bob",
    );
    expect(transitionPushes(declined).map((push) => [push.userId, push.kind])).toEqual([
      ["alice", "ended"],
      ["cara", "ended"],
    ]);
  });

  it("at the start, pushes to the first seat to act unless it started the game", () => {
    const lobby: LoadedGame = {
      game: game("lobby"),
      players: [
        row("alice", { joinedVia: "creator", state: "joined" }),
        row("bob", { state: "joined" }),
      ],
      joinLink: null,
    };
    const start = (actor: string) =>
      transition(
        lobby,
        {
          game: { status: "active", updatedAt: T0 + 1 },
          updatePlayers: [
            { id: "alice", set: { seat: 0, state: "playing", toAct: 1, toActSince: T0 + 1 } },
            { id: "bob", set: { seat: 1, state: "playing", toAct: 0, toActSince: null } },
          ],
        },
        actor,
      );
    // Bob's accept started it: Alice, first to act, is told.
    expect(transitionPushes(start("bob"))).toEqual([{ userId: "alice", seat: 0, kind: "turn" }]);
    // Alice pressed Start herself.
    expect(transitionPushes(start("alice"))).toEqual([]);
  });

  it.each([
    [
      "an accept that doesn't start",
      {
        game: { updatedAt: T0 + 1 },
        updatePlayers: [{ id: "bob", set: { state: "joined" as const } }],
      },
    ],
    [
      "a cancel",
      { game: { status: "cancelled" as const, endReason: "cancelled", updatedAt: T0 + 1 } },
    ],
    [
      "a lobby decline",
      {
        game: { status: "declined" as const, endReason: "declined", updatedAt: T0 + 1 },
        updatePlayers: [{ id: "bob", set: { state: "declined" as const } }],
      },
    ],
    [
      "an expiry",
      { game: { status: "expired" as const, endReason: "expired", updatedAt: T0 + 1 } },
    ],
  ])("sends nothing for a lobby event: %s", (_name, writes: GameWriteSet) => {
    const lobby: LoadedGame = {
      game: game("lobby"),
      players: [
        row("alice", { joinedVia: "creator", state: "joined" }),
        row("bob", { state: "invited" }),
        row("cara", { state: "joined" }),
      ],
      joinLink: null,
    };
    expect(transitionPushes(transition(lobby, writes, "bob"))).toEqual([]);
  });

  it("skips a seat whose account was deleted", () => {
    const deleted = transition(
      {
        ...ACTIVE,
        players: ACTIVE.players.map((p) => (p.id === "bob" ? { ...p, userId: null } : p)),
      },
      MOVE.writes,
      "alice",
      PLAYED,
    );
    expect(transitionPushes(deleted)).toEqual([]);
  });
});

describe("pushMessage (08 T18)", () => {
  it("is the describe text with names, then 'Your turn.', linking to the game", () => {
    expect(
      pushMessage(MOVE, { userId: "bob", seat: 1, kind: "turn" }, USERS, "Family Games"),
    ).toEqual({
      title: "Family Games",
      body: "Alice played QUIZ for 64. Your turn.",
      url: "/g/game-1",
      tag: "game-game-1",
    });
  });

  it("calls the recipient 'You' and a nameless player 'New player'", () => {
    const text: Text = [{ seat: 2 }, " passed, then ", { seat: 1 }, " looked"];
    expect(
      pushMessage({ ...MOVE, describe: text }, { userId: "bob", seat: 1, kind: "turn" }, USERS, "G")
        .body,
    ).toBe("New player passed, then You looked. Your turn.");
  });

  it("names a deleted account 'Deleted player'", () => {
    const users = new Map([["bob", { displayName: "Bob" }]]);
    expect(pushMessage(MOVE, { userId: "bob", seat: 1, kind: "turn" }, users, "G").body).toBe(
      "Deleted player played QUIZ for 64. Your turn.",
    );
  });

  it("says the game is over when it ended", () => {
    expect(pushMessage(MOVE, { userId: "cara", seat: 2, kind: "ended" }, USERS, "G").body).toBe(
      "Alice played QUIZ for 64. The game is over.",
    );
  });

  it("names the other players at the start, which has no describe text", () => {
    const start = transition(ACTIVE, MOVE.writes, "bob");
    expect(pushMessage(start, { userId: "alice", seat: 0, kind: "turn" }, USERS, "G").body).toBe(
      "Your game with Bob and New player has started. Your turn.",
    );
  });

  it("names whoever declined when a decline ended the game", () => {
    const declined = transition(ACTIVE, { game: { status: "declined", updatedAt: T0 } }, "bob");
    expect(
      pushMessage(declined, { userId: "alice", seat: 0, kind: "ended" }, USERS, "G").body,
    ).toBe("Bob declined the game, so it's over.");
  });

  it("never carries state, and cuts long text", () => {
    const long: Text = [{ seat: 0 }, ` said ${"word ".repeat(100)}`];
    const message = pushMessage(
      { ...MOVE, describe: long },
      { userId: "bob", seat: 1, kind: "turn" },
      USERS,
      "G",
    );
    expect(message.body.length).toBeLessThanOrEqual(240);
    expect(message.body.endsWith("…")).toBe(true);
    expect(
      JSON.stringify(pushMessage(MOVE, { userId: "bob", seat: 1, kind: "turn" }, USERS, "G")),
    ).not.toContain("rack");
  });
});

describe("addedMessage (alpha A12, 06 §6.2, T18)", () => {
  it("names the creator and nothing else, adding 'Your turn.' when it is", () => {
    expect(addedMessage("game-1", "Alice", false, "Games")).toEqual({
      title: "Games",
      body: "Alice added you to a game.",
      url: "/g/game-1",
      tag: "game-game-1",
    });
    expect(addedMessage("game-1", "Alice", true, "Games").body).toBe(
      "Alice added you to a game. Your turn.",
    );
  });

  it("says '<creator> wants a rematch.' for a rematch (alpha A15)", () => {
    expect(addedMessage("game-1", "Alice", false, "Games", true).body).toBe(
      "Alice wants a rematch.",
    );
    expect(addedMessage("game-1", "Alice", true, "Games", true).body).toBe(
      "Alice wants a rematch. Your turn.",
    );
  });

  it("cuts a long name like any other push text", () => {
    const body = addedMessage("g", "😀".repeat(300), true, "Games").body;
    expect(Array.from(body)).toHaveLength(240);
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("interleaveByRecipient (A8-S-3)", () => {
  const sub = (userId: string, n: number, useful: number) => ({
    id: `${userId}-${String(n)}`,
    userId,
    createdAt: useful,
    lastSuccessAt: null,
  });

  it("takes each recipient's devices in turn, most recently useful first", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, n) => sub("many", n, n)),
      sub("one", 0, 0),
      { ...sub("two", 0, 0), lastSuccessAt: 50 },
      sub("two", 1, 10),
    ];
    const order = interleaveByRecipient(rows, ["many", "one", "two"]).map((row) => row.id);
    expect(order.slice(0, 6)).toEqual(["many-9", "one-0", "two-0", "many-8", "two-1", "many-7"]);
    expect(order).toHaveLength(13);
    // A cut after the first three still reaches every recipient.
    expect(new Set(order.slice(0, 3).map((id) => id.split("-")[0]))).toEqual(
      new Set(["many", "one", "two"]),
    );
  });

  it("leaves out subscriptions of anyone not a recipient", () => {
    expect(interleaveByRecipient([sub("other", 0, 0)], ["many"])).toEqual([]);
  });
});

describe("cutting long text (A8-P-8)", () => {
  it("cuts by code point, never inside a surrogate pair", () => {
    const text: Text = [{ seat: 0 }, ` ${"🎲".repeat(300)}`];
    const body = pushMessage(
      { ...MOVE, describe: text },
      { userId: "bob", seat: 1, kind: "turn" },
      USERS,
      "G",
    ).body;
    expect(Array.from(body)).toHaveLength(240);
    expect(body.endsWith("🎲…")).toBe(true);
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });
});

describe("sendTransitionPushes and the per-transition cap (A8-R2-3)", () => {
  it("reaches every recipient when their devices are more than the cap", async () => {
    const ids = ["alice", "bob", "cara", "dan", "eve", "fay"];
    const before: LoadedGame = {
      game: { ...game("active"), seats: ids.length },
      players: ids.map((id, seat) => row(id, { seat, toAct: seat === 0 ? 1 : 0 })),
      joinLink: null,
    };
    const ended = transition(
      before,
      { game: { status: "finished", endReason: "done", updatedAt: T0 + 1 } },
      "alice",
      PLAYED,
    );
    // Five recipients with ten devices each, listed one recipient after another: 50 > 40.
    const subscriptions = ids.slice(1).flatMap((userId) =>
      Array.from({ length: 10 }, (_, n) => ({
        id: `${userId}-${String(n)}`,
        userId,
        sessionId: "s",
        endpoint: `https://fcm.googleapis.com/fcm/send/${userId}-${String(n)}`,
        p256dh: "p",
        auth: "a",
        createdAt: T0,
        lastSuccessAt: null,
      })),
    );
    const sentTo: string[] = [];
    const platform = {
      repos: {
        pushSubscriptions: {
          forUsers: () => Promise.resolve(subscriptions),
          delivered: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        },
        users: {
          findByIds: () => Promise.resolve(ids.map((id) => ({ id, displayName: id }))),
        },
      },
      push: {
        enabled: true,
        send: (target: { endpoint: string }) => {
          sentTo.push(target.endpoint);
          return Promise.resolve({ kind: "delivered" as const });
        },
      },
      config: { appName: "G" },
      now: () => new Date(T0),
      log: { warn: () => undefined, info: () => undefined },
    } as unknown as Platform;
    await sendTransitionPushes(platform, ended);
    expect(sentTo).toHaveLength(40);
    for (const userId of ids.slice(1)) {
      expect(sentTo.filter((endpoint) => endpoint.includes(`/${userId}-`)).length).toBe(8);
    }
  });
});
