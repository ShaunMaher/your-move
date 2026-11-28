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
  BlockPair,
  GamePlayerRecord,
  GamePlayerUpdate,
  GameRecord,
  GameWriteSet,
  JoinLinkTimes,
  PastOpponentPair,
} from "../db/repositories.js";
import { UNPLAYED } from "../db/repositories.js";
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
  /** The game's join link, live or expired, if it has one (04 `join_links`). */
  readonly joinLink: JoinLinkTimes | null;
}

/** The final views written when a started game ends (04 `games.final_views`). */
export interface FinalViews {
  readonly seats: readonly { readonly view: unknown; readonly summary: unknown }[];
  readonly public: { readonly view: unknown; readonly summary: unknown };
}

/** Whether two users have a block between them, in either direction (04 `blocks`). */
export type Blocked = (a: string, b: string) => boolean;

/** {@link Blocked} over the block pairs read for a set of users. */
export function blockedBy(pairs: readonly BlockPair[]): Blocked {
  const keys = new Set(pairs.map((pair) => `${pair.blockerId} ${pair.blockedId}`));
  return (a, b) => keys.has(`${a} ${b}`) || keys.has(`${b} ${a}`);
}

/** The user ids holding rows in a game, for its block lookup (once each). */
export function rowUserIds(players: readonly GamePlayerRecord[]): string[] {
  return [...new Set(players.flatMap((row) => (row.userId === null ? [] : [row.userId])))];
}

/**
 * An accept that found a block with a joined member (05 `/accept`, alpha A23): the invitation is
 * declined, written exactly as the holder's own decline, and the answer is `404`.
 */
export interface BlockedAccept {
  readonly blockedAccept: GameWriteSet;
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

/** Whether the game has a join link that still works at `now` (06 §6.8). */
export function linkLive(link: JoinLinkTimes | null, now: number): boolean {
  return link !== null && now < link.expiresAt;
}

/** Players in the lobby counted for starting and filling (02 §4). */
function lobbyCounts(players: readonly GamePlayerRecord[]): { joined: number; invited: number } {
  return {
    joined: players.filter((row) => row.state === "joined").length,
    invited: players.filter((row) => row.state === "invited").length,
  };
}

/** Too few joined players remain once the start's block re-check removed some (02 §4 step 1). */
const TOO_FEW = { tooFew: true } as const;

/**
 * The joined rows in joining order, split by the start's block re-check (02 §4 Start, step 1):
 * each row with a block against one kept before it is removed, so of a blocked pair the one who
 * joined later goes. The creator comes first, then in joining order (02 §4 seat order `join`).
 * Rows that joined in the same millisecond keep the order they were added in (the sort is stable,
 * and the rows come in that order): past opponents added at creation sit in the order the creator
 * listed them.
 */
function blockChecked(
  players: readonly GamePlayerRecord[],
  blocked: Blocked,
): { kept: GamePlayerRecord[]; removed: Set<string> } {
  const joined = players
    .filter((row) => row.state === "joined")
    .sort((a, b) => {
      const creator = Number(b.joinedVia === "creator") - Number(a.joinedVia === "creator");
      return creator !== 0 ? creator : (a.joinedAt ?? 0) - (b.joinedAt ?? 0);
    });
  const kept: GamePlayerRecord[] = [];
  const removed = new Set<string>();
  for (const row of joined) {
    const { userId } = row;
    const clash =
      userId !== null &&
      kept.some((other) => other.userId !== null && blocked(userId, other.userId));
    if (clash) removed.add(row.id);
    else kept.push(row);
  }
  return { kept, removed };
}

/**
 * The start transition's writes (02 §4 Start): the block re-check (a later-joined member of a
 * blocked pair is `removed`; too few left is {@link TOO_FEW}), `validateStart`, unjoined rows out
 * of the game, seats by the seat order (a `random` order drawn from the recorded randomness),
 * `setup` and the first clocks.
 */
function startWrites(
  ctx: GameContext,
  now: number,
  blocked: Blocked,
): GameWriteSet | GameError | typeof TOO_FEW {
  const { definition, game } = ctx;
  const { kept: joined, removed } = blockChecked(ctx.players, blocked);
  if (joined.length < definition.players(ctx.options).min) return TOO_FEW;
  const checked = definition.validateStart(ctx.options, joined.length);
  if (isGameError(checked)) return checked;

  const random = recorded(ctx.random);
  const order = game.seatOrder === "random" ? shuffle(joined, random.rng) : joined;
  const state = definition.setup({ options: ctx.options, seats: order.length, rng: random.rng });
  const toAct = new Set(definition.toAct(state));
  const seated = new Map(order.map((row, seat) => [row.id, seat]));

  return {
    // The link ends with the lobby (06 §6.8).
    deleteJoinLink: true,
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
      // Removed by the block re-check (02 §4 step 1), as a Remove would.
      if (removed.has(row.id)) {
        return { id: row.id, set: { seat: null, inviteEmail: null, ...removedSet(now) } };
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

/**
 * Whether the lobby starts by itself after a transition (02 §4 Start). Never while a join link is
 * live or once anyone has joined through one: the creator sees who joined and presses Start
 * (06 §6.8, 08 T24).
 */
function autoStarts(
  game: GameRecord,
  players: readonly GamePlayerRecord[],
  joinLink: JoinLinkTimes | null,
  now: number,
): boolean {
  const { joined } = lobbyCounts(players);
  // AI assistance allowed with another human: every human starts knowingly, by the creator's Start.
  const aiHeld = game.aiAssistance === "allowed" && joined > 1;
  const linkHeld =
    linkLive(joinLink, now) ||
    players.some((row) => row.state === "joined" && row.joinedVia === "join_link");
  return joined === game.seats && !aiHeld && !linkHeld;
}

/**
 * The start of a game created with every seat filled (05 `POST /api/v1/games` Created, 02 §4):
 * the creator and the past opponents added at once. The same rules as any automatic start, so
 * AI assistance allowed with another person keeps it in the lobby, and a `validateStart` refusal
 * simply leaves it there; null when it doesn't start.
 */
export function startAtCreation(
  ctx: GameContext,
  now: number,
  blocked: Blocked,
): GameWriteSet | null {
  if (ctx.game.status !== "lobby" || !autoStarts(ctx.game, ctx.players, ctx.joinLink, now)) {
    return null;
  }
  const writes = startWrites(ctx, now, blocked);
  return isStart(writes) ? writes : null;
}

/** Whether {@link startWrites} gave a start, not a refusal of one. */
function isStart(writes: GameWriteSet | GameError | typeof TOO_FEW): writes is GameWriteSet {
  return !isGameError(writes) && !("tooFew" in writes);
}

/** Merges the start's writes after another transition's row updates. */
function withStart(
  ctx: GameContext,
  rowUpdate: { id: string; set: GamePlayerUpdate },
  now: number,
  blocked: Blocked,
): GameWriteSet {
  const players = ctx.players.map((row) =>
    row.id === rowUpdate.id ? { ...row, ...rowUpdate.set } : row,
  );
  const plain: GameWriteSet = { game: { updatedAt: now }, updatePlayers: [rowUpdate] };
  if (!autoStarts(ctx.game, players, ctx.joinLink, now)) return plain;
  const started = startWrites({ ...ctx, players }, now, blocked);
  // An automatic start that the block re-check or validateStart refuses simply doesn't happen
  // (02 §4 steps 1 and 2).
  if (!isStart(started)) return plain;
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
  blocked: Blocked,
): GameWriteSet | Refusal {
  if (viewer.joinedVia !== "creator") return { refused: "NOT_ALLOWED" };
  if (ctx.game.status !== "lobby" || now >= lobbyExpiresAt(ctx.game)) {
    return { refused: "WRONG_STATUS" };
  }
  const { min } = ctx.definition.players(ctx.options);
  if (lobbyCounts(ctx.players).joined < min) return { refused: "NOT_ENOUGH_PLAYERS" };
  const writes = startWrites(ctx, now, blocked);
  // Too few left once the block re-check removed some: nothing is written (02 §4 step 1).
  if ("tooFew" in writes) return { refused: "NOT_ENOUGH_PLAYERS" };
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

/**
 * `POST /accept`: the holder of an invitation, in the lobby; may start the game (02 §4). A block in
 * either direction between the holder and any joined member declines the invitation instead,
 * exactly as the holder's own decline would (05, alpha A23): the caller writes it and answers
 * `404`.
 */
export function accept(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
  blocked: Blocked,
): GameWriteSet | BlockedAccept | Refusal {
  if (
    ctx.game.status !== "lobby" ||
    viewer.state !== "invited" ||
    now >= lobbyExpiresAt(ctx.game)
  ) {
    return { refused: "WRONG_STATUS" };
  }
  const { userId } = viewer;
  const clash =
    userId !== null &&
    ctx.players.some(
      (row) =>
        row.state === "joined" &&
        row.userId !== null &&
        row.userId !== userId &&
        blocked(userId, row.userId),
    );
  if (clash) {
    const declined = declineInLobby(ctx, viewer, now);
    if (isRefusal(declined)) return declined;
    return { blockedAccept: declined };
  }
  return withStart(ctx, { id: viewer.id, set: acceptedSet(now) }, now, blocked);
}

/** Whether an accept found a block and declined instead (05 `/accept`). */
export function isBlockedAccept(value: object): value is BlockedAccept {
  return "blockedAccept" in value;
}

/**
 * What accepting an invitation sets on its row, by the Accept button or by joining through a link
 * (06 §6.8): joined, as an invitation, its typed address cleared (06 §6.5). The row keeps its
 * `delivery`, which only an open invitation uses (05 `unread`).
 */
function acceptedSet(now: number): GamePlayerUpdate {
  return { state: "joined", joinedVia: "invitation", joinedAt: now, inviteEmail: null };
}

/** Every row's typed address cleared: the lobby reached a terminal state (06 §6.5). */
function clearAddresses(players: readonly GamePlayerRecord[], except?: string) {
  return players
    .filter((row) => row.inviteEmail !== null && row.id !== except)
    .map((row) => ({ id: row.id, set: { inviteEmail: null } }));
}

/**
 * Transitions the server starts itself (joins, the sweep, lazy expiry, claims) try once and, on
 * `stale`, reload and retry up to 3 times (03 §5.2): 4 attempts in all.
 */
export const SERVER_ATTEMPTS = 4;

/** Lobbies expire 14 days after creation, not extended by joins (02 §4); `invites` with them. */
export const LOBBY_LIFETIME_MS = 14 * DAY;

/** When the lobby expires (02 §4). */
export function lobbyExpiresAt(game: Pick<GameRecord, "createdAt">): number {
  return game.createdAt + LOBBY_LIFETIME_MS;
}

/**
 * Whether a game ended without being played ({@link UNPLAYED}): any `declined` ending, or a
 * `cancelled` or `expired` one with no action logged that isn't an operator's cancel. A finished
 * game's rematch that ended so may be replaced (04 `rematch_game_id`, 05).
 */
export function endedUnplayed(
  game: Pick<GameRecord, "status" | "actionCount" | "endReason">,
): boolean {
  if (game.status === UNPLAYED.always) return true;
  return (
    (UNPLAYED.ifNoAction as readonly string[]).includes(game.status) &&
    game.actionCount === 0 &&
    game.endReason !== UNPLAYED.operatorCancel
  );
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
    deleteJoinLink: true,
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
    deleteJoinLink: true,
    game: { status: "cancelled", endReason: "cancelled", endedAt: now, updatedAt: now },
    updatePlayers: clearAddresses(ctx.players),
  };
}

/**
 * `POST /decline` in the lobby (02 §4 Decline): an invited or joined player other than the
 * creator. The lobby ends `declined` when it can no longer fill: fewer than `min` joined and
 * invited, and no live join link to bring anyone else.
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
  if (joined + invited >= min || linkLive(ctx.joinLink, now)) {
    return { game: { updatedAt: now }, updatePlayers: [own] };
  }
  return {
    deleteJoinLink: true,
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

/**
 * `POST /remove-seat` (05, 02 §4): the creator, in the lobby, removes another row that holds a seat
 * (`invited` or `joined`). It becomes `removed` with `removed_at` set and any typed address
 * cleared (06 §6.5); a remove never ends the lobby and never starts it. Any other row, the
 * creator's own included, is `404`, as one of another game would be.
 */
export function removeSeat(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  playerId: string,
  now: number,
): GameWriteSet | Refusal {
  if (viewer.joinedVia !== "creator") return { refused: "NOT_ALLOWED" };
  if (ctx.game.status !== "lobby" || now >= lobbyExpiresAt(ctx.game)) {
    return { refused: "WRONG_STATUS" };
  }
  const row = ctx.players.find((candidate) => candidate.id === playerId);
  if (row === undefined || row.id === viewer.id) return { refused: "NOT_FOUND" };
  if (row.state !== "invited" && row.state !== "joined") return { refused: "NOT_FOUND" };
  return {
    game: { updatedAt: now },
    updatePlayers: [{ id: row.id, set: { ...removedSet(now), inviteEmail: null } }],
  };
}

/** A removed row (02 §4): by the creator's Remove, a block, or the start's block re-check. */
function removedSet(now: number) {
  return { state: "removed" as const, removedAt: now };
}

/**
 * What a block by `viewer` of `otherId` writes in one lobby they share (06 §6.10, 05 §Blocks), or
 * null when it changes nothing there. Only where the viewer can already tell the other's row is
 * theirs: a joined row, or the viewer's own pick as the creator (`invite_email` NULL while
 * invited). Then the creator removes their seat, exactly as `…/remove-seat`; anyone else declines
 * their own, exactly as `…/decline` (an invited or joined seat alike, 02 §4), so neither the blocked
 * person nor anyone else can tell it from that action. Every other row is left alone: acting on it
 * would say whose it is (Q3); the accept, join, claim and start checks keep the pair apart there.
 */
export function blockEffect(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  otherId: string,
  now: number,
): GameWriteSet | null {
  const other = ctx.players.find((row) => row.userId === otherId);
  if (other === undefined || ctx.game.status !== "lobby" || now >= lobbyExpiresAt(ctx.game)) {
    return null;
  }
  const creator = viewer.joinedVia === "creator";
  const attributable =
    other.state === "joined" ||
    (creator && other.state === "invited" && other.inviteEmail === null);
  const member =
    viewer.state === "joined" || (viewer.state === "invited" && viewer.delivery !== "inert");
  if (!attributable || !member) return null;
  const writes = creator
    ? removeSeat(ctx, viewer, other.id, now)
    : declineInLobby(ctx, viewer, now);
  return isRefusal(writes) ? null : writes;
}

/** What a join link offers one signed-in user (06 §6.8), the same for the lookup and the join. */
export type JoinVerdict =
  /** The indistinguishable `404`: whatever the reason, it reads and says the same. */
  | { readonly kind: "refused" }
  /** Already joined (the creator included): the lookup shows the game, a join is `409`. */
  | { readonly kind: "member" }
  /** Holds a `normal` or `hidden` invitation: joining accepts it, open seat or not. */
  | { readonly kind: "accept"; readonly row: GamePlayerRecord }
  /** Holds no row: joining takes an open seat on a new one. */
  | { readonly kind: "seat" };

/** Seats not held by an `invited` or `joined` row (02 §4 open seats). */
export function openSeats(game: GameRecord, players: readonly GamePlayerRecord[]): number {
  const { joined, invited } = lobbyCounts(players);
  return Math.max(0, game.seats - joined - invited);
}

/**
 * The join-link rules (06 §6.8, 05 §Join links) for `userId`, given the link the token named and
 * whether a block lies between the user and anyone holding a row in the game (either direction).
 * Every refusal is the same `refused`, so neither the lookup nor the join can say which rule it was.
 */
export function joinVerdict(
  game: GameRecord,
  players: readonly GamePlayerRecord[],
  link: JoinLinkTimes,
  input: { readonly userId: string; readonly blocked: boolean; readonly now: number },
): JoinVerdict {
  const { userId, blocked, now } = input;
  const refused = { kind: "refused" } as const;
  if (game.status !== "lobby" || now >= lobbyExpiresAt(game) || !linkLive(link, now)) {
    return refused;
  }
  // A lobby whose creator's account was deleted takes no one new (its link went with them too).
  const creator = players.find((row) => row.joinedVia === "creator");
  if (creator?.userId == null) return refused;
  const own = players.find((row) => row.userId === userId);
  if (own?.state === "joined") return { kind: "member" };
  if (blocked) return refused;
  if (own !== undefined) {
    // An inert row is never accepted (its block, or its being a duplicate, stays hidden). Declined,
    // left and removed rows never come back through any link, a rotated or new one included: the
    // creator can play with a removed person in another game (cancel this one, create a new one).
    return own.state === "invited" && own.delivery !== "inert"
      ? { kind: "accept", row: own }
      : refused;
  }
  return openSeats(game, players) === 0 ? refused : { kind: "seat" };
}

/**
 * The join's writes (05 `POST /api/v1/join`) for a verdict that takes or accepts a seat. A join
 * never starts the game: the link it came through is live, and a link joiner holds the start for
 * the creator (02 §4). The joiner has seen the version their join creates.
 */
export function joinWrites(
  game: GameRecord,
  verdict: Extract<JoinVerdict, { kind: "accept" | "seat" }>,
  input: { readonly userId: string; readonly newRowId: string; readonly now: number },
): GameWriteSet {
  const { userId, newRowId, now } = input;
  const seen = game.version + 1;
  const base = { game: { updatedAt: now } };
  switch (verdict.kind) {
    case "accept":
      return {
        ...base,
        updatePlayers: [
          { id: verdict.row.id, set: { ...acceptedSet(now), lastSeenVersion: seen } },
        ],
      };
    case "seat":
      return {
        ...base,
        insertPlayers: [
          {
            id: newRowId,
            userId,
            state: "joined",
            joinedVia: "join_link",
            joinedAt: now,
            lastSeenVersion: seen,
          },
        ],
      };
  }
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
