/**
 * The blank-letter picker and the swap and pass dialogs (docs/spec/07-frontend.md §2,
 * docs/spec/games/words.md §3.2, §3.3). Resigning is the shell's menu (02 §3); the module has no
 * resign action.
 */
import { useState, type ReactElement } from "react";

import { Dialog } from "./Dialog.js";
import { plural, shown, tileName } from "./text.js";
import { TileFace } from "./Tile.js";

const ALPHABET = Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i));

/** Asks which letter a blank stands for; dismissing it takes the blank back to the rack. */
export function BlankPicker(props: {
  readonly restoreTo: () => HTMLElement | null;
  readonly onPick: (letter: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <Dialog
      title="Choose a letter for the blank"
      onClose={props.onCancel}
      restoreTo={props.restoreTo}
    >
      <div className="ym-w-picker">
        {ALPHABET.map((letter) => (
          <button
            key={letter}
            type="button"
            aria-label={shown(letter)}
            onClick={() => {
              props.onPick(letter);
            }}
          >
            {shown(letter)}
          </button>
        ))}
      </div>
      <div className="ym-w-buttons">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** Picks the rack tiles to swap (words §3.2). */
export function SwapDialog(props: {
  readonly restoreTo: () => HTMLElement | null;
  readonly rack: readonly string[];
  readonly points: (tile: string) => number;
  readonly swapMinBag: number;
  readonly bagCount: number;
  readonly busy: boolean;
  readonly onSwap: (tiles: readonly string[]) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { rack, bagCount, swapMinBag } = props;
  const [chosen, setChosen] = useState<readonly number[]>([]);
  const allowed = bagCount >= swapMinBag;
  const toggle = (id: number): void => {
    setChosen((now) => (now.includes(id) ? now.filter((other) => other !== id) : [...now, id]));
  };
  return (
    <Dialog title="Swap tiles" onClose={props.onCancel} restoreTo={props.restoreTo}>
      {allowed ? (
        <p>Choose the tiles to put back. Swapping scores nothing and ends your turn.</p>
      ) : (
        <p role="status">
          You can swap only while the bag holds at least {plural(swapMinBag, "tile", "tiles")};{" "}
          {bagCount === 0 ? "it is empty" : `it holds ${String(bagCount)}`}.
        </p>
      )}
      <div className="ym-w-pick-tiles" role="group" aria-label="Tiles to swap">
        {rack.map((tile, id) => (
          <button
            key={id}
            type="button"
            className="ym-w-tile"
            data-blank={tile === "?"}
            data-selected={chosen.includes(id)}
            aria-pressed={chosen.includes(id)}
            aria-label={tileName(tile, props.points(tile))}
            disabled={!allowed}
            onClick={() => {
              toggle(id);
            }}
          >
            <TileFace tile={tile} points={props.points(tile)} />
          </button>
        ))}
      </div>
      <div className="ym-w-buttons">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="ym-w-primary"
          disabled={!allowed || chosen.length === 0 || props.busy}
          onClick={() => {
            props.onSwap(chosen.map((id) => rack[id] ?? ""));
          }}
        >
          {chosen.length === 0 ? "Swap" : `Swap ${plural(chosen.length, "tile", "tiles")}`}
        </button>
      </div>
    </Dialog>
  );
}

/** Confirms passing (words §3.3). */
export function PassDialog(props: {
  readonly restoreTo: () => HTMLElement | null;
  readonly busy: boolean;
  readonly onPass: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  return (
    <Dialog title="Pass your turn?" onClose={props.onCancel} restoreTo={props.restoreTo}>
      <p>
        Passing scores nothing and ends your turn. Several scoreless turns in a row end the game.
      </p>
      <div className="ym-w-buttons">
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
        <button type="button" className="ym-w-primary" disabled={props.busy} onClick={props.onPass}>
          Pass
        </button>
      </div>
    </Dialog>
  );
}
