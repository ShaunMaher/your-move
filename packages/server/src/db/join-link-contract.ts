/**
 * The join-link half of the repository contract suite (docs/spec/04-data-model.md `join_links`,
 * 06 §6.8, alpha A18): a link created with its game, read with it by its times only, found by its
 * token's hash, rotated and revoked without touching the game row, written only into a lobby,
 * deleted by the transition that ends the lobby (only if it wins) and by the sweep once expired.
 * Run against every adapter; the database is shared, so each check looks only at its own rows.
 */
import { describe, expect, it } from "vitest";

import { address } from "./auth-contract.js";
import type { GameWriteSet, NewGame, Repositories } from "./repositories.js";

const DAY = 24 * 60 * 60 * 1000;
/** After every other suite's rows, so the sweep's cut-off here can't reach theirs by accident. */
const LATER = Date.UTC(2032, 0, 1);

interface JoinLinkTarget {
  readonly repos: Repositories;
  sql(statement: string, ...params: (string | number | null)[]): Promise<Record<string, unknown>[]>;
}

/** A fresh 64-hex stand-in for a token's SHA-256. */
function freshHash(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "").slice(0, 64);
}

function newGame(status: NewGame["status"] = "lobby"): NewGame {
  return {
    id: crypto.randomUUID(),
    gameType: "contract",
    gameVersion: 1,
    options: "{}",
    status,
    seats: 3,
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    lastActionAt: LATER,
    createdAt: LATER,
    updatedAt: LATER,
  };
}

export function joinLinkRepositoryContract(target: () => JoinLinkTarget): void {
  const repos = (): Repositories => target().repos;

  /** A lobby with one joined row and, unless `link` is null, a link of these times. */
  async function lobby(
    link: { tokenHash: string; createdAt: number; expiresAt: number } | null = {
      tokenHash: freshHash(),
      createdAt: LATER,
      expiresAt: LATER + 7 * DAY,
    },
    status: NewGame["status"] = "lobby",
  ) {
    const game = newGame(status);
    await repos().games.create(
      game,
      [{ id: crypto.randomUUID(), state: "joined", joinedVia: "creator", joinedAt: LATER }],
      link === null ? {} : { joinLink: link },
    );
    return { gameId: game.id, link };
  }

  const rowsOf = async (gameId: string) =>
    target().sql(
      "SELECT token_hash, created_at, expires_at FROM join_links WHERE game_id = ?",
      gameId,
    );

  describe("join links (04 join_links)", () => {
    it("are created with their game and loaded with it by their times alone", async () => {
      const { gameId, link } = await lobby();
      const loaded = await repos().games.load(gameId);
      expect(loaded?.joinLink).toEqual({ createdAt: LATER, expiresAt: LATER + 7 * DAY });
      expect(loaded === null ? [] : Object.keys(loaded.joinLink ?? {})).not.toContain("tokenHash");
      expect(await repos().joinLinks.find(link?.tokenHash ?? "")).toEqual({
        gameId,
        createdAt: LATER,
        expiresAt: LATER + 7 * DAY,
      });
      const { gameId: bare } = await lobby(null);
      expect((await repos().games.load(bare))?.joinLink).toBeNull();
    });

    it("are found by their hash only: another hash finds nothing", async () => {
      await lobby();
      expect(await repos().joinLinks.find(freshHash())).toBeNull();
    });

    it("rotate in place: a new hash and a newer time, the old one gone, the game row untouched", async () => {
      const { gameId, link } = await lobby();
      const before = await repos().games.get(gameId);
      const next = { tokenHash: freshHash(), createdAt: LATER + DAY, expiresAt: LATER + 8 * DAY };
      expect(await repos().joinLinks.put(gameId, next)).toBe(true);
      expect(await repos().joinLinks.find(link?.tokenHash ?? "")).toBeNull();
      expect(await repos().joinLinks.find(next.tokenHash)).toEqual({
        gameId,
        createdAt: next.createdAt,
        expiresAt: next.expiresAt,
      });
      expect(await rowsOf(gameId)).toHaveLength(1);
      expect(await repos().games.get(gameId)).toEqual(before);
    });

    it("are created in a lobby that had none", async () => {
      const { gameId } = await lobby(null);
      const link = { tokenHash: freshHash(), createdAt: LATER, expiresAt: LATER + DAY };
      expect(await repos().joinLinks.put(gameId, link)).toBe(true);
      expect((await repos().games.load(gameId))?.joinLink).toEqual({
        createdAt: LATER,
        expiresAt: LATER + DAY,
      });
    });

    it.each(["active", "cancelled", "finished"] as const)(
      "are never written into a game that is %s, nor into one that doesn't exist",
      async (status) => {
        const { gameId } = await lobby(null, status);
        const link = { tokenHash: freshHash(), createdAt: LATER, expiresAt: LATER + DAY };
        expect(await repos().joinLinks.put(gameId, link)).toBe(false);
        expect(await rowsOf(gameId)).toEqual([]);
        expect(await repos().joinLinks.put(crypto.randomUUID(), link)).toBe(false);
        expect(await repos().joinLinks.find(link.tokenHash)).toBeNull();
      },
    );

    it("are revoked, and revoking again changes nothing", async () => {
      const { gameId, link } = await lobby();
      await repos().joinLinks.revoke(gameId);
      await repos().joinLinks.revoke(gameId);
      expect(await repos().joinLinks.find(link?.tokenHash ?? "")).toBeNull();
      expect((await repos().games.load(gameId))?.joinLink).toBeNull();
    });

    it("are deleted by the transition that ends the lobby, only when it wins", async () => {
      const { gameId, link } = await lobby();
      const ending: GameWriteSet = {
        deleteJoinLink: true,
        game: { status: "cancelled", endReason: "cancelled", endedAt: LATER, updatedAt: LATER },
      };
      expect(await repos().games.applyTransition(gameId, 5, ending)).toBe("stale");
      expect(await repos().joinLinks.find(link?.tokenHash ?? "")).not.toBeNull();
      expect(await repos().games.applyTransition(gameId, 0, ending)).toBe("ok");
      expect(await repos().joinLinks.find(link?.tokenHash ?? "")).toBeNull();
    });

    it("are kept by a transition that doesn't end the lobby", async () => {
      const { gameId, link } = await lobby();
      expect(await repos().games.applyTransition(gameId, 0, { game: { updatedAt: LATER } })).toBe(
        "ok",
      );
      expect(await repos().joinLinks.find(link?.tokenHash ?? "")).not.toBeNull();
    });

    it("hold a join to the link it was judged by: revoked, rotated or expired, the join is stale", async () => {
      const join = (tokenHash: string, now: number): GameWriteSet => ({
        game: { updatedAt: now },
        insertPlayers: [
          { id: crypto.randomUUID(), state: "joined", joinedVia: "join_link", joinedAt: now },
        ],
        requireJoinLink: { tokenHash, now },
      });
      const rowCount = async (gameId: string) =>
        (
          await target().sql("SELECT count(*) AS n FROM game_players WHERE game_id = ?", gameId)
        )[0]?.["n"];

      const live = await lobby();
      const hash = live.link?.tokenHash ?? "";
      expect(await repos().games.applyTransition(live.gameId, 0, join(hash, LATER + DAY))).toBe(
        "ok",
      );
      expect(await rowCount(live.gameId)).toBe(2);

      const revoked = await lobby();
      await repos().joinLinks.revoke(revoked.gameId);
      const stale = join(revoked.link?.tokenHash ?? "", LATER + DAY);
      expect(await repos().games.applyTransition(revoked.gameId, 0, stale)).toBe("stale");
      expect(await rowCount(revoked.gameId)).toBe(1);
      expect((await repos().games.get(revoked.gameId))?.version).toBe(0);

      const rotated = await lobby();
      await repos().joinLinks.put(rotated.gameId, {
        tokenHash: freshHash(),
        createdAt: LATER + 1,
        expiresAt: LATER + DAY,
      });
      const old = join(rotated.link?.tokenHash ?? "", LATER + 2);
      expect(await repos().games.applyTransition(rotated.gameId, 0, old)).toBe("stale");

      const expired = await lobby();
      const late = join(expired.link?.tokenHash ?? "", LATER + 7 * DAY);
      expect(await repos().games.applyTransition(expired.gameId, 0, late)).toBe("stale");
      expect(await rowCount(expired.gameId)).toBe(1);
    });

    it("go with the account of the lobby's creator, and only of lobbies it created (A18-S-1)", async () => {
      const id = crypto.randomUUID();
      const email = address(id);
      await repos().users.create({ id, email, createdAt: LATER, updatedAt: LATER });
      const withLink = async (joinedVia: "creator" | "join_link", status: NewGame["status"]) => {
        const game = newGame(status);
        const tokenHash = freshHash();
        await repos().games.create(
          game,
          [
            {
              id: crypto.randomUUID(),
              userId: joinedVia === "creator" ? id : null,
              state: "joined",
              joinedVia: "creator",
              joinedAt: LATER,
            },
            ...(joinedVia === "join_link"
              ? [
                  {
                    id: crypto.randomUUID(),
                    userId: id,
                    state: "joined" as const,
                    joinedVia,
                    joinedAt: LATER,
                  },
                ]
              : []),
          ],
          { joinLink: { tokenHash, createdAt: LATER, expiresAt: LATER + DAY } },
        );
        return game.id;
      };
      const created = await withLink("creator", "lobby");
      const joined = await withLink("join_link", "lobby");
      const bystander = await lobby();
      await repos().users.deleteAccount(
        { id, email },
        { userId: id, type: "account_deleted", ipHash: null, createdAt: LATER },
      );
      expect(await rowsOf(created)).toEqual([]);
      expect(await rowsOf(joined)).toHaveLength(1);
      expect(await rowsOf(bystander.gameId)).toHaveLength(1);
      // The lobby stays (its cancel is 04's step 2, M4); its creator row has no user any more.
      const players = await target().sql(
        "SELECT user_id FROM game_players WHERE game_id = ? AND joined_via = 'creator'",
        created,
      );
      expect(players).toEqual([{ user_id: null }]);
    });

    it("are swept once expired, longest expired first, at most the limit a run", async () => {
      const cutoff = LATER + 1000 * DAY;
      // Every earlier link of the shared database out of the way first.
      await repos().joinLinks.deleteExpired(cutoff - 10, 1_000_000);
      const at = (expiresAt: number) =>
        lobby({ tokenHash: freshHash(), createdAt: LATER, expiresAt });
      const oldest = await at(cutoff - 3);
      const older = await at(cutoff - 2);
      const due = await at(cutoff);
      const live = await at(cutoff + 1);
      expect(await repos().joinLinks.deleteExpired(cutoff, 2)).toBe(2);
      expect(await rowsOf(oldest.gameId)).toEqual([]);
      expect(await rowsOf(older.gameId)).toEqual([]);
      expect(await rowsOf(due.gameId)).toHaveLength(1);
      expect(await repos().joinLinks.deleteExpired(cutoff, 10)).toBe(1);
      expect(await rowsOf(due.gameId)).toEqual([]);
      expect(await rowsOf(live.gameId)).toHaveLength(1);
    });
  });
}
