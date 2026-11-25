/** A tile's face: its letter (capital) and its points. A blank shows the letter it stands for. */
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
      <span aria-hidden="true">{shown(tile, letter)}</span>
      {tile !== "?" && <small aria-hidden="true">{points}</small>}
    </>
  );
}
