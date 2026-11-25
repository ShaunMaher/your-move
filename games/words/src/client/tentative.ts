/**
 * The tiles a player has put on the board but not yet played (docs/spec/07-frontend.md §2): where
 * each rack tile is, in what order the rack is shown, and which blank is waiting for its letter.
 * Pure functions over plain data, so every move of a tile is testable without a browser.
 *
 * Rack tiles are identified by their index in the view's (sorted) `yourRack`, so two tiles of the
 * same letter stay distinct and the shown order survives a reshuffle.
 */
import { BLANK, type Placement } from "../engine/index.js";

/** A rack tile put on a board square; a blank carries the letter it will stand for. */
export interface Put {
  readonly id: number;
  readonly letter?: string;
}

export interface Tentative {
  /** Every rack tile id in the order the rack shows them (placed tiles keep their slot). */
  readonly order: readonly number[];
  /** Placed tiles by square key. */
  readonly placed: Readonly<Record<string, Put>>;
  /** The square of a just-placed blank that has no letter yet (the picker is open). */
  readonly blankFor: string | null;
}

/** Where a tile is picked up from. */
export type Source =
  | { readonly kind: "rack"; readonly id: number }
  | { readonly kind: "square"; readonly key: string };

/** Where a tile is put down: a square, or the rack in front of tile `before` (null: the end). */
export type Target =
  | { readonly kind: "square"; readonly key: string }
  | { readonly kind: "rack"; readonly before: number | null };

export function squareKey(row: number, col: number): string {
  return `${String(row)},${String(col)}`;
}

function parseKey(key: string): { row: number; col: number } {
  const [row = 0, col = 0] = key.split(",").map(Number);
  return { row, col };
}

/** Whether `order` is a permutation of `0..size-1`. */
function isPermutation(order: readonly number[], size: number): boolean {
  return (
    order.length === size &&
    new Set(order).size === size &&
    order.every((id) => Number.isInteger(id) && id >= 0 && id < size)
  );
}

/** A new tentative state for `rack`, in a saved order if it is a valid one for this rack. */
export function initial(
  rack: readonly string[],
  saved: readonly number[] | null = null,
): Tentative {
  const order =
    saved !== null && isPermutation(saved, rack.length) ? [...saved] : rack.map((_, id) => id);
  return { order, placed: {}, blankFor: null };
}

/** The rack tile ids still on the rack, in shown order. */
export function onRack(t: Tentative): number[] {
  const used = new Set(Object.values(t.placed).map((put) => put.id));
  return t.order.filter((id) => !used.has(id));
}

function without(placed: Tentative["placed"], key: string): Tentative["placed"] {
  return Object.fromEntries(Object.entries(placed).filter(([k]) => k !== key));
}

/**
 * Picks a tile up and puts it down. A square must be empty (the caller has checked the board); a
 * tile put on a rack square is returned; a blank put on a square waits for its letter.
 */
export function move(
  t: Tentative,
  rack: readonly string[],
  source: Source,
  target: Target,
): Tentative {
  const picked =
    source.kind === "rack" ? ({ id: source.id } satisfies Put) : (t.placed[source.key] ?? null);
  if (picked === null) return t;
  const from = source.kind === "square" ? source.key : null;
  if (target.kind === "square") {
    if (target.key === from || Object.hasOwn(t.placed, target.key)) return t;
    const isBlank = rack[picked.id] === BLANK;
    // A blank keeps its letter when moved; one from the rack asks for its letter.
    const put: Put = source.kind === "square" ? picked : { id: picked.id };
    const placed = { ...(from === null ? t.placed : without(t.placed, from)), [target.key]: put };
    const asks = isBlank && put.letter === undefined;
    return { ...t, placed, blankFor: asks ? target.key : t.blankFor };
  }
  if (from !== null) {
    const order = t.order.filter((id) => id !== picked.id);
    return {
      ...t,
      placed: without(t.placed, from),
      order: insertBefore(order, picked.id, target.before),
      blankFor: t.blankFor === from ? null : t.blankFor,
    };
  }
  // A rack tile dropped on the rack is only reordered.
  if (target.before === picked.id) return t;
  return {
    ...t,
    order: insertBefore(
      t.order.filter((id) => id !== picked.id),
      picked.id,
      target.before,
    ),
  };
}

function insertBefore(order: readonly number[], id: number, before: number | null): number[] {
  const at = before === null ? -1 : order.indexOf(before);
  return at === -1 ? [...order, id] : [...order.slice(0, at), id, ...order.slice(at)];
}

/** Gives the waiting blank its letter. */
export function setBlankLetter(t: Tentative, letter: string): Tentative {
  const key = t.blankFor;
  const put = key === null ? undefined : t.placed[key];
  if (key === null || put === undefined) return t;
  return { ...t, placed: { ...t.placed, [key]: { ...put, letter } }, blankFor: null };
}

/** Takes the waiting blank back to the rack: the picker was dismissed. */
export function cancelBlank(t: Tentative): Tentative {
  const key = t.blankFor;
  return key === null ? t : { ...t, placed: without(t.placed, key), blankFor: null };
}

/** Returns every placed tile to the rack. */
export function recall(t: Tentative): Tentative {
  return { ...t, placed: {}, blankFor: null };
}

/** The rack in a new order (a shuffle); placed tiles stay where they are. */
export function reorder(t: Tentative, order: readonly number[]): Tentative {
  return { ...t, order };
}

/** The play the placed tiles make, in board order; a blank still without a letter is left out. */
export function toPlacements(t: Tentative, rack: readonly string[]): Placement[] {
  return Object.entries(t.placed)
    .flatMap(([key, put]): Placement[] => {
      const tile = rack[put.id];
      if (tile === undefined || (tile === BLANK && put.letter === undefined)) return [];
      const { row, col } = parseKey(key);
      return [
        put.letter === undefined ? { row, col, tile } : { row, col, tile, letter: put.letter },
      ];
    })
    .sort((a, b) => a.row - b.row || a.col - b.col);
}

/** How many tiles are placed on the board. */
export function placedCount(t: Tentative): number {
  return Object.keys(t.placed).length;
}

/**
 * Carries the tentative tiles over to a new view of the game (an opponent played, a refetch):
 * the rack order is rebuilt against the new rack by tile, a placed tile stays if its square is
 * still empty and the rack still holds that tile, and a tile that can't be matched goes back to
 * the rack. Nothing is lost that the new view doesn't force.
 */
export function reconcile(
  t: Tentative,
  before: readonly string[],
  rack: readonly string[],
  isOccupied: (key: string) => boolean,
): Tentative {
  const free = rack.map((_, id) => id);
  const carried = new Map<number, number>();
  for (const old of t.order) {
    const tile = before[old];
    const at = tile === undefined ? -1 : free.findIndex((id) => rack[id] === tile);
    const [id] = at === -1 ? [] : free.splice(at, 1);
    if (id !== undefined) carried.set(old, id);
  }
  const placed: Record<string, Put> = {};
  for (const [key, put] of Object.entries(t.placed)) {
    const id = carried.get(put.id);
    if (id === undefined || isOccupied(key)) continue;
    placed[key] = put.letter === undefined ? { id } : { id, letter: put.letter };
  }
  const order = [...t.order.flatMap((old) => carried.get(old) ?? []), ...free];
  const blankFor = t.blankFor !== null && t.blankFor in placed ? t.blankFor : null;
  return { order, placed, blankFor };
}
