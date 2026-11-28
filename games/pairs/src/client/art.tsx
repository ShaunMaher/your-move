/**
 * The card artwork (docs/spec/games/pairs.md §1, §9): the 18 faces and the card back, original
 * drawings as SVG React elements. Each face is told apart by its shape; colour is decoration. The
 * drawings are decorative and `aria-hidden` (the card's button carries its name), and take their
 * colours from the board's tokens, so a face follows the theme (styles.ts).
 *
 * Classes: `ym-pr-k1`..`k4` fill with a palette colour, `ym-pr-ink` fills with the ink colour,
 * `ym-pr-line` strokes a thin ink line, `ym-pr-s1`..`s4` stroke a thick palette line. Nothing
 * here is keyed or named by anything but the face id, and only a card the view shows face up draws
 * one (Board.tsx).
 */
import type { ReactElement } from "react";

import { FACE_COUNT } from "../engine/index.js";

/** The drawing of each face in a 48 × 48 box, by face id (pairs §1). */
const DRAWINGS: readonly (() => ReactElement)[] = [
  // 0 acorn
  () => (
    <>
      <path className="ym-pr-k4 ym-pr-line" d="M15 24 Q15 41 24 43 Q33 41 33 24 Z" />
      <path className="ym-pr-k1 ym-pr-line" d="M12 25 Q12 12 24 12 Q36 12 36 25 Z" />
      <path className="ym-pr-line" d="M24 12 L24 5" />
    </>
  ),
  // 1 apple: whole, with a leaf and no bite
  () => (
    <>
      <path
        className="ym-pr-k1 ym-pr-line"
        d="M24 15 C16 8 7 14 8 27 C9 39 17 44 24 41 C31 44 39 39 40 27 C41 14 32 8 24 15 Z"
      />
      <path className="ym-pr-line" d="M24 15 L25 7" />
      <path className="ym-pr-k3 ym-pr-line" d="M26 11 Q33 3 40 8 Q33 15 26 11 Z" />
    </>
  ),
  // 2 bell
  () => (
    <>
      <path
        className="ym-pr-k4 ym-pr-line"
        d="M10 35 Q14 31 14 23 Q14 11 24 11 Q34 11 34 23 Q34 31 38 35 Z"
      />
      <path className="ym-pr-line" d="M24 11 L24 6" />
      <circle className="ym-pr-ink" cx="24" cy="39" r="3.5" />
    </>
  ),
  // 3 boat
  () => (
    <>
      <path className="ym-pr-line" d="M24 6 L24 31" />
      <path className="ym-pr-k1 ym-pr-line" d="M27 8 L41 28 L27 28 Z" />
      <path className="ym-pr-k3 ym-pr-line" d="M21 14 L9 28 L21 28 Z" />
      <path className="ym-pr-k2 ym-pr-line" d="M5 31 L43 31 L37 41 L11 41 Z" />
    </>
  ),
  // 4 cat
  () => (
    <>
      <path className="ym-pr-k4 ym-pr-line" d="M9 24 L9 6 L22 14 Z" />
      <path className="ym-pr-k4 ym-pr-line" d="M39 24 L39 6 L26 14 Z" />
      <ellipse className="ym-pr-k4 ym-pr-line" cx="24" cy="28" rx="16" ry="14" />
      <circle className="ym-pr-ink" cx="18" cy="25" r="2.4" />
      <circle className="ym-pr-ink" cx="30" cy="25" r="2.4" />
      <path className="ym-pr-k1 ym-pr-line" d="M21 31 L27 31 L24 35 Z" />
      <path className="ym-pr-line" d="M4 29 L14 31 M4 36 L14 34 M44 29 L34 31 M44 36 L34 34" />
    </>
  ),
  // 5 cloud
  () => (
    <path
      className="ym-pr-k2 ym-pr-line"
      d="M14 37 Q4 37 6 28 Q8 21 15 23 Q16 12 26 12 Q36 12 37 23 Q44 23 43 31 Q42 37 36 37 Z"
    />
  ),
  // 6 fish
  () => (
    <>
      <path className="ym-pr-k1 ym-pr-line" d="M34 24 L45 13 L45 35 Z" />
      <ellipse className="ym-pr-k2 ym-pr-line" cx="21" cy="24" rx="17" ry="11" />
      <path className="ym-pr-k4 ym-pr-line" d="M18 14 L24 7 L28 15 Z" />
      <circle className="ym-pr-ink" cx="11" cy="21" r="2.2" />
    </>
  ),
  // 7 flower
  () => (
    <>
      <path className="ym-pr-line" d="M24 26 L24 45" />
      <path className="ym-pr-k3 ym-pr-line" d="M24 38 Q32 30 39 33 Q33 41 24 38 Z" />
      <circle className="ym-pr-k1 ym-pr-line" cx="24" cy="10" r="6" />
      <circle className="ym-pr-k1 ym-pr-line" cx="33" cy="17" r="6" />
      <circle className="ym-pr-k1 ym-pr-line" cx="30" cy="27" r="6" />
      <circle className="ym-pr-k1 ym-pr-line" cx="18" cy="27" r="6" />
      <circle className="ym-pr-k1 ym-pr-line" cx="15" cy="17" r="6" />
      <circle className="ym-pr-k4 ym-pr-line" cx="24" cy="20" r="6" />
    </>
  ),
  // 8 house
  () => (
    <>
      <rect className="ym-pr-k4 ym-pr-line" x="10" y="22" width="28" height="21" />
      <path className="ym-pr-k1 ym-pr-line" d="M5 24 L24 7 L43 24 Z" />
      <rect className="ym-pr-k2 ym-pr-line" x="20" y="30" width="8" height="13" />
    </>
  ),
  // 9 key
  () => (
    <>
      <circle className="ym-pr-s4" cx="15" cy="15" r="8" fill="none" />
      <path className="ym-pr-s4" d="M21 21 L41 41 M34 34 L40 28 M28 28 L33 23" fill="none" />
    </>
  ),
  // 10 kite
  () => (
    <>
      <path className="ym-pr-k1 ym-pr-line" d="M24 3 L40 19 L24 37 L8 19 Z" />
      <path className="ym-pr-line" d="M24 3 L24 37 M8 19 L40 19" />
      <path className="ym-pr-line" d="M24 37 Q17 40 24 42 Q31 44 24 47" fill="none" />
      <path className="ym-pr-k2 ym-pr-line" d="M19 40 L24 42 L19 44 Z" />
    </>
  ),
  // 11 leaf
  () => (
    <>
      <path className="ym-pr-k3 ym-pr-line" d="M7 41 Q5 13 41 7 Q43 37 7 41 Z" />
      <path className="ym-pr-line" d="M7 41 L32 16" />
    </>
  ),
  // 12 moon
  () => <path className="ym-pr-k4 ym-pr-line" d="M31 5 A19 19 0 1 0 43 31 A15 15 0 1 1 31 5 Z" />,
  // 13 snail
  () => (
    <>
      <path className="ym-pr-k3 ym-pr-line" d="M3 41 L40 41 Q45 41 45 36 L20 36 Q11 36 8 28 Z" />
      <path className="ym-pr-line" d="M8 28 L5 19 M11 29 L12 19" />
      <circle className="ym-pr-k4 ym-pr-line" cx="29" cy="23" r="13" />
      <path
        className="ym-pr-line"
        d="M29 23 m0 -2 a2 2 0 1 1 -2 2 a5 5 0 1 1 5 5 a8 8 0 1 1 -8 -8"
        fill="none"
      />
    </>
  ),
  // 14 star
  () => (
    <path
      className="ym-pr-k4 ym-pr-line"
      d="M24 4 L29.9 17.2 L44 18.4 L33.4 27.8 L36.6 41.6 L24 34.4 L11.4 41.6 L14.6 27.8 L4 18.4 L18.1 17.2 Z"
    />
  ),
  // 15 sun
  () => (
    <>
      <path
        className="ym-pr-s1"
        d="M24 3 L24 9 M24 39 L24 45 M3 24 L9 24 M39 24 L45 24 M9 9 L13 13 M35 35 L39 39 M39 9 L35 13 M13 35 L9 39"
        fill="none"
      />
      <circle className="ym-pr-k4 ym-pr-line" cx="24" cy="24" r="10" />
    </>
  ),
  // 16 tree
  () => (
    <>
      <rect className="ym-pr-k1 ym-pr-line" x="21" y="30" width="6" height="15" />
      <circle className="ym-pr-k3 ym-pr-line" cx="24" cy="19" r="14" />
    </>
  ),
  // 17 umbrella
  () => (
    <>
      <path
        className="ym-pr-k1 ym-pr-line"
        d="M3 26 A21 21 0 0 1 45 26 Q40 22 35 26 Q30 22 24 26 Q18 22 13 26 Q8 22 3 26 Z"
      />
      <path className="ym-pr-line" d="M24 26 L24 40 Q24 45 19 44" fill="none" />
    </>
  ),
];

/** The decorative SVG of face `id`; nothing is drawn for an id outside 0–17. */
export function Face({ id }: { readonly id: number }): ReactElement | null {
  const draw = id >= 0 && id < FACE_COUNT ? DRAWINGS[id] : undefined;
  if (draw === undefined) return null;
  return (
    <svg className="ym-pr-art" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      {draw()}
    </svg>
  );
}

/** The card back: the same original pattern on every card, a diamond lattice (pairs §1). */
export function Back(): ReactElement {
  return (
    <svg className="ym-pr-art ym-pr-back" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect className="ym-pr-back-bg" x="0" y="0" width="48" height="48" />
      <path
        className="ym-pr-back-line"
        d="M24 6 L42 24 L24 42 L6 24 Z M24 15 L33 24 L24 33 L15 24 Z"
      />
      <circle className="ym-pr-back-dot" cx="24" cy="24" r="2.5" />
      <circle className="ym-pr-back-dot" cx="5" cy="5" r="2" />
      <circle className="ym-pr-back-dot" cx="43" cy="5" r="2" />
      <circle className="ym-pr-back-dot" cx="5" cy="43" r="2" />
      <circle className="ym-pr-back-dot" cx="43" cy="43" r="2" />
    </svg>
  );
}
