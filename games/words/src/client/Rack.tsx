/**
 * The viewer's rack (docs/spec/07-frontend.md §2): tiles at least 44 pt across, in an order the
 * player chooses. Tap a tile to select it, or drag it; the table decides what that does.
 */
import type { PointerEvent, ReactElement, RefObject } from "react";

import { tileName } from "./text.js";
import { TileFace } from "./Tile.js";

export function Rack({
  container,
  ...props
}: {
  readonly tiles: readonly string[];
  /** The ids (indexes into `tiles`) still on the rack, in shown order. */
  readonly ids: readonly number[];
  readonly points: (tile: string) => number;
  readonly selected: number | null;
  /** A tile from the board is selected: offer to take it back. */
  readonly canReturn: boolean;
  readonly container: RefObject<HTMLDivElement | null>;
  readonly onTap: (id: number) => void;
  readonly onReturn: () => void;
  readonly onTileDown: (id: number, event: PointerEvent<HTMLElement>) => void;
}): ReactElement {
  return (
    <div ref={container} className="ym-w-rack" role="group" aria-label="Your rack">
      {props.ids.map((id) => {
        const tile = props.tiles[id] ?? "";
        const points = props.points(tile);
        return (
          <button
            key={id}
            type="button"
            className="ym-w-tile"
            data-rack-id={id}
            data-blank={tile === "?"}
            data-selected={props.selected === id}
            aria-pressed={props.selected === id}
            aria-label={tileName(tile, points)}
            onClick={() => {
              props.onTap(id);
            }}
            onPointerDown={(event) => {
              props.onTileDown(id, event);
            }}
          >
            <TileFace tile={tile} points={points} />
          </button>
        );
      })}
      {props.canReturn && (
        <button type="button" className="ym-w-return" onClick={props.onReturn}>
          Return tile to rack
        </button>
      )}
      {props.ids.length === 0 && !props.canReturn && (
        <span className="ym-w-meta">All your tiles are on the board.</span>
      )}
    </div>
  );
}
