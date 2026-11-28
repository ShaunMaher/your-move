/**
 * The game's original art (paths §8), drawn as SVG from the tiles' path data so there are no
 * image assets and every colour comes from the theme's tokens: tiles show their four paths, and
 * each marker is told apart by its shape as well as its colour.
 */
import type { ReactElement } from "react";

import { pairD, placedPairs, SQUARE } from "./layout.js";

/** A marker's look: its colour's name and value, and its shape's name and drawing. */
export interface MarkerLook {
  readonly colour: string;
  readonly fill: string;
  readonly shape: string;
  /** SVG path data around the origin, within a radius of `R`. */
  readonly d: string;
}

/** The marker's radius in board units: under half the distance between a notch's neighbours. */
const R = 13;

/** A regular polygon with `sides` corners, one pointing up, as path data. */
function polygon(sides: number, radius: number, turn = 0): string {
  const corners = Array.from({ length: sides }, (_, i) => {
    const angle = turn + (i * 2 * Math.PI) / sides - Math.PI / 2;
    return `${(radius * Math.cos(angle)).toFixed(2)} ${(radius * Math.sin(angle)).toFixed(2)}`;
  });
  return `M${corners.join(" L")}Z`;
}

/** A five-pointed star as path data. */
function star(radius: number): string {
  const points = Array.from({ length: 10 }, (_, i) => {
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const length = i % 2 === 0 ? radius : radius * 0.45;
    return `${(length * Math.cos(angle)).toFixed(2)} ${(length * Math.sin(angle)).toFixed(2)}`;
  });
  return `M${points.join(" L")}Z`;
}

const CIRCLE = `M${String(-R)} 0 a${String(R)} ${String(R)} 0 1 0 ${String(2 * R)} 0 a${String(R)} ${String(R)} 0 1 0 ${String(-2 * R)} 0Z`;
const HOLE = 5;
const RING = `${CIRCLE} M${String(-HOLE)} 0 a${String(HOLE)} ${String(HOLE)} 0 1 1 ${String(2 * HOLE)} 0 a${String(HOLE)} ${String(HOLE)} 0 1 1 ${String(-2 * HOLE)} 0Z`;
const SQUARE_D = `M${String(-R * 0.85)} ${String(-R * 0.85)} h${String(R * 1.7)} v${String(R * 1.7)} h${String(-R * 1.7)}Z`;
const ARM = R * 0.42;
const CROSS = `M${String(-ARM)} ${String(-R)} h${String(2 * ARM)} v${String(R - ARM)} h${String(R - ARM)} v${String(2 * ARM)} h${String(ARM - R)} v${String(R - ARM)} h${String(-2 * ARM)} v${String(ARM - R)} h${String(ARM - R)} v${String(-2 * ARM)} h${String(R - ARM)}Z`;

/**
 * One look per seat (at most 8, paths §6): colours from the Okabe–Ito set, which stays apart for
 * the common kinds of colour blindness, and shapes that stay apart without colour at all.
 */
const BLUE: MarkerLook = { colour: "blue", fill: "#0072b2", shape: "circle", d: CIRCLE };

export const LOOKS: readonly MarkerLook[] = [
  BLUE,
  { colour: "orange", fill: "#e69f00", shape: "square", d: SQUARE_D },
  { colour: "green", fill: "#009e73", shape: "triangle", d: polygon(3, R * 1.15) },
  { colour: "pink", fill: "#cc79a7", shape: "diamond", d: polygon(4, R * 1.2) },
  { colour: "sky blue", fill: "#56b4e9", shape: "star", d: star(R * 1.2) },
  { colour: "red", fill: "#d55e00", shape: "hexagon", d: polygon(6, R * 1.05) },
  { colour: "yellow", fill: "#f0e442", shape: "cross", d: CROSS },
  { colour: "grey", fill: "#9a9a9a", shape: "ring", d: RING },
];

/** A seat's look; seats past the last (never in a legal game) share the first. */
export function lookOf(seat: number): MarkerLook {
  return LOOKS[seat] ?? BLUE;
}

/** "blue circle": a marker as it is described to someone who can't see its colour or shape. */
export function lookName(seat: number): string {
  const { colour, shape } = lookOf(seat);
  return `${colour} ${shape}`;
}

/**
 * A marker drawn at the origin: a dark and a light outline round the colour, so it shows on a
 * tile of either theme. `ghost` draws it hollow for a place a marker would end.
 */
export function Marker({
  seat,
  ghost = false,
}: {
  readonly seat: number;
  readonly ghost?: boolean;
}): ReactElement {
  const { fill, d } = lookOf(seat);
  return (
    <g className="ym-p-marker" data-seat={seat} data-ghost={ghost}>
      <path d={d} className="ym-p-halo-dark" strokeWidth={8} fillRule="evenodd" />
      <path d={d} className="ym-p-halo-light" strokeWidth={4.5} fillRule="evenodd" />
      <path d={d} fill={fill} fillOpacity={ghost ? 0.35 : 1} fillRule="evenodd" />
    </g>
  );
}

/** A marker on its own, for the player list and the keys. Decorative: its name is beside it. */
export function MarkerIcon({ seat }: { readonly seat: number }): ReactElement {
  return (
    <svg className="ym-p-icon" viewBox="-20 -20 40 40" aria-hidden="true" focusable="false">
      <Marker seat={seat} />
    </svg>
  );
}

/**
 * A tile at a rotation: the notches' four paths, each drawn as a dark casing under a light line so
 * crossings read. In its own `SQUARE`-unit drawing, so it fits a board square or a hand tile.
 */
export function TileArt({
  tileId,
  rotation,
}: {
  readonly tileId: number;
  readonly rotation: number;
}): ReactElement {
  const paths = placedPairs(tileId, rotation).map(pairD);
  return (
    <svg
      className="ym-p-tile"
      viewBox={`0 0 ${String(SQUARE)} ${String(SQUARE)}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect width={SQUARE} height={SQUARE} className="ym-p-tile-body" />
      {paths.map((d, i) => (
        <path key={`c${String(i)}`} d={d} className="ym-p-path-casing" />
      ))}
      {paths.map((d, i) => (
        <path key={`p${String(i)}`} d={d} className="ym-p-path" />
      ))}
    </svg>
  );
}
