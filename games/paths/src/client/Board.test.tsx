// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GameEnvelope, SubmitResult } from "@your-move/sdk";
import { seededRandom } from "@your-move/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { view as viewOf } from "../engine/present.js";
import { placeTile, type State } from "../engine/state.js";
import { envelope, facing, game, noRandom, out, placedFor, STRAIGHT } from "../test-support.js";
import "./dom-setup.js";
import { Board } from "./Board.js";
import { FRAME_MS } from "./plan.js";

const NAMES = ["Ann", "Bo"];
const KILLER = { tileId: 0, rotation: 0 };
const SAFE = placedFor(STRAIGHT);
/** Hands are kept ascending, so Ann's hand is the killer (0), tile 20 and the straight one. */
const SENT: SubmitResult = { ok: true, game: envelope(NAMES, 0), view: null };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

/** Ann faces (0, 2) from its top edge, left notch; Bo waits on the bottom edge. */
function fresh(fields: Partial<Parameters<typeof game>[0]> = {}): State {
  return game({
    markers: [facing(0, 2, 0), facing(5, 4, 4)],
    hands: [
      [KILLER.tileId, SAFE.tileId, 20],
      [21, 22, 23],
    ],
    ...fields,
  });
}

interface Shell {
  submit?: SubmitResult | Error;
  viewer?: number | null;
  yourTurn?: boolean;
  status?: GameEnvelope["status"];
  gameVersion?: number;
  options?: unknown;
  names?: (string | null)[];
}

function setup(state: State = fresh(), shell: Shell = {}) {
  const viewer = shell.viewer === undefined ? 0 : shell.viewer;
  const submit = vi.fn(() =>
    shell.submit instanceof Error
      ? Promise.reject(shell.submit)
      : Promise.resolve(shell.submit ?? SENT),
  );
  const preview = vi.fn(() => Promise.resolve(null));
  const base = envelope(shell.names ?? NAMES, viewer, {
    yourTurn: shell.yourTurn ?? viewer === state.turn,
    toAct: state.turn === null ? [] : [state.turn],
    options: shell.options ?? state.options,
    ...(shell.status === undefined ? {} : { status: shell.status }),
    ...(shell.gameVersion === undefined ? {} : { gameVersion: shell.gameVersion }),
  });
  const ui = (version: number, next: State = state) => (
    <Board
      game={{
        ...base,
        version,
        toAct: next.turn === null ? [] : [next.turn],
        yourTurn: shell.yourTurn ?? viewer === next.turn,
      }}
      view={viewOf(next, viewer)}
      submit={submit}
      preview={preview}
    />
  );
  const result = render(ui(3));
  return {
    submit,
    ...result,
    rerenderAt: (version: number, next: State) => {
      result.rerender(ui(version, next));
    },
  };
}

/** Runs `step` and lets the promises it starts (a submit's answer) settle. */
async function settle(step: () => void): Promise<void> {
  await act(async () => {
    step();
    await Promise.resolve();
  });
}

const tile = (index: number): HTMLElement => {
  const found = within(screen.getByRole("group", { name: "Your hand" })).getAllByRole("button")[
    index
  ];
  if (found === undefined) throw new Error("no such tile");
  return found;
};
const button = (name: string | RegExp): HTMLElement => screen.getByRole("button", { name });
const squareAt = (r: number, c: number): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[data-r="${String(r)}"][data-c="${String(c)}"]`,
  );
  if (found === null) throw new Error("no such square");
  return found;
};
const status = (): string => screen.getByRole("status").textContent;
const markerPoint = (seat: number): string | null =>
  document
    .querySelector(`.ym-p-over > g > .ym-p-marker[data-seat="${String(seat)}"]`)
    ?.parentElement?.getAttribute("transform") ?? null;

describe("the table", () => {
  it("shows the players, whose turn it is and the squares by their accessible names (paths §8)", () => {
    setup(fresh({ board: [{ r: 2, c: 2, placed: SAFE }] }));
    expect(screen.getByRole("region", { name: "Paths board" })).toBeTruthy();
    const players = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(players.map((li) => li.textContent)).toEqual([
      "Ann (you), blue circle marker3 tiles",
      "Bo, orange square marker3 tiles",
    ]);
    expect(players.map((li) => li.getAttribute("aria-current"))).toEqual(["true", "false"]);
    expect(screen.getByText("Your turn: choose a tile.").getAttribute("data-yours")).toBe("true");
    expect(squareAt(0, 2).getAttribute("aria-label")).toBe(
      "Row 1, column 3, empty, your marker faces this square",
    );
    expect(squareAt(5, 4).getAttribute("aria-label")).toBe(
      "Row 6, column 5, empty, Bo's marker faces this square",
    );
    expect(squareAt(2, 2).getAttribute("aria-label")).toBe("Row 3, column 3, tile placed");
    expect(squareAt(1, 1).getAttribute("aria-label")).toBe("Row 2, column 2, empty");
    // The target square is always highlighted.
    expect(squareAt(0, 2).getAttribute("data-target")).toBe("true");
    expect(squareAt(1, 1).getAttribute("data-target")).toBe("false");
  });

  it("says whose turn it is when it isn't yours, and names the deck", () => {
    setup(fresh({ turn: 1, tokenHolder: 1 }), { viewer: 0 });
    expect(screen.getByText("Bo's turn.").getAttribute("data-yours")).toBe("false");
    expect(screen.getByText(/in the deck\. Bo draws first when tiles come back\./u)).toBeTruthy();
  });

  it("names every marker by colour and shape, so colour is never the only difference", () => {
    setup(
      game({
        markers: Array.from({ length: 8 }, (_, i) => facing(0, i % 6, i % 2)),
        hands: Array.from({ length: 8 }, () => []),
      }),
      { names: Array.from({ length: 8 }, (_, i) => `P${String(i)}`) },
    );
    const shapes = within(screen.getByRole("list", { name: "Players" }))
      .getAllByRole("listitem")
      .map((li) => /, (.+) marker/u.exec(li.textContent)?.[1]);
    expect(new Set(shapes).size).toBe(8);
    const icons = [...document.querySelectorAll(".ym-p-icon path:last-child")].map((p) =>
      p.getAttribute("d"),
    );
    expect(new Set(icons).size).toBe(8);
  });
});

describe("the hand and the ghost preview", () => {
  it("names each tile with its rotation and whether your marker would survive", () => {
    setup();
    expect(tile(0).getAttribute("aria-label")).toBe(
      "Tile 1 of 3, rotated 0 degrees; your marker would be eliminated",
    );
    expect(tile(1).getAttribute("aria-label")).toMatch(
      /^Tile 2 of 3, rotated 0 degrees; your marker would (survive|be eliminated)$/u,
    );
    expect(tile(2).getAttribute("aria-label")).toMatch(/^Tile 3 of 3, rotated 0 degrees; /u);
    expect(
      screen.getByText("Choose a tile. Tap it again, or press Rotate, to turn it."),
    ).toBeTruthy();
    expect(button("Place").hasAttribute("disabled")).toBe(true);
  });

  it("selects a tile on a tap and turns it on a second tap, or on Rotate", () => {
    setup();
    fireEvent.click(tile(1));
    expect(tile(1).getAttribute("aria-pressed")).toBe("true");
    expect(tile(1).getAttribute("aria-label")).toContain("rotated 0 degrees");
    fireEvent.click(tile(1));
    expect(tile(1).getAttribute("aria-label")).toContain("rotated 90 degrees");
    fireEvent.click(button(/Rotate/u));
    expect(tile(1).getAttribute("aria-label")).toContain("rotated 180 degrees");
    fireEvent.click(tile(0));
    expect(tile(0).getAttribute("aria-pressed")).toBe("true");
    expect(tile(1).getAttribute("aria-pressed")).toBe("false");
    // Each tile keeps its own turn.
    expect(tile(1).getAttribute("aria-label")).toContain("rotated 180 degrees");
    expect(tile(0).getAttribute("aria-label")).toContain("rotated 0 degrees");
  });

  it("draws the ghost tile on the target square with every moved marker's trace", () => {
    setup();
    fireEvent.click(tile(1));
    const target = squareAt(0, 2);
    expect(target.getAttribute("data-ghost")).toBe("true");
    expect(target.querySelector(".ym-p-path")).not.toBeNull();
    const traces = document.querySelectorAll(".ym-p-trace-group");
    expect(traces).toHaveLength(1);
    expect(traces[0]?.getAttribute("data-seat")).toBe("0");
  });

  it("warns, in words, when your own marker would be eliminated, and refuses it while another choice avoids it", () => {
    setup();
    fireEvent.click(tile(0));
    expect(status()).toContain(
      "Warning: your marker would run off the board and you would be out.",
    );
    expect(status()).toContain("Another tile or turn keeps your marker on the board");
    expect(button("Place").hasAttribute("disabled")).toBe(true);
    expect(document.querySelector('[data-out="true"]')).not.toBeNull();
  });

  it("lets you play on when every choice puts you out", () => {
    setup(fresh({ hands: [[KILLER.tileId], [21, 22, 23]] }));
    fireEvent.click(tile(0));
    expect(status()).toContain("you would be out");
    expect(status()).toContain("you must play one anyway");
    expect(button("Place").hasAttribute("disabled")).toBe(false);
  });

  it("allows it under the variant, with the warning", () => {
    setup(fresh({ options: { selfElimination: "allowed" } }), {
      options: { boardSize: 6, handSize: 3, selfElimination: "allowed" },
    });
    fireEvent.click(tile(0));
    expect(status()).toContain("Warning: your marker would run off the board");
    expect(status()).not.toContain("you must play one anyway");
    expect(button("Place").hasAttribute("disabled")).toBe(false);
  });

  it("says when the tile keeps your marker on the board and who else it would put out", () => {
    // Bo faces the same square as Ann (notch 1); a tile joining 0–1 sends both off the board.
    const state = fresh({ markers: [facing(0, 2, 0), facing(0, 2, 1)] });
    setup(state);
    fireEvent.click(tile(0));
    expect(status()).toContain("Bo would be out too.");
    cleanup();
    setup();
    fireEvent.click(tile(1));
    fireEvent.click(tile(1));
    // Whichever rotation it is, the preview says one of the two things.
    expect(status()).toMatch(/would stay on the board|would run off the board/u);
  });

  it("places the chosen tile at its rotation through the shell's submit", async () => {
    const { submit } = setup(fresh({ hands: [[SAFE.tileId], [21, 22, 23]] }));
    fireEvent.click(tile(0));
    fireEvent.click(tile(0));
    await settle(() => {
      fireEvent.click(button("Place"));
    });
    expect(submit).toHaveBeenCalledWith({ type: "place-tile", tileId: SAFE.tileId, rotation: 1 });
    // Nothing more is sent while the answer is waited for.
    expect(button("Place").hasAttribute("disabled")).toBe(true);
  });

  it("shows what the server said when it refuses, and what happened to a failed request", async () => {
    const refused: SubmitResult = {
      ok: false,
      error: { code: "STALE_GAME", message: "stale" },
    };
    const { submit, unmount } = setup(fresh({ hands: [[SAFE.tileId], [21, 22, 23]] }), {
      submit: refused,
    });
    fireEvent.click(tile(0));
    await settle(() => {
      fireEvent.click(button("Place"));
    });
    expect(status()).toContain("The game moved on while you were choosing");
    expect(submit).toHaveBeenCalledTimes(1);
    unmount();
    setup(fresh({ hands: [[SAFE.tileId], [21, 22, 23]] }), { submit: new Error("offline") });
    fireEvent.click(tile(0));
    await settle(() => {
      fireEvent.click(button("Place"));
    });
    expect(status()).toContain("Couldn't send your move");
  });

  it("plays by keyboard: arrows choose, R turns, Enter places (07 §6)", async () => {
    const { submit } = setup(
      fresh({
        hands: [
          [SAFE.tileId, 20, 21],
          [22, 23, 24],
        ],
      }),
    );
    tile(0).focus();
    fireEvent.keyDown(tile(0), { key: "ArrowRight" });
    expect(tile(1).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(tile(1));
    fireEvent.keyDown(tile(1), { key: "ArrowLeft" });
    expect(tile(0).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(tile(0), { key: "ArrowLeft" });
    expect(tile(2).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(tile(2), { key: "ArrowDown" });
    expect(tile(0).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(tile(0), { key: "r" });
    expect(tile(0).getAttribute("aria-label")).toContain("rotated 90 degrees");
    fireEvent.keyDown(tile(0), { key: "R" });
    fireEvent.keyDown(tile(0), { key: "R" });
    fireEvent.keyDown(tile(0), { key: "R" });
    expect(tile(0).getAttribute("aria-label")).toContain("rotated 0 degrees");
    // Enter on a tile that isn't chosen chooses it; on the chosen one it places.
    fireEvent.keyDown(tile(1), { key: "Enter" });
    expect(tile(1).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(tile(0), { key: "Enter" });
    fireEvent.keyDown(tile(0), { key: "x" });
    await settle(() => {
      fireEvent.keyDown(tile(0), { key: "Enter" });
    });
    // The hand is [20, 21, SAFE]: tile 0 is the one the keyboard turned and chose.
    expect(submit).toHaveBeenCalledWith({ type: "place-tile", tileId: 20, rotation: 0 });
  });

  it("lets you look ahead off turn, but not place", () => {
    setup(fresh({ turn: 1 }), { viewer: 0 });
    fireEvent.click(tile(1));
    expect(status()).toContain("It isn't your turn yet");
    expect(button("Place").hasAttribute("disabled")).toBe(true);
  });

  it("has no hand for someone who isn't playing, one that is empty, or a seat that is out", () => {
    setup(fresh(), { viewer: null });
    expect(screen.queryByRole("group", { name: "Your hand" })).toBeNull();
    cleanup();
    setup(fresh({ hands: [[], [21, 22, 23]] }));
    expect(screen.getByText(/You have no tiles right now/u)).toBeTruthy();
    cleanup();
    setup(fresh({ markers: [out(2), facing(5, 4, 4)], turn: 1 }));
    expect(screen.getByText(/You're out of this game/u)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Your hand" })).toBeNull();
    const players = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(players[0]?.textContent).toContain("out");
  });
});

describe("the marker phase (paths §8)", () => {
  const early = (fields: Partial<Parameters<typeof game>[0]> = {}) =>
    game({
      phase: "markers",
      markers: [
        { pos: null, out: null },
        { pos: { r: 0, c: 3, n: 0 }, out: null },
      ],
      turn: 0,
      ...fields,
    });

  it("makes the edge squares buttons and leaves the inside squares alone", () => {
    setup(early());
    expect(screen.getByText("Your turn: choose where your marker starts.")).toBeTruthy();
    expect(squareAt(0, 0).tagName).toBe("BUTTON");
    expect(squareAt(2, 5).tagName).toBe("BUTTON");
    expect(squareAt(3, 3).tagName).toBe("DIV");
    expect(squareAt(0, 0).getAttribute("aria-label")).toBe(
      "Row 1, column 1, empty, choose a notch",
    );
    expect(status()).toContain("Tap a square on the edge of the board");
    const players = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(players.map((li) => li.textContent)).toEqual([
      "Ann (you), blue circle markerto place",
      "Bo, orange square markerplaced",
    ]);
  });

  it("opens large notch buttons for the tapped square, then places on the one chosen", async () => {
    const { submit } = setup(early());
    fireEvent.click(squareAt(0, 0));
    const group = screen.getByRole("group", {
      name: "Row 1, column 1: choose a notch",
    });
    const names = within(group)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual([
      "Top edge, left notch, free",
      "Top edge, right notch, free",
      "Left edge, lower notch, free",
      "Left edge, upper notch, free",
      "Choose another square",
    ]);
    // The first notch button has the keyboard's focus; aiming at one marks it on the board.
    expect(document.activeElement).toBe(button("Top edge, left notch, free"));
    expect(document.querySelectorAll(".ym-p-notch-dot")).toHaveLength(4);
    fireEvent.pointerEnter(button("Left edge, lower notch, free"));
    expect(document.querySelectorAll('.ym-p-notch-dot[data-aim="true"]')).toHaveLength(1);
    fireEvent.pointerLeave(button("Left edge, lower notch, free"));
    expect(document.querySelectorAll('.ym-p-notch-dot[data-aim="true"]')).toHaveLength(0);
    fireEvent.blur(button("Top edge, left notch, free"));
    await settle(() => {
      fireEvent.click(button("Left edge, upper notch, free"));
    });
    // Edge notch 47 is (0, 0) notch 7 (paths §1: left edge, clockwise from the top left).
    expect(submit).toHaveBeenCalledWith({ type: "place-marker", edgeNotch: 47 });
  });

  it("disables a notch another marker is on", () => {
    setup(early());
    fireEvent.click(squareAt(0, 3));
    const taken = button("Top edge, left notch, occupied");
    expect(taken.hasAttribute("disabled")).toBe(true);
    expect(button("Top edge, right notch, free").hasAttribute("disabled")).toBe(false);
  });

  it("goes back to the squares from the picker", () => {
    setup(early());
    fireEvent.click(squareAt(0, 0));
    fireEvent.click(button("Choose another square"));
    expect(screen.queryByRole("group", { name: /choose a notch/u })).toBeNull();
  });

  it("offers nothing off turn, and a square with no free notch isn't a button", () => {
    setup(early({ turn: 1 }), { viewer: 0 });
    expect(squareAt(0, 0).tagName).toBe("DIV");
    expect(screen.getByText("Bo is placing their marker.")).toBeTruthy();
  });

  it("announces another player's marker when it appears", () => {
    const state = early({ turn: 1 });
    const { rerenderAt } = setup(state, { viewer: 0 });
    const next = early({
      turn: 0,
      markers: [
        { pos: null, out: null },
        { pos: { r: 0, c: 3, n: 0 }, out: null },
      ],
    });
    rerenderAt(4, next);
    expect(status()).toContain("Bo placed their marker.");
  });
});

describe("movement and its animation (paths §8)", () => {
  const before = fresh({
    hands: [
      [SAFE.tileId, 20, 21],
      [22, 23, 24],
    ],
    turn: 0,
  });
  const after = placeTile(before, 0, SAFE, noRandom).state;

  it("moves the markers along their traces, one frame at a time, then rests on the view", () => {
    vi.useFakeTimers();
    const { rerenderAt } = setup(before, { viewer: 1 });
    const start = markerPoint(0);
    expect(start).toBe("translate(224 0)");
    rerenderAt(4, after);
    // Before the first frame the marker is where it was, not where it ends.
    expect(markerPoint(0)).toBe(start);
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 3);
    });
    const midway = markerPoint(0);
    expect(midway).not.toBe(start);
    expect(midway).not.toBe("translate(224 96)");
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 200);
    });
    expect(markerPoint(0)).toBe("translate(224 96)");
    expect(status()).toContain("Ann placed a tile.");
  });

  it("shows your own preview while another move is still being replayed", () => {
    vi.useFakeTimers();
    const { rerenderAt } = setup(before, { viewer: 1 });
    rerenderAt(4, placeTile(before, 0, SAFE, noRandom).state);
    fireEvent.click(tile(0));
    expect(document.querySelectorAll(".ym-p-trace-group")).toHaveLength(1);
    expect(status()).toContain("Ann placed a tile.");
    expect(status()).toMatch(/would (stay on|run off) the board/u);
  });

  it("jumps straight to the end under prefers-reduced-motion", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    const { rerenderAt } = setup(before, { viewer: 1 });
    rerenderAt(4, after);
    expect(markerPoint(0)).toBe("translate(224 96)");
  });

  it("says who went out, and keeps an eliminated marker on screen until the animation ends", () => {
    vi.useFakeTimers();
    const doomed = fresh({ hands: [[KILLER.tileId], [22, 23, 24]], turn: 0 });
    const done = placeTile(doomed, 0, KILLER, seededRandom(2)).state;
    const { rerenderAt } = setup(doomed, { viewer: 1 });
    rerenderAt(4, done);
    expect(markerPoint(0)).not.toBeNull();
    expect(status()).toContain("Ann ran off the board.");
    act(() => {
      vi.advanceTimersByTime(FRAME_MS * 200);
    });
    expect(markerPoint(0)).toBeNull();
  });

  it("names a head-on crash", () => {
    vi.useFakeTimers();
    // Both markers face (0, 0) from notches 0 and 7; a tile joining 0–7 sends them at each other.
    const head = placedFor([
      [0, 7],
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    const meet = game({
      markers: [facing(0, 0, 0), facing(0, 0, 7)],
      hands: [[head.tileId], [22, 23, 24]],
    });
    const done = placeTile(meet, 0, head, seededRandom(2)).state;
    const { rerenderAt } = setup(meet, { viewer: 1, yourTurn: false });
    rerenderAt(4, done);
    expect(status()).toContain("Ann placed a tile. Ann and Bo crashed.");
  });

  it("just shows the new board when the change isn't one move it can replay", () => {
    vi.useFakeTimers();
    const { rerenderAt } = setup(before, { viewer: 1 });
    const twice = placeTile(after, 1, SAFE, noRandom).state;
    rerenderAt(5, twice);
    expect(status()).not.toContain("placed a tile");
    expect(document.querySelector(".ym-p-marker")).not.toBeNull();
  });

  it("forgets what was waiting on the old board when a new one arrives", async () => {
    const { rerenderAt, submit } = setup(before, { viewer: 0 });
    fireEvent.click(tile(0));
    await settle(() => {
      fireEvent.click(button("Place"));
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(button("Place").hasAttribute("disabled")).toBe(true);
    rerenderAt(4, after);
    expect(screen.queryByText("Your turn: choose a tile.")).toBeNull();
  });
});

describe("a finished game", () => {
  it("says how it ended and shows what was left in hand", () => {
    const state = game({
      markers: [facing(0, 2, 0), out(5)],
      hands: [[SAFE.tileId, 20], []],
    });
    const finished: State = { ...state, turn: null, endReason: "last-standing" };
    setup(finished, { status: "finished", viewer: 0, yourTurn: false });
    expect(screen.getByText("Game over.")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "How it ended" });
    expect(summary.textContent).toContain("One marker was left on the board.");
    expect(summary.textContent).toContain("Ann kept 2 tiles:");
    expect(summary.querySelectorAll(".ym-p-mini")).toHaveLength(2);
    expect(screen.queryByRole("group", { name: "Your hand" })).toBeNull();
    cleanup();
    setup({ ...finished, endReason: "wipe-out" }, { status: "finished" });
    expect(screen.getByRole("region", { name: "How it ended" }).textContent).toContain(
      "left the board together",
    );
    cleanup();
    setup({ ...finished, endReason: "board-full" }, { status: "finished" });
    expect(screen.getByRole("region", { name: "How it ended" }).textContent).toContain(
      "Nobody left held a tile",
    );
  });
});

describe("what the board refuses to draw", () => {
  it("asks for a newer app when the game's rules version is one it doesn't know", () => {
    setup(fresh(), { gameVersion: 9 });
    expect(screen.getByRole("alert").textContent).toContain("Reload the page");
  });

  it("asks for a newer app when the options aren't ones it knows", () => {
    setup(fresh(), { options: { boardSize: 7 } });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("tells a browser without constructable stylesheets to update", async () => {
    vi.resetModules();
    vi.stubGlobal("CSSStyleSheet", undefined);
    const { Board: Fresh } = await import("./Board.js");
    const state = fresh();
    render(
      <Fresh
        game={envelope(NAMES, 0)}
        view={viewOf(state, 0)}
        submit={() => Promise.resolve(SENT)}
        preview={() => Promise.resolve(null)}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("Please update your browser to play.");
  });
});
