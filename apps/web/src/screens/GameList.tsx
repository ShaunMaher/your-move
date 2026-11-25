/**
 * The game list (07 §1): your turn, invitations, waiting (their turn and lobbies) and finished
 * games, with a badge for what needs you. The alpha has no realtime: it refetches on focus and
 * every 15 s while the tab is visible, so a new invitation or a move appears without a visit (07
 * §4, 10 Alpha).
 */
import type { ApiClient } from "@your-move/api-client";
import { useCallback, useEffect, useRef, useState } from "react";

import { loadCatalog } from "../catalog.js";
import { type CatalogGame, type GameSummary, listGames } from "../game-api.js";
import { opponentNames, type Section, sectionOf, textOf } from "../game-text.js";
import { GameIcon } from "../GameIcon.js";
import { Link } from "../router.js";
import { useRefresh } from "../use-refresh.js";
import { Problem } from "./Problem.js";

const POLL_MS = 15_000;

interface GameListProps {
  readonly api: ApiClient;
  /** The session is gone (401). */
  readonly onSessionLost: () => void;
}

const SECTIONS: readonly { readonly id: Section; readonly title: string }[] = [
  { id: "your-turn", title: "Your turn" },
  { id: "invitations", title: "Invitations" },
  { id: "waiting", title: "Waiting" },
];

function rowText(game: GameSummary): { title: string; detail: string; last: string } {
  const creator = game.players.find((player) => player.isCreator && !player.isYou);
  const invited = game.yourInvitation !== null && game.status === "lobby";
  return {
    title: opponentNames(game.players),
    detail: invited
      ? `${creator?.displayName ?? "Someone"} invited you`
      : textOf(game.summary.headline, game.players),
    last: game.lastAction === null ? "" : textOf(game.lastAction.describe, game.players),
  };
}

function Row({
  game,
  type,
}: {
  readonly game: GameSummary;
  readonly type: CatalogGame | undefined;
}) {
  const { title, detail, last } = rowText(game);
  return (
    <li>
      <Link to={`/g/${encodeURIComponent(game.id)}`} className="game-row">
        <GameIcon icon={type?.icon} />
        <span className="grow">
          <span className="row-title">
            {type?.name ?? game.gameType} with {title}
          </span>
          <span className="hint">{detail}</span>
          {last === "" ? null : <span className="hint">{last}</span>}
        </span>
        <span className="badges">
          {game.yourTurn && game.status === "active" ? (
            <span className="badge">Your turn</span>
          ) : null}
          {game.yourInvitation === "normal" && game.status === "lobby" ? (
            <span className="badge">Invitation</span>
          ) : null}
          {game.unread ? <span className="badge quiet">New</span> : null}
        </span>
      </Link>
    </li>
  );
}

export function GameList({ api, onSessionLost }: GameListProps) {
  const [games, setGames] = useState<readonly GameSummary[] | null>(null);
  const [more, setMore] = useState<string | null>(null);
  /** Hidden invitations (06 §6.7): fetched apart, first page only; never badged or unread. */
  const [hidden, setHidden] = useState<readonly GameSummary[]>([]);
  const [types, setTypes] = useState<ReadonlyMap<string, CatalogGame>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  /** Whether "Show more" has been used: a refresh then keeps the older pages already shown. */
  const expanded = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    void listGames(api, undefined, "hidden").then((result) => {
      if (mounted.current && result.ok) setHidden(result.data.games);
    });
    void listGames(api).then((result) => {
      loading.current = false;
      if (!mounted.current) return;
      if (result.ok) {
        const first = result.data.games;
        if (expanded.current) {
          const ids = new Set(first.map((game) => game.id));
          setGames((now) => [...first, ...(now ?? []).filter((game) => !ids.has(game.id))]);
        } else {
          setGames(first);
          setMore(result.data.nextCursor);
        }
        setError(null);
      } else if (result.status === 401) onSessionLost();
      else {
        setError(
          result.status === 0
            ? "You seem to be offline. We'll keep trying."
            : "Couldn't load your games. We'll keep trying.",
        );
      }
    });
  }, [api, onSessionLost]);

  useEffect(() => {
    refresh();
    void loadCatalog(api).then((result) => {
      if (result.ok) setTypes(new Map(result.data.games.map((game) => [game.type, game])));
    });
  }, [api, refresh]);

  useRefresh(refresh, POLL_MS);

  function showMore() {
    if (more === null) return;
    void listGames(api, more).then((result) => {
      if (!mounted.current) return;
      if (!result.ok) {
        setError("Couldn't load more games.");
        return;
      }
      expanded.current = true;
      setGames((now) => {
        const seen = new Set((now ?? []).map((game) => game.id));
        return [...(now ?? []), ...result.data.games.filter((game) => !seen.has(game.id))];
      });
      setMore(result.data.nextCursor);
    });
  }

  if (games === null) {
    return (
      <section className="card stack" aria-labelledby="games-heading" data-slot="game-list">
        <h2 id="games-heading">Your games</h2>
        <p role="status">{error ?? "Loading your games…"}</p>
      </section>
    );
  }

  const inSection = (id: Section) => games.filter((game) => sectionOf(game) === id);
  const finished = inSection("finished");
  return (
    <section className="stack" aria-labelledby="games-heading" data-slot="game-list">
      <h2 id="games-heading" className="visually-hidden">
        Your games
      </h2>
      <Problem id="games-problem" message={error} />
      {games.length === 0 ? <p className="card">No games yet. Start one with a friend.</p> : null}
      {SECTIONS.map(({ id, title }) => {
        const rows = inSection(id);
        if (rows.length === 0) return null;
        return (
          <section key={id} className="card stack" aria-labelledby={`section-${id}`}>
            <h3 id={`section-${id}`}>
              {title} <span className="hint">({String(rows.length)})</span>
            </h3>
            <ul className="plain">
              {rows.map((game) => (
                <Row key={game.id} game={game} type={types.get(game.gameType)} />
              ))}
            </ul>
          </section>
        );
      })}
      {finished.length === 0 ? null : (
        <details className="card stack">
          <summary>Finished ({String(finished.length)})</summary>
          <ul className="plain">
            {finished.map((game) => (
              <Row key={game.id} game={game} type={types.get(game.gameType)} />
            ))}
          </ul>
        </details>
      )}
      {hidden.length === 0 ? null : (
        <details className="card stack">
          <summary>Hidden invitations ({String(hidden.length)})</summary>
          <p className="hint">
            Invitations from people you haven&apos;t played before, over the daily limit. You can
            still accept or decline them.
          </p>
          <ul className="plain">
            {hidden.map((game) => (
              <Row key={game.id} game={game} type={types.get(game.gameType)} />
            ))}
          </ul>
        </details>
      )}
      {more === null ? null : (
        <button type="button" className="button secondary" onClick={showMore}>
          Show more games
        </button>
      )}
    </section>
  );
}
