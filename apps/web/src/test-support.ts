/** A fake API for the component tests: a handler table over the typed client; nothing touches the network. */
import { createApiClient } from "@your-move/api-client";
import { vi } from "vitest";

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

/** A VAPID public key, as `/api/v1/config` gives it (RFC 8291 Appendix A's, never deployed). */
export const PUSH_KEY =
  "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";

function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(key.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
}

interface FakePushOptions {
  /** `Notification.permission` now. Default `default`. */
  readonly permission?: NotificationPermission;
  /** What `requestPermission()` answers. Default `granted`. */
  readonly answer?: NotificationPermission;
  /** Whether a service worker is registered. Default true. */
  readonly registered?: boolean;
  /** An existing subscription, made with this VAPID key. */
  readonly subscribedWith?: string;
}

/**
 * A device with the Push API: a registration whose `pushManager` remembers one subscription, and
 * `Notification` with a permission. Undo it with {@link removeFakePush} (and
 * `vi.unstubAllGlobals`).
 */
export function fakePush(options: FakePushOptions = {}) {
  let permission: NotificationPermission = options.permission ?? "default";
  let serial = 0;
  const make = (key: Uint8Array<ArrayBuffer>) => {
    serial += 1;
    const endpoint = `https://fcm.googleapis.com/fcm/send/device-${String(serial)}`;
    const subscription = {
      endpoint,
      options: { applicationServerKey: key.buffer },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: "p", auth: "a" } }),
      unsubscribe: vi.fn(() => {
        if (state.subscription === subscription) state.subscription = null;
        return Promise.resolve(true);
      }),
    };
    return subscription;
  };
  const state: { subscription: ReturnType<typeof make> | null } = {
    subscription:
      options.subscribedWith === undefined ? null : make(keyBytes(options.subscribedWith)),
  };
  const pushManager = {
    getSubscription: vi.fn(() => Promise.resolve(state.subscription)),
    subscribe: vi.fn((init: { userVisibleOnly?: boolean; applicationServerKey: Uint8Array }) => {
      state.subscription = make(new Uint8Array(init.applicationServerKey));
      return Promise.resolve(state.subscription);
    }),
  };
  const requestPermission = vi.fn(() => {
    permission = options.answer ?? "granted";
    return Promise.resolve(permission);
  });
  Object.defineProperty(window.navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: () =>
        Promise.resolve(options.registered === false ? undefined : { pushManager }),
    },
  });
  vi.stubGlobal("PushManager", function PushManager() {
    // Only its presence is checked.
  });
  vi.stubGlobal("Notification", {
    get permission() {
      return permission;
    },
    requestPermission,
  });
  return { state, pushManager, requestPermission };
}

/** Takes the fake service worker container off `navigator` again. */
export function removeFakePush(): void {
  Reflect.deleteProperty(window.navigator, "serviceWorker");
  vi.unstubAllGlobals();
}
