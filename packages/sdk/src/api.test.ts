import { describe, expect, it } from "vitest";

import { gameEnvelopeSchema, submitResultSchema, textSchema } from "./api.js";

const envelope = {
  id: "g1",
  gameType: "example",
  gameVersion: 1,
  options: {},
  status: "active",
  version: 3,
  endReason: null,
  turnTimeoutDays: 7,
  seatOrder: "join",
  aiAssistance: "off",
  available: true,
  resources: [],
  players: [
    {
      seat: 0,
      userId: "u1",
      displayName: "Ann",
      kind: "human",
      state: "playing",
      isYou: true,
      isCreator: true,
    },
  ],
  yourSeat: 0,
  toAct: [0],
  yourTurn: true,
  yourInvitation: null,
  createdAt: 1,
  lastActionAt: null,
};

describe("client-facing API schemas", () => {
  it("accepts a valid envelope and a submit result carrying it", () => {
    expect(gameEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(submitResultSchema.parse({ ok: true, game: envelope, view: { any: 1 } }).ok).toBe(true);
  });

  it("accepts both error shapes", () => {
    expect(submitResultSchema.safeParse({ ok: false, error: { code: "BAD_CARD" } }).success).toBe(
      true,
    );
    expect(
      submitResultSchema.safeParse({ ok: false, error: { code: "STALE_GAME", message: "Reload" } })
        .success,
    ).toBe(true);
  });

  it("rejects a turn timeout outside 1–30 days", () => {
    expect(gameEnvelopeSchema.safeParse({ ...envelope, turnTimeoutDays: 31 }).success).toBe(false);
  });

  it("allows text of strings and seat placeholders only", () => {
    expect(textSchema.safeParse([{ seat: 0 }, " played"]).success).toBe(true);
    expect(textSchema.safeParse([{ seat: -1 }]).success).toBe(false);
    expect(textSchema.safeParse([{ seat: 0, name: "x" }]).success).toBe(false);
  });
});
