/**
 * The board's squares with zoom and pan (docs/spec/07-frontend.md §2): a square frame that holds a
 * grid scaled by a CSS transform (not browser zoom), pinch and double-tap to zoom, one finger to
 * pan once zoomed, plus plain zoom buttons. Every square is a labelled button reachable with the
 * arrow keys; the board itself never decides what a tap or a drop means (the table does).
 */
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type RefObject,
} from "react";

import { premiumAt, tilePoints, type Ruleset, type View } from "../engine/index.js";
import {
  distance,
  FIT,
  midpoint,
  panBy,
  revealSquare,
  TAP_SCALE,
  zoomAround,
  type Point,
  type Viewport,
} from "./geometry.js";
import { squareKey, type Put } from "./tentative.js";
import { tileName } from "./text.js";
import { TileFace } from "./Tile.js";

/** What a premium square says on its face: letters ×2 or ×3, whole words ×2 or ×3. */
const PREMIUM_LABEL = { DL: "2L", TL: "3L", DW: "2W", TW: "3W" } as const;

const PREMIUM_NAME = {
  DL: "double letter",
  TL: "triple letter",
  DW: "double word",
  TW: "triple word",
} as const;

/** What the table tells the grid to draw. */
export interface GridProps {
  readonly ruleset: Ruleset;
  readonly board: View["board"];
  /** Tentative tiles by square key, with their rack tile and letter. */
  readonly placed: Readonly<Record<string, { put: Put; tile: string }>>;
  /** Squares of the last play, highlighted. */
  readonly last: ReadonlySet<string>;
  readonly selected: string | null;
  /** Whether a selected tile is waiting for a square. */
  readonly holding: boolean;
  readonly viewport: Viewport;
  readonly onViewport: (viewport: Viewport) => void;
  readonly frame: RefObject<HTMLDivElement | null>;
  readonly onSquare: (key: string) => void;
  readonly onReturn: (key: string) => void;
  readonly onTileDown: (key: string, event: PointerEvent<HTMLElement>) => void;
  /** The square a drag would drop on, shown with an outline. */
  readonly dropTarget: string | null;
}

const DOUBLE_TAP_MS = 300;
const TAP_SLOP = 8;

export function BoardGrid({ frame, ...props }: GridProps): ReactElement {
  const { ruleset, board, viewport } = props;
  const size = ruleset.boardSize;
  const [focus, setFocus] = useState<string>(squareKey(ruleset.start[0], ruleset.start[1]));
  const [active, setActive] = useState(false);

  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const suppress = useRef(false);

  // Pinch, pan and double-tap are native listeners: the frame is not an interactive element.
  useEffect(() => {
    const element = frame.current;
    if (element === null) return;
    const pointers = new Map<number, Point>();
    let pinch: { dist: number; mid: Point; from: Viewport } | null = null;
    let pan: { last: Point; moved: number } | null = null;
    let lastTap: { at: number; point: Point } | null = null;
    const rect = (): DOMRect => element.getBoundingClientRect();
    const local = (event: { clientX: number; clientY: number }): Point => ({
      x: event.clientX - rect().left,
      y: event.clientY - rect().top,
    });
    const settle = (): void => {
      pinch = null;
      pan = null;
      setActive(false);
    };
    function down(event: globalThis.PointerEvent): void {
      if (event.target instanceof Element && event.target.closest("[data-drag]") !== null) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const { viewport: now } = latest.current;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        if (a !== undefined && b !== undefined) {
          pinch = { dist: distance(a, b) || 1, mid: midpoint(a, b), from: now };
          pan = null;
          setActive(true);
        }
      } else if (pointers.size === 1) {
        pan = { last: { x: event.clientX, y: event.clientY }, moved: 0 };
      }
    }
    function move(event: globalThis.PointerEvent): void {
      if (!pointers.has(event.pointerId)) return;
      const point = { x: event.clientX, y: event.clientY };
      pointers.set(event.pointerId, point);
      const frameSize = rect().width;
      const { onViewport, viewport: now } = latest.current;
      if (pointers.size >= 2 && pinch !== null) {
        const [a, b] = [...pointers.values()];
        if (a === undefined || b === undefined) return;
        const origin = { x: pinch.mid.x - rect().left, y: pinch.mid.y - rect().top };
        const zoomed = zoomAround(
          pinch.from,
          frameSize,
          origin,
          (pinch.from.scale * distance(a, b)) / pinch.dist,
        );
        const mid = midpoint(a, b);
        onViewport(panBy(zoomed, frameSize, mid.x - pinch.mid.x, mid.y - pinch.mid.y));
        suppress.current = true;
      } else if (pan !== null) {
        const dx = point.x - pan.last.x;
        const dy = point.y - pan.last.y;
        pan.moved += Math.abs(dx) + Math.abs(dy);
        pan.last = point;
        if (now.scale > 1 && pan.moved > TAP_SLOP) {
          setActive(true);
          suppress.current = true;
          onViewport(panBy(now, frameSize, dx, dy));
        }
      }
    }
    function up(event: globalThis.PointerEvent): void {
      if (!pointers.delete(event.pointerId)) return;
      const tapped = pointers.size === 0 && pan !== null && pan.moved <= TAP_SLOP && pinch === null;
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 0) {
        const { viewport: now, onViewport, holding } = latest.current;
        const point = local(event);
        if (tapped && !holding) {
          const again =
            lastTap !== null &&
            event.timeStamp - lastTap.at < DOUBLE_TAP_MS &&
            distance(lastTap.point, point) < 3 * TAP_SLOP;
          if (again) {
            const frameSize = rect().width;
            onViewport(now.scale > 1 ? FIT : zoomAround(now, frameSize, point, TAP_SCALE));
            lastTap = null;
          } else {
            lastTap = { at: event.timeStamp, point };
          }
        }
        settle();
        // A drag or pinch ends with a click on a square that nobody meant.
        if (suppress.current) setTimeout(() => (suppress.current = false), 0);
      }
    }
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
    };
  }, [frame]);

  const zoomBy = (factor: number): void => {
    const frameSize = frame.current?.getBoundingClientRect().width ?? 0;
    const centre = { x: frameSize / 2, y: frameSize / 2 };
    props.onViewport(zoomAround(viewport, frameSize, centre, viewport.scale * factor));
  };

  function onKey(event: KeyboardEvent<HTMLButtonElement>, row: number, col: number): void {
    const key = squareKey(row, col);
    const step = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = squareKey(
        Math.min(size - 1, Math.max(0, row + (step[0] ?? 0))),
        Math.min(size - 1, Math.max(0, col + (step[1] ?? 0))),
      );
      setFocus(next);
      frame.current
        ?.querySelector<HTMLElement>(`[data-square="${next}"]`)
        ?.focus({ preventScroll: true });
    } else if ((event.key === "Backspace" || event.key === "Delete") && key in props.placed) {
      event.preventDefault();
      props.onReturn(key);
    }
  }

  return (
    <>
      <div
        ref={frame}
        className="ym-w-frame"
        role="group"
        aria-label={`Board, ${String(size)} by ${String(size)}`}
      >
        <div
          className="ym-w-grid"
          data-gesture={active}
          style={{
            gridTemplateColumns: `repeat(${String(size)}, minmax(0, 1fr))`,
            gridTemplateRows: `repeat(${String(size)}, minmax(0, 1fr))`,
            transform: `translate(${String(viewport.x)}px, ${String(viewport.y)}px) scale(${String(viewport.scale)})`,
          }}
        >
          {board.map((line, row) =>
            line.map((square, col) => {
              const key = squareKey(row, col);
              const put = props.placed[key];
              const premium =
                square === null && put === undefined ? premiumAt(ruleset, row, col) : null;
              const isStart = ruleset.start[0] === row && ruleset.start[1] === col;
              const tile = square?.tile ?? put?.tile ?? null;
              const letter = square?.letter ?? put?.put.letter;
              const points = tile === null ? 0 : tilePoints(ruleset, tile);
              const where = `Row ${String(row + 1)}, column ${String(col + 1)}`;
              const what =
                tile === null
                  ? [
                      premium === null ? null : `${PREMIUM_LABEL[premium]}, ${PREMIUM_NAME[premium]}`,
                      isStart ? "start square" : null,
                      "empty",
                    ]
                      .filter((part) => part !== null)
                      .join(", ")
                  : [
                      tileName(tile, points, tile === "?" ? letter : undefined),
                      put === undefined ? null : "your tile, not played yet",
                      props.last.has(key) ? "last play" : null,
                    ]
                      .filter((part) => part !== null)
                      .join(", ");
              return (
                <button
                  key={key}
                  type="button"
                  className="ym-w-sq"
                  data-square={key}
                  data-drag={put === undefined ? undefined : ""}
                  data-premium={premium ?? undefined}
                  data-target={props.dropTarget === key}
                  tabIndex={focus === key ? 0 : -1}
                  aria-label={`${where}, ${what}`}
                  aria-pressed={put === undefined ? undefined : props.selected === key}
                  onFocus={() => {
                    setFocus(key);
                    const frameSize = frame.current?.getBoundingClientRect().width ?? 0;
                    const next = revealSquare(viewport, frameSize, size, row, col);
                    if (next !== viewport) props.onViewport(next);
                  }}
                  onKeyDown={(event) => {
                    onKey(event, row, col);
                  }}
                  onClick={() => {
                    if (!suppress.current) props.onSquare(key);
                  }}
                  onPointerDown={(event) => {
                    if (put !== undefined) props.onTileDown(key, event);
                  }}
                >
                  {tile === null ? (
                    <span aria-hidden="true" className="ym-w-face">
                      {isStart && <span className="ym-w-start" />}
                      {premium !== null && <span>{PREMIUM_LABEL[premium]}</span>}
                    </span>
                  ) : (
                    <span
                      className="ym-w-tile"
                      data-blank={tile === "?"}
                      data-state={
                        put !== undefined ? "placed" : props.last.has(key) ? "last" : undefined
                      }
                      data-selected={props.selected === key}
                    >
                      <TileFace tile={tile} points={points} letter={letter} />
                    </span>
                  )}
                </button>
              );
            }),
          )}
        </div>
      </div>
      <div className="ym-w-toolbar" role="group" aria-label="Board zoom">
        <span className="ym-w-meta">Pinch or double-tap to zoom</span>
        <button
          type="button"
          aria-label="Zoom out"
          disabled={viewport.scale <= 1}
          onClick={() => {
            zoomBy(1 / 1.5);
          }}
        >
          {"−"}
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => {
            zoomBy(1.5);
          }}
        >
          +
        </button>
      </div>
    </>
  );
}
