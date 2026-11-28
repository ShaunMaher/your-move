/**
 * Join-link tokens (docs/spec/06-auth.md §6.8, 08 T24, alpha A18): 128 random bits, shown once as
 * the fragment of `PUBLIC_URL/join#<token>` and stored only as their SHA-256, so the token never
 * reaches a server or proxy log and a database read can't use one.
 */
import type { GameEnvelope } from "@your-move/sdk";

import { toBase64Url } from "../base64.js";
import type {
  GamePlayerRecord,
  GameRecord,
  JoinLinkTimes,
  UserRecord,
} from "../db/repositories.js";
import { lobbyExpiresAt, openSeats } from "./lifecycle.js";

/** A link works for 7 days at most, and never past its lobby's expiry (06 §6.8, 04). */
const LINK_LIFETIME_MS = 7 * 86_400_000;

/** A fresh 128-bit token, from WebCrypto. */
export function newJoinToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** SHA-256 of the token, hex: the only form stored (04 `join_links.token_hash`). */
export async function hashJoinToken(token: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The link to share: the token in the fragment, which browsers never send (08 T24). */
export function joinUrl(publicUrl: string, token: string): string {
  return `${new URL("/join", publicUrl).toString()}#${token}`;
}

/** A new link's times: from now until 7 days on or the lobby's expiry, whichever is first. */
export function linkTimes(game: Pick<GameRecord, "createdAt">, now: number): JoinLinkTimes {
  return { createdAt: now, expiresAt: Math.min(now + LINK_LIFETIME_MS, lobbyExpiresAt(game)) };
}

/** What a link shows anyone signed in who has it (05 `POST /api/v1/join/lookup`). */
export interface JoinPreview {
  readonly id: string;
  readonly gameType: string;
  readonly options: unknown;
  readonly resources: GameEnvelope["resources"];
  readonly turnTimeoutDays: number;
  readonly seatOrder: GameRecord["seatOrder"];
  readonly aiAssistance: GameRecord["aiAssistance"];
  readonly creatorName: string | null;
  readonly players: { displayName: string | null; kind: "human" | "agent" }[];
  readonly openSeats: number;
  readonly expiresAt: number;
  /** Present when the viewer has already joined (05): the page offers to open the game. */
  readonly youAreIn?: true;
}

/**
 * The lookup's answer: the game's setup, the creator's name and **joined** players' names only
 * (06 §6.8), so a link holder learns nothing of invitations, typed addresses or anyone who left.
 */
export function previewOf(input: {
  readonly game: GameRecord;
  readonly players: readonly GamePlayerRecord[];
  /** The users of the joined rows, by id; a missing one was deleted. */
  readonly users: ReadonlyMap<string, UserRecord>;
  readonly resources: GameEnvelope["resources"];
  readonly link: JoinLinkTimes;
  readonly youAreIn: boolean;
}): JoinPreview {
  const { game, players, users, link } = input;
  const joined = players.filter((row) => row.state === "joined");
  const userOf = (row: GamePlayerRecord) =>
    row.userId === null ? undefined : users.get(row.userId);
  const creator = joined.find((row) => row.joinedVia === "creator");
  return {
    id: game.id,
    gameType: game.gameType,
    options: JSON.parse(game.options) as unknown,
    resources: input.resources,
    turnTimeoutDays: game.turnTimeoutDays,
    seatOrder: game.seatOrder,
    aiAssistance: game.aiAssistance,
    creatorName: creator === undefined ? null : (userOf(creator)?.displayName ?? null),
    players: joined.map((row) => ({
      displayName: userOf(row)?.displayName ?? null,
      kind: userOf(row)?.kind ?? "human",
    })),
    openSeats: openSeats(game, players),
    expiresAt: link.expiresAt,
    ...(input.youAreIn ? { youAreIn: true as const } : {}),
  };
}
