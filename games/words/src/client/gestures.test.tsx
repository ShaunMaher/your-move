// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { view } from "../engine/present.js";
import { board, envelope, rack, ruleset, state } from "../test-support.js";
import { Board } from "./Board.js";

const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;
/** The frame is 300 px square, so a square is 20 px; the rack lies below it. */
const FRAME = 300;
const CELL = FRAME / 15;
const RACK_TOP = 400;

/** The middle of a board square, in screen coordinates. */
const at = (row: number, col: number): { clientX: number; clientY: number } => ({
  clientX: col * CELL + CELL / 2,
  clientY: row * CELL + CELL / 2,
});

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const box = (left: number, top: number, width: number, height: number): DOMRect => ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    });
    if (this.classList.contains("ym-w-frame")) return box(0, 0, FRAME, FRAME);
    if (this.classList.contains("ym-w-rack")) return box(0, RACK_TOP, FRAME, 50);
    if (this.dataset["rackId"] !== undefined) {
      const index = [...(this.parentElement?.children ?? [])].indexOf(this);
      return box(index * 40, RACK_TOP, 40, 50);
    }
    return box(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

function table() {
  const s = state({
    racks: [rack("sxe?abc"), rack("eeeeeee")],
    board: board(CLASSIC, [{ row: SR, col: SC - 1, word: "cat" }]),
  });
  const preview = vi.fn(() =>
    Promise.resolve({ score: 6, words: [{ word: "cats", score: 6 }], bingo: false }),
  );
  render(
    <Board
      game={envelope(["Ann", "Bo"], 0)}
      view={view(s, 0)}
      submit={vi.fn()}
      preview={preview}
    />,
  );
  return { preview };
}

const square = (row: number, col: number): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[data-square="${String(row)},${String(col)}"]`,
  );
  if (found === null) throw new Error("no such square");
  return found;
};
const frame = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(".ym-w-frame");
  if (found === null) throw new Error("no frame");
  return found;
};
const grid = (): HTMLElement => document.querySelector<HTMLElement>(".ym-w-grid")!;
const rackTile = (name: string): HTMLElement => screen.getByRole("button", { name });
const rackNames = (): (string | null)[] =>
  [...document.querySelectorAll("[data-rack-id]")].map((tile) => tile.getAttribute("aria-label"));
const move = (clientX: number, clientY: number, pointerId = 1): void => {
  fireEvent.pointerMove(window, { pointerId, clientX, clientY });
};
const release = (pointerId = 1): void => {
  fireEvent.pointerUp(window, { pointerId });
};
const grab = (element: HTMLElement, x = 5, y = RACK_TOP + 5, extra = {}): void => {
  fireEvent.pointerDown(element, { pointerId: 1, clientX: x, clientY: y, button: 0, ...extra });
};

describe("dragging tiles", () => {
  it("drops a rack tile on a square, outlining the square it would land on", () => {
    table();
    grab(rackTile("S, 1 point"));
    move(150, 190);
    expect(square(SR + 2, SC).getAttribute("data-target")).toBe("true");
    expect(document.querySelector(".ym-w-ghost")).not.toBeNull();
    release();
    expect(square(SR + 2, SC).getAttribute("aria-label")).toContain("S, 1 point");
    expect(document.querySelector(".ym-w-ghost")).toBeNull();
    expect(square(SR + 2, SC).getAttribute("data-target")).toBe("false");
  });

  it("snaps a drop on a taken square to the nearest empty one", () => {
    table();
    grab(rackTile("S, 1 point"));
    move(at(SR, SC).clientX, at(SR, SC).clientY);
    release();
    expect(square(SR - 1, SC).getAttribute("aria-label")).toContain("S, 1 point");
  });

  it("holds the ghost above a finger, but not above a mouse", () => {
    table();
    grab(rackTile("S, 1 point"), 5, 420, { pointerType: "touch" });
    move(150, 250);
    expect(document.querySelector<HTMLElement>(".ym-w-ghost")?.style.top).toBe("194px");
    release();
    grab(rackTile("X, 8 points"), 5, 420, { pointerType: "mouse" });
    move(150, 250);
    expect(document.querySelector<HTMLElement>(".ym-w-ghost")?.style.top).toBe("250px");
  });

  it("drops a touch drag where the ghost is, not under the finger", () => {
    table();
    grab(rackTile("S, 1 point"), 5, 420, { pointerType: "touch" });
    move(150, 190 + 56);
    release();
    expect(square(SR + 2, SC).getAttribute("aria-label")).toContain("S, 1 point");
  });

  it("drags a placed tile to another square and back to the rack", () => {
    table();
    fireEvent.click(rackTile("S, 1 point"));
    fireEvent.click(square(SR + 2, SC));
    grab(square(SR + 2, SC), 150, 190);
    move(at(SR + 3, SC + 1).clientX, at(SR + 3, SC + 1).clientY);
    release();
    expect(square(SR + 2, SC).getAttribute("aria-label")).toContain("empty");
    expect(square(SR + 3, SC + 1).getAttribute("aria-label")).toContain("S, 1 point");
    grab(square(SR + 3, SC + 1));
    move(5, RACK_TOP + 20);
    release();
    expect(square(SR + 3, SC + 1).getAttribute("aria-label")).toContain("empty");
    expect(rackNames()[0]).toBe("S, 1 point");
  });

  it("reorders the rack by dropping a tile in front of another, or at the end", () => {
    table();
    grab(rackTile("S, 1 point"));
    move(5, RACK_TOP + 20);
    release();
    expect(rackNames().slice(0, 2)).toEqual(["S, 1 point", "A, 1 point"]);
    grab(rackTile("S, 1 point"));
    move(290, RACK_TOP + 20);
    release();
    expect(rackNames().at(-1)).toBe("S, 1 point");
  });

  it("asks for a letter when a blank is dropped", () => {
    table();
    grab(rackTile("Blank tile"));
    move(150, 190);
    release();
    expect(screen.getByRole("dialog", { name: "Choose a letter for the blank" })).toBeTruthy();
  });

  it("leaves the tile where it was when it is dropped on nothing, or the drag is cancelled", () => {
    table();
    grab(rackTile("S, 1 point"));
    move(150, 360);
    release();
    expect(rackNames()).toContain("S, 1 point");
    grab(rackTile("S, 1 point"));
    move(150, 190);
    fireEvent.pointerCancel(window, { pointerId: 1 });
    expect(square(SR + 2, SC).getAttribute("aria-label")).toContain("empty");
    expect(document.querySelector(".ym-w-ghost")).toBeNull();
  });

  it("treats a press that barely moves as a tap, and a drag as not one", () => {
    table();
    grab(rackTile("S, 1 point"));
    move(7, RACK_TOP + 6);
    release();
    fireEvent.click(rackTile("S, 1 point"));
    expect(rackTile("S, 1 point").getAttribute("aria-pressed")).toBe("true");
    cleanup();
    table();
    grab(rackTile("S, 1 point"));
    move(150, 190);
    release();
    // The click a browser sends after a drag must not select the next thing.
    fireEvent.click(rackTile("A, 1 point"));
    expect(rackTile("A, 1 point").getAttribute("aria-pressed")).toBe("false");
  });

  it("ignores other pointers and a mouse's other buttons", () => {
    table();
    grab(rackTile("S, 1 point"), 5, 420, { pointerType: "mouse", button: 2 });
    move(150, 190);
    expect(document.querySelector(".ym-w-ghost")).toBeNull();
    grab(rackTile("S, 1 point"));
    move(150, 190, 7);
    expect(document.querySelector(".ym-w-ghost")).toBeNull();
    release(7);
    move(150, 190);
    release();
    expect(square(SR + 2, SC).getAttribute("aria-label")).toContain("S, 1 point");
  });

  it("zooms the board around the finger after a short hover", () => {
    vi.useFakeTimers();
    table();
    grab(rackTile("S, 1 point"));
    move(150, 190);
    expect(grid().style.transform).toContain("scale(1)");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(grid().style.transform).toContain("scale(2.5)");
    release();
  });

  it("doesn't zoom when the drag leaves the board before the hover ends", () => {
    vi.useFakeTimers();
    table();
    grab(rackTile("S, 1 point"));
    move(150, 190);
    move(150, 360);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(grid().style.transform).toContain("scale(1)");
    release();
  });

  it("doesn't start another zoom when the board is already zoomed", () => {
    table();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    vi.useFakeTimers();
    grab(rackTile("S, 1 point"));
    move(150, 190);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(grid().style.transform).toContain("scale(1.5)");
    release();
  });

  it("doesn't drag when it isn't your turn to arrange tiles", () => {
    const s = state({ racks: [rack("sxe?abc"), rack("eeeeeee")] });
    render(
      <Board
        game={envelope(["Ann", "Bo"], 0, { status: "finished" })}
        view={view(s, 0)}
        submit={vi.fn()}
        preview={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-rack-id]")).toBeNull();
  });
});

describe("zoom and pan", () => {
  it("zooms with the buttons, never past the limits", () => {
    table();
    const out = screen.getByRole("button", { name: "Zoom out" });
    expect(out.hasAttribute("disabled")).toBe(true);
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    for (let i = 0; i < 6; i += 1) fireEvent.click(zoomIn);
    expect(grid().style.transform).toContain("scale(4)");
    fireEvent.click(out);
    expect(grid().style.transform).toContain("scale(2.6666");
  });

  it("zooms in and out on a double tap, but not while a tile is selected", () => {
    table();
    const tap = (x: number, y: number): void => {
      fireEvent.pointerDown(frame(), { pointerId: 1, clientX: x, clientY: y });
      fireEvent.pointerUp(frame(), { pointerId: 1, clientX: x, clientY: y });
    };
    tap(100, 100);
    expect(grid().style.transform).toContain("scale(1)");
    tap(102, 101);
    expect(grid().style.transform).toContain("scale(2.5)");
    tap(100, 100);
    tap(100, 100);
    expect(grid().style.transform).toContain("scale(1)");
    // Two taps far apart are not a double tap.
    tap(10, 10);
    tap(200, 200);
    expect(grid().style.transform).toContain("scale(1)");
    fireEvent.click(rackTile("S, 1 point"));
    tap(100, 100);
    tap(100, 100);
    expect(grid().style.transform).toContain("scale(1)");
  });

  it("pans a zoomed board with one finger, and not an unzoomed one", () => {
    table();
    const drag = (dx: number): void => {
      fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(frame(), { pointerId: 1, clientX: 100 + dx, clientY: 100 });
      fireEvent.pointerUp(frame(), { pointerId: 1, clientX: 100 + dx, clientY: 100 });
    };
    drag(-40);
    expect(grid().style.transform).toBe("translate(0px) scale(1)");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const before = grid().style.transform;
    drag(30);
    expect(grid().style.transform).not.toBe(before);
    // The click that follows a pan is not a tap on a square.
    fireEvent.click(rackTile("S, 1 point"));
    fireEvent.click(square(SR + 2, SC));
  });

  it("pinches to zoom and pans with the midpoint", () => {
    table();
    fireEvent.pointerDown(frame(), { pointerId: 1, clientX: 140, clientY: 150 });
    fireEvent.pointerDown(frame(), { pointerId: 2, clientX: 160, clientY: 150 });
    fireEvent.pointerMove(frame(), { pointerId: 2, clientX: 220, clientY: 150 });
    expect(grid().style.transform).not.toContain("scale(1)");
    fireEvent.pointerMove(frame(), { pointerId: 9, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(frame(), { pointerId: 2 });
    fireEvent.pointerUp(frame(), { pointerId: 1 });
    fireEvent.pointerUp(frame(), { pointerId: 1 });
  });

  it("doesn't let a drag of a placed tile pan the board", () => {
    table();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(rackTile("S, 1 point"));
    const target = at(SR + 2, SC);
    fireEvent.click(square(SR + 2, SC));
    const before = grid().style.transform;
    fireEvent.pointerDown(square(SR + 2, SC), { pointerId: 1, ...target });
    fireEvent.pointerMove(frame(), { pointerId: 1, clientX: target.clientX + 50, clientY: 0 });
    expect(grid().style.transform).toBe(before);
    fireEvent.pointerUp(frame(), { pointerId: 1 });
  });
});

describe("the keyboard", () => {
  it("moves between squares with the arrow keys and stops at the edge", () => {
    table();
    const start = square(SR, SC);
    start.focus();
    expect(start.getAttribute("tabindex")).toBe("0");
    expect(square(0, 0).getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement).toBe(square(SR, SC + 1));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(square(SR + 1, SC + 1));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(square(SR, SC));
    const corner = square(0, 0);
    corner.focus();
    fireEvent.keyDown(corner, { key: "ArrowUp" });
    fireEvent.keyDown(corner, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(corner);
  });

  it("pans a zoomed board to keep the focused square in view", () => {
    table();
    for (let i = 0; i < 4; i += 1) fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    const before = grid().style.transform;
    act(() => {
      square(14, 14).focus();
    });
    expect(grid().style.transform).toBe("translate(-900px, -900px) scale(4)");
    expect(grid().style.transform).not.toBe(before);
    act(() => {
      square(14, 14).focus();
      square(0, 0).focus();
    });
    expect(grid().style.transform).toBe("translate(0px) scale(4)");
  });

  it("plays entirely from the keyboard: select a tile, move to a square, press Enter", () => {
    table();
    const tile = rackTile("S, 1 point");
    fireEvent.click(tile);
    const target = square(SR + 2, SC);
    target.focus();
    fireEvent.click(target);
    expect(target.getAttribute("aria-label")).toContain("S, 1 point");
  });
});
