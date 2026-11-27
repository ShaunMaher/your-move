/**
 * The game framework's endpoints (docs/spec/05-api.md §Games, §Catalog): the catalog and rules,
 * creating and listing games, the game envelope and history, actions and previews, and the
 * lifecycle transitions. One schema per endpoint. The client-facing types a game client also needs
 * (`GameEnvelope`, `Text`, `ListSummary`) are the SDK's own Zod schemas, registered as they are,
 * so the generated client's types are structurally identical (02 §7.4).
 *
 * Game-specific payloads (`options`, `action`, `view`, `record`, `preview`, the module catalog) are
 * `unknown` here: each installed game module defines and validates them (05 §Versioning).
 */
import { createRoute, z } from "@hono/zod-openapi";
import { gameEnvelopeSchema, listSummarySchema, textSchema } from "@your-move/sdk";

import { EmptyObjectSchema } from "./auth.js";
import { ErrorResponseSchema } from "./errors.js";
import { API_V1 } from "./routes.js";

const errorContent = { "application/json": { schema: ErrorResponseSchema } } as const;
const SESSION = [{ sessionCookie: [] }];

/** Error responses by status, each with the shared error body (05 §Errors). */
function errors<const T extends Readonly<Record<number, string>>>(
  descriptions: T,
): { [K in keyof T]: { description: string; content: typeof errorContent } } {
  return Object.fromEntries(
    Object.entries(descriptions).map(([status, description]) => [
      status,
      { description, content: errorContent },
    ]),
  ) as { [K in keyof T]: { description: string; content: typeof errorContent } };
}

const COMMON_ERRORS = {
  400: "Invalid request (`BAD_REQUEST`), or a cookie and a bearer token together.",
  401: "No valid session (`UNAUTHENTICATED`).",
  413: "Body over 16 kB (`TOO_LARGE`).",
  415: "A body that isn't `application/json` (`UNSUPPORTED_MEDIA_TYPE`).",
  500: "Unexpected error.",
} as const;

const json = <T extends z.ZodType>(schema: T) => ({ "application/json": { schema } }) as const;
const jsonBody = <T extends z.ZodType>(schema: T) => ({ required: true, content: json(schema) });

/**
 * The game envelope (05 §Common types), registered exactly as the SDK defines it. The SDK's
 * schemas are used as they are, never extended: the SDK's Zod may be another instance than the one
 * `@hono/zod-openapi` extends, so they appear inline in the document rather than as named
 * components.
 */
export const GameEnvelopeSchema = gameEnvelopeSchema;
/** Display text: strings and `{ seat }` placeholders (02 §5). */
export const TextSchema = textSchema;
const ListSummarySchema = listSummarySchema;

/** Any value, but always present (`z.unknown()` alone would document the field as optional). */
const present = () => z.unknown().refine((value): boolean => value !== undefined, "Required");

const ModuleView = present().openapi({
  description:
    "The module's `view` for your seat (null in the lobby and for invitations); its shape is the installed game's `view` schema.",
});

const GameId = z
  .object({ id: z.string().min(1).max(64).openapi({ description: "The game id." }) })
  .strict();

const ExpectedVersion = z
  .number()
  .int()
  .min(0)
  .openapi({ description: "The game `version` the client last saw (03 §5.2)." });

/** `{ expectedVersion }`: the body of every lifecycle transition (05 §Lifecycle transitions). */
export const TransitionBodySchema = z
  .object({ expectedVersion: ExpectedVersion })
  .strict()
  .openapi("TransitionRequest");

/** A game and your view of it: `GET /api/v1/games/:id` and every lifecycle transition. */
export const GameWithViewSchema = z
  .object({ game: GameEnvelopeSchema, view: ModuleView })
  .strict()
  .openapi("GameWithView");

// Catalog and rules ---------------------------------------------------------------------------

export const CatalogSchema = z
  .object({
    games: z.array(
      z
        .object({
          type: z.string(),
          version: z.number().int().min(1).openapi({ description: "The latest rules version." }),
          name: z.string(),
          description: z.string(),
          icon: z.string().openapi({
            description:
              "Sanitised SVG markup (02 §7.2). Render it only as an image from a `data:` URL, never inline.",
          }),
          players: z.object({ min: z.number().int(), max: z.number().int() }).strict(),
          defaultTurnTimeoutDays: z.number().int().min(1).max(30),
          defaults: z.unknown().openapi({
            description:
              "The option input the new-game form starts from: your last options for this type if they still resolve, otherwise `{}` (module defaults).",
          }),
          catalog: z
            .unknown()
            .openapi({ description: "The module's catalog: its own schema (02 §2)." }),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("Catalog");

export const catalogRoute = createRoute({
  operationId: "getCatalog",
  "x-scope": "read",
  security: SESSION,
  method: "get",
  path: `${API_V1}/catalog`,
  tags: ["Games"],
  summary: "The game types you can create, with their options catalog",
  description:
    "Enabled game types only (`ENABLED_GAMES`). The module catalog sees the enabled built-in dictionaries; it never contains word-list contents, hashes or sizes.",
  responses: {
    200: { description: "The catalog.", content: json(CatalogSchema) },
    ...errors({ ...COMMON_ERRORS, 403: "`SUSPENDED`." }),
  },
});

export const RulesSchema = z
  .object({ type: z.string(), version: z.number().int().min(1), markdown: z.string() })
  .strict()
  .openapi("Rules");

export const rulesRoute = createRoute({
  operationId: "getGameRules",
  "x-scope": "public",
  method: "get",
  path: `${API_V1}/games/types/{type}/rules`,
  tags: ["Games"],
  summary: "A game type's rules, as Markdown",
  description:
    "Public. From the installed manifest (02 §7.2); the latest rules version unless `version` is given.",
  request: {
    params: z.object({ type: z.string().max(64) }).strict(),
    query: z
      .object({
        version: z
          .string()
          .regex(/^[1-9][0-9]{0,8}$/u)
          .optional()
          .openapi({ description: "A rules version; default the latest." }),
      })
      .strict(),
  },
  responses: {
    200: { description: "The rules.", content: json(RulesSchema) },
    ...errors({
      400: "Invalid request (`BAD_REQUEST`).",
      404: "Unknown game type or rules version (`NOT_FOUND`).",
      500: "Unexpected error.",
    }),
  },
});

// Creating a game -----------------------------------------------------------------------------

const EmailInvitee = z
  .object({
    email: z.string().max(320).openapi({
      description:
        "An address to invite. The response never reveals whether it has an account (06 §6.1).",
    }),
  })
  .strict();

const PickedInvitee = z
  .object({
    userId: z.string().min(1).max(64).openapi({
      description:
        "A past opponent's id, from `GET /api/v1/players/recent` (06 §6.1). They are added at once (`joined`) unless AI assistance is allowed, when they get an invitation (02 §4); anyone else is `INVALID_INVITEES`.",
    }),
  })
  .strict();

const Invitee = z.union([EmailInvitee, PickedInvitee]);

export const CreateGameBodySchema = z
  .object({
    gameType: z.string().max(64),
    options: z.unknown().optional().openapi({
      description:
        "The module's option input. Omitted top-level keys are filled from your last options for this type (05 §Remembered options).",
    }),
    seats: z.number().optional().openapi({
      description:
        "Seat count within the module's `players(options)`; default max if min = max, else min.",
    }),
    turnTimeoutDays: z.number().optional().openapi({
      description:
        "Whole days, 1–30 (`INVALID_TIMEOUT` otherwise); default the module's `defaultTurnTimeoutDays`.",
    }),
    seatOrder: z.enum(["join", "random"]).optional().openapi({ description: "Default `join`." }),
    aiAssistance: z.enum(["off", "allowed"]).optional().openapi({
      description:
        "Default `off` while any seat is open or two or more people play (02 §4); fixed at creation.",
    }),
    invitees: z.array(Invitee).max(16).openapi({
      description:
        "At most `seats - 1` people: addresses to invite, or past opponents to add by `userId`.",
    }),
  })
  .strict()
  .openapi("CreateGameRequest");

export const CreatedGameSchema = z
  .object({ game: GameEnvelopeSchema })
  .strict()
  .openapi("CreatedGame");

export const createGameRoute = createRoute({
  operationId: "createGame",
  "x-scope": "games:create",
  security: SESSION,
  method: "post",
  path: `${API_V1}/games`,
  tags: ["Games"],
  summary: "Create a game",
  description:
    "Every valid address gets a seat and the same response, whatever it turns out to be (Q3). A past opponent picked by `userId` is added at once. The game starts at once (`active`) only if every seat is filled by past opponents added that way; otherwise it waits in the lobby.",
  request: { body: jsonBody(CreateGameBodySchema) },
  responses: {
    201: { description: "The game.", content: json(CreatedGameSchema) },
    ...errors({
      ...COMMON_ERRORS,
      400: "`UNKNOWN_GAME`, `INVALID_OPTIONS` (`detail: { code, detail? }` with the module's code), `INVALID_SEAT_COUNT`, `INVALID_TIMEOUT`, `INVALID_INVITEES`, `CANNOT_PLAY_SELF` or `BAD_REQUEST`.",
      403: "`BAD_ORIGIN`, `ONBOARDING_REQUIRED` or `SUSPENDED`.",
      409: "`INVALID_SEATS` (the module's `validateStart`, `detail: { code, detail? }`) or `TOO_MANY_GAMES`.",
      429: "Too many games or email invitees (`RATE_LIMITED`); nothing is created.",
    }),
  },
});

// Rematch -------------------------------------------------------------------------------------

export const rematchRoute = createRoute({
  operationId: "rematchGame",
  "x-scope": "games:create",
  security: SESSION,
  method: "post",
  path: `${API_V1}/games/{id}/rematch`,
  tags: ["Games"],
  summary: "Rematch a finished game",
  description:
    "A player of a `finished` game asks for its rematch: the same game type, options (resolved again), seat count, turn timeout, seat order and AI setting, with every other player of the game whose account still exists picked by `userId`, created exactly as `POST /api/v1/games` would (`201`, you are the creator). A finished game has at most one rematch: once it exists every player's call answers `200` with it, accepting your invitation in it if you hold one. Anyone who wasn't a player of the game, or isn't a member of its rematch any more, gets `404`. Takes no input: an empty body or `{}`.",
  request: { params: GameId, body: { required: false, content: json(EmptyObjectSchema) } },
  responses: {
    200: {
      description: "The game's existing rematch (with your invitation accepted, if you held one).",
      content: json(CreatedGameSchema),
    },
    201: { description: "The rematch, created now.", content: json(CreatedGameSchema) },
    ...errors({
      ...COMMON_ERRORS,
      400: "As `POST /api/v1/games`: `UNKNOWN_GAME`, `INVALID_OPTIONS` (the stored options no longer resolve; `detail: { code, detail? }` with the module's code), `INVALID_SEAT_COUNT`, `INVALID_INVITEES` (another player can't be picked) or `BAD_REQUEST`.",
      403: "`BAD_ORIGIN`, `ONBOARDING_REQUIRED` or `SUSPENDED`.",
      404: "No such game, you weren't a player of it, or you're no longer a member of its rematch (`NOT_FOUND`).",
      409: "`WRONG_STATUS` (the game isn't `finished`, or the rematch's lobby has ended), `STALE_GAME` (accepting kept losing races; try again), `INVALID_SEATS` (`detail: { code, detail? }`), `TOO_MANY_GAMES` or `GAME_UNAVAILABLE`.",
      429: "Too many games or game writes (`RATE_LIMITED`); nothing is created.",
    }),
  },
});

// Listing games -------------------------------------------------------------------------------

const GamePlayer = gameEnvelopeSchema.shape.players.element;

export const GameSummarySchema = z
  .object({
    id: z.string(),
    gameType: z.string(),
    status: gameEnvelopeSchema.shape.status,
    endReason: z.string().nullable(),
    aiAssistance: z.enum(["off", "allowed"]),
    yourTurn: z.boolean(),
    yourInvitation: z.enum(["normal", "hidden"]).nullable(),
    players: z.array(GamePlayer),
    summary: ListSummarySchema,
    lastAction: z.object({ describe: TextSchema, byYou: z.boolean() }).strict().nullable(),
    lastActionAt: z.number().int(),
    unread: z.boolean(),
    version: z.number().int().min(0),
  })
  .strict()
  .openapi("GameSummary");

export const GameListSchema = z
  .object({
    games: z.array(GameSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi("GameList");

export const listGamesRoute = createRoute({
  operationId: "listGames",
  "x-scope": "read",
  security: SESSION,
  method: "get",
  path: `${API_V1}/games`,
  tags: ["Games"],
  summary: "Your games",
  description:
    "Newest activity first, 50 per page: every lobby and active game; finished games from the last 90 days; declined, cancelled and expired ones from the last 7 days.",
  request: {
    query: z
      .object({
        status: gameEnvelopeSchema.shape.status.optional(),
        gameType: z.string().max(64).optional(),
        invitations: z
          .enum(["true", "hidden"])
          .optional()
          .openapi({ description: "`true`: only your invitations; `hidden`: only hidden ones." }),
        cursor: z.string().max(200).optional(),
      })
      .strict(),
  },
  responses: {
    200: { description: "Your games.", content: json(GameListSchema) },
    ...errors({ ...COMMON_ERRORS, 403: "`ONBOARDING_REQUIRED` or `SUSPENDED`." }),
  },
});

// One game ------------------------------------------------------------------------------------

const MEMBER_ERRORS = {
  ...COMMON_ERRORS,
  403: "`SUSPENDED`.",
  404: "No such game, or you're not a member of it (`NOT_FOUND`).",
} as const;

export const getGameRoute = createRoute({
  operationId: "getGame",
  "x-scope": "read",
  security: SESSION,
  method: "get",
  path: `${API_V1}/games/{id}`,
  tags: ["Games"],
  summary: "A game and your view of it",
  description:
    "`view` is the module's view for your seat while active, null in the lobby, and your own final view after a started game ends.",
  request: { params: GameId },
  responses: {
    200: { description: "The game.", content: json(GameWithViewSchema) },
    ...errors(MEMBER_ERRORS),
  },
});

export const HistoryItemSchema = z
  .object({
    seq: z.number().int().min(1),
    seat: z.number().int().min(0),
    kind: z.enum(["action", "resign", "timeout", "decline"]),
    record: present().openapi({ description: "The module's public record (02 §2.1 rule 5)." }),
    describe: TextSchema,
    via: z.enum(["app", "token", "system"]).openapi({
      description:
        "How the transition was made: the app, an API token (an AI move, 02 §9.1) or the server itself (a timeout).",
    }),
    createdAt: z.number().int(),
  })
  .strict()
  .openapi("HistoryItem");

export const HistorySchema = z
  .object({ items: z.array(HistoryItemSchema), nextCursor: z.string().nullable() })
  .strict()
  .openapi("History");

export const historyRoute = createRoute({
  operationId: "getGameHistory",
  "x-scope": "read",
  security: SESSION,
  method: "get",
  path: `${API_V1}/games/{id}/history`,
  tags: ["Games"],
  summary: "A game's public history",
  description: "Oldest first, 100 per page. Empty for games that never started.",
  request: {
    params: GameId,
    query: z.object({ cursor: z.string().max(32).optional() }).strict(),
  },
  responses: {
    200: { description: "The history.", content: json(HistorySchema) },
    ...errors(MEMBER_ERRORS),
  },
});

export const SubmitActionBodySchema = z
  .object({
    expectedVersion: ExpectedVersion,
    action: z.unknown().openapi({ description: "The module's action." }),
  })
  .strict()
  .openapi("SubmitActionRequest");

export const ActionResultSchema = z
  .object({
    game: GameEnvelopeSchema,
    view: ModuleView,
    record: present().openapi({ description: "The transition's public record." }),
    describe: TextSchema,
  })
  .strict()
  .openapi("ActionResult");

const PLAY_ERRORS = {
  ...MEMBER_ERRORS,
  403: "`BAD_ORIGIN` or `SUSPENDED`.",
  429: "Too many requests (`RATE_LIMITED`).",
} as const;

export const submitActionRoute = createRoute({
  operationId: "submitAction",
  "x-scope": "play",
  security: SESSION,
  method: "post",
  path: `${API_V1}/games/{id}/actions`,
  tags: ["Games"],
  summary: "Make a move",
  description:
    "Checks in order: membership with a seat (`404`), `active` (`409 GAME_NOT_ACTIVE`, `GAME_UNAVAILABLE`), `expectedVersion` (`409 STALE_GAME`), your turn (`409 NOT_YOUR_TURN`), the action schema (`400 INVALID_ACTION`), then the module's `validate` (`400` with its `{ code, detail }`).",
  request: { params: GameId, body: jsonBody(SubmitActionBodySchema) },
  responses: {
    200: { description: "The move was made.", content: json(ActionResultSchema) },
    ...errors({
      ...PLAY_ERRORS,
      400: "`INVALID_ACTION`, a module error code with its detail, or `BAD_REQUEST`.",
      409: "`GAME_NOT_ACTIVE`, `GAME_UNAVAILABLE`, `STALE_GAME` or `NOT_YOUR_TURN`; refetch the game.",
    }),
  },
});

export const PreviewBodySchema = z
  .object({ action: z.unknown().openapi({ description: "A full module action." }) })
  .strict()
  .openapi("PreviewRequest");

export const PreviewResultSchema = z
  .object({ preview: z.unknown().openapi({ description: "The module's preview result." }) })
  .strict()
  .openapi("PreviewResult");

export const previewRoute = createRoute({
  operationId: "previewAction",
  "x-scope": "read",
  security: SESSION,
  method: "post",
  path: `${API_V1}/games/{id}/preview`,
  tags: ["Games"],
  summary: "Preview a move without making it",
  description:
    "Runs the membership, status, turn and schema checks of `/actions`, then the module's `preview`. `404` also for a game type without previews.",
  request: { params: GameId, body: jsonBody(PreviewBodySchema) },
  responses: {
    200: { description: "The preview.", content: json(PreviewResultSchema) },
    ...errors({
      ...PLAY_ERRORS,
      400: "`INVALID_ACTION`, a module error code with its detail, or `BAD_REQUEST`.",
      409: "`GAME_NOT_ACTIVE`, `GAME_UNAVAILABLE` or `NOT_YOUR_TURN`.",
    }),
  },
});

/** `POST /api/v1/games/:id/<name>` with `{ expectedVersion }` (05 §Lifecycle transitions). */
function transitionRoute(options: {
  readonly name: string;
  readonly operationId: string;
  readonly scope: string;
  readonly summary: string;
  readonly description: string;
  readonly errors: Readonly<Record<403 | 409, string>>;
  /** Also answers `204` when the transition ends the caller's membership. */
  readonly mayLeave?: boolean;
}) {
  return createRoute({
    operationId: options.operationId,
    "x-scope": options.scope,
    security: SESSION,
    method: "post",
    path: `${API_V1}/games/{id}/${options.name}`,
    tags: ["Games"],
    summary: options.summary,
    description: options.description,
    request: { params: GameId, body: jsonBody(TransitionBodySchema) },
    responses: {
      200: { description: "The game after the transition.", content: json(GameWithViewSchema) },
      ...(options.mayLeave === true
        ? { 204: { description: "Done; you are no longer a member of the game." } }
        : {}),
      ...errors({
        ...MEMBER_ERRORS,
        403: options.errors[403],
        409: options.errors[409],
        429: "Too many game writes (`RATE_LIMITED`).",
      }),
    },
  });
}

export const startGameRoute = transitionRoute({
  name: "start",
  operationId: "startGame",
  scope: "games:create",
  summary: "Start a game from the lobby",
  description:
    "Creator only, with at least the minimum number of seats joined. Unfilled seats are dropped.",
  errors: {
    403: "`NOT_ALLOWED` (not the creator), `BAD_ORIGIN` or `SUSPENDED`.",
    409: "`STALE_GAME`, `WRONG_STATUS`, `NOT_ENOUGH_PLAYERS`, `INVALID_SEATS` (`detail: { code, detail? }`) or `GAME_UNAVAILABLE` (this build no longer has the game's engine).",
  },
});

export const acceptInvitationRoute = transitionRoute({
  name: "accept",
  operationId: "acceptInvitation",
  scope: "join",
  summary: "Accept an invitation",
  description:
    "The holder of an invitation, in the lobby. The game starts by itself once every seat is joined.",
  errors: {
    403: "`ONBOARDING_REQUIRED`, `BAD_ORIGIN` or `SUSPENDED`.",
    409: "`STALE_GAME`, `WRONG_STATUS` or `GAME_UNAVAILABLE` (this build no longer has the game's engine).",
  },
});

export const declineGameRoute = transitionRoute({
  name: "decline",
  operationId: "declineGame",
  // A lobby decline is a `join` operation and a decline before a first action a `play` one
  // (05 §Token scopes); the scopes are enforced once API tokens exist.
  scope: "play",
  summary: "Decline an invitation or a game you haven't acted in",
  description:
    "An invited or joined player other than the creator, in the lobby (`204`: you are no longer a member); or any playing seat before its first action (`200`). Never a loss: too few players left ends the game `declined` with no ranking.",
  mayLeave: true,
  errors: {
    403: "`NOT_ALLOWED` (the creator in the lobby: cancel instead), `BAD_ORIGIN` or `SUSPENDED`.",
    409: "`STALE_GAME`, `ALREADY_ACTED`, `WRONG_STATUS` or `GAME_UNAVAILABLE` (this build no longer has the game's engine).",
  },
});

export const resignGameRoute = transitionRoute({
  name: "resign",
  operationId: "resignGame",
  scope: "play",
  summary: "Resign",
  description: "Any playing seat of an active game. A resignation is a loss.",
  errors: {
    403: "`BAD_ORIGIN` or `SUSPENDED`.",
    409: "`STALE_GAME`, `WRONG_STATUS` or `GAME_UNAVAILABLE` (this build no longer has the game's engine).",
  },
});

export const cancelGameRoute = transitionRoute({
  name: "cancel",
  operationId: "cancelGame",
  scope: "games:create",
  summary: "Cancel a game in the lobby",
  description: "Creator only, in the lobby.",
  errors: {
    403: "`NOT_ALLOWED` (not the creator), `BAD_ORIGIN` or `SUSPENDED`.",
    409: "`STALE_GAME`, `WRONG_STATUS` or `GAME_UNAVAILABLE` (this build no longer has the game's engine).",
  },
});

export const SeenBodySchema = z
  .object({ version: z.number().int().min(0) })
  .strict()
  .openapi("SeenRequest");

export const markSeenRoute = createRoute({
  operationId: "markGameSeen",
  "x-scope": "play",
  security: SESSION,
  method: "post",
  path: `${API_V1}/games/{id}/seen`,
  tags: ["Games"],
  summary: "Mark a game's activity as read",
  description: "Not a transition: it changes only your own unread marker.",
  request: { params: GameId, body: jsonBody(SeenBodySchema) },
  responses: {
    204: { description: "Marked." },
    ...errors({
      ...MEMBER_ERRORS,
      403: "`BAD_ORIGIN` or `SUSPENDED`.",
      429: "Too many game writes (`RATE_LIMITED`).",
    }),
  },
});

// Players -------------------------------------------------------------------------------------

export const RecentPlayersSchema = z
  .object({
    players: z.array(
      z
        .object({
          userId: z.string(),
          displayName: z.string(),
          lastPlayedAt: z.number().int().openapi({
            description: "When your latest finished game together ended (ms since the epoch).",
          }),
        })
        .strict(),
    ),
  })
  .strict()
  .openapi("RecentPlayers");

export const recentPlayersRoute = createRoute({
  operationId: "listRecentPlayers",
  "x-scope": "games:create",
  security: SESSION,
  method: "get",
  path: `${API_V1}/players/recent`,
  tags: ["Games"],
  summary: "Your past opponents, to pick for a new game",
  description:
    "People you've finished a game with, both having acted (04 `past_opponents`), newest first, at most 50, across all game types; never anyone with a block between you either way (06 §6.9).",
  responses: {
    200: { description: "Your past opponents.", content: json(RecentPlayersSchema) },
    ...errors({ ...COMMON_ERRORS, 403: "`ONBOARDING_REQUIRED` or `SUSPENDED`." }),
  },
});
