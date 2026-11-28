/**
 * The pairs board (docs/spec/games/pairs.md §9, 07 §2, §6): the players, whose turn it is, the
 * grid of cards and a live status line. It talks to the server only through the shell's `submit`
 * and renders only what the view contains, so it never remembers a face for anyone: a card the
 * view shows face down has no face element, class, key, data attribute or text in the page; the
 * turn-down animation keeps the old face for its own duration and then drops the node; nothing
 * is stored. Resigning is the shell's menu.
 */
import type { Seat } from "@your-move/sdk";
import type { BoardProps } from "@your-move/sdk/client";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import { engines, type Action, type Card, type View } from "../engine/index.js";
import { Back, Face } from "./art.js";
import { FLIP_MS, installStyles } from "./styles.js";
import {
  cardName,
  endingLine,
  errorText,
  moveNote,
  plural,
  seatNames,
  shownLine,
  type Mode,
  type Who,
} from "./text.js";
import { Unsupported } from "./Unsupported.js";

type Props = BoardProps<Action, View, unknown>;

const SUBMIT_FAILED = "Couldn't send your move. Check your connection and try again.";

/** Whether the person asked for no motion (07 §5). */
function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function Board(props: Props): ReactElement {
  const { game, view } = props;
  const [styled] = useState(installStyles);
  if (!styled) return <Unsupported />;
  if (game.gameVersion !== engines[1].version) {
    return (
      <p role="alert">
        This game uses a version of the rules this app doesn&apos;t know. Reload the page to update.
      </p>
    );
  }
  // The choices belong to one game and survive its new versions.
  return <Table key={game.id} {...props} view={view} />;
}

interface CardProps {
  readonly card: Card;
  readonly name: string;
  readonly disabled: boolean;
  readonly turning: boolean;
  readonly tabbable: boolean;
  readonly register: (node: HTMLButtonElement | null) => void;
  readonly onTap: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onFocus: () => void;
}

/** The player number a card carries: who missed or matched it (pairs §9). */
function badgeOf(card: Card): string | null {
  switch (card.state) {
    case "missed":
      return String(card.by + 1);
    case "matched":
      return `✓${String(card.by + 1)}`;
    default:
      return null;
  }
}

/**
 * One card. A card whose face the view doesn't give is the back and nothing else. When a face
 * goes (the card turns down), the old face is kept for the flip's own duration and then removed;
 * with reduced motion it is never kept.
 */
function CardButton({
  card,
  name,
  disabled,
  turning,
  tabbable,
  register,
  onTap,
  onKeyDown,
  onFocus,
}: CardProps): ReactElement {
  const face = card.face;
  const [seenFace, setSeenFace] = useState<number | null>(face);
  const [leaving, setLeaving] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false);
  if (seenFace !== face) {
    setSeenFace(face);
    const motion = !reducedMotion();
    setLeaving(face === null && seenFace !== null && motion ? seenFace : null);
    setFresh(face !== null && seenFace === null && motion);
  }
  useEffect(() => {
    if (leaving === null) return undefined;
    const timer = setTimeout(() => {
      setLeaving(null);
    }, FLIP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [leaving]);

  const badge = badgeOf(card);
  // A face drawn while the game is still on is always one of the view's up, missed or matched
  // cards; a down card has one only once the game is over, and is then shown as not found.
  const state = card.state === "down" && face !== null ? "unfound" : card.state;
  return (
    <button
      type="button"
      className="ym-pr-card"
      ref={register}
      data-state={state}
      {...(turning ? { "data-turning": "true" } : {})}
      aria-label={name}
      aria-disabled={disabled}
      tabIndex={tabbable ? 0 : -1}
      onClick={onTap}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {face === null ? <Back /> : null}
      {face === null ? null : (
        <span className={fresh ? "ym-pr-face ym-pr-flip-in" : "ym-pr-face"}>
          <Face id={face} />
        </span>
      )}
      {leaving === null ? null : (
        <span className="ym-pr-ghost ym-pr-flip-out" aria-hidden="true">
          <Face id={leaving} />
        </span>
      )}
      {badge === null ? null : <span className="ym-pr-badge" data-no={badge} aria-hidden="true" />}
    </button>
  );
}

/** The turn line and its tail: whose turn it is and, near the limit, how many moves are left. */
function turnLine(view: View, who: Who, yourTurn: boolean): string {
  const turn = view.turn;
  const head = yourTurn
    ? `Your turn: turn over a ${view.cards.some((row) => row.some((card) => card.state === "up")) ? "second " : ""}card`
    : `${turn === null ? "Someone" : (who.names[turn] ?? "Someone")} to play`;
  const left = view.moveLimit - view.moves;
  const playing = view.out.filter((out) => out === null).length;
  return left < 2 * playing ? `${head} · ${plural(Math.max(left, 0), "move", "moves")} left` : head;
}

interface Seen {
  readonly version: number;
  readonly view: View;
}

function Table(props: Props): ReactElement {
  const { game, view } = props;
  const names = seatNames(game, view.pairs.length);
  const seat: Seat | null = game.yourSeat;
  const who: Who = { names, you: seat };
  const mode: Mode =
    view.endReason !== null ? "over" : game.status === "active" ? "play" : "stopped";
  const [busy, setBusy] = useState<{ row: number; column: number } | null>(null);
  const [sentFor, setSentFor] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [seen, setSeen] = useState<Seen>({ version: game.version, view });
  const [focus, setFocus] = useState({ row: 0, column: 0 });
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // A new version of the game: say what the viewer's own second card did, and forget the old
  // message. Done while rendering, so the line is never one view behind the board.
  if (seen.version !== game.version) {
    setSeen({ version: game.version, view });
    setMessage(null);
    setNote(moveNote(seen.view, view, who));
  }

  const yourTurn = mode === "play" && game.yourTurn && seat !== null && view.turn === seat;
  const canAct = yourTurn && busy === null && sentFor !== game.version;

  async function turnOver(row: number, column: number): Promise<void> {
    const card = view.cards[row]?.[column];
    if (!canAct || card === undefined || card.state === "matched" || card.state === "up") return;
    setBusy({ row, column });
    setMessage(null);
    const sentAt = game.version;
    try {
      const outcome = await props.submit({ type: "flip", row, column });
      if (outcome.ok) setSentFor(sentAt);
      else setMessage(errorText(outcome.error));
    } catch {
      setMessage(SUBMIT_FAILED);
    } finally {
      setBusy(null);
    }
  }

  function moveFocus(row: number, column: number): void {
    const r = Math.min(Math.max(row, 0), view.rows - 1);
    const c = Math.min(Math.max(column, 0), view.columns - 1);
    setFocus({ row: r, column: c });
    buttons.current[r * view.columns + c]?.focus();
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>, row: number, column: number): void {
    const to = (r: number, c: number) => {
      event.preventDefault();
      moveFocus(r, c);
    };
    switch (event.key) {
      case "ArrowRight":
        to(row, column + 1);
        break;
      case "ArrowLeft":
        to(row, column - 1);
        break;
      case "ArrowDown":
        to(row + 1, column);
        break;
      case "ArrowUp":
        to(row - 1, column);
        break;
      case "Home":
        to(event.ctrlKey ? 0 : row, 0);
        break;
      case "End":
        to(event.ctrlKey ? view.rows - 1 : row, view.columns - 1);
        break;
      default:
    }
  }

  const status: { tone?: "bad"; text: string }[] = [];
  if (message !== null) status.push({ tone: "bad", text: message });
  if (note !== null) status.push({ text: note });
  const line = shownLine(view, who, mode, yourTurn);
  if (line !== null) status.push({ text: line });
  if (mode === "play" && seat !== null && view.out[seat] !== null && view.out[seat] !== undefined) {
    status.push({ text: "You're out of this game. You can watch it finish." });
  }

  const ending = endingLine(view, names);

  return (
    <section className="ym-pr" aria-label="Pairs board">
      <ul className="ym-pr-players" aria-label="Players">
        {names.map((name, player) => {
          const out = view.out[player] ?? null;
          const found = view.pairs[player] ?? 0;
          return (
            <li
              key={player}
              aria-current={mode === "play" && view.turn === player}
              data-out={out !== null}
            >
              <span className="ym-pr-vh">Player </span>
              <span className="ym-pr-no">{player + 1}</span>
              <span className="ym-pr-who">
                {name}
                {player === seat ? <span className="ym-pr-vh">, you</span> : null}
              </span>
              <span className="ym-pr-score">
                {out === null ? (
                  <>
                    {"· "}
                    {found}
                    <span className="ym-pr-vh">{found === 1 ? " pair" : " pairs"}</span>
                  </>
                ) : (
                  <>
                    {"· out"}
                    {found > 0 ? ` (${String(found)})` : ""}
                    <span className="ym-pr-vh">
                      {found === 1 ? ", 1 pair kept" : `, ${String(found)} pairs kept`}
                    </span>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {mode === "play" && (
        <p className="ym-pr-turn" data-yours={yourTurn}>
          {turnLine(view, who, yourTurn)}
        </p>
      )}
      <div
        className="ym-pr-board"
        role="grid"
        aria-label="Cards"
        aria-busy={busy !== null}
        data-cols={view.columns}
      >
        {view.cards.map((cards, row) => (
          <div className="ym-pr-row" role="row" key={row}>
            {cards.map((card, column) => {
              const inactive = !canAct || card.state === "matched" || card.state === "up";
              return (
                <div className="ym-pr-cell" role="gridcell" key={column}>
                  <CardButton
                    card={card}
                    name={cardName(row, column, card, who, mode)}
                    disabled={inactive}
                    turning={busy?.row === row && busy.column === column}
                    tabbable={focus.row === row && focus.column === column}
                    register={(node) => {
                      buttons.current[row * view.columns + column] = node;
                    }}
                    onTap={() => {
                      void turnOver(row, column);
                    }}
                    onKeyDown={(event) => {
                      onKey(event, row, column);
                    }}
                    onFocus={() => {
                      setFocus({ row, column });
                    }}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="ym-pr-status" role="status" aria-live="polite" aria-atomic="true">
        {status.map((entry, i) => (
          <span key={i} data-tone={entry.tone}>
            {entry.text}
          </span>
        ))}
      </div>
      {mode === "over" && (
        <section className="ym-pr-final" aria-label="How it ended">
          <h2>How it ended</h2>
          {ending === null ? null : <p>{ending}</p>}
          <ul>
            {names.map((name, player) => {
              const out = view.out[player] ?? null;
              return (
                <li key={player}>
                  {`${name} found ${plural(view.pairs[player] ?? 0, "pair", "pairs")}${out === null ? "" : " and left the game"}.`}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </section>
  );
}
