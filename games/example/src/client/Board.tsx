/**
 * The example game's board (docs/spec/02-game-framework.md §3): the players, the last revealed
 * round and the viewer's hand. It talks to the server only through the shell's `submit` and
 * `preview`, and renders only what the view contains. Either call can reject (the network is
 * down, say); the board then tells the player in its alert region instead of failing silently.
 */
import { isGameError } from "@your-move/sdk";
import type { BoardProps } from "@your-move/sdk/client";
import { useRef, useState, type ReactElement } from "react";

import type { Action, LastRound, PreviewResult, View } from "../engine/index.js";
import { plural, seatNames } from "./names.js";

type Props = BoardProps<Action, View, PreviewResult>;

/** Shown when `preview` or `submit` rejects instead of answering. */
const PREVIEW_FAILED = "Couldn't check that card. Try again.";
const SUBMIT_FAILED = "Couldn't send your play. Check your connection and try again.";

/** What each end reason means, for people. */
const END_TEXT = {
  "last-standing": "Game over: one player left standing.",
  "cards-exhausted": "Game over: the cards ran out.",
} as const;

export function Board(props: Props): ReactElement {
  // The shell's callbacks are called through `props`, never detached from it.
  const { game, view } = props;
  const names = seatNames(game, view.seats.length);
  const mine = view.you === null ? null : view.seats[view.you];
  const hand = mine?.hand ?? [];
  const canPlay = mine?.status === "playing" && view.yourPlay === null && view.endReason === null;

  const [selected, setSelected] = useState<number | null>(null);
  const [kept, setKept] = useState<readonly number[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef<number | null>(null);
  const choice = canPlay && selected !== null && hand.includes(selected) ? selected : null;

  function choose(card: number): void {
    setSelected(card);
    setKept(null);
    setError(null);
    latest.current = card;
    props.preview({ card }).then(
      (answer) => {
        // Only the latest choice's preview is shown.
        if (latest.current === card) setKept(isGameError(answer) ? null : answer.handAfter);
      },
      () => {
        if (latest.current === card) setError(PREVIEW_FAILED);
      },
    );
  }

  async function play(card: number): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const outcome = await props.submit({ card });
      if (outcome.ok) setSelected(null);
      else setError(`That card couldn't be played (${outcome.error.code}).`);
    } catch {
      setError(SUBMIT_FAILED);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Table">
      <h2>{view.endReason === null ? `Round ${String(view.round)}` : END_TEXT[view.endReason]}</h2>
      <p>{plural(view.deckCount, "card", "cards")} left in the deck</p>

      <ul aria-label="Players">
        {view.seats.map((seat, index) => (
          <li key={index}>
            {names[index]}
            {index === view.you ? " (you)" : ""}: {plural(seat.lives, "life", "lives")},{" "}
            {plural(seat.points, "point", "points")}, {seatState(seat, view.endReason !== null)}
            {view.endReason !== null && seat.hand !== null && seat.hand.length > 0
              ? `; held ${seat.hand.join(", ")}`
              : ""}
          </li>
        ))}
      </ul>

      {view.lastRound && <RoundOutcome round={view.lastRound} names={names} />}

      {mine && view.endReason === null && (
        <div role="group" aria-label="Your hand">
          {view.yourPlay !== null && (
            <p>You played {view.yourPlay}. Waiting for the others to play.</p>
          )}
          {hand.map((card) => (
            <button
              key={card}
              type="button"
              aria-pressed={card === choice}
              disabled={!canPlay || busy}
              onClick={() => {
                choose(card);
              }}
            >
              {card}
            </button>
          ))}
          {choice !== null && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void play(choice);
                }}
              >
                Play {choice}
              </button>
              {kept && <p>You will keep {kept.length > 0 ? kept.join(", ") : "no cards"}.</p>}
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}

function seatState(seat: View["seats"][number], over: boolean): string {
  if (seat.status === "out") return "out";
  if (over) return "still in";
  return seat.played ? "has played" : "choosing a card";
}

/** The last revealed round: every card, who scored, who lost a life. */
function RoundOutcome(props: { round: LastRound; names: readonly string[] }): ReactElement {
  const { round, names } = props;
  const name = (seat: number): string => names[seat] ?? `Seat ${String(seat + 1)}`;
  const cards = round.plays.map((play) => `${name(play.seat)} ${String(play.card)}`).join(", ");
  const out = round.eliminated === null ? "" : " and is out";
  return (
    <p>
      Round {round.round}: {cards}. {name(round.high)} scores a point; {name(round.low)} loses a
      life{out}.
    </p>
  );
}
