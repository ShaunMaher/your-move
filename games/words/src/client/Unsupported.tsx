/** What a browser without constructable stylesheets sees instead of the board (07 §1). */
import type { ReactElement } from "react";

export function Unsupported(): ReactElement {
  return <p role="alert">Please update your browser to play.</p>;
}
