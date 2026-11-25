/**
 * The game calls the shell makes (05 §Games), each settled into a result the screens can show
 * without knowing HTTP. Only the typed API client is used (03 §1 principle 6). A network failure
 * has status 0; every other failure carries the API's own error code.
 */
import type { ApiClient, Schema } from "@your-move/api-client";
import type { GameEnvelope } from "@your-move/sdk";

export type { GameEnvelope };

export type Catalog = Schema<"Catalog">;
export type CatalogGame = Catalog["games"][number];
export type GameSummary = Schema<"GameSummary">;
export type GameWithView = Schema<"GameWithView">;
export type Player = GameEnvelope["players"][number];
export type HistoryItem = Schema<"HistoryItem">;
export type CreateGameRequest = Schema<"CreateGameRequest">;

/**
 * A game and the viewer's view, with the envelope as the SDK types it (what a board is given). The
 * generated type marks `options` optional where the SDK's requires the key; the key is set
 * explicitly here (its value is whatever the server sent, `unknown` either way).
 */
export function adapt(answer: GameWithView): { game: GameEnvelope; view: unknown } {
  return { game: { ...answer.game, options: answer.game.options }, view: answer.view ?? null };
}

export type Call<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** 0: the request never got an answer. */
      readonly status: number;
      readonly code: string;
      readonly detail?: unknown;
      readonly message?: string;
    };

interface Settled<T> {
  readonly data?: T;
  readonly error?: unknown;
  readonly response: Response;
}

function errorOf(error: unknown): { code?: string; message?: string; detail?: unknown } {
  if (typeof error !== "object" || error === null || !("error" in error)) return {};
  const inner = error.error;
  if (typeof inner !== "object" || inner === null) return {};
  return {
    ...("code" in inner && typeof inner.code === "string" ? { code: inner.code } : {}),
    ...("message" in inner && typeof inner.message === "string" ? { message: inner.message } : {}),
    ...("detail" in inner ? { detail: inner.detail } : {}),
  };
}

async function settle<T>(request: Promise<Settled<T>>): Promise<Call<T>> {
  try {
    const { data, error, response } = await request;
    if (response.ok) return { ok: true, data: data as T };
    const { code, message, detail } = errorOf(error);
    return {
      ok: false,
      status: response.status,
      code: code ?? (response.status === 429 ? "RATE_LIMITED" : "FAILED"),
      ...(message === undefined ? {} : { message }),
      ...(detail === undefined ? {} : { detail }),
    };
  } catch {
    return { ok: false, status: 0, code: "OFFLINE" };
  }
}

export const listGames = (api: ApiClient, cursor?: string) =>
  settle(api.GET("/api/v1/games", { params: { query: cursor === undefined ? {} : { cursor } } }));

export const loadCatalogFrom = (api: ApiClient) => settle(api.GET("/api/v1/catalog"));

export const getGame = (api: ApiClient, id: string) =>
  settle(api.GET("/api/v1/games/{id}", { params: { path: { id } } }));

export const getHistory = (api: ApiClient, id: string, cursor?: string) =>
  settle(
    api.GET("/api/v1/games/{id}/history", {
      params: { path: { id }, ...(cursor === undefined ? {} : { query: { cursor } }) },
    }),
  );

export const createGame = (api: ApiClient, body: CreateGameRequest) =>
  settle(api.POST("/api/v1/games", { body }));

export const markSeen = (api: ApiClient, id: string, version: number) =>
  settle(api.POST("/api/v1/games/{id}/seen", { params: { path: { id } }, body: { version } }));

export const submitAction = (
  api: ApiClient,
  id: string,
  expectedVersion: number,
  action: unknown,
) =>
  settle(
    api.POST("/api/v1/games/{id}/actions", {
      params: { path: { id } },
      body: { expectedVersion, action },
    }),
  );

export const previewAction = (api: ApiClient, id: string, action: unknown) =>
  settle(api.POST("/api/v1/games/{id}/preview", { params: { path: { id } }, body: { action } }));

/** The lifecycle transitions (05): each takes the version the client last saw. */
export type Transition = "start" | "accept" | "decline" | "cancel" | "resign";

/**
 * `data` is the new game and view, or `undefined` for the one `204`: a lobby decline, after which
 * the caller is no longer a member.
 */
export function transition(
  api: ApiClient,
  verb: Transition,
  id: string,
  expectedVersion: number,
): Promise<Call<GameWithView | undefined>> {
  const options = { params: { path: { id } }, body: { expectedVersion } };
  switch (verb) {
    case "start":
      return settle(api.POST("/api/v1/games/{id}/start", options));
    case "accept":
      return settle(api.POST("/api/v1/games/{id}/accept", options));
    case "decline":
      return settle(api.POST("/api/v1/games/{id}/decline", options));
    case "cancel":
      return settle(api.POST("/api/v1/games/{id}/cancel", options));
    case "resign":
      return settle(api.POST("/api/v1/games/{id}/resign", options));
  }
}
