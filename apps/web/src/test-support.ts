/** A fake API for the component tests: a handler table over the typed client; nothing touches the network. */
import { createApiClient } from "@your-move/api-client";

import type { GameEnvelope } from "./game-api.js";

export const CONFIG = {
  appName: "Family Games",
  appShortName: "Games",
  operatorContact: "ops@example.org",
  minAge: 13,
  uploadsEnabled: false,
};

export const ME = {
  id: "u1",
  kind: "human" as const,
  email: "sam@example.org",
  displayName: "Sam",
  settings: { whoCanAddMe: "pastOpponents" as const, emailNudges: false },
  ageAttested: true,
  needsOnboarding: false,
  isAdmin: false,
};

interface Call {
  readonly method: string;
  readonly path: string;
  /** The query string, with its `?`, or an empty string. */
  readonly search: string;
  readonly body: unknown;
}

type Answer = Response | Error | Promise<Response | Error>;
type Handler = (call: Call) => Answer;
type Routes = Record<string, Handler | Answer>;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const problem = (status: number, code: string): Response =>
  json({ error: { code, message: "x" } }, status);

/**
 * Routes are keyed `"METHOD /path"`; unlisted ones answer 404. `calls` records every request,
 * body included.
 */
export function fakeApi(routes: Routes) {
  const calls: Call[] = [];
  const api = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request: Request) => {
      const method = request.method;
      const path = new URL(request.url).pathname;
      const text = await request.clone().text();
      const call = {
        method,
        path,
        search: new URL(request.url).search,
        body: text === "" ? undefined : (JSON.parse(text) as unknown),
      };
      calls.push(call);
      // A route may name a query (`GET /api/v1/games?invitations=hidden`); the hidden-invitation
      // list is empty unless a test says otherwise.
      const search = new URL(request.url).search;
      const route: Handler | Answer | undefined =
        routes[`${method} ${path}${search}`] ??
        (search === "?invitations=hidden" && path === "/api/v1/games"
          ? json({ games: [], nextCursor: null })
          : routes[`${method} ${path}`]);
      const answer = await (typeof route === "function" ? route(call) : route);
      // A body can be read once; the same route may be asked again.
      if (answer instanceof Response) return answer.clone();
      if (answer instanceof Error) throw answer;
      return new Response(null, { status: 404 });
    },
  });
  return { api, calls };
}

/** A faked words-like game type, as the catalog lists it (icon: sanitised SVG markup). */
export const CATALOG_GAME = {
  type: "words",
  version: 1,
  name: "Words",
  description: "A crossword-tile word game.",
  icon: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
  players: { min: 2, max: 2 },
  defaultTurnTimeoutDays: 3,
  defaults: { rulesetId: "standard" },
  catalog: { note: "the module's own part" },
};
export const CATALOG = { games: [CATALOG_GAME] };

type Player = GameEnvelope["players"][number];

export function player(over: Partial<Player> = {}): Player {
  return {
    seat: 0,
    userId: "u1",
    displayName: "Sam",
    kind: "human",
    state: "playing",
    isYou: true,
    isCreator: true,
    ...over,
  };
}

/** An active two-player game where it is the viewer's turn, unless `over` says otherwise. */
export function envelope(over: Partial<GameEnvelope> = {}): GameEnvelope {
  return {
    id: "g1",
    gameType: "words",
    gameVersion: 1,
    options: { rulesetId: "standard" },
    status: "active",
    version: 3,
    endReason: null,
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    available: true,
    resources: [],
    players: [
      player(),
      player({ seat: 1, userId: "u2", displayName: "Alex", isYou: false, isCreator: false }),
    ],
    yourSeat: 0,
    toAct: [0],
    yourTurn: true,
    yourInvitation: null,
    createdAt: 1,
    lastActionAt: 2,
    ...over,
  };
}

/** A list row as `GET /api/v1/games` returns it. */
export function summary(over: Record<string, unknown> = {}) {
  const game = envelope();
  return {
    id: "g1",
    gameType: "words",
    status: "active",
    endReason: null,
    aiAssistance: "off",
    yourTurn: true,
    yourInvitation: null,
    players: game.players,
    summary: { headline: ["Your move"] },
    lastAction: null,
    lastActionAt: 2,
    unread: false,
    version: 3,
    ...over,
  };
}
