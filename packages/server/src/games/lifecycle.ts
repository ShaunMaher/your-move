/**
 * The game lifecycle as write sets (docs/spec/02-game-framework.md §4, §5, 03 §5.2): each function
 * takes a loaded game and returns everything one transition writes, or the error that refuses it.
 * Nothing here touches storage; the caller applies the write set with the `write_token`
 * transition and answers `409 STALE_GAME` if it lost the race.
 */
import {
  type AnyGameDefinition,
  type GameError,
  isGameError,
  type RandomSource,
  type Seat,
  shuffle,
  type Text,
  type Transition,
} from "@your-move/sdk";

import type {
  GamePlayerRecord,
  GamePlayerUpdate,
  GameRecord,
  GameWriteSet,
  PastOpponentPair,
} from "../db/repositories.js";
import { type Draw, recorded } from "./random.js";

/** A loaded game with its parsed options and, once started, its parsed state. */
export interface GameContext {
  readonly game: GameRecord;
  readonly players: readonly GamePlayerRecord[];
  readonly definition: AnyGameDefinition;
  readonly options: unknown;
  /** The module state; null in the lobby. */
  readonly state: unknown;
  /** This transition's source of randomness, recorded for replay (02 §5). */
  readonly random: RandomSource;
}

/** The final views written when a started game ends (04 `games.final_views`). */
export interface FinalViews {
  readonly seats: readonly { readonly view: unknown; readonly summary: unknown }[];
  readonly public: { readonly view: unknown; readonly summary: unknown };
}

/** A refusal, as `{ code }` of the framework error table (05 §Errors). */
export interface Refusal {
  readonly refused:
    | "NOT_ALLOWED"
    | "WRONG_STATUS"
    | "NOT_ENOUGH_PLAYERS"
    | "INVALID_SEATS"
    | "ALREADY_ACTED"
    | "NOT_FOUND";
  readonly detail?: unknown;
}

const DAY = 86_400_000;

/** A module transition's outcome, for the response (05 `/actions`). */
export interface ModuleOutcome {
  readonly writes: GameWriteSet;
  readonly record: unknown;
  readonly describe: Text;
}

/** Rows holding a seat, by seat number. */
function seatedRows(players: readonly GamePlayerRecord[]): GamePlayerRecord[] {
  return players.filter((row) => row.seat !== null).sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
}

/** When a seat in `toAct` times out (02 §4); shown, not enforced, until the sweep (M3). */
export function deadlineOf(row: GamePlayerRecord, turnTimeoutDays: number): number | undefined {
  return row.toAct === 1 && row.toActSince !== null
    ? row.toActSince + turnTimeoutDays * DAY
    : undefined;
}

function finalViews(definition: AnyGameDefinition, state: unknown, seats: number): FinalViews {
  return {
    seats: Array.from({ length: seats }, (_, seat) => ({
      view: definition.view(state, seat),
      summary: definition.summary(state, seat),
    })),
    public: { view: definition.view(state, null), summary: definition.summary(state, null) },
  };
}

/**
 * Standard competition ranking of the module's ranking without the seats out as `declined`
 * (02 §4): tied seats share a rank and the next rank skips.
 */
export function rerank(
  ranking: readonly { seat: Seat; rank: number; score?: number }[],
  declined: ReadonlySet<Seat>,
): Map<Seat, { rank: number; score?: number }> {
  const kept = ranking.filter((entry) => !declined.has(entry.seat));
  const result = new Map<Seat, { rank: number; score?: number }>();
  for (const entry of kept) {
    const better = kept.filter((other) => other.rank < entry.rank).length;
    result.set(entry.seat, {
      rank: better + 1,
      ...(entry.score === undefined ? {} : { score: entry.score }),
    });
  }
  return result;
}

type ModuleKind = "action" | "resign" | "decline";

/**
 * One module transition (02 §5): runs the module with recorded randomness, logs it, recomputes
 * `toAct` and the per-seat clocks (02 §2.3), stores newly-out seats (02 §4), and finishes the game
 * when `result()` is non-null: ranks without `declined` seats, final views and past opponents.
 */
export function moduleTransition(
  ctx: GameContext,
  input: {
    readonly seat: Seat;
    readonly kind: ModuleKind;
    readonly action?: unknown;
    readonly run: (rng: RandomSource) => Transition<unknown, unknown>;
    readonly now: number;
  },
): ModuleOutcome {
  const { definition, game } = ctx;
  const { seat, kind, now } = input;
  const random = recorded(ctx.random);
  const { state, record } = input.run(random.rng);
  const describe = definition.describe(record);
  const result = definition.result(state);
  const toAct = new Set(result === null ? definition.toAct(state) : []);
  const status = definition.seatStatus(state);
  const seq = game.actionCount + 1;
  const rows = seatedRows(ctx.players);

  const outReasons = new Map<Seat, GamePlayerRecord["outReason"]>();
  const updates = rows.map((row) => {
    const rowSeat = row.seat ?? 0;
    const set: GamePlayerUpdate = {};
    const acted = rowSeat === seat && kind === "action";
    if (toAct.has(rowSeat)) {
      set.toAct = 1;
      // A clock starts when the seat enters toAct, and restarts when its accepted action leaves
      // it there; each (re)start resets the reminders (02 §2.3).
      if (row.toAct !== 1 || acted) {
        set.toActSince = now;
        set.timeoutRemindersSent = 0;
      }
    } else if (row.toAct !== 0 || row.toActSince !== null) {
      set.toAct = 0;
      set.toActSince = null;
    }
    if (acted && row.actedOnce !== 1) set.actedOnce = 1;
    const leaving = rowSeat === seat && kind !== "action";
    if (row.state === "playing" && (leaving || status[rowSeat] === "out")) {
      const reason = leaving ? (kind === "resign" ? "resigned" : "declined") : "eliminated";
      set.state = "out";
      set.outReason = reason;
      outReasons.set(rowSeat, reason);
    }
    return { row, set };
  });

  const writes: GameWriteSet = {
    game: {
      state: JSON.stringify(state),
      actionCount: seq,
      lastActionAt: now,
      updatedAt: now,
      ...(result === null
        ? {}
        : {
            status: "finished" as const,
            endReason: result.endReason,
            endedAt: now,
            finalViews: JSON.stringify(finalViews(definition, state, rows.length)),
          }),
    },
    insertActions: [
      {
        seq,
        seat,
        kind,
        action: kind === "action" ? JSON.stringify(input.action) : null,
        record: JSON.stringify(record),
        describe: JSON.stringify(describe),
        rng: JSON.stringify(random.draws),
        via: "app",
        createdAt: now,
      },
    ],
  };

  let pastOpponents: PastOpponentPair[] = [];
  if (result !== null) {
    const declined = new Set(
      rows
        .filter((row) => (outReasons.get(row.seat ?? 0) ?? row.outReason) === "declined")
        .map((row) => row.seat ?? 0),
    );
    const ranks = rerank(result.ranking, declined);
    for (const update of updates) {
      const entry = ranks.get(update.row.seat ?? 0);
      if (entry !== undefined) {
        update.set.rank = entry.rank;
        if (entry.score !== undefined) update.set.score = Math.round(entry.score);
      }
    }
    pastOpponents = pairsWhoActed(updates, now);
  }

  return {
    writes: {
      ...writes,
      updatePlayers: updates
        .filter((update) => Object.keys(update.set).length > 0)
        .map((update) => ({ id: update.row.id, set: update.set })),
      ...(pastOpponents.length > 0 ? { pastOpponents } : {}),
    },
    record,
    describe,
  };
}

/**
 * Past opponents (04 `past_opponents`): every pair of seated users who both acted, both
 * directions. Players who joined through a link are never paired automatically (06 §6.9).
 */
function pairsWhoActed(
  updates: readonly { row: GamePlayerRecord; set: GamePlayerUpdate }[],
  now: number,
): PastOpponentPair[] {
  const acted = updates
    .filter(
      ({ row, set }) =>
        row.userId !== null &&
        row.joinedVia !== "join_link" &&
        (set.actedOnce ?? row.actedOnce) === 1,
    )
    .map(({ row }) => row.userId ?? "");
  return acted.flatMap((userId) =>
    acted
      .filter((otherId) => otherId !== userId)
      .map((otherId) => ({ userId, otherId, lastFinishedAt: now })),
  );
}

/** Players in the lobby counted for starting and filling (02 §4). */
function lobbyCounts(players: readonly GamePlayerRecord[]): { joined: number; invited: number } {
  return {
    joined: players.filter((row) => row.state === "joined").length,
    invited: players.filter((row) => row.state === "invited").length,
  };
}

/**
 * The start transition's writes (02 §4 Start, steps 2–5): `validateStart`, unjoined rows out of
 * the game, seats by the seat order (a `random` order drawn from the recorded randomness), `setup`
 * and the first clocks. Step 1, the block re-check, has nothing to check until blocks exist (M4).
 */
function startWrites(ctx: GameContext, now: number): GameWriteSet | GameError {
  const { definition, game } = ctx;
  const joined = ctx.players
    .filter((row) => row.state === "joined")
    .sort((a, b) => {
      // The creator first, then in joining order (02 §4 seat order `join`).
      const creator = Number(b.joinedVia === "creator") - Number(a.joinedVia === "creator");
      return creator !== 0
        ? creator
        : (a.joinedAt ?? 0) - (b.joinedAt ?? 0) || (a.id < b.id ? -1 : 1);
    });
  const checked = definition.validateStart(ctx.options, joined.length);
  if (isGameError(checked)) return checked;

  const random = recorded(ctx.random);
  const order = game.seatOrder === "random" ? shuffle(joined, random.rng) : joined;
  const state = definition.setup({ options: ctx.options, seats: order.length, rng: random.rng });
  const toAct = new Set(definition.toAct(state));
  const seated = new Map(order.map((row, seat) => [row.id, seat]));

  return {
    game: {
      status: "active",
      seats: order.length,
      state: JSON.stringify(state),
      setupRng: JSON.stringify(random.draws satisfies readonly Draw[]),
      startedAt: now,
      lastActionAt: now,
      updatedAt: now,
    },
    updatePlayers: ctx.players.map((row) => {
      const seat = seated.get(row.id);
      if (seat !== undefined) {
        return {
          id: row.id,
          set: {
            seat,
            state: "playing" as const,
            toAct: toAct.has(seat) ? 1 : 0,
            toActSince: toAct.has(seat) ? now : null,
            timeoutRemindersSent: 0,
          },
        };
      }
      // Out of the game: declined, left and removed rows keep their state, unfilled invitations
      // are dropped; none keeps a seat or a typed address (02 §4 step 3, 06 §6.5).
      return {
        id: row.id,
        set: {
          seat: null,
          inviteEmail: null,
          ...(row.state === "invited" ? { state: "dropped" as const } : {}),
        },
      };
    }),
  };
}

/** Whether the lobby starts by itself after a transition (02 §4 Start). */
function autoStarts(game: GameRecord, players: readonly GamePlayerRecord[]): boolean {
  const { joined } = lobbyCounts(players);
  // AI assistance allowed with another human: every human starts knowingly, by the creator's Start.
  const aiHeld = game.aiAssistance === "allowed" && joined > 1;
  return joined === game.seats && !aiHeld;
}

/** Merges the start's writes after another transition's row updates. */
function withStart(
  ctx: GameContext,
  rowUpdate: { id: string; set: GamePlayerUpdate },
  now: number,
): GameWriteSet {
  const players = ctx.players.map((row) =>
    row.id === rowUpdate.id ? { ...row, ...rowUpdate.set } : row,
  );
  const plain: GameWriteSet = { game: { updatedAt: now }, updatePlayers: [rowUpdate] };
  if (!autoStarts(ctx.game, players)) return plain;
  const started = startWrites({ ...ctx, players }, now);
  // An automatic start that validateStart refuses simply doesn't happen (02 §4 step 2).
  if (isGameError(started)) return plain;
  return {
    ...started,
    updatePlayers: (started.updatePlayers ?? []).map((update) =>
      update.id === rowUpdate.id
        ? { id: update.id, set: { ...rowUpdate.set, ...update.set } }
        : update,
    ),
  };
}

/** `POST /start`: the creator, in the lobby, with at least `min` joined (05). */
export function start(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): GameWriteSet | Refusal {
  if (viewer.joinedVia !== "creator") return { refused: "NOT_ALLOWED" };
  if (ctx.game.status !== "lobby") return { refused: "WRONG_STATUS" };
  const { min } = ctx.definition.players(ctx.options);
  if (lobbyCounts(ctx.players).joined < min) return { refused: "NOT_ENOUGH_PLAYERS" };
  const writes = startWrites(ctx, now);
  if (isGameError(writes)) {
    return {
      refused: "INVALID_SEATS",
      detail: {
        code: writes.code,
        ...(writes.detail === undefined ? {} : { detail: writes.detail }),
      },
    };
  }
  return writes;
}

/** `POST /accept`: the holder of an invitation, in the lobby; may start the game (02 §4). */
export function accept(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): GameWriteSet | Refusal {
  if (ctx.game.status !== "lobby" || viewer.state !== "invited") return { refused: "WRONG_STATUS" };
  return withStart(
    ctx,
    {
      id: viewer.id,
      set: { state: "joined", joinedVia: "invitation", joinedAt: now, inviteEmail: null },
    },
    now,
  );
}

/** Every row's typed address cleared: the lobby reached a terminal state (06 §6.5). */
function clearAddresses(players: readonly GamePlayerRecord[], except?: string) {
  return players
    .filter((row) => row.inviteEmail !== null && row.id !== except)
    .map((row) => ({ id: row.id, set: { inviteEmail: null } }));
}

/** Lobbies expire 14 days after creation, not extended by joins (02 §4); `invites` with them. */
export const LOBBY_LIFETIME_MS = 14 * DAY;

/** When the lobby expires (02 §4). */
function lobbyExpiresAt(game: GameRecord): number {
  return game.createdAt + LOBBY_LIFETIME_MS;
}

/**
 * The expiry transition (02 §4) of a lobby past its expiry, or null for any other game: the lobby
 * ends `expired` and every typed address is cleared (06 §6.5). It ended when it fell due, which is
 * what `ended_at` records, however late it is noticed.
 */
export function expire(
  game: GameRecord,
  players: readonly GamePlayerRecord[],
  now: number,
): GameWriteSet | null {
  if (game.status !== "lobby" || now < lobbyExpiresAt(game)) return null;
  return {
    game: {
      status: "expired",
      endReason: "expired",
      endedAt: lobbyExpiresAt(game),
      updatedAt: now,
    },
    updatePlayers: clearAddresses(players),
  };
}

/** `POST /cancel`: the creator, in the lobby (02 §4). */
export function cancel(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): GameWriteSet | Refusal {
  if (viewer.joinedVia !== "creator") return { refused: "NOT_ALLOWED" };
  if (ctx.game.status !== "lobby") return { refused: "WRONG_STATUS" };
  return {
    game: { status: "cancelled", endReason: "cancelled", endedAt: now, updatedAt: now },
    updatePlayers: clearAddresses(ctx.players),
  };
}

/**
 * `POST /decline` in the lobby (02 §4 Decline): an invited or joined player other than the
 * creator. The lobby ends `declined` when it can no longer fill (no join links exist yet, M4).
 */
function declineInLobby(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): GameWriteSet | Refusal {
  if (viewer.joinedVia === "creator") return { refused: "NOT_ALLOWED" };
  if (viewer.state !== "invited" && viewer.state !== "joined") return { refused: "WRONG_STATUS" };
  const own = { id: viewer.id, set: { state: "declined" as const, inviteEmail: null } };
  const players = ctx.players.map((row) =>
    row.id === viewer.id ? { ...row, state: "declined" as const } : row,
  );
  const { joined, invited } = lobbyCounts(players);
  const { min } = ctx.definition.players(ctx.options);
  if (joined + invited >= min) return { game: { updatedAt: now }, updatePlayers: [own] };
  return {
    game: { status: "declined", endReason: "declined", endedAt: now, updatedAt: now },
    updatePlayers: [own, ...clearAddresses(ctx.players, viewer.id)],
  };
}

/**
 * `POST /decline` after start (02 §4 Before a seat's first action): a playing seat that hasn't
 * acted. With too few seats left the game ends `declined` as a framework-only transition: no
 * module call, nothing logged, the state frozen, no ranks. Otherwise the seat is out as
 * `declined` through `onResign(…, "decline")` and play continues.
 */
function declineActive(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): GameWriteSet | ModuleOutcome | Refusal {
  if (viewer.state !== "playing" || viewer.seat === null) return { refused: "WRONG_STATUS" };
  if (viewer.actedOnce === 1) return { refused: "ALREADY_ACTED" };
  const seat = viewer.seat;
  const playing = ctx.players.filter((row) => row.state === "playing").length;
  const { min } = ctx.definition.players(ctx.options);
  if (playing - 1 >= min) {
    return moduleTransition(ctx, {
      seat,
      kind: "decline",
      run: (rng) => ctx.definition.onResign(ctx.state, seat, rng, "decline"),
      now,
    });
  }
  const rows = seatedRows(ctx.players);
  return {
    game: {
      status: "declined",
      endReason: "declined",
      endedAt: now,
      updatedAt: now,
      finalViews: JSON.stringify(finalViews(ctx.definition, ctx.state, rows.length)),
    },
    updatePlayers: rows.map((row) => ({
      id: row.id,
      set: {
        toAct: 0,
        toActSince: null,
        ...(row.id === viewer.id ? { state: "out" as const, outReason: "declined" as const } : {}),
      },
    })),
  };
}

/** `POST /decline`, in the lobby or before a first action (05 §Lifecycle transitions). */
export function decline(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): GameWriteSet | ModuleOutcome | Refusal {
  if (ctx.game.status === "lobby") return declineInLobby(ctx, viewer, now);
  if (ctx.game.status === "active") return declineActive(ctx, viewer, now);
  return { refused: "WRONG_STATUS" };
}

/** `POST /resign`: any playing seat of an active game (02 §4 Resign). */
export function resign(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
): ModuleOutcome | Refusal {
  if (ctx.game.status !== "active" || viewer.state !== "playing" || viewer.seat === null) {
    return { refused: "WRONG_STATUS" };
  }
  const seat = viewer.seat;
  return moduleTransition(ctx, {
    seat,
    kind: "resign",
    run: (rng) => ctx.definition.onResign(ctx.state, seat, rng, "resign"),
    now,
  });
}

/** Whether a lifecycle function refused. */
export function isRefusal(value: object): value is Refusal {
  return "refused" in value;
}

/** Whether a lifecycle function returned a module transition. */
export function isModuleOutcome(value: object): value is ModuleOutcome {
  return "writes" in value;
}
