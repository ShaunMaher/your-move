/**
 * A game waiting for its players (07 §1, 02 §4): who is invited and who has joined, Accept or
 * Decline for an invitation, Start or Cancel for the creator.
 */
import { useState } from "react";

import { Dialog } from "../Dialog.js";
import type { GameEnvelope, Player } from "../game-api.js";
import { seatLabel } from "../game-text.js";
import { Link } from "../router.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

/** What a lobby action did: nothing to show, or what went wrong. */
export type LobbyAction = "start" | "accept" | "decline" | "cancel";

interface LobbyProps {
  readonly appName: string;
  readonly gameName: string;
  readonly game: GameEnvelope;
  readonly onAction: (action: LobbyAction) => Promise<string | null>;
  /** Why the screen may be out of date, or `null`. */
  readonly notice: string | null;
}

const STATE_TEXT: Readonly<Record<Player["state"], string>> = {
  invited: "Invited",
  joined: "Joined",
  declined: "Declined",
  left: "Left",
  removed: "Removed",
  playing: "Playing",
  out: "Out",
};

function whoText(player: Player): string {
  if (player.isYou) return "You";
  // A seat never joined has no name for anyone but the creator, who sees the address typed.
  return player.displayName ?? player.invitedAs ?? "Invited player";
}

export function Lobby({ appName, gameName, game, onAction, notice }: LobbyProps) {
  const [pending, setPending] = useState<LobbyAction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const you = game.players.find((player) => player.isYou);
  const isCreator = you?.isCreator === true;
  const invited = game.yourInvitation !== null;
  const creator = game.players.find((player) => player.isCreator);
  const joined = game.players.filter((player) => player.state === "joined").length;

  async function run(action: LobbyAction) {
    if (pending !== null) return;
    setPending(action);
    setProblem(null);
    const failure = await onAction(action);
    setPending(null);
    setProblem(failure);
    setConfirmCancel(false);
  }

  const status = isCreator
    ? joined < 2
      ? "Waiting for the other players to accept."
      : "Everyone is here. Start when you're ready."
    : invited
      ? `${creator === undefined ? "Someone" : seatLabel(creator)} invited you to play.`
      : "Waiting for the creator to start the game.";

  return (
    <Page appName={appName} nav={<Link to="/">Home</Link>}>
      <h1 tabIndex={-1}>{gameName} lobby</h1>
      <p role="status">{notice ?? status}</p>
      <section className="card stack" aria-labelledby="lobby-players">
        <h2 id="lobby-players">Players</h2>
        <ul className="plain">
          {game.players.map((player, index) => (
            <li key={player.playerId ?? String(index)} className="seat">
              <span>
                {whoText(player)}
                {player.isCreator ? <span className="hint"> (creator)</span> : null}
              </span>
              <span className="badge quiet">{STATE_TEXT[player.state]}</span>
            </li>
          ))}
        </ul>
        {game.resources.length === 0 ? null : (
          <dl className="details">
            <dt>Word list</dt>
            <dd>{game.resources.map((resource) => resource.name).join(", ")}</dd>
          </dl>
        )}
      </section>
      <Problem id="lobby-problem" message={problem} />
      <div className="row">
        {invited ? (
          <>
            <button
              type="button"
              className="button"
              disabled={pending !== null}
              onClick={() => void run("accept")}
            >
              {pending === "accept" ? "Accepting…" : "Accept"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending !== null}
              onClick={() => void run("decline")}
            >
              {pending === "decline" ? "Declining…" : "Decline"}
            </button>
          </>
        ) : null}
        {isCreator ? (
          <>
            <button
              type="button"
              className="button"
              disabled={pending !== null}
              onClick={() => void run("start")}
            >
              {pending === "start" ? "Starting…" : "Start game"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending !== null}
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Cancel game
            </button>
          </>
        ) : null}
      </div>
      {confirmCancel ? (
        <Dialog
          title="Cancel this game?"
          dismissible={pending === null}
          onClose={() => {
            setConfirmCancel(false);
          }}
        >
          <p>Nobody will be able to join it. This can&apos;t be undone.</p>
          <div className="row">
            <button
              type="button"
              className="button danger"
              disabled={pending !== null}
              onClick={() => void run("cancel")}
            >
              Cancel game
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending !== null}
              onClick={() => {
                setConfirmCancel(false);
              }}
            >
              Keep it
            </button>
          </div>
        </Dialog>
      ) : null}
    </Page>
  );
}
