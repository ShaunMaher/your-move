/**
 * The game framework's endpoints (docs/spec/05-api.md §Games, §Catalog): catalog and rules,
 * creating and listing games, one game's envelope and history, actions and previews, and the
 * lifecycle transitions. Every state change goes through the `write_token` transition (03 §5.2);
 * GET handlers never write game state.
 *
 * Membership decides access (04 §Membership): a game the viewer isn't a member of is `404`,
 * never `403`.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { isGameError, type ResourceMeta } from "@your-move/sdk";
import {
  acceptInvitationRoute,
  cancelGameRoute,
  catalogRoute,
  createGameRoute,
  declineGameRoute,
  getGameRoute,
  historyRoute,
  listGamesRoute,
  markSeenRoute,
  previewRoute,
  resignGameRoute,
  rulesRoute,
  startGameRoute,
  submitActionRoute,
} from "@your-move/shared";
import type { Context } from "hono";

import { checkLimits, type LimitName } from "../auth/limits.js";
import { requireSession } from "../auth/require-session.js";
import type { Subkeys } from "../crypto/subkeys.js";
import type { GamePlayerRecord, GameWriteSet, LoadedGame, UserRecord } from "../db/repositories.js";
import { ApiError } from "../http/api-error.js";
import type { AppEnv, Platform } from "../platform.js";
import { createGame } from "./create.js";
import {
  accept,
  cancel,
  decline,
  type GameContext,
  isModuleOutcome,
  isRefusal,
  moduleTransition,
  type ModuleOutcome,
  type Refusal,
  resign,
  start,
} from "./lifecycle.js";
import {
  engineOf,
  envelope,
  memberRow,
  plainText,
  type PresentInput,
  summaryOf,
  viewOf,
} from "./present.js";
import type { GameRegistry } from "./registry.js";
import type { ResourceProvider } from "./resources.js";
import { lastOptionsOf } from "./settings.js";

const DAY = 86_400_000;
const LIST_PAGE = 50;
const HISTORY_PAGE = 100;
/** `GET /api/v1/games` keeps finished games 90 days and other endings 7 days (05). */
const FINISHED_LISTED_MS = 90 * DAY;
const ENDED_LISTED_MS = 7 * DAY;

export interface GameRouteOptions {
  readonly platform: Platform;
  readonly registry: GameRegistry;
  readonly resources: ResourceProvider;
  readonly keys: () => Promise<Subkeys>;
}

/** OpenAPI's `{id}` path parameters as Hono's `:id`, for middleware registration. */
function honoPath(path: string): string {
  return path.replace(/\{([a-zA-Z]+)\}/gu, ":$1");
}

/** The list cursor: the last listed game's `last_action_at` and id. */
const LIST_CURSOR = /^([0-9]{1,16}):([0-9a-f-]{36})$/u;

function parseListCursor(cursor: string | undefined) {
  if (cursor === undefined) return undefined;
  const match = LIST_CURSOR.exec(cursor);
  if (match === null) throw ApiError.of("BAD_REQUEST");
  return { lastActionAt: Number(match[1]), id: match[2] ?? "" };
}

function parseSeqCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[0-9]{1,9}$/u.test(cursor)) throw ApiError.of("BAD_REQUEST");
  return Number(cursor);
}

/** A refusal from the lifecycle as the API answers it. */
function refusal(refused: Refusal): ApiError {
  return ApiError.of(refused.refused, refused.detail);
}

export function registerGameRoutes(app: OpenAPIHono<AppEnv>, options: GameRouteOptions): void {
  const { platform, registry, resources } = options;
  const { repos, config } = platform;
  const now = (): number => platform.now().getTime();

  const session = requireSession(platform);
  for (const route of [
    catalogRoute,
    createGameRoute,
    listGamesRoute,
    getGameRoute,
    historyRoute,
    submitActionRoute,
    previewRoute,
    startGameRoute,
    acceptInvitationRoute,
    declineGameRoute,
    resignGameRoute,
    cancelGameRoute,
    markSeenRoute,
  ]) {
    // Registered for the method only, so the public rules route under /games/types is unaffected.
    app.on(route.method.toUpperCase(), honoPath(route.path), session);
  }

  const userOf = (c: Context<AppEnv>): UserRecord => c.get("session").user;

  /** Onboarding gate (05: the game list, creating and accepting). Re-prompts arrive in M4. */
  const onboarded = (user: UserRecord): void => {
    if (user.onboardedAt === null) throw ApiError.of("ONBOARDING_REQUIRED");
  };

  const limit = async (user: UserRecord, ...names: LimitName[]): Promise<void> => {
    const results = await checkLimits(
      repos,
      config,
      now(),
      names.map((name) => ({ name, key: user.id, amount: 1 })),
    );
    if (results.some((result) => result.exceeded)) throw ApiError.of("RATE_LIMITED");
  };

  const describeResource = (kind: "dictionary", id: string): ResourceMeta | undefined =>
    resources.describe(kind, id);

  /** The game and the viewer's membership row, or `404` (04 §Membership). */
  const loadMember = async (
    gameId: string,
    user: UserRecord,
  ): Promise<{ loaded: LoadedGame; viewer: GamePlayerRecord }> => {
    const loaded = await repos.games.load(gameId);
    const viewer = loaded === null ? undefined : memberRow(loaded.players, user.id);
    if (loaded === null || viewer === undefined) throw ApiError.of("NOT_FOUND");
    return { loaded, viewer };
  };

  /** Everything presenting one game needs: its resources and its players' users. */
  const presentInput = async (
    loaded: LoadedGame,
    viewer: GamePlayerRecord,
  ): Promise<PresentInput> => {
    const ids = [
      ...new Set(loaded.players.flatMap((row) => (row.userId === null ? [] : [row.userId]))),
    ];
    const [gameResources, users] = await Promise.all([
      repos.games.resources(loaded.game.id),
      repos.users.findByIds(ids),
    ]);
    return {
      game: loaded.game,
      players: loaded.players,
      resources: gameResources,
      users: new Map(users.map((user) => [user.id, user])),
      viewer,
      type: registry.get(loaded.game.gameType),
      describeResource,
    };
  };

  /** `{ game, view }` for the viewer, freshly read. */
  const gameWithView = async (gameId: string, user: UserRecord) => {
    const { loaded, viewer } = await loadMember(gameId, user);
    const input = await presentInput(loaded, viewer);
    return { game: envelope(input), view: viewOf(input) };
  };

  /** As {@link gameWithView}, or null once the viewer is no longer a member (a lobby decline). */
  const gameWithViewIfMember = async (gameId: string, user: UserRecord) => {
    const loaded = await repos.games.load(gameId);
    const viewer = loaded === null ? undefined : memberRow(loaded.players, user.id);
    if (loaded === null || viewer === undefined) return null;
    const input = await presentInput(loaded, viewer);
    return { game: envelope(input), view: viewOf(input) };
  };

  /** The module context of a loaded game, or `409 GAME_UNAVAILABLE` (02 §7.3). */
  const contextOf = (loaded: LoadedGame): GameContext => {
    const definition = engineOf({ game: loaded.game, type: registry.get(loaded.game.gameType) });
    if (definition === undefined) throw ApiError.of("GAME_UNAVAILABLE");
    const parsed = definition.optionsSchema.safeParse(JSON.parse(loaded.game.options));
    if (!parsed.success) throw new Error("stored options don't match the module's schema");
    return {
      game: loaded.game,
      players: loaded.players,
      definition,
      options: parsed.data,
      state: loaded.game.state === null ? null : (JSON.parse(loaded.game.state) as unknown),
    };
  };

  /** Applies a write set from the version it was computed at; `409 STALE_GAME` if it lost. */
  const commit = async (loaded: LoadedGame, writes: GameWriteSet): Promise<void> => {
    const result = await repos.games.applyTransition(loaded.game.id, loaded.game.version, writes);
    if (result === "stale") throw ApiError.of("STALE_GAME");
  };

  /** A lifecycle transition (05 §Lifecycle transitions) from `expectedVersion`. */
  const lifecycle = async (
    c: Context<AppEnv>,
    gameId: string,
    expectedVersion: number,
    run: (
      ctx: GameContext,
      viewer: GamePlayerRecord,
      at: number,
    ) => GameWriteSet | ModuleOutcome | Refusal,
    gate?: (user: UserRecord) => void,
  ) => {
    const user = userOf(c);
    gate?.(user);
    await limit(user, "WRITES_USER_MINUTE");
    const { loaded, viewer } = await loadMember(gameId, user);
    const ctx = contextOf(loaded);
    if (loaded.game.version !== expectedVersion) throw ApiError.of("STALE_GAME");
    const outcome = run(ctx, viewer, now());
    if (isRefusal(outcome)) throw refusal(outcome);
    await commit(loaded, isModuleOutcome(outcome) ? outcome.writes : outcome);
    return gameWithViewIfMember(gameId, user);
  };

  /** A lifecycle transition whose caller always stays a member. */
  const memberLifecycle = async (...args: Parameters<typeof lifecycle>) => {
    const after = await lifecycle(...args);
    if (after === null) throw new Error("the viewer lost membership in a transition that keeps it");
    return after;
  };

  /**
   * The checks `/actions` and `/preview` share (05): a member with a seat (`404`), `active`
   * (`GAME_NOT_ACTIVE`) and not orphaned (`GAME_UNAVAILABLE`), then — for actions only — the
   * expected version.
   */
  const seatedContext = async (gameId: string, user: UserRecord) => {
    const { loaded, viewer } = await loadMember(gameId, user);
    if (viewer.seat === null) throw ApiError.of("NOT_FOUND");
    if (loaded.game.status !== "active") throw ApiError.of("GAME_NOT_ACTIVE");
    return { loaded, viewer, seat: viewer.seat, ctx: contextOf(loaded) };
  };

  // Catalog and rules --------------------------------------------------------------------------

  app.openapi(catalogRoute, (c) => {
    const user = userOf(c);
    const games = registry.enabled().flatMap((type) => {
      const ctx = { config: type.config, resources: resources.listForUser("dictionary", user.id) };
      const last = lastOptionsOf(user.settings, type.type);
      const lastResolved = last === undefined ? undefined : type.latest.resolveOptions(last, ctx);
      const useLast = lastResolved !== undefined && !isGameError(lastResolved);
      const resolved = useLast ? lastResolved : type.latest.resolveOptions({}, ctx);
      if (isGameError(resolved)) {
        // checkConfig keeps the defaults usable; a type whose defaults don't resolve isn't offered.
        platform.log.warn("game type's default options don't resolve", { gameType: type.type });
        return [];
      }
      return [
        {
          type: type.type,
          version: type.latest.version,
          name: type.manifest.name,
          description: type.manifest.description,
          icon: type.manifest.icon,
          players: { min: type.manifest.players.min, max: type.manifest.players.max },
          defaultTurnTimeoutDays: type.latest.defaultTurnTimeoutDays(resolved),
          defaults: useLast ? last : {},
          catalog: type.latest.catalog(ctx),
        },
      ];
    });
    return c.json({ games }, 200);
  });

  app.openapi(rulesRoute, (c) => {
    const { type: typeId } = c.req.valid("param");
    const { version } = c.req.valid("query");
    const type = registry.get(typeId);
    const number = version === undefined ? type?.latest.version : Number(version);
    const markdown = number === undefined ? undefined : type?.manifest.rules[number];
    if (type === undefined || number === undefined || markdown === undefined) {
      throw ApiError.of("NOT_FOUND");
    }
    return c.json({ type: type.type, version: number, markdown }, 200);
  });

  // Creating and listing ------------------------------------------------------------------------

  app.openapi(createGameRoute, async (c) => {
    const user = userOf(c);
    onboarded(user);
    await limit(user, "WRITES_USER_MINUTE");
    const body = c.req.valid("json");
    const gameId = await createGame(
      { platform, resources, keys: await options.keys() },
      user,
      registry.get(body.gameType),
      body,
    );
    const { game } = await gameWithView(gameId, user);
    return c.json({ game }, 201);
  });

  app.openapi(listGamesRoute, async (c) => {
    const user = userOf(c);
    onboarded(user);
    const query = c.req.valid("query");
    const at = now();
    const after = parseListCursor(query.cursor);
    const rows = await repos.games.listForUser({
      userId: user.id,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.gameType === undefined ? {} : { gameType: query.gameType }),
      ...(query.invitations === undefined
        ? {}
        : { invitations: query.invitations === "true" ? "normal" : "hidden" }),
      finishedSince: at - FINISHED_LISTED_MS,
      endedSince: at - ENDED_LISTED_MS,
      ...(after === undefined ? {} : { after }),
      limit: LIST_PAGE + 1,
    });
    const page = rows.slice(0, LIST_PAGE);
    const ids = page.map((row) => row.game.id);
    const [players, lastActions] = await Promise.all([
      repos.games.playersOf(ids),
      repos.games.lastActions(ids),
    ]);
    const userIds = [
      ...new Set(players.flatMap((row) => (row.userId === null ? [] : [row.userId]))),
    ];
    const users = new Map((await repos.users.findByIds(userIds)).map((u) => [u.id, u]));
    const games = page.map(({ game, member }) => {
      const input: PresentInput = {
        game,
        players: players.filter((row) => row.gameId === game.id),
        resources: [],
        users,
        viewer: member,
        type: registry.get(game.gameType),
        describeResource,
      };
      const shown = envelope(input);
      const last = lastActions.find((action) => action.gameId === game.id);
      const summary = summaryOf(input);
      return {
        id: game.id,
        gameType: game.gameType,
        status: game.status,
        endReason: game.endReason,
        aiAssistance: game.aiAssistance,
        yourTurn: shown.yourTurn,
        yourInvitation: shown.yourInvitation,
        players: shown.players,
        summary: {
          headline: plainText(summary.headline),
          ...(summary.scores === undefined ? {} : { scores: [...summary.scores] }),
        },
        lastAction:
          last === undefined
            ? null
            : {
                describe: JSON.parse(last.describe) as (string | { seat: number })[],
                byYou: member.seat !== null && last.seat === member.seat,
              },
        lastActionAt: game.lastActionAt,
        unread: member.delivery !== "hidden" && game.version > member.lastSeenVersion,
        version: game.version,
      };
    });
    const lastRow = page.at(-1);
    const nextCursor =
      rows.length > LIST_PAGE && lastRow !== undefined
        ? `${String(lastRow.game.lastActionAt)}:${lastRow.game.id}`
        : null;
    return c.json({ games, nextCursor }, 200);
  });

  // One game -------------------------------------------------------------------------------------

  app.openapi(getGameRoute, async (c) => {
    return c.json(await gameWithView(c.req.valid("param").id, userOf(c)), 200);
  });

  app.openapi(historyRoute, async (c) => {
    const { id } = c.req.valid("param");
    const after = parseSeqCursor(c.req.valid("query").cursor);
    await loadMember(id, userOf(c));
    const rows = await repos.games.history(id, after, HISTORY_PAGE + 1);
    const page = rows.slice(0, HISTORY_PAGE);
    const items = page.map((row) => ({
      seq: row.seq,
      seat: row.seat,
      kind: row.kind,
      record: JSON.parse(row.record) as unknown,
      describe: JSON.parse(row.describe) as (string | { seat: number })[],
      via: row.via === "token" ? ("token" as const) : ("app" as const),
      createdAt: row.createdAt,
    }));
    const last = page.at(-1);
    const nextCursor = rows.length > HISTORY_PAGE && last !== undefined ? String(last.seq) : null;
    return c.json({ items, nextCursor }, 200);
  });

  app.openapi(submitActionRoute, async (c) => {
    const user = userOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await limit(user, "WRITES_USER_MINUTE", "MOVES_USER_MINUTE");
    const { loaded, viewer, seat, ctx } = await seatedContext(id, user);
    if (loaded.game.version !== body.expectedVersion) throw ApiError.of("STALE_GAME");
    if (viewer.toAct !== 1) throw ApiError.of("NOT_YOUR_TURN");
    const parsed = ctx.definition.actionSchema.safeParse(body.action);
    if (!parsed.success) throw ApiError.of("INVALID_ACTION");
    const action: unknown = parsed.data;
    const loadedResources = await resources.load(await repos.games.resources(id));
    const valid = ctx.definition.validate(ctx.state, seat, action, loadedResources);
    if (isGameError(valid)) throw ApiError.module(valid.code, valid.detail);
    const outcome = moduleTransition(ctx, {
      seat,
      kind: "action",
      action,
      run: (rng) => ctx.definition.apply(ctx.state, seat, action, rng),
      now: now(),
    });
    await commit(loaded, outcome.writes);
    const after = await gameWithView(id, user);
    return c.json(
      {
        ...after,
        record: outcome.record,
        describe: plainText(ctx.definition.describe(outcome.record)),
      },
      200,
    );
  });

  app.openapi(previewRoute, async (c) => {
    const user = userOf(c);
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    await limit(user, "PREVIEWS_USER_MINUTE");
    const { viewer, seat, ctx } = await seatedContext(id, user);
    const preview = ctx.definition.preview?.bind(ctx.definition);
    if (preview === undefined) throw ApiError.of("NOT_FOUND");
    if (viewer.toAct !== 1) throw ApiError.of("NOT_YOUR_TURN");
    const parsed = ctx.definition.actionSchema.safeParse(body.action);
    if (!parsed.success) throw ApiError.of("INVALID_ACTION");
    const loadedResources = await resources.load(await repos.games.resources(id));
    const result = preview(ctx.state, seat, parsed.data, loadedResources);
    if (isGameError(result)) throw ApiError.module(result.code, result.detail);
    return c.json({ preview: result }, 200);
  });

  // Lifecycle transitions ------------------------------------------------------------------------

  app.openapi(startGameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { expectedVersion } = c.req.valid("json");
    return c.json(await memberLifecycle(c, id, expectedVersion, start), 200);
  });

  app.openapi(acceptInvitationRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { expectedVersion } = c.req.valid("json");
    return c.json(await memberLifecycle(c, id, expectedVersion, accept, onboarded), 200);
  });

  app.openapi(declineGameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { expectedVersion } = c.req.valid("json");
    // A lobby decline ends the decliner's membership: nothing left to show them (04 §Membership).
    const after = await lifecycle(c, id, expectedVersion, decline);
    return after === null ? c.body(null, 204) : c.json(after, 200);
  });

  app.openapi(resignGameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { expectedVersion } = c.req.valid("json");
    return c.json(await memberLifecycle(c, id, expectedVersion, resign), 200);
  });

  app.openapi(cancelGameRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { expectedVersion } = c.req.valid("json");
    return c.json(await memberLifecycle(c, id, expectedVersion, cancel), 200);
  });

  app.openapi(markSeenRoute, async (c) => {
    const user = userOf(c);
    const { id } = c.req.valid("param");
    await limit(user, "WRITES_USER_MINUTE");
    await loadMember(id, user);
    await repos.games.markSeen(id, user.id, c.req.valid("json").version);
    return c.body(null, 204);
  });
}
