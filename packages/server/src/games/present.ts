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
  ListedGame,
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
function isMemberRow(row: GamePlayerRecord): boolean {
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

/**
 * An invitation to a past opponent the creator picked by id (alpha A12), in an open lobby: a user
 * id but no typed address. While the lobby is open a typed address stays on its row until the row
 * leaves `invited` (06 §6.5); a lobby that ended has cleared every address, so there the two kinds
 * look alike and neither shows anything but its state. The creator already knows who they picked,
 * so they see the name (05 §Who sees what); nothing about a typed address decides whether a row is
 * one.
 *
 * This inference depends on an invariant: no writer clears `invite_email` on an `invited` row of an
 * open lobby (A12-S-3; pinned by the lifecycle unit tests and the repository contract). A writer
 * that broke it would show a typed invitation's user by name. An explicit marker on the row is M4's.
 */
function isPickedInvitation(row: GamePlayerRecord, lobbyOpen: boolean): boolean {
  return lobbyOpen && row.state === "invited" && row.userId !== null && row.inviteEmail === null;
}

/**
 * The users whose names a game's rows may show: rows that have joined, and invitations picked by
 * id in an open lobby (for the creator's `invitedAs`). Reading no others keeps a lobby's reads the
 * same whatever its typed addresses resolve to (Q3).
 */
export function shownUserIds(
  players: readonly GamePlayerRecord[],
  lobbyOpen: (gameId: string) => boolean,
): string[] {
  return [
    ...new Set(
      players.flatMap((row) =>
        row.userId === null ||
        (row.joinedAt === null && !isPickedInvitation(row, lobbyOpen(row.gameId)))
          ? []
          : [row.userId],
      ),
    ),
  ];
}

/** What the creator sees of an invitation (05 `invitedAs`): the typed address or the picked name. */
function invitedAsOf(
  row: GamePlayerRecord,
  users: ReadonlyMap<string, UserRecord>,
  lobbyOpen: boolean,
): string | undefined {
  if (row.state !== "invited") return undefined;
  if (row.inviteEmail !== null) return row.inviteEmail;
  if (!isPickedInvitation(row, lobbyOpen) || row.userId === null) return undefined;
  return users.get(row.userId)?.displayName ?? undefined;
}

export interface PresentInput {
  readonly game: GameRecord;
  readonly players: readonly GamePlayerRecord[];
  readonly resources: readonly GameResourceRecord[];
  /** Users of the game's joined rows ({@link shownUserIds}), by id; a missing one was deleted. */
  readonly users: ReadonlyMap<string, UserRecord>;
  readonly viewer: GamePlayerRecord;
  /** The installed game type, if any; its engine for this version decides `available`. */
  readonly type: GameType | undefined;
  readonly describeResource: (kind: "dictionary", id: string) => ResourceMeta | undefined;
}

/** What presenting the players needs: a few game columns, the rows, their users, the viewer. */
export interface PlayersInput {
  readonly game: Pick<GameRecord, "status" | "startedAt" | "turnTimeoutDays">;
  readonly players: readonly GamePlayerRecord[];
  readonly users: ReadonlyMap<string, UserRecord>;
  readonly viewer: GamePlayerRecord;
}

function playerOf(row: ShownRow, input: PlayersInput, creatorView: boolean): EnvelopePlayer {
  const { game, viewer } = input;
  // A row never joined shows no name or id to anyone (05 §Who sees what, Q3).
  const joined = row.joinedAt !== null;
  const user = joined && row.userId !== null ? input.users.get(row.userId) : undefined;
  const lobby = game.status === "lobby";
  const deadline = deadlineOf(row, game.turnTimeoutDays);
  const invitedAs = creatorView ? invitedAsOf(row, input.users, lobby) : undefined;
  return {
    ...(creatorView && lobby ? { playerId: row.id } : {}),
    seat: row.seat,
    userId: joined ? row.userId : null,
    displayName: joined ? (user?.displayName ?? null) : null,
    kind: user?.kind ?? "human",
    ...(invitedAs === undefined ? {} : { invitedAs }),
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
export function visiblePlayers(input: PlayersInput): EnvelopePlayer[] {
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
export function engineOf(input: {
  readonly game: Pick<GameRecord, "gameVersion">;
  readonly type: GameType | undefined;
}) {
  return input.type?.engine(input.game.gameVersion);
}

/**
 * The viewer's open invitation: an `invited` row they can see, while the lobby is still open. An
 * ended lobby's invitation can no longer be accepted, so it isn't one (A2 review P-1).
 */
export function invitationOf(
  game: Pick<GameRecord, "status">,
  viewer: GamePlayerRecord,
): GameEnvelope["yourInvitation"] {
  if (game.status !== "lobby" || viewer.state !== "invited" || viewer.delivery === "inert") {
    return null;
  }
  return viewer.delivery;
}

/** The seats in `toAct`, and whether the viewer's is one of them. */
export function turnOf(
  players: readonly GamePlayerRecord[],
  viewer: GamePlayerRecord,
): { toAct: number[]; yourTurn: boolean } {
  const toAct = players
    .filter((row) => row.toAct === 1 && row.seat !== null)
    .map((row) => row.seat ?? 0)
    .sort((a, b) => a - b);
  return { toAct, yourTurn: viewer.seat !== null && toAct.includes(viewer.seat) };
}

/** The game envelope for one member (05 §Common types). */
export function envelope(input: PresentInput): GameEnvelope {
  const { game, viewer } = input;
  const { toAct, yourTurn } = turnOf(input.players, viewer);
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
    yourSeat: viewer.seat,
    toAct,
    yourTurn,
    yourInvitation: invitationOf(game, viewer),
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

/** The list line (05 `GameSummary.summary`) of one listed game. */
export function summaryOf(input: {
  readonly game: ListedGame;
  readonly players: readonly GamePlayerRecord[];
  readonly viewer: GamePlayerRecord;
  readonly type: GameType | undefined;
}): ListSummary {
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
  if (game.finalSummary !== null) return JSON.parse(game.finalSummary) as ListSummary;
  return { headline: [LOBBY_ENDINGS[game.status] ?? "Ended"] };
}

/** A `Text` as the API schema types it (mutable arrays). */
export function plainText(text: Text): (string | { seat: number })[] {
  return text.map((part) => (typeof part === "string" ? part : { seat: part.seat }));
}
