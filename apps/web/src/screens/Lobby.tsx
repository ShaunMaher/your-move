/**
 * A game waiting for its players (07 §1, 02 §4): who is invited and who has joined, Accept,
 * Decline or Block (its creator, alpha A23) for an invitation, Decline or Block for a player already in (a past opponent added them without
 * asking, alpha A12, or they joined through the link), and for the creator Start, Cancel, Remove
 * per seat and the join-link controls (alpha A18).
 */
import { useState } from "react";

import { Dialog } from "../Dialog.js";
import type { GameEnvelope, Player } from "../game-api.js";
import { seatLabel } from "../game-text.js";
import { Link } from "../router.js";
import { JoinLinkPanel, type MadeLink } from "./JoinLinkPanel.js";
import { Page } from "./Page.js";
import { Problem } from "./Problem.js";

/** What a lobby action did: nothing to show, or what went wrong. */
export type LobbyAction = "start" | "accept" | "decline" | "cancel";

interface LobbyProps {
  readonly appName: string;
  readonly gameName: string;
  readonly game: GameEnvelope;
  readonly onAction: (action: LobbyAction) => Promise<string | null>;
  /** The creator removes a seat (05 `remove-seat`); what went wrong, or null. */
  readonly onRemove: (playerId: string) => Promise<string | null>;
  /** An invitee or joined player blocks the game's creator (05 §Blocks); what went wrong, or null. */
  readonly onBlock: (userId: string) => Promise<string | null>;
  readonly onCreateLink: () => Promise<MadeLink>;
  readonly onRevokeLink: () => Promise<string | null>;
  /** A join link made at creation, to show once (06 §6.8). */
  readonly freshLink: string | null;
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

/** A row the creator may remove: someone else's that holds a seat (05 `remove-seat`). */
function removable(player: Player): player is Player & { playerId: string } {
  return (
    player.playerId !== undefined &&
    !player.isCreator &&
    (player.state === "invited" || player.state === "joined")
  );
}

export function Lobby({
  appName,
  gameName,
  game,
  onAction,
  onRemove,
  onBlock,
  onCreateLink,
  onRevokeLink,
  freshLink,
  notice,
}: LobbyProps) {
  const [pending, setPending] = useState<LobbyAction | "remove" | "block" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  /** The seat whose removal is being confirmed. */
  const [removing, setRemoving] = useState<(Player & { playerId: string }) | null>(null);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const you = game.players.find((player) => player.isYou);
  const isCreator = you?.isCreator === true;
  const invited = game.yourInvitation !== null;
  /** In the lobby but not its creator: added by a past opponent, or accepted. Either may decline. */
  const joinedNotCreator = you?.state === "joined" && !isCreator;
  const creator = game.players.find((player) => player.isCreator);
  /**
   * Who Block blocks: the creator, while their account exists, for anyone else in the lobby, an
   * invitee or someone who joined (a past opponent may have added them, A23-P-1).
   */
  const blockable = (invited || joinedNotCreator) && creator?.userId != null ? creator : undefined;
  const blockButton =
    blockable === undefined ? null : (
      <button
        type="button"
        className="button secondary"
        disabled={pending !== null}
        aria-label={`Block ${seatLabel(blockable)}`}
        onClick={() => {
          setConfirmBlock(true);
        }}
      >
        Block
      </button>
    );
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

  async function block(userId: string) {
    if (pending !== null) return;
    setPending("block");
    setProblem(null);
    const failure = await onBlock(userId);
    setPending(null);
    setProblem(failure);
    setConfirmBlock(false);
  }

  async function remove(playerId: string) {
    if (pending !== null) return;
    setPending("remove");
    setProblem(null);
    const failure = await onRemove(playerId);
    setPending(null);
    setProblem(failure);
    setRemoving(null);
  }

  const seats = game.seats;
  const status = isCreator
    ? seats !== undefined && joined >= seats
      ? "Everyone is here. Start when you're ready."
      : joined >= 2
        ? `${String(joined)} of ${String(seats ?? joined)} joined: you can start now, or wait for more.`
        : game.joinLink?.active === true
          ? "Waiting for players to join."
          : "Waiting for the other players to accept."
    : invited
      ? `${creator === undefined ? "Someone" : seatLabel(creator)} invited you to play.`
      : joinedNotCreator
        ? "Waiting for the creator to start the game. You can still decline."
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
              <span className="row">
                <span className="badge quiet">{STATE_TEXT[player.state]}</span>
                {isCreator && removable(player) ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={pending !== null}
                    aria-label={`Remove ${whoText(player)}`}
                    onClick={() => {
                      setRemoving(player);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </span>
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
      {isCreator ? (
        <JoinLinkPanel
          link={game.joinLink}
          fresh={freshLink}
          onCreate={onCreateLink}
          onRevoke={onRevokeLink}
          onProblem={setProblem}
        />
      ) : null}
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
            {blockButton}
          </>
        ) : null}
        {joinedNotCreator ? (
          <>
            <button
              type="button"
              className="button secondary"
              disabled={pending !== null}
              onClick={() => void run("decline")}
            >
              {pending === "decline" ? "Declining…" : "Decline"}
            </button>
            {blockButton}
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
      {removing !== null ? (
        <Dialog
          title={`Remove ${whoText(removing)}?`}
          dismissible={pending === null}
          onClose={() => {
            setRemoving(null);
          }}
        >
          <p>
            They won&apos;t be in this game. They can&apos;t come back into this game through any
            join link.
          </p>
          <div className="row">
            <button
              type="button"
              className="button danger"
              disabled={pending !== null}
              onClick={() => void remove(removing.playerId)}
            >
              Remove
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending !== null}
              onClick={() => {
                setRemoving(null);
              }}
            >
              Keep them
            </button>
          </div>
        </Dialog>
      ) : null}
      {confirmBlock && blockable?.userId != null ? (
        <Dialog
          title={`Block ${seatLabel(blockable)}?`}
          dismissible={pending === null}
          onClose={() => {
            setConfirmBlock(false);
          }}
        >
          <p>
            {invited ? "You'll decline this invitation." : "You'll leave this game."} They
            won&apos;t be able to add you to games or invite you, and you won&apos;t be put in a
            game with them. In other games that haven&apos;t started yet, you&apos;ll leave the ones
            they&apos;ve joined (or they&apos;re removed from games you created), and any invitation
            they have to a game you&apos;ve joined stops. Games you&apos;re already playing carry
            on.
          </p>
          <p>
            They won&apos;t be told, but you&apos;ll no longer be on each other&apos;s lists of
            people you&apos;ve played. You can unblock them in Settings.
          </p>
          <div className="row">
            <button
              type="button"
              className="button danger"
              disabled={pending !== null}
              onClick={() => void block(blockable.userId ?? "")}
            >
              {pending === "block" ? "Blocking…" : "Block"}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={pending !== null}
              onClick={() => {
                setConfirmBlock(false);
              }}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
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
