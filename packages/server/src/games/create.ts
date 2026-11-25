/**
 * Creating a game (docs/spec/05-api.md `POST /api/v1/games`, 02 §4 Creating, 06 §6.1): option
 * resolution with remembered options, the seat count, the turn timeout, the invitees, resource
 * authorisation and `validateStart`, the creator's game caps and rate limits, then one atomic
 * insert of the lobby.
 *
 * Every valid address gets a seat and the same response, with the same reads and writes, whether
 * it belongs to an onboarded user (an invitation), to nobody or to an account that hasn't finished
 * onboarding (an email-invite seat, claimed at onboarding once email invites exist, M4). No email
 * is sent yet (M4). Per-pair counts use the typed address's `emailId`, never the user it resolves
 * to (Q3).
 */
import type { z } from "@hono/zod-openapi";
import { isGameError, type GameError, type OptionsContext } from "@your-move/sdk";
import type { CreateGameBodySchema } from "@your-move/shared";

import { normaliseAddress, type NormalisedEmail } from "../accounts/email.js";
import { checkLimits, type LimitCheck } from "../auth/limits.js";
import { emailId, type Subkeys } from "../crypto/subkeys.js";
import type { NewGamePlayer, UserRecord } from "../db/repositories.js";
import { ApiError } from "../http/api-error.js";
import type { Platform } from "../platform.js";
import type { GameType } from "./registry.js";
import type { ResourceProvider } from "./resources.js";
import { lastOptionsOf, mergeOptions, rememberedInput } from "./settings.js";

type CreateGameBody = z.infer<typeof CreateGameBodySchema>;

const DAY = 86_400_000;
/** Lobbies expire 14 days after creation (02 §4); `invites` rows expire with them. */
const LOBBY_LIFETIME_MS = 14 * DAY;
/** `TOO_MANY_GAMES` (05): live games a user created, in total and per invitee. */
const MAX_LIVE_CREATED = 50;
const MAX_LIVE_CREATED_PER_PAIR = 5;

export interface CreateDeps {
  readonly platform: Platform;
  readonly resources: ResourceProvider;
  readonly keys: Subkeys;
}

/** `INVALID_OPTIONS` with the module's code and detail (05 §Errors, module errors). */
function invalidOptions(error: GameError): ApiError {
  return ApiError.of("INVALID_OPTIONS", {
    code: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  });
}

/**
 * Resolves the option input with the remembered options merged in; if the module rejects that, once
 * more with the request's input alone (05 §Remembered options).
 */
function resolve(
  type: GameType,
  input: unknown,
  remembered: unknown,
  ctx: OptionsContext,
): { options: unknown; input: unknown } {
  const merged = mergeOptions(input, remembered);
  const first = type.latest.resolveOptions(merged, ctx);
  if (!isGameError(first)) return { options: first, input: merged };
  if (merged === input) throw invalidOptions(first);
  const second = type.latest.resolveOptions(input, ctx);
  if (isGameError(second)) throw invalidOptions(second);
  return { options: second, input };
}

/** The seat count (05 `seats`): default max if min = max, else min; within `players(options)`. */
function seatCount(type: GameType, options: unknown, seats: number | undefined): number {
  const { min, max } = type.latest.players(options);
  const count = seats ?? (min === max ? max : min);
  if (!Number.isInteger(count) || count < min || count > max) {
    throw ApiError.of("INVALID_SEAT_COUNT");
  }
  return count;
}

/** The turn timeout (02 §4): whole days, 1–30, validated by the framework. */
function timeoutDays(type: GameType, options: unknown, days: number | undefined): number {
  const value = days ?? type.latest.defaultTurnTimeoutDays(options);
  if (!Number.isInteger(value) || value < 1 || value > 30) throw ApiError.of("INVALID_TIMEOUT");
  return value;
}

/** The typed addresses, normalised and checked (05 `INVALID_INVITEES`, `CANNOT_PLAY_SELF`). */
function invitees(
  body: CreateGameBody,
  creator: UserRecord,
  seats: number,
): readonly NormalisedEmail[] {
  if (body.invitees.length > seats - 1) throw ApiError.of("INVALID_INVITEES");
  const addresses = body.invitees.map((invitee) => normaliseAddress(invitee.email));
  const valid = addresses.filter((address): address is NormalisedEmail => address !== null);
  if (valid.length !== addresses.length) throw ApiError.of("INVALID_INVITEES");
  if (creator.email !== null && valid.includes(creator.email)) {
    throw ApiError.of("CANNOT_PLAY_SELF");
  }
  // Only literal duplicates are refused, so the response never says whose address it is (06 §6.1).
  if (new Set(valid).size !== valid.length) throw ApiError.of("INVALID_INVITEES");
  return valid;
}

/** Creates the game and returns its id. Throws {@link ApiError} for every refusal. */
export async function createGame(
  deps: CreateDeps,
  creator: UserRecord,
  type: GameType | undefined,
  body: CreateGameBody,
): Promise<string> {
  const { platform, resources, keys } = deps;
  const { repos, config } = platform;
  if (type?.enabled !== true) throw ApiError.of("UNKNOWN_GAME");

  const ctx: OptionsContext = {
    config: type.config,
    resources: resources.listForUser("dictionary", creator.id),
  };
  const remembered = lastOptionsOf(creator.settings, type.type);
  const { options, input } = resolve(type, body.options, remembered, ctx);
  const seats = seatCount(type, options, body.seats);
  const turnTimeoutDays = timeoutDays(type, options, body.turnTimeoutDays);
  const emails = invitees(body, creator, seats);

  const requested = type.latest.resources(options);
  for (const resource of requested) {
    // Normally resolveOptions has refused already: it sees only what the creator may use.
    if (!resources.authorizeForNewGame(resource.kind, resource.id, creator.id)) {
      throw ApiError.of("INVALID_OPTIONS", { code: resources.unknownCode(resource.kind) });
    }
  }
  const startable = type.latest.validateStart(options, seats);
  if (isGameError(startable)) {
    throw ApiError.of("INVALID_SEATS", {
      code: startable.code,
      ...(startable.detail === undefined ? {} : { detail: startable.detail }),
    });
  }

  const emailIds = await Promise.all(emails.map((email) => emailId(keys, email)));
  const live = await repos.games.countLiveCreated(creator.id);
  const perPair = await Promise.all(
    emailIds.map((hash) => repos.games.countLiveCreatedWithInvite(creator.id, hash)),
  );
  if (live >= MAX_LIVE_CREATED || perPair.some((count) => count >= MAX_LIVE_CREATED_PER_PAIR)) {
    throw ApiError.of("TOO_MANY_GAMES");
  }

  const now = platform.now().getTime();
  const checks: LimitCheck[] = [
    // Counted for every typed address, whatever it turns out to be (08 §4).
    ...(emails.length === 0
      ? []
      : (["EMAIL_INVITEES_USER_HOUR", "EMAIL_INVITEES_USER_DAY"] as const).map(
          (name): LimitCheck => ({ name, key: creator.id, amount: emails.length }),
        )),
    { name: "GAMES_CREATED_USER_DAY", key: creator.id, amount: 1 },
    ...emailIds.map((hash): LimitCheck => ({
      name: "GAMES_CREATED_PAIR_DAY",
      key: `${creator.id}:${hash}`,
      amount: 1,
    })),
  ];
  const limits = await checkLimits(repos, config, now, checks);
  if (limits.some((limit) => limit.exceeded)) throw ApiError.of("RATE_LIMITED");

  // The same lookup and the same row for every address, whatever it resolves to (Q3).
  const found = await Promise.all(emails.map((email) => repos.users.findByEmail(email)));
  const gameId = crypto.randomUUID();
  const players: NewGamePlayer[] = [
    {
      id: crypto.randomUUID(),
      userId: creator.id,
      state: "joined",
      joinedVia: "creator",
      joinedAt: now,
    },
    ...emails.map((email, i): NewGamePlayer => {
      const user = found[i];
      const invitable = user?.kind === "human" && user.onboardedAt !== null;
      return {
        id: crypto.randomUUID(),
        userId: invitable ? user.id : null,
        inviteEmail: email,
        state: "invited",
        delivery: "normal",
      };
    }),
  ];
  await repos.games.create(
    {
      id: gameId,
      gameType: type.type,
      gameVersion: type.latest.version,
      options: JSON.stringify(options),
      status: "lobby",
      createdBy: creator.id,
      seats,
      turnTimeoutDays,
      seatOrder: body.seatOrder ?? "join",
      // Off whenever a seat is open or two people play (02 §4), which is every game until AI
      // accounts exist (M3); the creator may still allow it.
      aiAssistance: body.aiAssistance ?? "off",
      lastActionAt: now,
      createdAt: now,
      updatedAt: now,
    },
    players,
    {
      resources: requested.map((resource) => ({
        kind: resource.kind,
        resourceId: resource.id,
        version: resource.version ?? null,
      })),
      invites: emailIds.map((hash) => ({
        id: crypto.randomUUID(),
        inviterId: creator.id,
        emailHash: hash,
        sentAt: null,
        expiresAt: now + LOBBY_LIFETIME_MS,
      })),
    },
  );
  await repos.users.rememberGameOptions(creator.id, {
    gameType: type.type,
    input: rememberedInput(input),
    updatedAt: now,
  });
  return gameId;
}
