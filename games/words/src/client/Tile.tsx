/**
 * A tile's face: its letter (capital) and its points. A blank shows the letter it stands for. The
 * space between the two is not drawn (the tile is a flex box) but it is in the face's text, "A 1",
 * which the tile's name "A, 1 point" contains (WCAG 2.5.3, label in name).
 */
import type { ReactElement } from "react";

import { shown } from "./text.js";

export function TileFace(props: {
  readonly tile: string;
  readonly points: number;
  readonly letter?: string | undefined;
}): ReactElement {
  const { tile, points, letter } = props;
  return (
    <>
      <span aria-hidden="true">{shown(tile, letter)}</span>{" "}
      {tile !== "?" && <small aria-hidden="true">{points}</small>}
    </>
  );
}
