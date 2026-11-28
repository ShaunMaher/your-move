/**
 * One game at `/g/:id` (07 §1): loads the game and your view of it, shows the lobby or the frame
 * with the module's board, wires the board's `submit` and `preview` to the API, and keeps the
 * screen current. The alpha has no realtime: it refetches on focus and, while the game waits on
 * someone else, every few seconds (10, Alpha). A `STALE_GAME` or `NOT_YOUR_TURN` answer means the
 * game moved on: the shell refetches and the board keeps its tentative tiles (07 §2).
 */
import type { ApiClient } from "@your-move/api-client";
import type { SubmitResult } from "@your-move/sdk";
import type { BoardResources, GameClientModule, PublicWordList } from "@your-move/sdk/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadCatalog } from "../catalog.js";
import { rematchProblem } from "../create-problems.js";
import {
  adapt,
  addPlayer,
  createJoinLink,
  type GameEnvelope,
  type GameWithView,
  getGame,
  markSeen,
  previewAction,
  rematchGame,
  removeSeat,
  revokeJoinLink,
  submitAction,
  transition,
} from "../game-api.js";
import { loadGameClient } from "../games.js";
import { forgetJoinLink, peekJoinLink } from "../join-link-handoff.js";
import { rememberPushOffered, shouldOfferPush } from "../push.js";
import { PushOffer } from "../PushOffer.js";
import { navigate, Link } from "../router.js";
import { useRefresh, useVisible } from "../use-refresh.js";
import { openWordList } from "../word-lists.js";
import { Frame, type RematchFailure } from "./Frame.js";
import type { MadeLink } from "./JoinLinkPanel.js";
import { Lobby, type LobbyAction } from "./Lobby.js";
import { Page } from "./Page.js";

const POLL_MS = 5000;
const OFFLINE_NOTICE = "You seem to be offline. We'll keep trying.";
const SERVER_NOTICE = "The server isn't answering right now. We'll keep trying.";

/** The answers that mean the game is not as the client last saw it: refetch (05 §actions). */
const MOVED_ON = new Set([
  "STALE_GAME",
  "NOT_YOUR_TURN",
  "GAME_NOT_ACTIVE",
  "WRONG_STATUS",
  "GAME_UNAVAILABLE",
]);

const LOBBY_PROBLEMS: Readonly<Record<string, string>> = {
  STALE_GAME: "The game changed while you were looking. Check it and try again.",
  WRONG_STATUS: "The game has changed. Check it and try again.",
  NOT_ENOUGH_PLAYERS: "Wait for the other players to accept first.",
  INVALID_SEATS: "The game can't start with these players and options.",
  NOT_ALLOWED: "You can't do that in this game.",
  ONBOARDING_REQUIRED: "Finish setting up your account first.",
};

const REMOVE_PROBLEMS: Readonly<Record<string, string>> = {
  ...LOBBY_PROBLEMS,
  NOT_FOUND: "That player is no longer in the lobby.",
};

const LINK_PROBLEMS: Readonly<Record<string, string>> = {
  ...LOBBY_PROBLEMS,
  RATE_LIMITED: "You've made too many join links today. Try again tomorrow.",
};

const ADD_PROBLEMS: Readonly<Record<string, string>> = {
  NOT_FOUND: "You can't add this player from this game.",
  RATE_LIMITED: "Too many attempts. Wait a little and try again.",
};

const RESIGN_PROBLEMS: Readonly<Record<string, string>> = {
  STALE_GAME: "The game changed while you were looking. Check it and try again.",
  WRONG_STATUS: "The game is no longer in progress.",
  GAME_UNAVAILABLE: "This game is no longer available.",
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
  /** The instance's VAPID public key, for the notifications offer after accepting (03 §7). */
  readonly pushKey?: string | undefined;
  readonly id: string;
  /** The session is gone (401). */
  readonly onSessionLost: () => void;
  /** How a game type's client module is loaded; the generated import map unless a test says otherwise. */
  readonly loadClient?: (type: string) => Promise<GameClientModule | null>;
}

export function Game({
  api,
  appName,
  pushKey,
  id,
  onSessionLost,
  loadClient = loadGameClient,
}: GameProps) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  /** The notifications offer, open after an accepted invitation (A8-P-2). */
  const [offering, setOffering] = useState(false);
  /** The offer just closed: focus goes to the screen's heading (A8-R2-4). */
  const offerClosed = useRef(false);
  useEffect(() => {
    if (offering || !offerClosed.current) return;
    offerClosed.current = false;
    // After the dialog's own clean-up, whose opener (the Accept button) may be gone.
    document.querySelector<HTMLElement>("h1")?.focus();
  }, [offering]);
  /** Why the screen may be out of date (offline, a failing server), or `null` when it is current. */
  const [notice, setNotice] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<{
    readonly type: string;
    readonly module: GameClientModule | null;
  } | null>(null);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  /** A join link made with the game, shown once in its lobby (07 §1.1 step 5). */
  const [freshLink] = useState(() => peekJoinLink(id));
  useEffect(() => {
    forgetJoinLink(id);
  }, [id]);
  const fetching = useRef(false);
  /** A refetch asked for while one was in flight: one more runs when it ends. */
  const again = useRef(false);
  const mounted = useRef(true);
  const visible = useVisible();
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
      if (!mounted.current) return;
      if (result.ok) {
        setNotice(null);
        apply(result.data);
      } else if (result.status === 401) onSessionLost();
      else if (result.status === 404) setLoad({ status: "missing" });
      else {
        const offline = result.status === 0;
        setNotice(offline ? OFFLINE_NOTICE : SERVER_NOTICE);
        setLoad((now) => (now.status === "loading" ? { status: "failed", offline } : now));
      }
    },
    [apply, onSessionLost],
  );

  /**
   * Fetches the game again, one request at a time. A poll or focus event that arrives while one is
   * in flight is dropped; a `queued` one (the game moved on under an action) runs once more after
   * it, because the answer in flight may predate the change.
   */
  const refetch = useCallback(
    async (queued = false) => {
      const wantsAnother = () => again.current;
      if (fetching.current) {
        if (queued) again.current = true;
        return;
      }
      fetching.current = true;
      try {
        do {
          again.current = false;
          const result = await getGame(api, id);
          settle(result);
        } while (wantsAnother() && mounted.current);
      } finally {
        fetching.current = false;
      }
    },
    [api, id, settle],
  );

  useEffect(() => {
    mounted.current = true;
    void refetch();
    return () => {
      mounted.current = false;
    };
  }, [refetch]);

  function retry() {
    newest.current = -1;
    setLoad({ status: "loading" });
    void refetch(true);
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

  // The public word lists the game uses are cached, and its own public list is handed to the
  // board as one object for as long as the game's resources stay the same (07 §3–4, 02 §3).
  const listKey = `${id}:${JSON.stringify(resources ?? [])}`;
  const active = game?.status === "active";
  const [wordList, setWordList] = useState<{ key: string; list: PublicWordList } | null>(null);
  useEffect(() => {
    if (resources === undefined || !active) return undefined;
    let cancelled = false;
    void openWordList(resources).then((list) => {
      if (!cancelled) setWordList(list === null ? null : { key: listKey, list });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the lists' content
  }, [listKey, active]);
  const boardResources = useMemo<BoardResources | undefined>(
    () => (wordList?.key === listKey ? { dictionary: wordList.list } : undefined),
    [wordList, listKey],
  );

  // Looking at a version of a game under way, in a tab that is showing, marks it read (not a
  // transition). A hidden tab has seen nothing, and a lobby has no moves to read.
  const started = game !== null && game.status !== "lobby";
  useEffect(() => {
    if (version !== null && started && visible) void markSeen(api, id, version);
  }, [api, id, version, started, visible]);

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
      if (MOVED_ON.has(result.code)) void refetch(true);
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
        // An invited player may never create a game: they are offered notifications here, once
        // per device, after the tap that accepted (03 §7).
        if (verb === "accept" && pushKey !== undefined && (await shouldOfferPush(pushKey))) {
          rememberPushOffered();
          setOffering(true);
        }
        return null;
      }
      if (result.status === 401) onSessionLost();
      if (result.status === 404) setLoad({ status: "missing" });
      if (MOVED_ON.has(result.code)) void refetch(true);
      return failureText(
        result.status,
        result.code,
        verb === "resign" ? RESIGN_PROBLEMS : LOBBY_PROBLEMS,
      );
    },
    [api, id, game, apply, refetch, onSessionLost, pushKey],
  );

  /** The creator removes a seat (05 `remove-seat`). */
  const remove = useCallback(
    async (playerId: string): Promise<string | null> => {
      if (game === null) return null;
      const result = await removeSeat(api, id, game.version, playerId);
      if (result.ok) {
        apply(result.data);
        return null;
      }
      if (result.status === 401) onSessionLost();
      // A missing row, or a game that moved on: show what is there now.
      if (result.status === 404 || MOVED_ON.has(result.code)) void refetch(true);
      return failureText(result.status, result.code, REMOVE_PROBLEMS);
    },
    [api, id, game, apply, refetch, onSessionLost],
  );

  /** The creator makes or rotates the join link; its URL is shown once (06 §6.8). */
  const makeLink = useCallback(async (): Promise<MadeLink> => {
    const result = await createJoinLink(api, id);
    // The link doesn't change the game's version: refetch so its state shows.
    void refetch(true);
    if (result.ok) return { url: result.data.url };
    if (result.status === 401) onSessionLost();
    return { problem: failureText(result.status, result.code, LINK_PROBLEMS) };
  }, [api, id, refetch, onSessionLost]);

  const revokeLink = useCallback(async (): Promise<string | null> => {
    const result = await revokeJoinLink(api, id);
    void refetch(true);
    if (result.ok) return null;
    if (result.status === 401) onSessionLost();
    return failureText(result.status, result.code, LOBBY_PROBLEMS);
  }, [api, id, refetch, onSessionLost]);

  /** Opens the finished game's rematch, creating or accepting it first (05, 07 §1). */
  const rematch = useCallback(async (): Promise<RematchFailure | null> => {
    const result = await rematchGame(api, id);
    if (result.ok) {
      navigate(`/g/${encodeURIComponent(result.data.game.id)}`);
      return null;
    }
    if (result.status === 401) onSessionLost();
    // The rematch isn't what the screen showed (gone, ended, or another player's meanwhile):
    // refetch, so the button says what the server now does (A15-P-8).
    if (result.status === 404 || result.status === 409) void refetch(true);
    return { code: result.code, message: rematchProblem(result.status, result.code) };
  }, [api, id, onSessionLost, refetch]);

  /** The creator's yes to "Add <name> to your players?" (05 `add-player`, alpha A19). */
  const addToPlayers = useCallback(
    async (userId: string): Promise<string | null> => {
      const result = await addPlayer(api, id, userId);
      // The game's version doesn't change: refetch, so the list follows the server.
      void refetch(true);
      if (result.ok) return null;
      if (result.status === 401) onSessionLost();
      return failureText(result.status, result.code, ADD_PROBLEMS);
    },
    [api, id, onSessionLost, refetch],
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
  const offer =
    offering && pushKey !== undefined ? (
      <PushOffer
        api={api}
        appName={appName}
        pushKey={pushKey}
        onDone={() => {
          offerClosed.current = true;
          setOffering(false);
        }}
      />
    ) : null;
  if (load.game.status === "lobby") {
    return (
      <>
        <Lobby
          appName={appName}
          gameName={gameName}
          game={load.game}
          onAction={act}
          onRemove={remove}
          onCreateLink={makeLink}
          onRevokeLink={revokeLink}
          freshLink={freshLink}
          notice={notice}
        />
        {offer}
      </>
    );
  }
  return (
    <>
      {offer}
      <Frame
        api={api}
        appName={appName}
        gameName={gameName}
        game={load.game}
        view={load.view}
        client={client}
        submit={submit}
        preview={preview}
        resources={boardResources}
        onResign={() => act("resign")}
        onRematch={rematch}
        onAddPlayer={addToPlayers}
        onSessionLost={onSessionLost}
        notice={notice}
      />
    </>
  );
}
