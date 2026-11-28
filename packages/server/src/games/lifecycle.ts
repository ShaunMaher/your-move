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
 * A transition that is written and then answered with a refusal (alpha A23): an accept that found
 * a block with a joined member (its own decline, then `404`, 05 `/accept`), and a Start whose
 * outstanding block effects leave too few players or end the lobby (02 §4 step 1).
 */
export interface Settled {
  readonly settle: GameWriteSet;
  readonly then: Refusal;
}

/** Whether a lifecycle function wrote something and then refused (05 `/accept`, `/start`). */
export function isSettled(value: object): value is Settled {
  return "settle" in value;
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

/** The joined rows, the creator first, then in joining order (02 §4 seat order `join`). */
function joinedInOrder(players: readonly GamePlayerRecord[]): GamePlayerRecord[] {
  // Rows that joined in the same millisecond keep the order they were added in (the sort is
  // stable, and the rows come in that order): past opponents added at creation sit in the order
  // the creator listed them.
  return players
    .filter((row) => row.state === "joined")
    .sort((a, b) => {
      const creator = Number(b.joinedVia === "creator") - Number(a.joinedVia === "creator");
      return creator !== 0 ? creator : (a.joinedAt ?? 0) - (b.joinedAt ?? 0);
    });
}

/** The lobby's rows after a set of row updates. */
function withUpdates(
  players: readonly GamePlayerRecord[],
  updates: ReadonlyMap<string, GamePlayerUpdate>,
): GamePlayerRecord[] {
  return players.map((row) => {
    const set = updates.get(row.id);
    return set === undefined ? row : { ...row, ...set };
  });
}

/** What {@link settleBlocks} found: the rows' updates, the rows after them, and a lobby ending. */
interface Settlement {
  readonly updates: ReadonlyMap<string, GamePlayerUpdate>;
  readonly players: readonly GamePlayerRecord[];
  /** A decline left the lobby unable to fill: it ends `declined`, as a decline would end it. */
  readonly ended: boolean;
}

/**
 * The outstanding block effects among a lobby's joined players (02 §4 Start step 1, 06 §6.10,
 * A23-S-3): for each pair of joined users with a block, the blocker's own effect, exactly as the
 * block itself would have written it had it reached this lobby: the blocker's Decline, or, when
 * the creator is the blocker, a Remove of the person blocked. Never anything a bystander couldn't
 * attribute to the blocker's own action. Pairs are taken in joining order until none is left.
 */
function settleBlocks(ctx: GameContext, pairs: readonly BlockPair[], now: number): Settlement {
  const blocks = (a: string | null, b: string | null) =>
    a !== null && b !== null && pairs.some((pair) => pair.blockerId === a && pair.blockedId === b);
  const updates = new Map<string, GamePlayerUpdate>();
  let players = [...ctx.players];
  let declined = false;
  for (;;) {
    const joined = joinedInOrder(players);
    let found: { readonly earlier: GamePlayerRecord; readonly later: GamePlayerRecord } | null =
      null;
    for (let j = 0; j < joined.length && found === null; j++) {
      for (let i = 0; i < j && found === null; i++) {
        const [earlier, later] = [joined[i], joined[j]];
        if (earlier === undefined || later === undefined) continue;
        if (blocks(earlier.userId, later.userId) || blocks(later.userId, earlier.userId)) {
          found = { earlier, later };
        }
      }
    }
    if (found === null) break;
    const { earlier, later } = found;
    let row: GamePlayerRecord;
    let set: GamePlayerUpdate;
    if (earlier.joinedVia === "creator" && blocks(earlier.userId, later.userId)) {
      // The creator's block: their Remove of the person blocked.
      [row, set] = [later, { ...removedSet(now), inviteEmail: null }];
    } else {
      // Otherwise the blocker's own Decline (the later one's, if both blocked).
      row = blocks(later.userId, earlier.userId) ? later : earlier;
      set = { state: "declined", inviteEmail: null };
      declined = true;
    }
    updates.set(row.id, { ...updates.get(row.id), ...set });
    players = withUpdates(players, new Map([[row.id, set]]));
  }
  if (!declined) return { updates, players, ended: false };
  // A Decline ends a lobby that can no longer fill (02 §4); a Remove never does.
  const { joined, invited } = lobbyCounts(players);
  const { min } = ctx.definition.players(ctx.options);
  return { updates, players, ended: joined + invited < min && !linkLive(ctx.joinLink, now) };
}

/** The settlement's writes on their own: its rows, and the lobby's ending if a decline ended it. */
function settledWrites(ctx: GameContext, settled: Settlement, now: number): GameWriteSet {
  const rows = [...settled.updates].map(([id, set]) => ({ id, set }));
  if (!settled.ended) return { game: { updatedAt: now }, updatePlayers: rows };
  return {
    deleteJoinLink: true,
    game: { status: "declined", endReason: "declined", endedAt: now, updatedAt: now },
    updatePlayers: [
      ...rows,
      ...clearAddresses(ctx.players).filter((update) => !settled.updates.has(update.id)),
    ],
  };
}

/** A write set with more row updates merged into it, a row's sets combined. */
function mergeRows(
  writes: GameWriteSet,
  updates: ReadonlyMap<string, GamePlayerUpdate>,
): GameWriteSet {
  const merged = new Map<string, GamePlayerUpdate>(updates);
  for (const update of writes.updatePlayers ?? []) {
    merged.set(update.id, { ...merged.get(update.id), ...update.set });
  }
  return { ...writes, updatePlayers: [...merged].map(([id, set]) => ({ id, set })) };
}

/**
 * The start transition's writes (02 §4 Start, steps 2–5) for a lobby whose blocks are settled:
 * `validateStart`, unjoined rows out of the game, seats by the seat order (a `random` order drawn
 * from the recorded randomness), `setup` and the first clocks.
 */
function startWrites(ctx: GameContext, now: number): GameWriteSet | GameError {
  const { definition, game } = ctx;
  const joined = joinedInOrder(ctx.players);
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
 * simply leaves it there. Outstanding block effects among the joined (a block made in between)
 * are written instead, and the game then waits (02 §4 step 1). Null when nothing is written.
 */
export function startAtCreation(
  ctx: GameContext,
  now: number,
  pairs: readonly BlockPair[],
): GameWriteSet | null {
  if (ctx.game.status !== "lobby" || !autoStarts(ctx.game, ctx.players, ctx.joinLink, now)) {
    return null;
  }
  const settled = settleBlocks(ctx, pairs, now);
  if (settled.updates.size > 0) return settledWrites(ctx, settled, now);
  const writes = startWrites(ctx, now);
  return isGameError(writes) ? null : writes;
}

/**
 * Another transition's row update, with the outstanding block effects among the joined that it
 * finds (02 §4 step 1, A23-S-3) and the automatic start when the lobby is then full.
 */
function withStart(
  ctx: GameContext,
  rowUpdate: { id: string; set: GamePlayerUpdate },
  now: number,
  pairs: readonly BlockPair[],
): GameWriteSet {
  const players = withUpdates(ctx.players, new Map([[rowUpdate.id, rowUpdate.set]]));
  const settled = settleBlocks({ ...ctx, players }, pairs, now);
  const updates = new Map(settled.updates);
  updates.set(rowUpdate.id, { ...rowUpdate.set, ...settled.updates.get(rowUpdate.id) });
  const plain = settledWrites(ctx, { ...settled, updates }, now);
  if (settled.ended || !autoStarts(ctx.game, settled.players, ctx.joinLink, now)) return plain;
  const started = startWrites({ ...ctx, players: settled.players }, now);
  // An automatic start that validateStart refuses simply doesn't happen (02 §4 step 2).
  if (isGameError(started)) return plain;
  return mergeRows(started, updates);
}

/**
 * `POST /start`: the creator, in the lobby, with at least `min` joined (05). Outstanding block
 * effects among the joined are written first, each the blocker's own Decline or Remove (02 §4
 * step 1, A23-S-3); if they leave fewer than `min`, or end the lobby, they are written and the
 * answer is `NOT_ENOUGH_PLAYERS`, so the lobby converges whatever the start does.
 */
export function start(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
  pairs: readonly BlockPair[],
): GameWriteSet | Settled | Refusal {
  if (viewer.joinedVia !== "creator") return { refused: "NOT_ALLOWED" };
  if (ctx.game.status !== "lobby" || now >= lobbyExpiresAt(ctx.game)) {
    return { refused: "WRONG_STATUS" };
  }
  const { min } = ctx.definition.players(ctx.options);
  if (lobbyCounts(ctx.players).joined < min) return { refused: "NOT_ENOUGH_PLAYERS" };
  const settled = settleBlocks(ctx, pairs, now);
  const settledOnly = settledWrites(ctx, settled, now);
  if (settled.ended || lobbyCounts(settled.players).joined < min) {
    return { settle: settledOnly, then: { refused: "NOT_ENOUGH_PLAYERS" } };
  }
  const writes = startWrites({ ...ctx, players: settled.players }, now);
  if (isGameError(writes)) {
    const refused: Refusal = {
      refused: "INVALID_SEATS",
      detail: {
        code: writes.code,
        ...(writes.detail === undefined ? {} : { detail: writes.detail }),
      },
    };
    return settled.updates.size > 0 ? { settle: settledOnly, then: refused } : refused;
  }
  return mergeRows(writes, settled.updates);
}

/**
 * `POST /accept`: the holder of an invitation, in the lobby; may start the game (02 §4). A block in
 * either direction between the holder and any joined member declines the invitation instead,
 * exactly as the holder's own decline would (05, alpha A23): the caller writes it and answers
 * `404`. It is a backstop: a block already makes the person blocked's invitations in the blocker's
 * lobbies `inert` (06 §6.10). The write set carries the guard against a block racing it (A23-S-4).
 */
export function accept(
  ctx: GameContext,
  viewer: GamePlayerRecord,
  now: number,
  pairs: readonly BlockPair[],
): GameWriteSet | Settled | Refusal {
  if (
    ctx.game.status !== "lobby" ||
    viewer.state !== "invited" ||
    now >= lobbyExpiresAt(ctx.game)
  ) {
    return { refused: "WRONG_STATUS" };
  }
  const { userId } = viewer;
  const blocked = blockedBy(pairs);
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
    return { settle: declined, then: { refused: "NOT_FOUND" } };
  }
  const writes = withStart(ctx, { id: viewer.id, set: acceptedSet(now) }, now, pairs);
  return userId === null ? writes : { ...writes, requireUnblocked: { userId } };
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

/** A removed row (02 §4): by the creator's Remove, their block, or that block found at a start. */
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
