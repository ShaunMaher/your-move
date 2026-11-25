/**
 * Board geometry for zoom, pan and drag (docs/spec/07-frontend.md §2): pure functions over the
 * viewport transform, so the gestures can be tested without a browser.
 */

/** How far the board is zoomed and where it sits inside its square frame (CSS pixels). */
export interface Viewport {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** The zoom a double tap or a hovering drag goes to. */
export const TAP_SCALE = 2.5;

export const FIT: Viewport = { scale: MIN_SCALE, x: 0, y: 0 };

/** A point in the board frame's own coordinates (CSS pixels from its top-left corner). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Keeps the board covering its frame: zoomed between the limits and never panned off an edge. */
export function clampViewport(viewport: Viewport, frame: number): Viewport {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, viewport.scale));
  const lowest = frame * (1 - scale);
  return {
    scale,
    x: Math.min(0, Math.max(lowest, viewport.x)),
    y: Math.min(0, Math.max(lowest, viewport.y)),
  };
}

/** Zooms to `scale`, keeping the board point under `around` where it is. */
export function zoomAround(
  viewport: Viewport,
  frame: number,
  around: Point,
  scale: number,
): Viewport {
  const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const ratio = next / viewport.scale;
  return clampViewport(
    {
      scale: next,
      x: around.x - (around.x - viewport.x) * ratio,
      y: around.y - (around.y - viewport.y) * ratio,
    },
    frame,
  );
}

/** Moves the board by a drag of `dx`, `dy`. */
export function panBy(viewport: Viewport, frame: number, dx: number, dy: number): Viewport {
  return clampViewport({ ...viewport, x: viewport.x + dx, y: viewport.y + dy }, frame);
}

/** The square under a point of the frame, or null outside the board. */
export function squareAtPoint(
  viewport: Viewport,
  frame: number,
  size: number,
  point: Point,
): { row: number; col: number } | null {
  if (frame <= 0) return null;
  const cell = (frame * viewport.scale) / size;
  const col = Math.floor((point.x - viewport.x) / cell);
  const row = Math.floor((point.y - viewport.y) / cell);
  const inside = point.x >= 0 && point.y >= 0 && point.x < frame && point.y < frame;
  return inside && row >= 0 && col >= 0 && row < size && col < size ? { row, col } : null;
}

/**
 * The empty square nearest to a drop point, within two squares of it, or null if there is none.
 * Ties go to the earlier row, then column, so a drop never depends on iteration luck.
 */
export function nearestEmpty(
  row: number,
  col: number,
  size: number,
  isEmpty: (row: number, col: number) => boolean,
): { row: number; col: number } | null {
  const reach = 2;
  let best: { row: number; col: number; distance: number } | null = null;
  for (let r = Math.max(0, row - reach); r <= Math.min(size - 1, row + reach); r += 1) {
    for (let c = Math.max(0, col - reach); c <= Math.min(size - 1, col + reach); c += 1) {
      const distance = (r - row) ** 2 + (c - col) ** 2;
      if (
        distance <= reach * reach &&
        isEmpty(r, c) &&
        (best === null || distance < best.distance)
      ) {
        best = { row: r, col: c, distance };
      }
    }
  }
  return best === null ? null : { row: best.row, col: best.col };
}

/** The distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The point halfway between two points. */
export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Pans the board just far enough that a square is inside the frame; the same viewport if it is. */
export function revealSquare(
  viewport: Viewport,
  frame: number,
  size: number,
  row: number,
  col: number,
): Viewport {
  const cell = (frame * viewport.scale) / size;
  const left = col * cell + viewport.x;
  const top = row * cell + viewport.y;
  const dx = left < 0 ? -left : left + cell > frame ? frame - cell - left : 0;
  const dy = top < 0 ? -top : top + cell > frame ? frame - cell - top : 0;
  return dx === 0 && dy === 0 ? viewport : panBy(viewport, frame, dx, dy);
}
