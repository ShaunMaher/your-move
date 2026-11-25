/**
 * One game at `/g/:id` (07 §1): loads the game and your view of it, shows the lobby or the frame
 * with the module's board, wires the board's `submit` and `preview` to the API, and keeps the
 * screen current. The alpha has no realtime: it refetches on focus and, while the game waits on
 * someone else, every few seconds (10, Alpha). A `STALE_GAME` or `NOT_YOUR_TURN` answer means the
 * game moved on: the shell refetches and the board keeps its tentative tiles (07 §2).
 */
import type { ApiClient } from "@your-move/api-client";
import type { SubmitResult } from "@your-move/sdk";
import type { GameClientModule } from "@your-move/sdk/client";
import { useCallback, useEffect, useRef, useState } from "react";

import { loadCatalog } from "../catalog.js";
import {
  adapt,
  type GameEnvelope,
  type GameWithView,
  getGame,
  markSeen,
  previewAction,
  submitAction,
  transition,
} from "../game-api.js";
import { loadGameClient } from "../games.js";
import { navigate, Link } from "../router.js";
import { useRefresh } from "../use-refresh.js";
import { cacheWordLists } from "../word-lists.js";
import { Frame } from "./Frame.js";
import { Lobby, type LobbyAction } from "./Lobby.js";
import { Page } from "./Page.js";

const POLL_MS = 5000;

/** The answers that mean the game is not as the client last saw it: refetch (05 §actions). */
const MOVED_ON = new Set(["STALE_GAME", "NOT_YOUR_TURN", "GAME_NOT_ACTIVE", "WRONG_STATUS"]);

const LOBBY_PROBLEMS: Readonly<Record<string, string>> = {
  STALE_GAME: "The game changed while you were looking. Check it and try again.",
  WRONG_STATUS: "The game has changed. Check it and try again.",
  NOT_ENOUGH_PLAYERS: "Wait for the other players to accept first.",
  INVALID_SEATS: "The game can't start with these players and options.",
  NOT_ALLOWED: "You can't do that in this game.",
  ONBOARDING_REQUIRED: "Finish setting up your account first.",
};

const RESIGN_PROBLEMS: Readonly<Record<string, string>> = {
  STALE_GAME: "The game changed while you were looking. Check it and try again.",
  WRONG_STATUS: "The game is no longer in progress.",
};

function failureText(
  status: number,
  code: string,
  known: Readonly<Record<string, string>>,
): string {
  if (status === 0) return "You seem to be offline. Check your connection and try again.";
  return known[code] ?? "Something went wrong. Please try again.";
}

type Load =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "failed"; readonly offline: boolean }
  | { readonly status: "ready"; readonly game: GameEnvelope; readonly view: unknown };

interface GameProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly id: string;
  /** The session is gone (401). */
  readonly onSessionLost: () => void;
  /** How a game type's client module is loaded; the generated import map unless a test says otherwise. */
  readonly loadClient?: (type: string) => Promise<GameClientModule | null>;
}

export function Game({ api, appName, id, onSessionLost, loadClient = loadGameClient }: GameProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [offline, setOffline] = useState(false);
  const [loaded, setLoaded] = useState<{
    readonly type: string;
    readonly module: GameClientModule | null;
  } | null>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const fetching = useRef(false);
  /** The newest game the screen has shown: an older answer arriving late must not replace it. */
  const newest = useRef(-1);

  const apply = useCallback((answer: GameWithView) => {
    const next = adapt(answer);
    if (next.game.version < newest.current) return;
    newest.current = next.game.version;
    setLoad({ status: "ready", ...next });
  }, []);

  /** Applies what a fetch of the game answered. */
  const settle = useCallback(
    (result: Awaited<ReturnType<typeof getGame>>) => {
      if (result.ok) {
        setOffline(false);
        apply(result.data);
      } else if (result.status === 401) onSessionLost();
      else if (result.status === 404) setLoad({ status: "missing" });
      else if (result.status === 0) {
        setOffline(true);
        setLoad((now) => (now.status === "loading" ? { status: "failed", offline: true } : now));
      } else {
        setLoad((now) => (now.status === "loading" ? { status: "failed", offline: false } : now));
      }
    },
    [apply, onSessionLost],
  );

  const refetch = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    const result = await getGame(api, id);
    fetching.current = false;
    settle(result);
  }, [api, id, settle]);

  useEffect(() => {
    let live = true;
    void getGame(api, id).then((result) => {
      if (live) settle(result);
    });
    return () => {
      live = false;
    };
  }, [api, id, settle]);

  function retry() {
    newest.current = -1;
    setLoad({ status: "loading" });
    void refetch();
  }

  const game = load.status === "ready" ? load.game : null;
  const gameType = game?.gameType ?? null;
  const version = game?.version ?? null;
  const resources = game?.resources;
  const waiting =
    game !== null && (game.status === "lobby" || (game.status === "active" && !game.yourTurn));
  useRefresh(() => void refetch(), waiting ? POLL_MS : null);

  useEffect(() => {
    if (gameType === null) return undefined;
    let cancelled = false;
    void loadClient(gameType).then((module) => {
      if (!cancelled) setLoaded({ type: gameType, module });
    });
    void loadCatalog(api).then((result) => {
      if (cancelled || !result.ok) return;
      setNames(new Map(result.data.games.map((entry) => [entry.type, entry.name])));
    });
    return () => {
      cancelled = true;
    };
  }, [api, gameType, loadClient]);

  // The public word lists the game uses are cached for the module's previews (07 §3).
  const listKey = JSON.stringify(resources ?? []);
  useEffect(() => {
    if (resources !== undefined && game?.status === "active") void cacheWordLists(resources);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the lists' content
  }, [listKey, game?.status]);

  // Looking at a version of the game marks it read (not a transition).
  useEffect(() => {
    if (version !== null) void markSeen(api, id, version);
  }, [api, id, version]);

  const submit = useCallback(
    async (action: unknown): Promise<SubmitResult> => {
      if (game === null) throw new Error("no game");
      const result = await submitAction(api, id, game.version, action);
      if (result.ok) {
        apply({ game: result.data.game, view: result.data.view });
        return { ok: true, game: adapt(result.data).game, view: result.data.view };
      }
      if (result.status === 0) throw new Error("offline");
      if (result.status === 401) onSessionLost();
      if (MOVED_ON.has(result.code)) void refetch();
      return {
        ok: false,
        error: {
          code: result.code,
          message: result.message ?? "",
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        },
      };
    },
    [api, id, game, apply, refetch, onSessionLost],
  );

  const preview = useCallback(
    async (action: unknown): Promise<unknown> => {
      const result = await previewAction(api, id, action);
      if (result.ok) return result.data.preview;
      if (result.status === 0) throw new Error("offline");
      if (result.status === 401) onSessionLost();
      return {
        code: result.code,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      };
    },
    [api, id, onSessionLost],
  );

  const act = useCallback(
    async (verb: LobbyAction | "resign"): Promise<string | null> => {
      if (game === null) return null;
      const result = await transition(api, verb, id, game.version);
      if (result.ok) {
        if (result.data === undefined)
          navigate("/"); // a lobby decline: no longer a member
        else apply(result.data);
        return null;
      }
      if (result.status === 401) onSessionLost();
      if (result.status === 404) setLoad({ status: "missing" });
      if (MOVED_ON.has(result.code)) void refetch();
      return failureText(
        result.status,
        result.code,
        verb === "resign" ? RESIGN_PROBLEMS : LOBBY_PROBLEMS,
      );
    },
    [api, id, game, apply, refetch, onSessionLost],
  );

  if (load.status === "loading") {
    return (
      <Page appName={appName} nav={<Link to="/">Home</Link>}>
        <h1 tabIndex={-1}>Game</h1>
        <p role="status">Loading…</p>
      </Page>
    );
  }
  if (load.status === "missing") {
    return (
      <Page appName={appName} nav={<Link to="/">Home</Link>}>
        <h1 tabIndex={-1}>Game not found</h1>
        <p role="status">
          This game isn&apos;t available to you. It may have been cancelled, or the link is wrong.
        </p>
        <Link to="/" className="button">
          Back to games
        </Link>
      </Page>
    );
  }
  if (load.status === "failed") {
    return (
      <Page appName={appName} nav={<Link to="/">Home</Link>}>
        <h1 tabIndex={-1}>{load.offline ? "You're offline" : "Can't load this game"}</h1>
        <p role="status">
          {load.offline
            ? "Check your connection and try again."
            : "The server isn't answering right now. Try again in a moment."}
        </p>
        <button type="button" className="button" onClick={retry}>
          Try again
        </button>
      </Page>
    );
  }

  const client = loaded?.type === load.game.gameType ? loaded.module : "loading";
  const gameName = names.get(load.game.gameType) ?? load.game.gameType;
  if (load.game.status === "lobby") {
    return (
      <Lobby
        appName={appName}
        gameName={gameName}
        game={load.game}
        onAction={act}
        offline={offline}
      />
    );
  }
  return (
    <Frame
      api={api}
      appName={appName}
      gameName={gameName}
      game={load.game}
      view={load.view}
      client={client}
      submit={submit}
      preview={preview}
      onResign={() => act("resign")}
      onSessionLost={onSessionLost}
      offline={offline}
    />
  );
}
