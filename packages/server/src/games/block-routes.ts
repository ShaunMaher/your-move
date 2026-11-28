/**
 * The block endpoints (docs/spec/05-api.md §Blocks, 06 §6.10, 08 T20; alpha A23): list, create and
 * remove the viewer's own blocks. Session only.
 *
 * A new block deletes the pair's past opponents in its own batch (04 invariant 6), then changes the
 * lobbies the two share, but only where the viewer can already tell the other's row is theirs (a
 * joined row, or the creator's own pick): the creator removes their seat, anyone else declines
 * their own, each written exactly as that action would be, so no one can tell it was a block. Any
 * other lobby is left as it is, so the block never says who an unattributed row is (Q3); the
 * accept, join, claim and start checks keep the two apart there. Games under way carry on.
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createBlockRoute, deleteBlockRoute, listBlocksRoute } from "@your-move/shared";
import type { Context } from "hono";

import type { LimitName } from "../auth/limits.js";
import { requireSession } from "../auth/require-session.js";
import type {
  BlockCursor,
  GamePlayerRecord,
  GameWriteSet,
  InstalledVersion,
  LoadedGame,
  TransitionResult,
  UserRecord,
} from "../db/repositories.js";
import { ApiError } from "../http/api-error.js";
import type { AppEnv, Platform } from "../platform.js";
import { blockEffect, type GameContext, LOBBY_LIFETIME_MS, SERVER_ATTEMPTS } from "./lifecycle.js";
import { memberRow } from "./present.js";

/** `GET /api/v1/blocks` lists this many a page (05 §Conventions: at most 100). */
const BLOCKS_PAGE = 100;

/** What the block routes borrow from the game routes, so lobby changes are judged the same way. */
export interface BlockRouteDeps {
  readonly platform: Platform;
  readonly userOf: (c: Context<AppEnv>) => UserRecord;
  readonly onboarded: (user: UserRecord) => void;
  readonly limit: (user: UserRecord, ...names: LimitName[]) => Promise<void>;
  /** The module context, or `409 GAME_UNAVAILABLE` for an orphaned game (02 §7.3). */
  readonly contextOf: (loaded: LoadedGame) => GameContext;
  /** Applies a write set as the actor's own transition (their unread marker moves with it). */
  readonly applyAs: (
    loaded: LoadedGame,
    writes: GameWriteSet,
    actor: GamePlayerRecord,
  ) => Promise<TransitionResult>;
  /** Lobbies one block changes at most (09 §3): Node 50, the Worker 6. */
  readonly lobbiesPerCall: number;
  /** The game type and version pairs this build can run (02 §7.3). */
  readonly installed: readonly InstalledVersion[];
}

/** The list cursor: the last listed block's `created_at` and blocked user id. */
const BLOCK_CURSOR = /^([0-9]{1,16}):([^:]{1,64})$/u;

function parseCursor(cursor: string | undefined): BlockCursor | undefined {
  if (cursor === undefined) return undefined;
  const match = BLOCK_CURSOR.exec(cursor);
  if (match === null) throw ApiError.of("BAD_REQUEST");
  return { createdAt: Number(match[1]), userId: match[2] ?? "" };
}

export function registerBlockRoutes(app: OpenAPIHono<AppEnv>, deps: BlockRouteDeps): void {
  const { platform, userOf, onboarded, limit, contextOf, applyAs } = deps;
  const { repos, log } = platform;
  const now = (): number => platform.now().getTime();

  const session = requireSession(platform);
  // One path for the list and the create; registered before the handlers, so it runs first.
  app.use(listBlocksRoute.path, session);
  app.use(deleteBlockRoute.path.replace("{userId}", ":userId"), session);

  app.openapi(listBlocksRoute, async (c) => {
    const user = userOf(c);
    const after = parseCursor(c.req.valid("query").cursor);
    const rows = await repos.users.blocksOf(user.id, {
      ...(after === undefined ? {} : { after }),
      limit: BLOCKS_PAGE + 1,
    });
    const blocks = rows.slice(0, BLOCKS_PAGE);
    const last = blocks.at(-1);
    const nextCursor =
      rows.length > BLOCKS_PAGE && last !== undefined
        ? `${String(last.createdAt)}:${last.userId}`
        : null;
    return c.json({ blocks, nextCursor }, 200);
  });

  /**
   * The block's change to one lobby (06 §6.10), as the viewer's own transition from the version it
   * was judged at; a lost race reloads and judges again (03 §5.2). Nothing when the lobby has
   * ended, the viewer is no longer a member, or the other's row isn't one the viewer can attribute.
   */
  const applyIn = async (gameId: string, viewerId: string, otherId: string): Promise<void> => {
    for (let attempt = 0; attempt < SERVER_ATTEMPTS; attempt++) {
      const loaded = await repos.games.load(gameId);
      const viewer = loaded === null ? undefined : memberRow(loaded.players, viewerId);
      if (loaded === null || viewer === undefined) return;
      const writes = blockEffect(contextOf(loaded), viewer, otherId, now());
      if (writes === null) return;
      // No push: lobby removals and declines reach the members as realtime only (02 §4).
      if ((await applyAs(loaded, writes, viewer)) === "ok") return;
    }
    // Every attempt lost a race: the lobby's next Start or Accept writes the same effect (02 §4
    // step 1), and a repeat of the block retries it.
    log.warn("block's lobby change kept losing races", { attempts: SERVER_ATTEMPTS });
  };

  app.openapi(createBlockRoute, async (c) => {
    const user = userOf(c);
    await limit(user, "WRITES_USER_MINUTE");
    const { userId } = c.req.valid("json");
    if (!(await repos.users.canBlock(user.id, userId))) throw ApiError.of("NOT_FOUND");
    const at = now();
    await repos.users.block(user.id, userId, at);
    const lobbies = await repos.games.blockableLobbies(user.id, userId, {
      createdAfter: at - LOBBY_LIFETIME_MS,
      installed: deps.installed,
      limit: deps.lobbiesPerCall,
    });
    for (const gameId of lobbies) {
      try {
        await applyIn(gameId, user.id, userId);
      } catch (error) {
        // The block stands whatever happened in one lobby: the accept, join and start checks
        // still keep the pair apart there, and a repeat retries.
        log.warn("block's lobby change failed", {
          errorClass:
            error instanceof ApiError
              ? error.code
              : error instanceof Error
                ? error.name
                : typeof error,
        });
      }
    }
    return c.body(null, 204);
  });

  app.openapi(deleteBlockRoute, async (c) => {
    const user = userOf(c);
    // Unblocking reopens contact, like making a join link: gated (06 §5).
    onboarded(user);
    await limit(user, "WRITES_USER_MINUTE");
    const { userId } = c.req.valid("param");
    if (!(await repos.users.unblock(user.id, userId))) throw ApiError.of("NOT_FOUND");
    return c.body(null, 204);
  });
}
