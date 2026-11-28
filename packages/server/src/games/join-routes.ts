/**
 * The join-link endpoints (docs/spec/05-api.md §Join links and `…/join-link`, 06 §6.8, 08 T24,
 * alpha A18): the creator makes, rotates and revokes a lobby's link; anyone signed in and onboarded
 * with its token looks the game up and joins it. Every refusal of the lookup and the join is the
 * same `404`, with the same reads, so neither says which rule refused.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { GameEnvelope, ResourceMeta } from "@your-move/sdk";
import {
  createJoinLinkRoute,
  joinLookupRoute,
  joinRoute,
  revokeJoinLinkRoute,
} from "@your-move/shared";
import type { Context } from "hono";

import { clientBucketsOf } from "../auth/client-buckets.js";
import { checkLimits, type LimitCheck, type LimitName } from "../auth/limits.js";
import { requireSession } from "../auth/require-session.js";
import type { Subkeys } from "../crypto/subkeys.js";
import type { GamePlayerRecord, LoadedGame, UserRecord } from "../db/repositories.js";
import { ApiError } from "../http/api-error.js";
import type { AppEnv, Platform } from "../platform.js";
import { loadCurrent } from "./expiry.js";
import { hashJoinToken, joinUrl, linkTimes, newJoinToken, previewOf } from "./join-links.js";
import {
  type GameContext,
  joinVerdict,
  joinWrites,
  lobbyExpiresAt,
  SERVER_ATTEMPTS,
} from "./lifecycle.js";
import { resourcesOf } from "./present.js";

/** What the join routes borrow from the game routes, so both judge membership the same way. */
export interface JoinRouteDeps {
  readonly platform: Platform;
  readonly keys: () => Promise<Subkeys>;
  readonly userOf: (c: Context<AppEnv>) => UserRecord;
  readonly onboarded: (user: UserRecord) => void;
  readonly limit: (user: UserRecord, ...names: LimitName[]) => Promise<void>;
  readonly loadMember: (
    gameId: string,
    user: UserRecord,
  ) => Promise<{ loaded: LoadedGame; viewer: GamePlayerRecord }>;
  /** The module context, or `409 GAME_UNAVAILABLE` for an orphaned game (02 §7.3). */
  readonly contextOf: (loaded: LoadedGame) => GameContext;
  readonly gameWithView: (
    gameId: string,
    user: UserRecord,
  ) => Promise<{ game: GameEnvelope; view: unknown }>;
  readonly describeResource: (kind: "dictionary", id: string) => ResourceMeta | undefined;
}

export function registerJoinRoutes(app: OpenAPIHono<AppEnv>, deps: JoinRouteDeps): void {
  const { platform, userOf, onboarded, limit, loadMember } = deps;
  const { repos, config } = platform;
  const now = (): number => platform.now().getTime();

  const session = requireSession(platform);
  for (const route of [createJoinLinkRoute, revokeJoinLinkRoute, joinLookupRoute, joinRoute]) {
    app.on(route.method.toUpperCase(), route.path.replace(/\{([a-zA-Z]+)\}/gu, ":$1"), session);
  }

  /** The game's creator, in the game; anyone else in it is `403`, anyone outside it `404`. */
  const loadAsCreator = async (gameId: string, user: UserRecord) => {
    const member = await loadMember(gameId, user);
    if (member.viewer.joinedVia !== "creator") throw ApiError.of("NOT_ALLOWED");
    return member;
  };

  /** The creator's daily link creations (08 §4): read before a link is made, counted once it is. */
  const creations = (user: UserRecord, amount: 0 | 1) =>
    checkLimits(repos, config, now(), [
      { name: "JOIN_LINKS_CREATED_USER_DAY", key: user.id, amount },
    ]);

  app.openapi(createJoinLinkRoute, async (c) => {
    const user = userOf(c);
    // Making or rotating a link brings new people into the lobby: gated (06 §5, A21-S-5).
    // Revoking it stays open to a re-prompted creator.
    onboarded(user);
    await limit(user, "WRITES_USER_MINUTE");
    const { id } = c.req.valid("param");
    const { loaded } = await loadAsCreator(id, user);
    const at = now();
    if (loaded.game.status !== "lobby" || at >= lobbyExpiresAt(loaded.game)) {
      throw ApiError.of("WRONG_STATUS");
    }
    // Approximate under concurrent requests by the same creator (read, then counted): they can pass
    // the cap together, which is acceptable because each only rewrites that game's one link row.
    if ((await creations(user, 0)).some((result) => result.exceeded)) {
      throw ApiError.of("RATE_LIMITED");
    }
    const token = newJoinToken();
    const times = linkTimes(loaded.game, at);
    // Only while still a lobby: a start or another ending meanwhile leaves no link behind, and
    // then counts nothing against the creator.
    const written = await repos.joinLinks.put(id, {
      tokenHash: await hashJoinToken(token),
      ...times,
    });
    if (!written) throw ApiError.of("WRONG_STATUS");
    await creations(user, 1);
    return c.json({ url: joinUrl(config.publicUrl, token), expiresAt: times.expiresAt }, 200);
  });

  app.openapi(revokeJoinLinkRoute, async (c) => {
    const user = userOf(c);
    await limit(user, "WRITES_USER_MINUTE");
    const { id } = c.req.valid("param");
    await loadAsCreator(id, user);
    // Whatever the game's status: a lobby that ended or started has no link left anyway.
    await repos.joinLinks.revoke(id);
    return c.body(null, 204);
  });

  /**
   * The joiner's own limits (08 §4), counted for every lookup and join whatever it answers, before
   * the token is looked up: per user and per IP bucket, never the creator's. A request without a
   * client address is `400`, as on every route with a per-IP limit (08 §4.1).
   */
  const joinLimits = async (c: Context<AppEnv>, user: UserRecord, write: boolean) => {
    const buckets = await clientBucketsOf(platform, c, await deps.keys());
    if (buckets === null) throw ApiError.of("BAD_REQUEST");
    const checks: LimitCheck[] = [
      { name: "JOIN_LINK_USER_HOUR", key: user.id, amount: 1 },
      ...buckets.ipBuckets.map((bucket): LimitCheck => ({
        name: "JOIN_LINK_IP_HOUR",
        key: bucket.hash,
        amount: 1,
        multiplier: bucket.multiplier,
      })),
      ...(write ? [{ name: "WRITES_USER_MINUTE" as const, key: user.id, amount: 1 }] : []),
    ];
    const results = await checkLimits(repos, config, now(), checks);
    if (results.some((result) => result.exceeded)) throw ApiError.of("RATE_LIMITED");
  };

  /**
   * What the token offers the user now (06 §6.8): the link, the game as it stands and the verdict.
   * The same reads for every live link whatever the verdict turns out to be, the block check
   * included (one placeholder per row without a user), so the work never says which rule refused
   * (Q3). A well-formed token that isn't a live link's is the same `404`; the schema refuses any
   * other shape as a bad request.
   */
  const resolveJoin = async (token: string, user: UserRecord) => {
    const tokenHash = await hashJoinToken(token);
    const link = await repos.joinLinks.find(tokenHash);
    if (link === null) throw ApiError.of("NOT_FOUND");
    const at = now();
    const loaded = await loadCurrent(repos, link.gameId, user.id, at);
    if (loaded === null) throw ApiError.of("NOT_FOUND");
    const pairs = await repos.users.blocksAmong([
      user.id,
      ...loaded.players.map((row) => row.userId ?? ""),
    ]);
    const blocked = pairs.some((pair) => pair.blockerId === user.id || pair.blockedId === user.id);
    const verdict = joinVerdict(loaded.game, loaded.players, link, {
      userId: user.id,
      blocked,
      now: at,
    });
    return { link, tokenHash, loaded, verdict, at };
  };

  app.openapi(joinLookupRoute, async (c) => {
    const user = userOf(c);
    onboarded(user);
    await joinLimits(c, user, false);
    const { link, loaded, verdict } = await resolveJoin(c.req.valid("json").token, user);
    if (verdict.kind === "refused") throw ApiError.of("NOT_FOUND");
    const joinedIds = loaded.players.flatMap((row) =>
      row.state === "joined" && row.userId !== null ? [row.userId] : [],
    );
    const [gameResources, users] = await Promise.all([
      repos.games.resources(loaded.game.id),
      repos.users.findByIds(joinedIds),
    ]);
    const game = previewOf({
      game: loaded.game,
      players: loaded.players,
      users: new Map(users.map((found) => [found.id, found])),
      resources: resourcesOf({ resources: gameResources, describeResource: deps.describeResource }),
      link,
      youAreIn: verdict.kind === "member",
    });
    return c.json({ game }, 200);
  });

  app.openapi(joinRoute, async (c) => {
    const user = userOf(c);
    onboarded(user);
    await joinLimits(c, user, true);
    const { token } = c.req.valid("json");
    // A server-started transition: a lost race reloads and judges again (03 §5.2), so a seat
    // that filled meanwhile is the same `404` as a full game.
    for (let attempt = 1; ; attempt++) {
      const { loaded, verdict, at, tokenHash } = await resolveJoin(token, user);
      if (verdict.kind === "refused") throw ApiError.of("NOT_FOUND");
      if (verdict.kind === "member") throw ApiError.of("ALREADY_JOINED");
      // An orphaned game takes no one new: `409 GAME_UNAVAILABLE`, as every transition (02 §7.3).
      deps.contextOf(loaded);
      const writes = {
        ...joinWrites(loaded.game, verdict, {
          userId: user.id,
          newRowId: crypto.randomUUID(),
          now: at,
        }),
        // Only through the link as it was judged: one revoked, rotated or expired meanwhile makes
        // the join stale, and the retry finds the link gone (T24).
        requireJoinLink: { tokenHash, now: at },
        // And only while no block lies between the joiner and a joined member: a block made
        // meanwhile makes the join stale, and the retry finds it (A23-S-4).
        requireUnblocked: { userId: user.id },
      };
      // No push: joins reach the other members as realtime invalidations only (02 §4).
      const result = await repos.games.applyTransition(loaded.game.id, loaded.game.version, writes);
      if (result === "ok") {
        return c.json({ game: (await deps.gameWithView(loaded.game.id, user)).game }, 200);
      }
      if (attempt >= SERVER_ATTEMPTS) throw ApiError.of("STALE_GAME");
    }
  });
}
