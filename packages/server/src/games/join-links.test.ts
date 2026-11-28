/**
 * Join links' rules as pure functions (docs/spec/06-auth.md §6.8, 02 §4, 08 T24, alpha A18): the
 * verdict a token gives one user, the join's writes, the creator's remove, and the lobby rules a
 * live link changes (no automatic start, no `declined` ending), plus the token helpers.
 */
import { type AnyGameDefinition, OK } from "@your-move/sdk";
import { describe, expect, it } from "vitest";

import type { GamePlayerRecord, GameRecord, JoinLinkTimes } from "../db/repositories.js";
import { hashJoinToken, joinUrl, linkTimes, newJoinToken } from "./join-links.js";
import {
  accept,
  cancel,
  decline,
  expire,
  type GameContext,
  isRefusal,
  joinVerdict,
  joinWrites,
  LOBBY_LIFETIME_MS,
  openSeats,
  removeSeat,
  start,
  startAtCreation,
} from "./lifecycle.js";
import { cryptoRandom } from "./random.js";

const DAY = 86_400_000;
const CREATED = 1_000_000;
const NOW = CREATED + DAY;

function row(
  id: string,
  state: GamePlayerRecord["state"],
  overrides: Partial<GamePlayerRecord> = {},
): GamePlayerRecord {
  return {
    id,
    gameId: "g",
    seat: null,
    userId: `u-${id}`,
    inviteEmail: null,
    state,
    outReason: null,
    joinedVia: null,
    delivery: "normal",
    removedAt: null,
    joinedAt: state === "joined" ? CREATED : null,
    toAct: 0,
    toActSince: null,
    actedOnce: 0,
    rank: null,
    score: null,
    lastSeenVersion: 0,
    lastNudgedAt: null,
    timeoutRemindersSent: 0,
    ...overrides,
  };
}

function lobby(seats: number, overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: "g",
    status: "lobby",
    createdAt: CREATED,
    seats,
    aiAssistance: "off",
    seatOrder: "join",
    version: 7,
    gameType: "t",
    gameVersion: 1,
    options: "{}",
    ...overrides,
  } as GameRecord;
}

const creator = row("a", "joined", { joinedVia: "creator" });
const LINK: JoinLinkTimes = { createdAt: CREATED + 1000, expiresAt: CREATED + 7 * DAY };

function ctxOf(
  game: GameRecord,
  players: readonly GamePlayerRecord[],
  joinLink: JoinLinkTimes | null,
): GameContext {
  return {
    game,
    players,
    definition: {
      players: () => ({ min: 2, max: 4 }),
      validateStart: () => OK,
      setup: () => ({}),
      toAct: () => [0],
    } as unknown as AnyGameDefinition,
    options: {},
    state: null,
    random: cryptoRandom(),
    joinLink,
  };
}

describe("joinVerdict (06 §6.8)", () => {
  const verdict = (
    players: readonly GamePlayerRecord[],
    options: {
      readonly userId?: string;
      readonly blocked?: boolean;
      readonly now?: number;
      readonly game?: GameRecord;
      readonly link?: JoinLinkTimes;
    } = {},
  ) =>
    joinVerdict(options.game ?? lobby(3), players, options.link ?? LINK, {
      userId: options.userId ?? "u-z",
      blocked: options.blocked ?? false,
      now: options.now ?? NOW,
    });

  it("gives someone with no row an open seat", () => {
    expect(verdict([creator])).toEqual({ kind: "seat" });
  });

  it.each([
    ["an expired link", { now: LINK.expiresAt }],
    [
      "a lobby past its 14 days",
      { now: CREATED + LOBBY_LIFETIME_MS, link: { ...LINK, expiresAt: Infinity } },
    ],
    ["a game that started", { game: lobby(3, { status: "active" }) }],
    ["a cancelled lobby", { game: lobby(3, { status: "cancelled" }) }],
    ["a block with anyone holding a row", { blocked: true }],
  ] as const)("refuses %s", (_name, options) => {
    expect(verdict([creator], options)).toEqual({ kind: "refused" });
  });

  it("refuses a full game: every seat held by an invited or joined row, of any delivery", () => {
    const full = [
      creator,
      row("b", "joined", { joinedVia: "join_link" }),
      row("c", "invited", { userId: null, inviteEmail: "c@example.org", delivery: "inert" }),
    ];
    expect(openSeats(lobby(3), full)).toBe(0);
    expect(verdict(full)).toEqual({ kind: "refused" });
    // A declined, left or removed row frees its seat.
    const freed = [...full.slice(0, 2), row("c", "declined", { userId: null })];
    expect(openSeats(lobby(3), freed)).toBe(1);
    expect(verdict(freed)).toEqual({ kind: "seat" });
  });

  it("says an already joined user (the creator too) is a member, whatever else holds", () => {
    expect(verdict([creator], { userId: "u-a" })).toEqual({ kind: "member" });
    expect(verdict([creator, row("b", "joined")], { userId: "u-b", blocked: true })).toEqual({
      kind: "member",
    });
  });

  it("accepts the viewer's own normal or hidden invitation, even with no seat open", () => {
    for (const delivery of ["normal", "hidden"] as const) {
      const invitation = row("b", "invited", { delivery, inviteEmail: "b@example.org" });
      expect(verdict([creator, invitation], { userId: "u-b", game: lobby(2) })).toEqual({
        kind: "accept",
        row: invitation,
      });
    }
  });

  it("never accepts an inert row, nor seats its holder elsewhere", () => {
    const inert = row("b", "invited", { delivery: "inert" });
    expect(verdict([creator, inert], { userId: "u-b", game: lobby(4) })).toEqual({
      kind: "refused",
    });
  });

  it.each(["declined", "left"] as const)("never lets back someone who %s", (state) => {
    expect(verdict([creator, row("b", state)], { userId: "u-b" })).toEqual({ kind: "refused" });
  });

  it("never lets back someone the creator removed, through this link or any later one (A18-S-3)", () => {
    for (const removedAt of [LINK.createdAt - DAY, LINK.createdAt, LINK.createdAt + 5]) {
      const removed = row("b", "removed", { removedAt });
      expect(verdict([creator, removed], { userId: "u-b", game: lobby(4) })).toEqual({
        kind: "refused",
      });
    }
  });

  it("refuses every link of a lobby whose creator's account was deleted (A18-S-1)", () => {
    const orphaned = row("a", "joined", { joinedVia: "creator", userId: null });
    expect(verdict([orphaned])).toEqual({ kind: "refused" });
    expect(verdict([orphaned, row("b", "invited")], { userId: "u-b" })).toEqual({
      kind: "refused",
    });
  });

  it("refuses a blocked invitee and a blocked removed row too", () => {
    const invitation = row("b", "invited");
    expect(verdict([creator, invitation], { userId: "u-b", blocked: true })).toEqual({
      kind: "refused",
    });
    const before = row("b", "removed", { removedAt: 1 });
    expect(verdict([creator, before], { userId: "u-b", blocked: true })).toEqual({
      kind: "refused",
    });
  });
});

describe("joinWrites (05 POST /api/v1/join)", () => {
  const game = lobby(3);

  it("takes a seat on a new joined row, marked as a link join and seen by its joiner", () => {
    expect(joinWrites(game, { kind: "seat" }, { userId: "u-z", newRowId: "n", now: NOW })).toEqual({
      game: { updatedAt: NOW },
      insertPlayers: [
        {
          id: "n",
          userId: "u-z",
          state: "joined",
          joinedVia: "join_link",
          joinedAt: NOW,
          lastSeenVersion: 8,
        },
      ],
    });
  });

  it("accepts an invitation as an accept would (joined_via invitation), its address cleared", () => {
    const invitation = row("b", "invited", { inviteEmail: "b@example.org" });
    const writes = joinWrites(
      game,
      { kind: "accept", row: invitation },
      { userId: "u-b", newRowId: "n", now: NOW },
    );
    expect(writes.updatePlayers).toEqual([
      {
        id: "b",
        set: {
          state: "joined",
          joinedVia: "invitation",
          joinedAt: NOW,
          inviteEmail: null,
          lastSeenVersion: 8,
        },
      },
    ]);
    expect(writes.insertPlayers).toBeUndefined();
  });

  it("accepts exactly as the Accept button does", () => {
    const invitation = row("b", "invited", { inviteEmail: "b@example.org", delivery: "hidden" });
    const byButton = accept(ctxOf(lobby(3), [creator, invitation], null), invitation, NOW);
    const byLink = joinWrites(
      game,
      { kind: "accept", row: invitation },
      { userId: "u-b", newRowId: "n", now: NOW },
    );
    const { lastSeenVersion, ...set } = byLink.updatePlayers?.[0]?.set ?? {};
    expect(lastSeenVersion).toBe(8);
    expect(isRefusal(byButton) ? null : byButton.updatePlayers?.[0]?.set).toEqual(set);
  });

  it("never starts the game, writes nothing to the game but the time, and leaves the link", () => {
    for (const writes of [
      joinWrites(game, { kind: "seat" }, { userId: "u-z", newRowId: "n", now: NOW }),
      joinWrites(
        game,
        { kind: "accept", row: row("b", "invited") },
        { userId: "u-b", newRowId: "n", now: NOW },
      ),
    ]) {
      expect(writes.game).toEqual({ updatedAt: NOW });
      expect(writes.deleteJoinLink).toBeUndefined();
    }
  });
});

describe("the automatic start with a join link (02 §4 Start, 08 T24)", () => {
  const invited = row("b", "invited");

  it("doesn't happen on the last accept while a link is live", () => {
    const writes = accept(ctxOf(lobby(2), [creator, invited], LINK), invited, NOW);
    expect(isRefusal(writes) ? null : writes.game).toEqual({ updatedAt: NOW });
  });

  it("does once the link has expired or there is none", () => {
    for (const link of [null, { ...LINK, expiresAt: NOW }]) {
      const writes = accept(ctxOf(lobby(2), [creator, invited], link), invited, NOW);
      expect(isRefusal(writes) ? null : writes.game.status).toBe("active");
    }
  });

  it("never happens once anyone has joined through a link, even after the link is revoked", () => {
    const linkJoiner = row("c", "joined", { joinedVia: "join_link" });
    const writes = accept(ctxOf(lobby(3), [creator, linkJoiner, invited], null), invited, NOW);
    expect(isRefusal(writes) ? null : writes.game).toEqual({ updatedAt: NOW });
  });

  it("doesn't start a game created full with a link asked for", () => {
    const added = row("b", "joined", { joinedVia: "added" });
    expect(startAtCreation(ctxOf(lobby(2), [creator, added], LINK), NOW)).toBeNull();
    expect(startAtCreation(ctxOf(lobby(2), [creator, added], null), NOW)).not.toBeNull();
  });

  it("is the creator's to make: Start works with a link joiner, and deletes the link", () => {
    const linkJoiner = row("c", "joined", { joinedVia: "join_link" });
    const writes = start(ctxOf(lobby(3), [creator, linkJoiner], LINK), creator, NOW);
    expect(isRefusal(writes) ? null : [writes.game.status, writes.deleteJoinLink]).toEqual([
      "active",
      true,
    ]);
  });
});

describe("lobby endings and a live link (02 §4 Decline, 06 §6.8)", () => {
  const joined = row("b", "joined", { joinedVia: "join_link" });

  it("a decline doesn't end the lobby while a link is live, and does once it isn't", () => {
    const live = decline(ctxOf(lobby(2), [creator, joined], LINK), joined, NOW);
    expect(isRefusal(live) ? null : "game" in live ? live.game : null).toEqual({ updatedAt: NOW });
    const gone = decline(ctxOf(lobby(2), [creator, joined], null), joined, NOW);
    expect(
      isRefusal(gone) || !("game" in gone) ? null : [gone.game.status, gone.deleteJoinLink],
    ).toEqual(["declined", true]);
  });

  it("cancel and expiry delete the link with the lobby", () => {
    const ctx = ctxOf(lobby(2), [creator, joined], LINK);
    const cancelled = cancel(ctx, creator, NOW);
    expect(isRefusal(cancelled) ? null : cancelled.deleteJoinLink).toBe(true);
    expect(expire(ctx.game, ctx.players, CREATED + LOBBY_LIFETIME_MS)?.deleteJoinLink).toBe(true);
  });
});

describe("removeSeat (05 POST /remove-seat)", () => {
  const typed = row("b", "invited", { inviteEmail: "b@example.org" });
  const joined = row("c", "joined", { joinedVia: "join_link" });
  const declined = row("d", "declined");
  const players = [creator, typed, joined, declined];
  const ctx = ctxOf(lobby(4), players, LINK);

  it("removes an invited or joined row, its address cleared, never ending or starting the lobby", () => {
    for (const target of [typed, joined]) {
      expect(removeSeat(ctx, creator, target.id, NOW)).toEqual({
        game: { updatedAt: NOW },
        updatePlayers: [
          { id: target.id, set: { state: "removed", removedAt: NOW, inviteEmail: null } },
        ],
      });
    }
  });

  it("is the creator's alone, only in an open lobby", () => {
    expect(removeSeat(ctx, joined, typed.id, NOW)).toEqual({ refused: "NOT_ALLOWED" });
    const started = ctxOf(lobby(4, { status: "active" }), players, null);
    expect(removeSeat(started, creator, typed.id, NOW)).toEqual({ refused: "WRONG_STATUS" });
    expect(removeSeat(ctx, creator, typed.id, CREATED + LOBBY_LIFETIME_MS)).toEqual({
      refused: "WRONG_STATUS",
    });
  });

  it("is 404 for the creator's own row, a row of another game, or one already out", () => {
    for (const id of [creator.id, "elsewhere", declined.id]) {
      expect(removeSeat(ctx, creator, id, NOW)).toEqual({ refused: "NOT_FOUND" });
    }
  });
});

describe("join-link tokens (08 T24)", () => {
  it("are 128 random bits as 22 base64url characters, a new one each time", () => {
    const tokens = new Set(Array.from({ length: 50 }, () => newJoinToken()));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it("are stored only as their SHA-256 (the known digest of a fixed input)", async () => {
    expect(await hashJoinToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("travel in the URL's fragment", () => {
    expect(joinUrl("https://play.example.org", "TOKEN")).toBe(
      "https://play.example.org/join#TOKEN",
    );
  });

  it("live 7 days, never past the lobby's expiry", () => {
    expect(linkTimes({ createdAt: CREATED }, CREATED)).toEqual({
      createdAt: CREATED,
      expiresAt: CREATED + 7 * DAY,
    });
    const late = CREATED + 10 * DAY;
    expect(linkTimes({ createdAt: CREATED }, late).expiresAt).toBe(CREATED + LOBBY_LIFETIME_MS);
  });
});
