/**
 * The transition race suite (docs/spec/03-architecture.md §5.2, 10 M3): concurrent lifecycle
 * requests from one game version, through the real app over a runtime's repositories, so it runs
 * on both drivers. Every request of a race loads the game before any of them writes (a barrier on
 * `GameRepo.load`), so all of them pass the version check and reach `applyTransition`: exactly one
 * wins, the store answers `stale` to every other, which answers `409 STALE_GAME`, and the database
 * holds exactly the winner's writes — none of a loser's, on its own row or any other — with the
 * version moved by one and a log that replays to the stored state. Exported as
 * `@your-move/server/testing`; never part of a runtime build.
 *
 * The game is the caller's (this package never imports one): a type for two and three players
 * whose first round has every seat in `toAct` at once, like the reference game (02 §7.6), with a
 * legal move for a seat read from that seat's view.
 */
import type { AnyGameDefinition, GameEnvelope } from "@your-move/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normaliseAddress } from "../accounts/email.js";
import { createApp, type App } from "../app.js";
import { createSession } from "../auth/session.js";
import { parseConfig } from "../config/parse.js";
import type { GamePlayerRecord, LoadedGame, Repositories } from "../db/repositories.js";
import { createConsoleEmailSender } from "../email/sender.js";
import { createJsonLogger } from "../log.js";
import { DISABLED_PUSH_SENDER } from "../push/sender.js";
import type { InstalledGame } from "./registry.js";
import { replayState } from "./replay.js";
import { NO_DICTIONARIES } from "./resources.js";

/** The game the races play, supplied by the caller. */
export interface RaceGame {
  /** The installed games; the app is built with `type` alone, which must be among them. */
  readonly installed: readonly InstalledGame[];
  readonly type: string;
  /** A legal move for `seat`, in `toAct`, read from that seat's own view. */
  legalMove(view: unknown, seat: number): unknown;
}

const ORIGIN = "https://play.example.org";
const ENV = {
  PUBLIC_URL: ORIGIN,
  APP_SECRET: btoa("race-contract-only-0123456789abcdef"),
  EMAIL_PROVIDER: "resend",
  EMAIL_API_KEY: "unused",
  EMAIL_FROM: "no-reply@example.org",
  OPERATOR_CONTACT: "ops@example.org",
};

/** How long the barrier waits for every request of a race before letting them through anyway. */
const BARRIER_TIMEOUT_MS = 5000;

/**
 * The runtime's repositories with a barrier on `games.load` and a count of `stale` transitions.
 * While armed for `parties`, each of the first `parties` loads waits until all have read the game.
 */
function racing(repos: Repositories) {
  let barrier: {
    parties: number;
    arrived: number;
    open: () => void;
    opened: Promise<void>;
  } | null = null;
  let stale = 0;
  const games: Repositories["games"] = {
    ...repos.games,
    async load(id): Promise<LoadedGame | null> {
      const loaded = await repos.games.load(id);
      const current = barrier;
      if (current !== null && current.arrived < current.parties) {
        current.arrived += 1;
        if (current.arrived === current.parties) current.open();
        await current.opened;
      }
      return loaded;
    },
    async applyTransition(...args) {
      const result = await repos.games.applyTransition(...args);
      if (result === "stale") stale += 1;
      return result;
    },
  };
  return {
    repos: { ...repos, games },
    /** Runs the requests of one race through the barrier; returns their answers and the stale count. */
    async race<T>(
      requests: readonly (() => Promise<T>)[],
    ): Promise<{ answers: T[]; stale: number }> {
      let open = (): void => undefined;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const timer = setTimeout(open, BARRIER_TIMEOUT_MS);
      barrier = { parties: requests.length, arrived: 0, open, opened };
      stale = 0;
      try {
        const answers = await Promise.all(requests.map((request) => request()));
        return { answers, stale };
      } finally {
        clearTimeout(timer);
        barrier = null;
      }
    },
  };
}

/** One migrated database of a runtime adapter, for the whole suite. */
interface RaceTarget {
  readonly repos: Repositories;
  close(): Promise<void>;
}

interface Player {
  readonly id: string;
  readonly email: string;
  readonly cookie: string;
}

interface Answer {
  readonly status: number;
  readonly body: { game?: GameEnvelope; view?: unknown; error?: { code: string } } | null;
}

/** The race suite on one adapter, playing the caller's game. */
export function gameRaceContract(
  name: string,
  connect: () => Promise<RaceTarget>,
  game: RaceGame,
): void {
  describe(`transition races (03 §5.2): ${name}`, () => {
    let target: RaceTarget;
    let races: ReturnType<typeof racing>;
    let repos: Repositories;
    let app: App;
    let clock = Date.UTC(2026, 0, 1, 9);

    // Only the race's game: the suite has no resources to offer any other.
    const installed = game.installed.filter((candidate) => candidate.manifest.type === game.type);

    beforeAll(async () => {
      target = await connect();
      races = racing(target.repos);
      repos = races.repos;
      const now = (): Date => new Date(clock);
      const log = createJsonLogger({ level: "error", now, sink: () => undefined });
      app = createApp({
        platform: {
          repos,
          config: parseConfig(
            { ...ENV, ENABLED_GAMES: game.type },
            {
              runtime: "node",
              installedGames: installed.map((candidate) => ({
                type: candidate.manifest.type,
                enabledByDefault: candidate.enabledByDefault,
              })),
            },
          ),
          log,
          email: createConsoleEmailSender(log, now),
          push: DISABLED_PUSH_SENDER,
          // No game route uses the client address.
          clientIp: () => ({ ok: false, reason: "missing" }),
          dictionaries: NO_DICTIONARIES,
          now,
        },
        games: installed,
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
      const parsed: unknown = text === "" ? null : JSON.parse(text);
      return { status: response.status, body: parsed as Answer["body"] };
    };

    const view = async (who: Player, gameId: string) => {
      const answer = await send(who, "GET", `/api/v1/games/${gameId}`);
      expect(answer.status).toBe(200);
      return answer.body?.view;
    };

    const lobby = async (seats: number, invitees: readonly Player[]) => {
      const creator = await player();
      const created = await send(creator, "POST", "/api/v1/games", {
        gameType: game.type,
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
      // The seats as the start assigned them: the creator first in `join` order.
      return { a: creator, b, gameId, version: accepted.body?.game?.version ?? -1 };
    };

    const move = async (who: Player, gameId: string, seat: number) =>
      game.legalMove(await view(who, gameId), seat);

    const rows = async (gameId: string) => repos.games.players(gameId);
    const rowOf = (players: readonly GamePlayerRecord[], who: Player) => {
      const row = players.find((candidate) => candidate.userId === who.id);
      if (row === undefined) throw new Error("no row for that player");
      return row;
    };

    /**
     * Exactly one 200, every other answer `409 STALE_GAME`, and the store said `stale` to every
     * loser: the `write_token` guard decided the race, not a check before it.
     */
    const oneWinner = (result: { answers: readonly Answer[]; stale: number }): number => {
      const { answers, stale } = result;
      expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
      for (const answer of answers.filter((a) => a.status !== 200)) {
        expect([answer.status, answer.body?.error?.code]).toEqual([409, "STALE_GAME"]);
      }
      expect(stale).toBe(answers.length - 1);
      return answers.findIndex((answer) => answer.status === 200);
    };

    const definitionOf = (gameVersion: number): AnyGameDefinition | undefined =>
      installed[0]?.engines[gameVersion];

    /** The stored game: version, log, replay and `toAct` rows all agree (04 invariants 1–3). */
    const consistent = async (gameId: string, version: number) => {
      const stored = await repos.games.get(gameId);
      const players = await rows(gameId);
      const actions = await repos.games.actions(gameId);
      expect(stored?.version).toBe(version);
      expect(actions.map((action) => action.seq)).toEqual(
        Array.from({ length: stored?.actionCount ?? 0 }, (_, i) => i + 1),
      );
      const definition = stored === null ? undefined : definitionOf(stored.gameVersion);
      if (stored?.state != null && definition !== undefined) {
        const state = replayState(definition, stored, actions);
        expect(JSON.stringify(state)).toBe(stored.state);
        const toAct = stored.status === "active" ? definition.toAct(state) : [];
        expect(
          players
            .filter((row) => row.toAct === 1)
            .map((row) => row.seat)
            .sort(),
        ).toEqual([...toAct].sort());
      }
      return { game: stored, players, actions };
    };

    it("two moves from one version: exactly one is made", async () => {
      for (let round = 0; round < 5; round++) {
        const { a, b, gameId, version } = await active();
        const moves = [await move(a, gameId, 0), await move(b, gameId, 1)];
        const before = await rows(gameId);
        const result = await races.race(
          [a, b].map(
            (who, seat) => () =>
              send(who, "POST", `/api/v1/games/${gameId}/actions`, {
                expectedVersion: version,
                action: moves[seat],
              }),
          ),
        );
        const winner = oneWinner(result);
        const { actions, players } = await consistent(gameId, version + 1);
        expect(actions.map((action) => action.seat)).toEqual([winner]);
        // Nothing of the loser's own transition: not its first action, not its seen marker.
        const loser = winner === 0 ? b : a;
        expect(rowOf(players, loser).actedOnce).toBe(0);
        expect(rowOf(players, loser).lastSeenVersion).toBe(rowOf(before, loser).lastSeenVersion);
      }
    });

    it("the same move submitted three times is made once (double-submit protection)", async () => {
      const { a, gameId, version } = await active();
      const action = await move(a, gameId, 0);
      const result = await races.race(
        [0, 1, 2].map(
          () => () =>
            send(a, "POST", `/api/v1/games/${gameId}/actions`, {
              expectedVersion: version,
              action,
            }),
        ),
      );
      oneWinner(result);
      expect((await consistent(gameId, version + 1)).actions).toHaveLength(1);
    });

    it("a move against a decline: exactly one happens", async () => {
      for (let round = 0; round < 5; round++) {
        const { a, b, gameId, version } = await active();
        const action = await move(a, gameId, 0);
        const before = await rows(gameId);
        const winner = oneWinner(
          await races.race([
            () =>
              send(a, "POST", `/api/v1/games/${gameId}/actions`, {
                expectedVersion: version,
                action,
              }),
            () => send(b, "POST", `/api/v1/games/${gameId}/decline`, { expectedVersion: version }),
          ]),
        );
        const { game: stored, actions, players } = await consistent(gameId, version + 1);
        if (winner === 0) {
          expect(stored?.status).toBe("active");
          expect(actions).toHaveLength(1);
          // The decline wrote nothing: b still plays, its marker unmoved.
          expect(rowOf(players, b)).toMatchObject({ state: "playing", outReason: null });
          expect(rowOf(players, b).lastSeenVersion).toBe(rowOf(before, b).lastSeenVersion);
        } else {
          // The framework-only declined ending: nothing logged, the state frozen.
          expect(stored?.status).toBe("declined");
          expect(actions).toHaveLength(0);
          expect(rowOf(players, a)).toMatchObject({ actedOnce: 0, state: "playing" });
          expect(rowOf(players, a).lastSeenVersion).toBe(rowOf(before, a).lastSeenVersion);
        }
      }
    });

    it("start against cancel: exactly one happens", async () => {
      for (let round = 0; round < 5; round++) {
        const b = await player();
        const c = await player();
        const { creator, gameId } = await lobby(3, [b, c]);
        const accepted = await send(b, "POST", `/api/v1/games/${gameId}/accept`, {
          expectedVersion: 0,
        });
        const version = accepted.body?.game?.version ?? -1;
        const winner = oneWinner(
          await races.race(
            ["start", "cancel"].map(
              (transition) => () =>
                send(creator, "POST", `/api/v1/games/${gameId}/${transition}`, {
                  expectedVersion: version,
                }),
            ),
          ),
        );
        const { game: stored, players } = await consistent(gameId, version + 1);
        expect(stored?.status).toBe(winner === 0 ? "active" : "cancelled");
        expect(players.some((row) => row.seat !== null)).toBe(winner === 0);
        // c's unfilled invitation: dropped by a start, left invited by a cancel, never both.
        expect(rowOf(players, c).state).toBe(winner === 0 ? "dropped" : "invited");
      }
    });

    it("accept against cancel: exactly one happens", async () => {
      for (let round = 0; round < 5; round++) {
        const b = await player();
        const { creator, gameId } = await lobby(2, [b]);
        const before = await rows(gameId);
        const winner = oneWinner(
          await races.race([
            () => send(b, "POST", `/api/v1/games/${gameId}/accept`, { expectedVersion: 0 }),
            () => send(creator, "POST", `/api/v1/games/${gameId}/cancel`, { expectedVersion: 0 }),
          ]),
        );
        const { game: stored, players } = await consistent(gameId, 1);
        // The accept that wins starts the game by itself, in the same transition.
        expect(stored?.status).toBe(winner === 0 ? "active" : "cancelled");
        if (winner === 0) {
          expect(rowOf(players, creator).lastSeenVersion).toBe(
            rowOf(before, creator).lastSeenVersion,
          );
        } else {
          expect(rowOf(players, b)).toMatchObject({
            state: "invited",
            joinedAt: null,
            lastSeenVersion: rowOf(before, b).lastSeenVersion,
          });
        }
      }
    });

    it("two accepts racing for the start: one wins, the other retries and starts the game", async () => {
      const b = await player();
      const c = await player();
      const { gameId } = await lobby(3, [b, c]);
      const before = await rows(gameId);
      const winner = oneWinner(
        await races.race(
          [b, c].map(
            (who) => () =>
              send(who, "POST", `/api/v1/games/${gameId}/accept`, { expectedVersion: 0 }),
          ),
        ),
      );
      const after = await consistent(gameId, 1);
      expect(after.game?.status).toBe("lobby");
      expect(after.game?.state).toBeNull();
      const loser = [b, c][1 - winner];
      if (loser === undefined) throw new Error("no loser");
      expect(rowOf(after.players, loser)).toEqual(rowOf(before, loser));
      const retried = await send(loser, "POST", `/api/v1/games/${gameId}/accept`, {
        expectedVersion: 1,
      });
      expect(retried.body?.game?.status).toBe("active");
      await consistent(gameId, 2);
      clock += 1;
    });
  });
}
