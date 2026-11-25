/**
 * The transition race suite (docs/spec/03-architecture.md §5.2, 10 M3): concurrent lifecycle
 * requests from one game version, through the real app over a runtime's repositories, so it runs
 * on both drivers. In every race exactly one request wins, the others answer `409 STALE_GAME`, and
 * the database holds exactly the winner's writes: the version moved by one, the log matches, and
 * replaying the log reproduces the stored state. Exported as `@your-move/server/testing`; never
 * part of a runtime build.
 *
 * The races use the reference game (`example`, 02 §7.6), passed in by the caller: this package
 * never imports a game.
 */
import type { GameEnvelope } from "@your-move/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normaliseAddress } from "../accounts/email.js";
import { createApp, type App } from "../app.js";
import { createSession } from "../auth/session.js";
import { parseConfig } from "../config/parse.js";
import type { Repositories } from "../db/repositories.js";
import type { ContractTarget } from "../db/repository-contract.js";
import { createConsoleEmailSender } from "../email/sender.js";
import { createJsonLogger } from "../log.js";
import type { InstalledGame } from "./registry.js";
import { replayState } from "./replay.js";
import { NO_DICTIONARIES } from "./resources.js";

const ORIGIN = "https://play.example.org";
const ENV = {
  PUBLIC_URL: ORIGIN,
  APP_SECRET: btoa("race-contract-only-0123456789abcdef"),
  EMAIL_PROVIDER: "resend",
  EMAIL_API_KEY: "unused",
  EMAIL_FROM: "no-reply@example.org",
  OPERATOR_CONTACT: "ops@example.org",
  ENABLED_GAMES: "example",
};

interface Player {
  readonly id: string;
  readonly email: string;
  readonly cookie: string;
}

interface Answer {
  readonly status: number;
  readonly body: { game?: GameEnvelope; view?: unknown; error?: { code: string } } | null;
}

/** The race suite on one adapter; of the installed games given, only `example` is used. */
export function gameRaceContract(
  name: string,
  connect: () => Promise<ContractTarget>,
  installed: readonly InstalledGame[],
): void {
  const games = installed.filter((game) => game.manifest.type === "example");
  describe(`transition races (03 §5.2): ${name}`, () => {
    let target: ContractTarget;
    let repos: Repositories;
    let app: App;
    let clock = Date.UTC(2026, 0, 1, 9);

    beforeAll(async () => {
      target = await connect();
      repos = target.repos;
      const now = (): Date => new Date(clock);
      const log = createJsonLogger({ level: "error", now, sink: () => undefined });
      app = createApp({
        platform: {
          repos,
          config: parseConfig(ENV, {
            runtime: "node",
            installedGames: games.map((game) => ({
              type: game.manifest.type,
              enabledByDefault: game.enabledByDefault,
            })),
          }),
          log,
          email: createConsoleEmailSender(log, now),
          // No game route uses the client address.
          clientIp: () => ({ ok: false, reason: "missing" }),
          dictionaries: NO_DICTIONARIES,
          now,
        },
        games,
      });
    });

    afterAll(async () => {
      await target.close();
    });

    const player = async (): Promise<Player> => {
      const id = crypto.randomUUID();
      const email = normaliseAddress(`race-${id}@example.org`);
      if (email === null) throw new Error("not an address");
      await repos.users.createOrGetByEmail({
        id,
        email,
        displayName: "Racer",
        onboardedAt: clock,
        createdAt: clock,
        updatedAt: clock,
      });
      const token = await createSession(repos, id, clock, undefined);
      return { id, email, cookie: `__Host-sid=${token}` };
    };

    const send = async (who: Player, method: string, path: string, body?: unknown) => {
      const response = await app.request(path, {
        method,
        headers: {
          Cookie: who.cookie,
          Origin: ORIGIN,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const body: unknown = text === "" ? null : JSON.parse(text);
      return { status: response.status, body: body as Answer["body"] };
    };

    const view = async (who: Player, gameId: string) => {
      const answer = await send(who, "GET", `/api/v1/games/${gameId}`);
      expect(answer.status).toBe(200);
      return answer.body as { game: GameEnvelope; view: { seats: { hand: number[] | null }[] } };
    };

    const lobby = async (seats: number, invitees: readonly Player[]) => {
      const creator = await player();
      const created = await send(creator, "POST", "/api/v1/games", {
        gameType: "example",
        seats,
        invitees: invitees.map((invitee) => ({ email: invitee.email })),
      });
      expect(created.status).toBe(201);
      return { creator, gameId: created.body?.game?.id ?? "" };
    };

    const active = async () => {
      const b = await player();
      const { creator, gameId } = await lobby(2, [b]);
      const accepted = await send(b, "POST", `/api/v1/games/${gameId}/accept`, {
        expectedVersion: 0,
      });
      expect(accepted.body?.game?.status).toBe("active");
      return { a: creator, b, gameId, version: accepted.body?.game?.version ?? -1 };
    };

    const firstCard = async (who: Player, gameId: string, seat: number) =>
      (await view(who, gameId)).view.seats[seat]?.hand?.[0];

    /**
     * Exactly one 200; every other answer `409 STALE_GAME`, or another 409 a request that read the
     * winner's writes may answer first (05 `/actions` checks the status before the version).
     */
    const oneWinner = (answers: readonly Answer[], alsoLosing: readonly string[] = []): number => {
      const winners = answers.filter((answer) => answer.status === 200);
      expect(winners).toHaveLength(1);
      for (const answer of answers.filter((a) => a.status !== 200)) {
        expect(answer.status).toBe(409);
        expect(["STALE_GAME", ...alsoLosing]).toContain(answer.body?.error?.code);
      }
      return answers.findIndex((answer) => answer.status === 200);
    };

    /** The stored game: version, log, replay and `toAct` rows all agree (04 invariants 1–3). */
    const consistent = async (gameId: string, version: number) => {
      const game = await repos.games.get(gameId);
      const players = await repos.games.players(gameId);
      const actions = await repos.games.actions(gameId);
      expect(game?.version).toBe(version);
      expect(actions.map((action) => action.seq)).toEqual(
        Array.from({ length: game?.actionCount ?? 0 }, (_, i) => i + 1),
      );
      const definition = games.find((g) => g.manifest.type === "example")?.engines[1];
      if (game?.state != null && definition !== undefined) {
        const state = replayState(definition, game, actions);
        expect(JSON.stringify(state)).toBe(game.state);
        const toAct = game.status === "active" ? definition.toAct(state) : [];
        expect(
          players
            .filter((row) => row.toAct === 1)
            .map((row) => row.seat)
            .sort(),
        ).toEqual([...toAct].sort());
      }
      return { game, players, actions };
    };

    it("two moves from one version: exactly one is made", async () => {
      for (let round = 0; round < 5; round++) {
        const { a, b, gameId, version } = await active();
        const cards = [await firstCard(a, gameId, 0), await firstCard(b, gameId, 1)];
        const answers = await Promise.all(
          [a, b].map((who, seat) =>
            send(who, "POST", `/api/v1/games/${gameId}/actions`, {
              expectedVersion: version,
              action: { card: cards[seat] },
            }),
          ),
        );
        const winner = oneWinner(answers);
        const { actions, players } = await consistent(gameId, version + 1);
        expect(actions.map((action) => action.seat)).toEqual([winner]);
        expect(players.map((row) => row.actedOnce)).toEqual(winner === 0 ? [1, 0] : [0, 1]);
      }
    });

    it("the same move submitted twice is made once (double-submit protection)", async () => {
      const { a, gameId, version } = await active();
      const card = await firstCard(a, gameId, 0);
      const answers = await Promise.all(
        [0, 1, 2].map(() =>
          send(a, "POST", `/api/v1/games/${gameId}/actions`, {
            expectedVersion: version,
            action: { card },
          }),
        ),
      );
      oneWinner(answers);
      expect((await consistent(gameId, version + 1)).actions).toHaveLength(1);
    });

    it("a move against a decline: exactly one happens", async () => {
      for (let round = 0; round < 5; round++) {
        const { a, b, gameId, version } = await active();
        const card = await firstCard(a, gameId, 0);
        const answers = await Promise.all([
          send(a, "POST", `/api/v1/games/${gameId}/actions`, {
            expectedVersion: version,
            action: { card },
          }),
          send(b, "POST", `/api/v1/games/${gameId}/decline`, { expectedVersion: version }),
        ]);
        const winner = oneWinner(answers, ["GAME_NOT_ACTIVE"]);
        const { game, actions } = await consistent(gameId, version + 1);
        if (winner === 0) {
          expect(game?.status).toBe("active");
          expect(actions).toHaveLength(1);
        } else {
          // The framework-only declined ending: nothing logged, the state frozen.
          expect(game?.status).toBe("declined");
          expect(actions).toHaveLength(0);
        }
      }
    });

    it("start against cancel: exactly one happens", async () => {
      for (let round = 0; round < 5; round++) {
        const b = await player();
        const { creator, gameId } = await lobby(3, [b, await player()]);
        const accepted = await send(b, "POST", `/api/v1/games/${gameId}/accept`, {
          expectedVersion: 0,
        });
        const version = accepted.body?.game?.version ?? -1;
        const answers = await Promise.all(
          ["start", "cancel"].map((name) =>
            send(creator, "POST", `/api/v1/games/${gameId}/${name}`, { expectedVersion: version }),
          ),
        );
        const winner = oneWinner(answers);
        const { game, players } = await consistent(gameId, version + 1);
        expect(game?.status).toBe(winner === 0 ? "active" : "cancelled");
        expect(players.some((row) => row.seat !== null)).toBe(winner === 0);
      }
    });

    it("accept against cancel: exactly one happens", async () => {
      for (let round = 0; round < 5; round++) {
        const b = await player();
        const { creator, gameId } = await lobby(2, [b]);
        const answers = await Promise.all([
          send(b, "POST", `/api/v1/games/${gameId}/accept`, { expectedVersion: 0 }),
          send(creator, "POST", `/api/v1/games/${gameId}/cancel`, { expectedVersion: 0 }),
        ]);
        const winner = oneWinner(answers);
        const { game, players } = await consistent(gameId, 1);
        // The accept that wins starts the game by itself, in the same transition.
        expect(game?.status).toBe(winner === 0 ? "active" : "cancelled");
        expect(players.find((row) => row.userId === b.id)?.state).toBe(
          winner === 0 ? "playing" : "invited",
        );
      }
    });

    it("two accepts racing for the start: one wins, the other retries and starts the game", async () => {
      const b = await player();
      const c = await player();
      const { gameId } = await lobby(3, [b, c]);
      const answers = await Promise.all(
        [b, c].map((who) =>
          send(who, "POST", `/api/v1/games/${gameId}/accept`, { expectedVersion: 0 }),
        ),
      );
      const winner = oneWinner(answers);
      const after = await consistent(gameId, 1);
      expect(after.game?.status).toBe("lobby");
      expect(after.game?.state).toBeNull();
      const loser = [b, c][1 - winner];
      if (loser === undefined) throw new Error("no loser");
      const retried = await send(loser, "POST", `/api/v1/games/${gameId}/accept`, {
        expectedVersion: 1,
      });
      expect(retried.body?.game?.status).toBe("active");
      await consistent(gameId, 2);
      clock += 1;
    });
  });
}
