/**
 * The frame around every game (07 §1, 02 §3): the header with the players and whose turn it is,
 * the menu (rules, history, game info, resign), the results of a finished game, and the module's
 * own board. The board reaches the server only through the `submit` and `preview` it is given.
 */
import type { ApiClient } from "@your-move/api-client";
import type { BoardProps, GameClientModule } from "@your-move/sdk/client";
import { useRef, useState } from "react";

import { Dialog } from "../Dialog.js";
import type { GameEnvelope, Player } from "../game-api.js";
import { endReasonText, seatLabel } from "../game-text.js";
import { Link } from "../router.js";
import { History } from "./History.js";
import { Problem } from "./Problem.js";

type Panel = "menu" | "rules" | "history" | "resign" | null;

interface FrameProps {
  readonly api: ApiClient;
  readonly appName: string;
  readonly gameName: string;
  readonly game: GameEnvelope;
  readonly view: unknown;
  readonly client: GameClientModule | null | "loading";
  readonly submit: BoardProps<unknown, unknown, unknown>["submit"];
  readonly preview: BoardProps<unknown, unknown, unknown>["preview"];
  /** Resigns; resolves to what went wrong, or `null` when it worked. */
  readonly onResign: () => Promise<string | null>;
  readonly onSessionLost: () => void;
  readonly offline: boolean;
}

const OUT_TEXT: Readonly<Record<string, string>> = {
  resigned: "resigned",
  timed_out: "ran out of time",
  declined: "declined",
  cancelled: "cancelled",
};

function turnText(game: GameEnvelope): string {
  switch (game.status) {
    case "active": {
      if (game.yourTurn) return "Your turn";
      const waiting = game.players
        .filter((player) => player.seat !== null && game.toAct.includes(player.seat))
        .map(seatLabel);
      return waiting.length === 0 ? "Waiting" : `Waiting for ${waiting.join(" and ")}`;
    }
    case "finished":
      return "Game over";
    case "declined":
      return "Declined: no result";
    case "cancelled":
      return "Cancelled";
    default:
      return "Expired";
  }
}

function PlayerChip({ player, acting, over }: { player: Player; acting: boolean; over: boolean }) {
  const note = player.outReason === undefined ? "" : OUT_TEXT[player.outReason];
  return (
    <li className="chip" aria-current={acting ? "true" : undefined}>
      <span>{seatLabel(player)}</span>
      {player.score === undefined ? null : <strong>{String(player.score)}</strong>}
      {note === undefined || note === "" ? null : <span className="hint">{note}</span>}
      {over && player.rank !== undefined ? (
        <span className="badge quiet">#{String(player.rank)}</span>
      ) : null}
    </li>
  );
}

/** The finished game's result: ranks when there are any, and how it ended. */
function Results({ game }: { readonly game: GameEnvelope }) {
  const seated = game.players
    .filter((player) => player.seat !== null)
    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (a.seat ?? 0) - (b.seat ?? 0));
  const ranked = seated.some((player) => player.rank !== undefined);
  const title =
    game.status === "finished"
      ? "Final result"
      : game.status === "declined"
        ? "Declined, no result"
        : game.status === "cancelled"
          ? "Cancelled"
          : "Expired";
  const reason = game.status === "finished" ? endReasonText(game.endReason, game.status) : "";
  return (
    <section className="card stack" aria-labelledby="results-heading">
      <h2 id="results-heading">{title}</h2>
      {reason === "" ? null : <p>{reason}</p>}
      {ranked ? (
        <ol className="results">
          {seated.map((player) => (
            <li key={player.seat}>
              <span className="rank">{player.rank === undefined ? "–" : String(player.rank)}</span>
              <span className="grow">{seatLabel(player)}</span>
              {player.score === undefined ? null : <strong>{String(player.score)}</strong>}
              {player.outReason === "resigned" ? <span className="hint">resigned</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      <Link to="/" className="button">
        Back to games
      </Link>
    </section>
  );
}

export function Frame(props: FrameProps) {
  const { api, game, view, client, gameName, offline } = props;
  const [panel, setPanel] = useState<Panel>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const over = game.status !== "active";
  const canResign = game.status === "active" && game.yourSeat !== null && game.available;
  const seated = game.players.filter((player) => player.seat !== null);

  function close() {
    setPanel(null);
    setProblem(null);
    // The opener (a menu item) is gone by now; the menu button is where focus belongs.
    menuButton.current?.focus();
  }

  async function resign() {
    if (pending) return;
    setPending(true);
    setProblem(null);
    const failure = await props.onResign();
    setPending(false);
    if (failure === null) close();
    else setProblem(failure);
  }

  let board;
  if (!game.available) board = <p className="card">This game is no longer available.</p>;
  else if (client === "loading") board = <p role="status">Loading the board…</p>;
  else if (client === null) {
    board = (
      <p role="alert" className="problem">
        This game can&apos;t be shown by this version of the app. Reload the page to update.
      </p>
    );
  } else if (!client.versions.includes(game.gameVersion)) {
    board = (
      <p role="alert" className="problem">
        This game uses a version of the rules this app doesn&apos;t know. Reload the page to update.
      </p>
    );
  } else if (view === null || view === undefined) {
    board = over ? null : <p role="status">Loading the board…</p>;
  } else {
    board = <client.Board game={game} view={view} submit={props.submit} preview={props.preview} />;
  }

  return (
    <div className="shell frame">
      <header className="bar frame-bar">
        <Link to="/">Games</Link>
        <p className="brand">{gameName}</p>
        <button
          ref={menuButton}
          type="button"
          className="button secondary"
          aria-haspopup="dialog"
          onClick={() => {
            setPanel("menu");
          }}
        >
          Menu
        </button>
      </header>
      <main className="stack">
        <h1 tabIndex={-1} className="visually-hidden">
          {gameName} game
        </h1>
        <ul className="chips" aria-label="Players">
          {seated.map((player) => (
            <PlayerChip
              key={player.seat}
              player={player}
              acting={player.seat !== null && game.toAct.includes(player.seat)}
              over={over}
            />
          ))}
        </ul>
        <p role="status" className="turn" data-yours={game.yourTurn}>
          {offline ? "You seem to be offline. We'll keep trying." : turnText(game)}
        </p>
        {over ? <Results game={game} /> : null}
        {board}
      </main>

      {panel === "menu" ? (
        <Dialog title="Menu" onClose={close}>
          <dl className="details">
            <dt>Game</dt>
            <dd>{gameName}</dd>
            {game.resources.length === 0 ? null : (
              <>
                <dt>Word list</dt>
                <dd>{game.resources.map((resource) => resource.name).join(", ")}</dd>
              </>
            )}
            <dt>Players</dt>
            <dd>{seated.map(seatLabel).join(", ")}</dd>
          </dl>
          <div className="stack">
            <button
              type="button"
              className="button secondary"
              disabled={client === null || client === "loading"}
              onClick={() => {
                setPanel("rules");
              }}
            >
              Rules
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={client === null || client === "loading"}
              onClick={() => {
                setPanel("history");
              }}
            >
              History
            </button>
            {canResign ? (
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  setPanel("resign");
                }}
              >
                Resign…
              </button>
            ) : null}
            <button type="button" className="button secondary" onClick={close}>
              Close
            </button>
          </div>
        </Dialog>
      ) : null}

      {panel === "rules" && client !== null && client !== "loading" ? (
        <Dialog title="Rules" onClose={close} variant="drawer">
          <client.RulesSheet options={game.options} gameVersion={game.gameVersion} />
          <button type="button" className="button secondary" onClick={close}>
            Close
          </button>
        </Dialog>
      ) : null}

      {panel === "history" && client !== null && client !== "loading" ? (
        <History
          api={api}
          game={game}
          client={client}
          onClose={close}
          onSessionLost={props.onSessionLost}
        />
      ) : null}

      {panel === "resign" ? (
        <Dialog title="Resign this game?" onClose={close}>
          <p>Resigning ends the game for you and counts as a loss.</p>
          <Problem id="resign-problem" message={problem} />
          <div className="row">
            <button
              type="button"
              className="button danger"
              disabled={pending}
              onClick={() => void resign()}
            >
              {pending ? "Resigning…" : "Resign"}
            </button>
            <button type="button" className="button secondary" onClick={close}>
              Keep playing
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
