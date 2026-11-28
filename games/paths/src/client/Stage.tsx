/**
 * The board itself (docs/spec/games/paths.md §8): the squares as an HTML grid, so each has an
 * accessible name and edge squares can be tapped in the marker phase, and over them one SVG for
 * the ghost path traces and the markers, which are drawn in board units and move freely between
 * squares (the animation changes their points, not the DOM's structure).
 */
import type { Seat } from "@your-move/sdk";
import type { ReactElement } from "react";

import { livePosition, type NotchPosition, type Placed, type View } from "../engine/index.js";
import { lookOf, Marker, TileArt } from "./art.js";
import {
  edgeNotchesOf,
  hopsOf,
  notchOffset,
  pointOf,
  SQUARE,
  traceD,
  type Point,
} from "./layout.js";
import type { Preview } from "./plan.js";
import { squareName } from "./text.js";

/** A ghost: the tile the viewer is thinking of and what it would do. */
export interface Ghost {
  readonly placed: Placed;
  readonly preview: Preview;
}

export interface StageProps {
  readonly view: View;
  readonly seat: Seat | null;
  readonly names: readonly string[];
  /** The square the viewer's marker faces, always highlighted in the tile phase. */
  readonly target: { r: number; c: number } | null;
  readonly ghost: Ghost | null;
  /** Marker positions during an animation, by seat; null when nothing is animating. */
  readonly shown: ReadonlyMap<Seat, Point> | null;
  /** The marker phase's edge squares that can be tapped, and the one picked. */
  readonly pickable: (r: number, c: number) => boolean;
  readonly picked: { r: number; c: number } | null;
  /** The notch a button is aimed at (focus or hover), drawn on the board. */
  readonly aim: number | null;
  readonly free: (pos: NotchPosition) => boolean;
  readonly onPick: (r: number, c: number) => void;
}

/** The eight notches of an empty square, as dots. */
function Dots(): ReactElement {
  return (
    <svg viewBox={`0 0 ${String(SQUARE)} ${String(SQUARE)}`} aria-hidden="true" focusable="false">
      {Array.from({ length: 8 }, (_, n) => {
        const { x, y } = notchOffset(n);
        return <circle key={n} cx={x} cy={y} r={3} className="ym-p-dot" />;
      })}
    </svg>
  );
}

/** One square: a tile, the ghost of the tile in hand, or an empty square with its notch dots. */
function Square(props: StageProps & { readonly r: number; readonly c: number }): ReactElement {
  const { view, seat, names, target, ghost, pickable, picked, onPick, r, c } = props;
  const tile = view.board[r]?.[c] ?? null;
  const facing = view.markers.flatMap((marker, who) => {
    const pos = livePosition(marker);
    return pos?.r === r && pos.c === c ? [who] : [];
  });
  const isTarget = target?.r === r && target.c === c;
  const label = squareName(r, c, {
    tile: tile !== null,
    youFace: seat !== null && facing.includes(seat),
    facing: facing.filter((who) => who !== seat).map((who) => names[who] ?? ""),
  });
  const shownGhost = isTarget && tile === null ? ghost : null;
  const art =
    tile === null ? (
      shownGhost === null ? (
        <Dots />
      ) : (
        <TileArt tileId={shownGhost.placed.tileId} rotation={shownGhost.placed.rotation} />
      )
    ) : (
      <TileArt tileId={tile.tileId} rotation={tile.rotation} />
    );
  const common = {
    className: "ym-p-sq",
    "data-r": r,
    "data-c": c,
    "data-target": isTarget && view.phase === "tiles",
    "data-ghost": shownGhost !== null,
  };
  if (pickable(r, c)) {
    return (
      <button
        type="button"
        {...common}
        aria-label={`${label}, choose a notch`}
        aria-pressed={picked?.r === r && picked.c === c}
        data-pickable="true"
        data-selected={picked?.r === r && picked.c === c}
        onClick={() => {
          onPick(r, c);
        }}
      >
        {art}
      </button>
    );
  }
  return (
    <div {...common} role="img" aria-label={label}>
      {art}
    </div>
  );
}

/** The ghost's traces: each moved marker's path, and where it would end. */
function Traces({
  ghost,
  seat,
}: {
  readonly ghost: Ghost;
  readonly seat: Seat | null;
}): ReactElement {
  const { moves, ends } = ghost.preview.movement;
  return (
    <g data-testid="traces">
      {moves.map((move, i) => {
        const d = traceD(hopsOf(move.path));
        const end = ends[i] ?? null;
        const last = move.path[move.path.length - 1];
        const point = last === undefined ? null : pointOf(last);
        return (
          <g
            key={move.seat}
            className="ym-p-trace-group"
            data-seat={move.seat}
            data-yours={move.seat === seat}
          >
            <path d={d} className="ym-p-trace-casing" />
            <path d={d} className="ym-p-trace-halo" />
            <path d={d} className="ym-p-trace" stroke={lookOf(move.seat).fill} />
            {point !== null &&
              (end === null ? (
                <g transform={`translate(${String(point.x)} ${String(point.y)})`} data-out="true">
                  <path d="M-9 -9 L9 9 M9 -9 L-9 9" className="ym-p-crash" />
                  <path d="M-9 -9 L9 9 M9 -9 L-9 9" className="ym-p-crash-light" />
                </g>
              ) : (
                <g transform={`translate(${String(point.x)} ${String(point.y)})`}>
                  <Marker seat={move.seat} ghost />
                </g>
              ))}
          </g>
        );
      })}
    </g>
  );
}

export function Stage(props: StageProps): ReactElement {
  const { view, seat, ghost, shown, picked, aim, free } = props;
  const size = view.boardSize;
  const units = size * SQUARE;
  const squares = Array.from({ length: size * size }, (_, i) => ({
    r: Math.floor(i / size),
    c: i % size,
  }));
  const pickedNotches = picked === null ? [] : edgeNotchesOf(size, picked.r, picked.c);
  return (
    <div className="ym-p-stage">
      <div className="ym-p-grid" role="group" aria-label="Board">
        {squares.map(({ r, c }) => (
          <Square key={`${String(r)},${String(c)}`} {...props} r={r} c={c} />
        ))}
      </div>
      <svg
        className="ym-p-over"
        viewBox={`0 0 ${String(units)} ${String(units)}`}
        aria-hidden="true"
        focusable="false"
      >
        {ghost !== null && <Traces ghost={ghost} seat={seat} />}
        {picked !== null &&
          pickedNotches.map((n) => {
            const point = pointOf({ r: picked.r, c: picked.c, n });
            return (
              <circle
                key={n}
                cx={point.x}
                cy={point.y}
                r={aim === n ? 9 : 6}
                className="ym-p-notch-dot"
                data-free={free({ r: picked.r, c: picked.c, n })}
                data-aim={aim === n}
              />
            );
          })}
        {view.markers.map((marker, who) => {
          const pos = livePosition(marker);
          const point = shown?.get(who) ?? (pos === null ? null : pointOf(pos));
          return point === null ? null : (
            <g key={who} transform={`translate(${String(point.x)} ${String(point.y)})`}>
              <Marker seat={who} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
