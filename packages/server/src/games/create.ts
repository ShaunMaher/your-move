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
 * to (Q3). An invitation over the target's inbound cap is `hidden` (06 §6.7).
 *
 * A past opponent picked by `userId` (alpha A12) must be one the creator may pick (no block either
 * way, `INVALID_INVITEES` otherwise) and is added at once (`joined`, `joined_via = added`), unless
 * AI assistance is allowed or their stored `whoCanAddMe` is `nobody`, when it is an invitation
 * (02 §4, 06 §6.2). Picked invitees are seated before
 * typed addresses, whatever their order in the request, so a typed address never changes how a
 * picked one is seated: an address that resolves to a picked user, or to a user with a block
 * against anyone seated before it, gets an `inert` seat instead (06 §6.1). The route starts a game
 * whose seats are all filled this way (05 Created).
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
import { expireOverdueLobbies } from "./expiry.js";
import { LOBBY_LIFETIME_MS } from "./lifecycle.js";
import type { GameType } from "./registry.js";
import type { ResourceProvider } from "./resources.js";
import { lastOptionsOf, mergeOptions, rememberedInput, whoCanAddMeOf } from "./settings.js";

type CreateGameBody = z.infer<typeof CreateGameBodySchema>;

/** `TOO_MANY_GAMES` (05): live games a user created, in total and per invitee. */
const MAX_LIVE_CREATED = 50;
const MAX_LIVE_CREATED_PER_PAIR = 5;
/** `last_seen_version` of a row its user has never seen (04): below every game version. */
const NEVER_SEEN = -1;

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

/** The invitees: typed addresses, normalised, and past opponents picked by id. */
interface Invitees {
  readonly emails: readonly NormalisedEmail[];
  readonly picked: readonly string[];
}

/** The invitees, checked (05 `INVALID_INVITEES`, `CANNOT_PLAY_SELF`). */
function invitees(body: CreateGameBody, creator: UserRecord, seats: number): Invitees {
  if (body.invitees.length > seats - 1) throw ApiError.of("INVALID_INVITEES");
  const emails: NormalisedEmail[] = [];
  const picked: string[] = [];
  for (const invitee of body.invitees) {
    if ("userId" in invitee) {
      picked.push(invitee.userId);
      continue;
    }
    const address = normaliseAddress(invitee.email);
    if (address === null) throw ApiError.of("INVALID_INVITEES");
    emails.push(address);
  }
  if ((creator.email !== null && emails.includes(creator.email)) || picked.includes(creator.id)) {
    throw ApiError.of("CANNOT_PLAY_SELF");
  }
  // Only literal duplicates are refused, so the response never says whose address it is (06 §6.1).
  if (new Set(emails).size !== emails.length || new Set(picked).size !== picked.length) {
    throw ApiError.of("INVALID_INVITEES");
  }
  return { emails, picked };
}

/**
 * Every picked id must be a past opponent the creator may pick: no block either way, an onboarded
 * human (06 §6.1). Anything else is `INVALID_INVITEES`, the same answer whatever the reason.
 */
async function checkPicked(deps: CreateDeps, creator: UserRecord, picked: readonly string[]) {
  if (picked.length === 0) return;
  const pickable = new Set(await deps.platform.repos.users.pickableOpponents(creator.id, picked));
  if (picked.some((id) => !pickable.has(id))) throw ApiError.of("INVALID_INVITEES");
}

/**
 * Whether a picked past opponent is added at once (02 §4, 06 §6.2): under their `whoCanAddMe`
 * default, `pastOpponents`, unless AI assistance is allowed, so every person sees the AI setting
 * before they're in. A stored `nobody` makes it an invitation (the Settings choice is M4's). AI
 * seats arrive with AI accounts (M8).
 */
function addsAtOnce(aiAssistance: "off" | "allowed", user: UserRecord | undefined): boolean {
  return (
    aiAssistance === "off" && user !== undefined && whoCanAddMeOf(user.settings) === "pastOpponents"
  );
}

/** The blocks among a set of users, as a lookup either way round (04 `blocks`). */
async function blockLookup(deps: CreateDeps, userIds: readonly string[]) {
  const pairs = await deps.platform.repos.users.blocksAmong(userIds);
  const keys = new Set(pairs.map((pair) => `${pair.blockerId} ${pair.blockedId}`));
  return (a: string, b: string): boolean => keys.has(`${a} ${b}`) || keys.has(`${b} ${a}`);
}

/** Stands in for "no user" in the past-opponent lookup, so it runs the same for every address. */
const NO_USER = "";

/**
 * The inbound invitation cap (06 §6.7, 08 T20): a user receives at most 1 invitation a day from
 * any one creator who isn't a past opponent, and 3 a day in total from such creators; over the cap
 * the invitation is `hidden`. Counted in `rate_limits` keyed by the target's `emailId` (per
 * creator: creator and `emailId`), so it is counted, with the same lookups and writes, for every
 * typed address whatever it resolves to (Q3): a past opponent's invitation reads the counters
 * without adding to them, and one already over the per-creator cap adds nothing to the total. The
 * creator's response is the same either way. Returns each address's delivery.
 */
async function inboundDelivery(
  deps: CreateDeps,
  creator: UserRecord,
  emailIds: readonly string[],
  invitable: readonly (UserRecord | null)[],
  now: number,
): Promise<("normal" | "hidden")[]> {
  if (emailIds.length === 0) return [];
  const { repos, config } = deps.platform;
  const pastOpponents = new Set(
    await repos.users.pastOpponentsOf(
      creator.id,
      invitable.map((user) => user?.id ?? NO_USER),
    ),
  );
  const strangers = invitable.map((user) => user === null || !pastOpponents.has(user.id));
  const perCreator = await checkLimits(
    repos,
    config,
    now,
    emailIds.map((hash, i) => ({
      name: "INVITATIONS_RECEIVED_PAIR_DAY",
      key: `${creator.id}:${hash}`,
      amount: strangers[i] === true ? 1 : 0,
    })),
  );
  const total = await checkLimits(
    repos,
    config,
    now,
    emailIds.map((hash, i) => ({
      name: "INVITATIONS_RECEIVED_DAY",
      key: hash,
      amount: strangers[i] === true && perCreator[i]?.exceeded !== true ? 1 : 0,
    })),
  );
  return emailIds.map((_hash, i) =>
    strangers[i] === true && (perCreator[i]?.exceeded === true || total[i]?.exceeded === true)
      ? "hidden"
      : "normal",
  );
}

/** A created game: its id and the past opponents added to it at once. */
export interface CreatedGame {
  readonly gameId: string;
  /** User ids of the picked past opponents seated as `joined` (02 §4), in request order. */
  readonly added: readonly string[];
}

/** Creates the game. Throws {@link ApiError} for every refusal. */
export async function createGame(
  deps: CreateDeps,
  creator: UserRecord,
  type: GameType | undefined,
  body: CreateGameBody,
): Promise<CreatedGame> {
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
  const { emails, picked } = invitees(body, creator, seats);

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

  await checkPicked(deps, creator, picked);
  const pickedUsers = new Map((await repos.users.findByIds(picked)).map((user) => [user.id, user]));

  const emailIds = await Promise.all(emails.map((email) => emailId(keys, email)));
  // The live-game caps are read before the insert, so concurrent creates can pass them together
  // and go a few games over. That is accepted: the atomic daily limits below (30 games a day, 5 a
  // pair) bound how far, and the caps exist to stop slow accumulation (A2 review S-7).
  // An overdue lobby isn't live: expire the creator's before counting them (lazy expiry).
  await expireOverdueLobbies(repos, creator.id, platform.now().getTime());
  const live = await repos.games.countLiveCreated(creator.id);
  const perPair = await Promise.all([
    ...emailIds.map((hash) => repos.games.countLiveCreatedWithInvite(creator.id, hash)),
    // A picked past opponent's pair is (creator, userId) (06 §6.7).
    ...picked.map((id) => repos.games.countLiveCreatedWithUser(creator.id, id)),
  ]);
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
    ...picked.map((id): LimitCheck => ({
      name: "GAMES_CREATED_PAIR_DAY",
      key: `${creator.id}:user:${id}`,
      amount: 1,
    })),
  ];
  const limits = await checkLimits(repos, config, now, checks);
  if (limits.some((limit) => limit.exceeded)) throw ApiError.of("RATE_LIMITED");

  // The same lookup and the same row for every address, whatever it resolves to (Q3).
  const found = await Promise.all(emails.map((email) => repos.users.findByEmail(email)));
  const invitable = found.map((user) =>
    user?.kind === "human" && user.onboardedAt !== null ? user : null,
  );
  const delivery = await inboundDelivery(deps, creator, emailIds, invitable, now);
  // One lookup for every request, with a placeholder for each address that resolves to no one,
  // so the reads don't depend on what the addresses turn out to be (Q3).
  const blocked = await blockLookup(deps, [
    creator.id,
    ...picked,
    ...invitable.map((user) => user?.id ?? NO_USER),
  ]);
  const aiAssistance = body.aiAssistance ?? "off";
  /** Users holding a row so far, in seating order: the creator, then each invitee. */
  const seated: string[] = [creator.id];
  const blockedWithSeated = (userId: string) => seated.some((other) => blocked(userId, other));

  const pickedRows = picked.map((userId): NewGamePlayer => {
    // A block with the creator was refused above; one with an earlier picked invitee gives an
    // `inert` seat (06 §6.1).
    const inert = blockedWithSeated(userId);
    seated.push(userId);
    const base = { id: crypto.randomUUID(), userId, lastSeenVersion: NEVER_SEEN };
    if (inert) return { ...base, state: "invited", delivery: "inert" };
    if (!addsAtOnce(aiAssistance, pickedUsers.get(userId))) {
      return { ...base, state: "invited", delivery: "normal" };
    }
    // Unread until they open it, like an invitation (04 `last_seen_version`).
    return { ...base, state: "joined", joinedVia: "added", joinedAt: now };
  });
  const emailRows = emails.map((email, i): NewGamePlayer => {
    const user = invitable[i] ?? null;
    // Already added in this request: an `inert` email-only seat, so the response never confirms
    // whose address it is (06 §6.1).
    const duplicate = user !== null && seated.includes(user.id);
    const inert = duplicate || (user !== null && blockedWithSeated(user.id));
    if (user !== null && !duplicate) seated.push(user.id);
    return {
      id: crypto.randomUUID(),
      userId: duplicate ? null : (user?.id ?? null),
      inviteEmail: email,
      state: "invited",
      delivery: inert ? "inert" : (delivery[i] ?? "normal"),
      // Never seen: a new invitation is unread (A2 review P-6).
      lastSeenVersion: NEVER_SEEN,
    };
  });
  const gameId = crypto.randomUUID();
  const players: NewGamePlayer[] = [
    {
      id: crypto.randomUUID(),
      userId: creator.id,
      state: "joined",
      joinedVia: "creator",
      joinedAt: now,
    },
    ...pickedRows,
    ...emailRows,
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
      aiAssistance,
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
  return {
    gameId,
    added: pickedRows.flatMap((row) =>
      row.state === "joined" && row.userId != null ? [row.userId] : [],
    ),
  };
}
