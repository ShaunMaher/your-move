/**
 * The paths board (docs/spec/games/paths.md §8, 07 §2, §6): the players and whose turn it is, the
 * board with the ghost of the tile in hand and the paths it would send each marker down, the hand
 * with rotation, and the marker phase's two steps. It talks to the server only through the
 * shell's `submit` and renders only what the view contains; the previews are the engine's own
 * movement run on the public board, so they are exact, and still never authoritative (02 §3).
 * Resigning is the shell's menu.
 */
import type { Seat } from "@your-move/sdk";
import type { BoardProps } from "@your-move/sdk/client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import {
  edgeNotch,
  edgeNotchCount,
  engines,
  livePosition,
  samePosition,
  type Action,
  type NotchPosition,
  type Options,
  type View,
} from "../engine/index.js";
import { MarkerIcon, TileArt, lookName } from "./art.js";
import { edgeNotchesOf, notchName } from "./layout.js";
import {
  FRAME_MS,
  frameCount,
  positionsAt,
  previewPlacement,
  replayOf,
  selfEliminationBlocked,
  targetOf,
  walks,
  type Replay,
  type Walk,
} from "./plan.js";
import { Stage, type Ghost } from "./Stage.js";
import { installStyles } from "./styles.js";
import { errorText, handTileName, list, notchButtonName, plural, seatNames } from "./text.js";
import { Unsupported } from "./Unsupported.js";

type Props = BoardProps<Action, View, unknown>;

const NO_TILES: readonly number[] = [];
const SUBMIT_FAILED = "Couldn't send your move. Check your connection and try again.";
const OUT_TEXT = {
  eliminated: "out",
  resigned: "resigned",
  timed_out: "out of time",
  declined: "declined",
} as const;

/** Whether the person asked for no motion (07 §5). */
function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** One line saying what a replayed move did, for the board's live status. */
function moveNote(replay: Replay, names: readonly string[]): string {
  const who = replay.mover === null ? "Someone" : (names[replay.mover] ?? "Someone");
  const named = (seats: readonly number[]): string[] => seats.map((seat) => names[seat] ?? "");
  const { eliminated, collided } = replay.movement;
  const crashed = new Set(collided.flat());
  const crashes = eliminated.filter((seat) => crashed.has(seat));
  const offBoard = eliminated.filter((seat) => !crashed.has(seat));
  const parts = [`${who} placed a tile.`];
  if (crashes.length > 0) parts.push(`${list(named(crashes))} crashed.`);
  if (offBoard.length > 0) parts.push(`${list(named(offBoard))} ran off the board.`);
  return parts.join(" ");
}

/** The edge-notch index of a notch of an edge square (the action's `edgeNotch`). */
function indexOf(size: number, pos: NotchPosition): number {
  for (let e = 0; e < edgeNotchCount(size); e += 1) {
    if (samePosition(edgeNotch(size, e), pos)) return e;
  }
  return -1;
}

export function Board(props: Props): ReactElement {
  const { game, view } = props;
  const [styled] = useState(installStyles);
  if (!styled) return <Unsupported />;
  const engine = game.gameVersion === engines[1].version ? engines[1] : undefined;
  const options = engine?.optionsSchema.safeParse(game.options);
  if (options?.success !== true) {
    return (
      <p role="alert">
        This game uses a version of the rules this app doesn&apos;t know. Reload the page to update.
      </p>
    );
  }
  // The choices belong to one game and survive its new versions.
  return <Table key={game.id} {...props} view={view} options={options.data} />;
}

interface Seen {
  readonly version: number;
  readonly view: View;
}

interface Anim {
  readonly walks: readonly Walk[];
  readonly frame: number;
  readonly total: number;
}

function Table(props: Props & { readonly options: Options }): ReactElement {
  const { game, view, options } = props;
  const names = seatNames(game, view.markers.length);
  const seat: Seat | null = game.yourSeat;
  const hand = view.yourHand ?? NO_TILES;
  const active = game.status === "active";
  const [rotations, setRotations] = useState<Readonly<Record<number, number>>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [picked, setPicked] = useState<{ r: number; c: number } | null>(null);
  const [aim, setAim] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [anim, setAnim] = useState<Anim | null>(null);
  const [seen, setSeen] = useState<Seen>({ version: game.version, view });
  const tiles = useRef<(HTMLButtonElement | null)[]>([]);
  const notches = useRef<HTMLFieldSetElement | null>(null);

  // A new version of the game: replay the move on the old board if it was one tile (paths §8),
  // and forget what was waiting on the old one. Done while rendering, so the new board is never
  // drawn for a moment before its markers start from where they were.
  if (seen.version !== game.version) {
    const replay = replayOf(seen.view, view);
    const marked = seen.view.phase === "markers" && view.phase === "markers";
    setSeen({ version: game.version, view });
    setSent(false);
    setMessage(null);
    setPicked(null);
    setAim(null);
    setNote(
      replay !== null
        ? moveNote(replay, names)
        : marked && seen.view.toAct[0] !== undefined
          ? `${names[seen.view.toAct[0]] ?? "Someone"} placed their marker.`
          : null,
    );
    const all = replay === null || reducedMotion() ? null : walks(replay);
    setAnim(
      all === null || frameCount(all) === 0
        ? null
        : { walks: all, frame: 0, total: frameCount(all) },
    );
    if (selected !== null && !hand.includes(selected)) setSelected(null);
  }

  const running = anim?.walks ?? null;
  useEffect(() => {
    if (running === null) return undefined;
    const timer = setInterval(() => {
      setAnim((now) =>
        now === null || now.frame >= now.total ? null : { ...now, frame: now.frame + 1 },
      );
    }, FRAME_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running]);

  // A picked square moves focus to its notch buttons, for keyboards and screen readers.
  useEffect(() => {
    if (picked !== null) notches.current?.querySelector("button")?.focus();
  }, [picked]);

  const shown = useMemo(() => (anim === null ? null : positionsAt(anim.walks, anim.frame)), [anim]);

  const mine = seat === null ? undefined : view.markers[seat];
  const out = mine !== undefined && mine.out !== null;
  const canAct = active && game.yourTurn && seat !== null && !out && !busy && !sent;
  const target = view.phase === "tiles" && !out ? targetOf(view, seat) : null;
  const rotationOf = (tileId: number): number => rotations[tileId] ?? 0;
  const chosen = selected !== null && hand.includes(selected) ? selected : null;
  const placed = chosen === null ? null : { tileId: chosen, rotation: rotationOf(chosen) };
  const preview =
    placed === null || seat === null || target === null
      ? null
      : previewPlacement(view, seat, placed);
  const avoid = options.selfElimination === "avoidIfPossible";
  const verdict =
    preview === null || seat === null ? null : selfEliminationBlocked(view, seat, avoid, preview);
  const ghost: Ghost | null = placed === null || preview === null ? null : { placed, preview };

  const taken = view.markers.flatMap((marker) => {
    const pos = livePosition(marker);
    return pos === null ? [] : [pos];
  });
  const free = (pos: NotchPosition): boolean => !taken.some((other) => samePosition(other, pos));
  const pickable = (r: number, c: number): boolean =>
    view.phase === "markers" &&
    canAct &&
    edgeNotchesOf(view.boardSize, r, c).some((n) => free({ r, c, n }));

  async function send(action: Action): Promise<void> {
    if (!canAct) return;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await props.submit(action);
      if (outcome.ok) setSent(true);
      else setMessage(errorText(outcome.error));
    } catch {
      setMessage(SUBMIT_FAILED);
    } finally {
      setBusy(false);
    }
  }

  function place(): void {
    if (placed === null || verdict?.blocked !== false) return;
    void send({ type: "place-tile", tileId: placed.tileId, rotation: placed.rotation });
  }

  function turn(tileId: number): void {
    setRotations((now) => ({ ...now, [tileId]: ((now[tileId] ?? 0) + 1) % 4 }));
  }

  function tap(tileId: number): void {
    if (chosen === tileId) turn(tileId);
    else setSelected(tileId);
  }

  function choose(index: number): void {
    const tileId = hand[(index + hand.length) % hand.length];
    if (tileId === undefined) return;
    setSelected(tileId);
    tiles.current[(index + hand.length) % hand.length]?.focus();
  }

  function onTileKey(event: KeyboardEvent, index: number, tileId: number): void {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        choose(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        choose(index - 1);
        break;
      case "r":
      case "R":
        event.preventDefault();
        setSelected(tileId);
        turn(tileId);
        break;
      case "Enter":
        // Enter places the tile in hand (07 §6); Space still selects and turns it, as a tap does.
        event.preventDefault();
        if (chosen === tileId) place();
        else setSelected(tileId);
        break;
      default:
    }
  }

  const status: { tone?: "bad" | "ok"; text: string }[] = [];
  if (message !== null) status.push({ tone: "bad", text: message });
  if (note !== null) status.push({ text: note });
  if (view.phase === "markers" && active && canAct && picked === null) {
    status.push({
      text: "Tap a square on the edge of the board, then choose a notch for your marker.",
    });
  }
  if (view.phase === "tiles" && active && seat !== null && !out) {
    if (!game.yourTurn && chosen !== null) {
      status.push({ text: "It isn't your turn yet; this is how the board looks now." });
    }
    if (preview === null && hand.length > 0 && game.yourTurn) {
      status.push({ text: "Choose a tile. Tap it again, or press Rotate, to turn it." });
    }
    if (preview !== null) {
      const others = preview.movement.eliminated.filter((who) => who !== seat);
      if (preview.eliminatesYou) {
        status.push({
          tone: "bad",
          text: "Warning: your marker would run off the board and you would be out.",
        });
        if (verdict?.blocked === true) {
          status.push({
            tone: "bad",
            text: "Another tile or turn keeps your marker on the board, so you can't play this one.",
          });
        } else if (avoid) {
          status.push({
            text: "Every tile and turn in your hand does the same, so you must play one anyway.",
          });
        }
      } else {
        status.push({ tone: "ok", text: "Your marker would stay on the board." });
      }
      if (others.length > 0) {
        status.push({ text: `${list(others.map((who) => names[who] ?? ""))} would be out too.` });
      }
    }
  }

  const mover = game.toAct[0];
  const who = mover === undefined ? "Someone" : (names[mover] ?? "Someone");
  let turnText = "";
  if (game.status === "finished") turnText = "Game over.";
  else if (active && game.yourTurn) {
    turnText =
      view.phase === "markers"
        ? "Your turn: choose where your marker starts."
        : "Your turn: choose a tile.";
  } else if (active) {
    turnText = view.phase === "markers" ? `${who} is placing their marker.` : `${who}'s turn.`;
  }

  const pickedNotches = picked === null ? [] : edgeNotchesOf(view.boardSize, picked.r, picked.c);

  return (
    <section className="ym-p" aria-label="Paths board">
      <ul className="ym-p-players" aria-label="Players">
        {names.map((name, who) => {
          const marker = view.markers[who];
          const reason = marker?.out?.reason;
          return (
            <li key={who} aria-current={game.toAct.includes(who)} data-out={reason !== undefined}>
              <MarkerIcon seat={who} />
              <span>
                {name}
                {who === seat ? " (you)" : ""}
                <span className="ym-p-vh">, {lookName(who)} marker</span>
              </span>
              <span className="ym-p-detail">
                {reason !== undefined
                  ? OUT_TEXT[reason]
                  : view.phase === "markers"
                    ? marker?.pos == null
                      ? "to place"
                      : "placed"
                    : plural(view.handCounts[who] ?? 0, "tile", "tiles")}
              </span>
            </li>
          );
        })}
      </ul>
      {turnText !== "" && (
        <p className="ym-p-turn" data-yours={active && game.yourTurn && !out}>
          {turnText}
        </p>
      )}
      <Stage
        view={view}
        seat={seat}
        names={names}
        target={target}
        ghost={ghost}
        shown={shown}
        pickable={pickable}
        picked={picked}
        aim={aim}
        free={free}
        onPick={(r, c) => {
          setPicked({ r, c });
          setAim(null);
          setMessage(null);
        }}
      />
      <div className="ym-p-status" role="status" aria-live="polite" aria-atomic="true">
        {status.map((line, i) => (
          <span key={i} data-tone={line.tone}>
            {line.text}
          </span>
        ))}
      </div>

      {view.phase === "markers" && picked !== null && canAct && (
        <fieldset className="ym-p-picker" ref={notches}>
          <legend>{`Row ${String(picked.r + 1)}, column ${String(picked.c + 1)}: choose a notch`}</legend>
          <div className="ym-p-notches">
            {pickedNotches.map((n) => {
              const here = { r: picked.r, c: picked.c, n };
              const open = free(here);
              return (
                <button
                  key={n}
                  type="button"
                  aria-label={notchButtonName(n, open)}
                  disabled={!open}
                  onFocus={() => {
                    setAim(n);
                  }}
                  onBlur={() => {
                    setAim(null);
                  }}
                  onPointerEnter={() => {
                    setAim(n);
                  }}
                  onPointerLeave={() => {
                    setAim(null);
                  }}
                  onClick={() => {
                    void send({ type: "place-marker", edgeNotch: indexOf(view.boardSize, here) });
                  }}
                >
                  {notchName(n)}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="ym-p-cancel"
            onClick={() => {
              setPicked(null);
              setAim(null);
            }}
          >
            Choose another square
          </button>
        </fieldset>
      )}

      {view.phase === "tiles" && active && seat !== null && view.yourHand !== null && !out && (
        <>
          {hand.length === 0 ? (
            <p className="ym-p-meta">
              You have no tiles right now. You&apos;ll be skipped until you get one.
            </p>
          ) : (
            <>
              <div className="ym-p-hand" role="group" aria-label="Your hand">
                {hand.map((tileId, index) => {
                  const rotation = rotationOf(tileId);
                  const result =
                    target === null ? null : previewPlacement(view, seat, { tileId, rotation });
                  const eliminates = result?.eliminatesYou ?? null;
                  return (
                    <div className="ym-p-pick" key={tileId}>
                      <button
                        type="button"
                        className="ym-p-hand-tile"
                        ref={(node) => {
                          tiles.current[index] = node;
                        }}
                        aria-pressed={chosen === tileId}
                        aria-label={handTileName(index, hand.length, rotation, eliminates)}
                        onClick={() => {
                          tap(tileId);
                        }}
                        onKeyDown={(event) => {
                          onTileKey(event, index, tileId);
                        }}
                      >
                        <TileArt tileId={tileId} rotation={rotation} />
                      </button>
                      {eliminates !== null && (
                        <span className="ym-p-chip" aria-hidden="true" data-eliminates={eliminates}>
                          {eliminates ? "✗ out" : "✓ safe"}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="ym-p-actions">
                <button
                  type="button"
                  disabled={chosen === null || busy}
                  onClick={() => {
                    if (chosen !== null) turn(chosen);
                  }}
                >
                  {"↻ Rotate"}
                </button>
                <button
                  type="button"
                  className="ym-p-primary"
                  disabled={!canAct || placed === null || verdict?.blocked !== false}
                  onClick={place}
                >
                  Place
                </button>
              </div>
            </>
          )}
          {view.deckCount > 0 || view.tokenHolder !== null ? (
            <p className="ym-p-meta">
              {plural(view.deckCount, "tile", "tiles")} in the deck
              {view.tokenHolder === null
                ? ""
                : `. ${names[view.tokenHolder] ?? "Someone"} draws first when tiles come back.`}
            </p>
          ) : null}
        </>
      )}
      {view.phase === "tiles" && active && out && (
        <p className="ym-p-meta">You&apos;re out of this game. You can watch it finish.</p>
      )}

      {view.endReason !== null && view.hands !== null && (
        <section className="ym-p-final" aria-label="How it ended">
          <h2>How it ended</h2>
          <p>
            {view.endReason === "last-standing"
              ? "One marker was left on the board."
              : view.endReason === "wipe-out"
                ? "The last markers left the board together."
                : "Nobody left held a tile to play."}
          </p>
          <ul>
            {view.hands.map((tilesLeft, who) =>
              tilesLeft.length === 0 ? null : (
                <li key={who}>
                  <span>{`${names[who] ?? ""} kept ${plural(tilesLeft.length, "tile", "tiles")}:`}</span>
                  {tilesLeft.map((tileId) => (
                    <span key={tileId} className="ym-p-mini">
                      <TileArt tileId={tileId} rotation={0} />
                    </span>
                  ))}
                </li>
              ),
            )}
          </ul>
        </section>
      )}
    </section>
  );
}
