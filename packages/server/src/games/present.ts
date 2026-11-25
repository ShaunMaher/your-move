/**
 * What one viewer may see of a game (docs/spec/05-api.md §Common types, 02 §5, 04 invariant 4):
 * the envelope, the module view and the list summary. Game data reaches the viewer only through
 * the module's `view` and `summary` for their own seat, or their own `final_views` entry; the
 * state, the recorded randomness and other seats' final views never leave this module.
 */
import type { GameEnvelope, ListSummary, ResourceMeta, Text } from "@your-move/sdk";

import type {
  GamePlayerRecord,
  GameRecord,
  GameResourceRecord,
  UserRecord,
} from "../db/repositories.js";
import { deadlineOf, type FinalViews } from "./lifecycle.js";
import type { GameType } from "./registry.js";

type EnvelopePlayer = GameEnvelope["players"][number];

type ShownRow = GamePlayerRecord & { readonly state: EnvelopePlayer["state"] };

/** Lobby rows that are shown at all (05 §Who sees what). */
function isLobbyRow(row: GamePlayerRecord): row is ShownRow {
  return ["invited", "joined", "declined", "left", "removed"].includes(row.state);
}

/** Seated rows (`playing` or `out`), the only ones shown after start. */
function isSeatedRow(row: GamePlayerRecord): row is ShownRow {
  return row.seat !== null && (row.state === "playing" || row.state === "out");
}

/** Whether a row makes its user a member, for reads and actions (04 §Membership). */
export function isMemberRow(row: GamePlayerRecord): boolean {
  if (row.state === "joined" || row.state === "playing" || row.state === "out") return true;
  return row.state === "invited" && row.userId !== null && row.delivery !== "inert";
}

/** The viewer's own membership row, if any. */
export function memberRow(
  players: readonly GamePlayerRecord[],
  userId: string,
): GamePlayerRecord | undefined {
  return players.find((row) => row.userId === userId && isMemberRow(row));
}

export interface PresentInput {
  readonly game: GameRecord;
  readonly players: readonly GamePlayerRecord[];
  readonly resources: readonly GameResourceRecord[];
  /** Users of the game's rows, by id; a missing one has been deleted. */
  readonly users: ReadonlyMap<string, UserRecord>;
  readonly viewer: GamePlayerRecord;
  /** The installed game type, if any; its engine for this version decides `available`. */
  readonly type: GameType | undefined;
  readonly describeResource: (kind: "dictionary", id: string) => ResourceMeta | undefined;
}

function playerOf(row: ShownRow, input: PresentInput, creatorView: boolean): EnvelopePlayer {
  const { game, viewer } = input;
  // A row never joined shows no name or id to anyone (05 §Who sees what, Q3).
  const joined = row.joinedAt !== null;
  const user = row.userId === null ? undefined : input.users.get(row.userId);
  const lobby = game.status === "lobby";
  const deadline = deadlineOf(row, game.turnTimeoutDays);
  return {
    ...(creatorView && lobby ? { playerId: row.id } : {}),
    seat: row.seat,
    userId: joined ? row.userId : null,
    displayName: joined ? (user?.displayName ?? null) : null,
    kind: user?.kind ?? "human",
    ...(creatorView && row.state === "invited" && row.inviteEmail !== null
      ? { invitedAs: row.inviteEmail }
      : {}),
    state: row.state,
    ...(row.outReason === null ? {} : { outReason: row.outReason }),
    ...(row.rank === null ? {} : { rank: row.rank }),
    ...(row.score === null ? {} : { score: row.score }),
    ...(deadline === undefined ? {} : { deadline }),
    isYou: row.id === viewer.id,
    isCreator: row.joinedVia === "creator",
  };
}

/** The players a viewer sees: lobby rows in the lobby, seated players after start. */
function visiblePlayers(input: PresentInput): EnvelopePlayer[] {
  const { game, players, viewer } = input;
  const creatorView = viewer.joinedVia === "creator";
  const rows =
    game.startedAt === null
      ? players.filter(isLobbyRow)
      : players.filter(isSeatedRow).sort((a, b) => (a.seat ?? 0) - (b.seat ?? 0));
  return rows.map((row) => playerOf(row, input, creatorView));
}

function resourcesOf(input: PresentInput): GameEnvelope["resources"] {
  return input.resources.flatMap((resource) => {
    if (resource.kind !== "dictionary") return [];
    const meta = input.describeResource("dictionary", resource.resourceId);
    return [
      {
        kind: "dictionary" as const,
        id: resource.resourceId,
        name: meta?.name ?? resource.resourceId,
        ...(meta === undefined ? {} : { distribution: meta.distribution }),
        ...(meta?.downloadUrl === undefined ? {} : { downloadUrl: meta.downloadUrl }),
      },
    ];
  });
}

/** Whether this build still has the engine for the game's type and rules version (02 §7.3). */
export function engineOf(input: Pick<PresentInput, "game" | "type">) {
  return input.type?.engine(input.game.gameVersion);
}

/** The game envelope for one member (05 §Common types). */
export function envelope(input: PresentInput): GameEnvelope {
  const { game, viewer } = input;
  const toAct = input.players
    .filter((row) => row.toAct === 1 && row.seat !== null)
    .map((row) => row.seat ?? 0)
    .sort((a, b) => a - b);
  const yourSeat = viewer.seat;
  return {
    id: game.id,
    gameType: game.gameType,
    gameVersion: game.gameVersion,
    options: JSON.parse(game.options) as unknown,
    status: game.status,
    version: game.version,
    endReason: game.endReason,
    turnTimeoutDays: game.turnTimeoutDays,
    seatOrder: game.seatOrder,
    aiAssistance: game.aiAssistance,
    available: engineOf(input) !== undefined,
    resources: resourcesOf(input),
    players: visiblePlayers(input),
    yourSeat,
    toAct,
    yourTurn: yourSeat !== null && toAct.includes(yourSeat),
    yourInvitation:
      viewer.state === "invited" && viewer.delivery !== "inert" ? viewer.delivery : null,
    createdAt: game.createdAt,
    lastActionAt: game.lastActionAt,
  };
}

function storedFinalViews(game: GameRecord): FinalViews | null {
  return game.finalViews === null ? null : (JSON.parse(game.finalViews) as FinalViews);
}

/**
 * The viewer's view (05 `GET /api/v1/games/:id`): the module's view for their seat while active,
 * their own final view after a started game ends, otherwise null.
 */
export function viewOf(input: PresentInput): unknown {
  const { game, viewer } = input;
  if (viewer.seat === null) return null;
  if (game.status === "active") {
    const definition = engineOf(input);
    if (definition === undefined || game.state === null) return null;
    return definition.view(JSON.parse(game.state) as unknown, viewer.seat);
  }
  return storedFinalViews(game)?.seats[viewer.seat]?.view ?? null;
}

const LOBBY_ENDINGS: Readonly<Record<string, string>> = {
  cancelled: "Cancelled",
  declined: "Declined",
  expired: "Expired",
};

/** The list line (05 `GameSummary.summary`). */
export function summaryOf(input: PresentInput): ListSummary {
  const { game, viewer, players } = input;
  if (game.status === "lobby") {
    const open = game.seats - players.filter((row) => row.state === "joined").length;
    return {
      headline:
        open > 0
          ? [`Waiting for ${String(open)} ${open === 1 ? "player" : "players"}`]
          : ["Waiting for the creator to start"],
    };
  }
  if (game.status === "active") {
    const definition = engineOf(input);
    if (definition === undefined || game.state === null || viewer.seat === null) {
      return { headline: ["This game is no longer available"] };
    }
    return definition.summary(JSON.parse(game.state) as unknown, viewer.seat);
  }
  const stored = viewer.seat === null ? undefined : storedFinalViews(game)?.seats[viewer.seat];
  if (stored !== undefined) return stored.summary as ListSummary;
  return { headline: [LOBBY_ENDINGS[game.status] ?? "Ended"] };
}

/** A `Text` as the API schema types it (mutable arrays). */
export function plainText(text: Text): (string | { seat: number })[] {
  return text.map((part) => (typeof part === "string" ? part : { seat: part.seat }));
}
