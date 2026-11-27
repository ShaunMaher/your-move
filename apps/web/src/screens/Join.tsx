/**
 * The join-link landing page at `/join` (07 §1, 06 §6.8): what the link is for — the game, its
 * creator and who has joined, the turn timeout and the AI setting — and an explicit Join button.
 * Nothing joins by itself. The token was taken out of the address bar before the app rendered
 * (`join-token.ts`); it is cleared here after a join or a `404`, so a link that doesn't work isn't
 * offered again.
 */
import type { ApiClient } from "@your-move/api-client";
import { useCallback, useEffect, useState } from "react";

import { loadCatalog } from "../catalog.js";
import { joinGame, type JoinPreview, lookUpJoinLink } from "../game-api.js";
import { GameIcon } from "../GameIcon.js";
import { captureJoinFragment, clearJoinToken, keptJoinToken } from "../join-token.js";
import { Link, navigate } from "../router.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

interface JoinProps {
  readonly api: ApiClient;
  readonly appName: string;
  /** The session is gone (401). */
  readonly onSessionLost: () => void;
}

type Load =
  | { readonly status: "loading" }
  | { readonly status: "missing" }
  | { readonly status: "limited" }
  | { readonly status: "failed"; readonly offline: boolean }
  | { readonly status: "ready"; readonly game: JoinPreview };

const until = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

function gamePath(id: string): string {
  return `/g/${encodeURIComponent(id)}`;
}

export function Join({ api, appName, onSessionLost }: JoinProps) {
  const [load, setLoad] = useState<Load>(() =>
    keptJoinToken() === null ? { status: "missing" } : { status: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  const [names, setNames] = useState<ReadonlyMap<string, { name: string; icon: string }>>(
    new Map(),
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** The link doesn't work (or never did): forget it, so it isn't offered again (06 §6.8). */
  const gone = useCallback(() => {
    clearJoinToken();
    setLoad({ status: "missing" });
  }, []);

  useEffect(() => {
    // A new link opened over this page arrives as a fragment again: take it and look it up.
    const onHash = () => {
      captureJoinFragment();
      setLoad(keptJoinToken() === null ? { status: "missing" } : { status: "loading" });
      setAttempt((n) => n + 1);
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  useEffect(() => {
    const token = keptJoinToken();
    // Without a token the screen already says the link doesn't work.
    if (token === null) return undefined;
    let cancelled = false;
    void lookUpJoinLink(api, token).then((result) => {
      if (cancelled) return;
      if (result.ok) setLoad({ status: "ready", game: result.data.game });
      else if (result.status === 401) onSessionLost();
      else if (result.status === 404) gone();
      else if (result.status === 429) setLoad({ status: "limited" });
      else setLoad({ status: "failed", offline: result.status === 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [api, attempt, gone, onSessionLost]);

  useEffect(() => {
    let cancelled = false;
    void loadCatalog(api).then((result) => {
      if (cancelled || !result.ok) return;
      setNames(
        new Map(
          result.data.games.map((entry) => [entry.type, { name: entry.name, icon: entry.icon }]),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function join(game: JoinPreview) {
    const token = keptJoinToken();
    if (pending || token === null) return;
    setPending(true);
    setProblem(null);
    const result = await joinGame(api, token);
    setPending(false);
    if (result.ok) {
      clearJoinToken();
      navigate(gamePath(result.data.game.id), { replace: true });
    } else if (result.code === "ALREADY_JOINED") {
      clearJoinToken();
      navigate(gamePath(game.id), { replace: true });
    } else if (result.status === 401) onSessionLost();
    else if (result.status === 404) gone();
    else if (result.status === 0) {
      setProblem("You seem to be offline. Check your connection and try again.");
    } else if (result.status === 429) {
      setProblem("You've tried to join too many games just now. Try again in an hour.");
    } else setProblem("Something went wrong. Please try again.");
  }

  const nav = <Link to="/">Home</Link>;
  if (load.status === "loading") {
    return (
      <Page appName={appName} nav={nav}>
        <h1 tabIndex={-1}>Join a game</h1>
        <p role="status">Loading…</p>
      </Page>
    );
  }
  if (load.status !== "ready") {
    const failed = load.status === "failed";
    return (
      <Page appName={appName} nav={nav}>
        <h1 tabIndex={-1}>
          {load.status === "missing" ? "This link doesn't work" : "Can't open this link"}
        </h1>
        <p role="status">
          {load.status === "missing"
            ? "It may have expired or been replaced, or the game may be full or have started. Ask whoever sent it for a new one."
            : load.status === "limited"
              ? "You've opened too many join links just now. Try again in an hour."
              : load.offline
                ? "You seem to be offline. Check your connection and try again."
                : "The server isn't answering right now. Try again in a moment."}
        </p>
        {failed ? (
          <button
            type="button"
            className="button"
            onClick={() => {
              setLoad({ status: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        ) : (
          <Link to="/" className="button">
            Back to games
          </Link>
        )}
      </Page>
    );
  }

  const { game } = load;
  const type = names.get(game.gameType);
  const gameName = type?.name ?? game.gameType;
  const creator = game.creatorName ?? "Someone";
  return (
    <Page appName={appName} nav={nav}>
      <h1 tabIndex={-1}>Join {gameName}</h1>
      <section className="card stack" aria-labelledby="join-game">
        <div className="row">
          <GameIcon icon={type?.icon} />
          <h2 id="join-game">
            {creator}&apos;s {gameName} game
          </h2>
        </div>
        <dl className="details">
          <dt>Players</dt>
          <dd>{game.players.map((player) => player.displayName ?? "Deleted player").join(", ")}</dd>
          <dt>Open seats</dt>
          <dd>{String(game.openSeats)}</dd>
          <dt>Turn time</dt>
          <dd>
            {String(game.turnTimeoutDays)} {game.turnTimeoutDays === 1 ? "day" : "days"} a move
          </dd>
          {game.resources.length === 0 ? null : (
            <>
              <dt>Word list</dt>
              <dd>{game.resources.map((resource) => resource.name).join(", ")}</dd>
            </>
          )}
          <dt>AI assistance</dt>
          <dd>{game.aiAssistance === "allowed" ? "Allowed: moves by AI are marked" : "Off"}</dd>
          <dt>Link works until</dt>
          <dd>{until.format(new Date(game.expiresAt))}</dd>
        </dl>
      </section>
      <p>
        If you join, {creator} and the other players will see your name. The game starts when{" "}
        {creator} starts it.
      </p>
      <Problem id="join-problem" message={problem} />
      <div className="row">
        <button
          type="button"
          className="button"
          disabled={pending}
          aria-describedby="join-problem"
          onClick={() => void join(game)}
        >
          {pending ? "Joining…" : "Join"}
        </button>
        <Link to="/" className="button secondary">
          Not now
        </Link>
      </div>
    </Page>
  );
}
