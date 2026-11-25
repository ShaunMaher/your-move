/**
 * The finished game as the module shows it (docs/spec/games/words.md §6, §7, §10.4): how it ended,
 * the final-scoring adjustments and every player's last rack. Ranks and the winner are the
 * shell's finished screen.
 */
import type { ReactElement } from "react";

import { tilePoints, type Ruleset, type View } from "../engine/index.js";
import { plural, tileName } from "./text.js";
import { TileFace } from "./Tile.js";

type Final = NonNullable<View["final"]>;

/** One line saying how the game ended. */
function endText(final: Final, last: View["lastMove"], names: readonly string[]): string {
  const who = last === null ? "A player" : (names[last.seat] ?? "A player");
  switch (final.reason) {
    case "out":
      return `${who} used their last tile. The game is over.`;
    case "scoreless":
      return "Too many turns in a row scored nothing. The game is over.";
    case "resign":
      return `${who} resigned. The game is over.`;
    case "timeout":
      return `${who} ran out of time. The game is over.`;
    case "decline":
      return `${who} declined the game.`;
  }
}

function adjustment(points: number): string {
  if (points === 0) return "no change";
  return `${points > 0 ? "+" : "−"}${plural(Math.abs(points), "point", "points")}`;
}

export function FinalSummary(props: {
  readonly view: View;
  readonly final: Final;
  readonly ruleset: Ruleset;
  readonly names: readonly string[];
}): ReactElement {
  const { view, final, ruleset, names } = props;
  const scored = final.reason === "out" || final.reason === "scoreless";
  return (
    <section className="ym-w-final" aria-label="Game over">
      <h2>{endText(final, view.lastMove, names)}</h2>
      <ul>
        {names.map((name, seat) => {
          const rack = final.racks[seat] ?? [];
          return (
            <li key={seat}>
              <strong>{name}</strong>: {String(view.scores[seat] ?? 0)}
              {scored && ` (tiles left: ${adjustment(final.adjustments[seat] ?? 0)})`}
              {rack.length > 0 && (
                <span
                  className="ym-w-racks"
                  role="img"
                  aria-label={`Tiles left: ${rack.map((t) => tileName(t, tilePoints(ruleset, t))).join("; ")}`}
                >
                  {rack.map((tile, i) => (
                    <span key={i} className="ym-w-mini">
                      <span className="ym-w-tile" data-blank={tile === "?"}>
                        <TileFace tile={tile} points={tilePoints(ruleset, tile)} />
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
