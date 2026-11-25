import { describe, expect, it } from "vitest";

import {
  clampViewport,
  distance,
  FIT,
  midpoint,
  nearestEmpty,
  panBy,
  revealSquare,
  squareAtPoint,
  zoomAround,
} from "./geometry.js";

const FRAME = 300;

describe("clampViewport", () => {
  it("keeps the zoom between the limits and the board over its frame", () => {
    expect(clampViewport({ scale: 9, x: 50, y: -9999 }, FRAME)).toEqual({
      scale: 4,
      x: 0,
      y: -900,
    });
    expect(clampViewport({ scale: 0.2, x: -40, y: 10 }, FRAME)).toEqual(FIT);
  });
});

describe("zoomAround", () => {
  it("keeps the board point under the finger where it is", () => {
    const zoomed = zoomAround(FIT, FRAME, { x: 150, y: 90 }, 2);
    expect(zoomed).toEqual({ scale: 2, x: -150, y: -90 });
    // The point (150, 90) of the frame still shows the same board point.
    expect(zoomed.x + 150 * 2).toBe(150);
  });

  it("zooming back out returns to the fitted board", () => {
    const zoomed = zoomAround(FIT, FRAME, { x: 20, y: 280 }, 3);
    expect(zoomAround(zoomed, FRAME, { x: 20, y: 280 }, 1)).toEqual(FIT);
  });
});

describe("panBy", () => {
  it("moves the board but never off an edge", () => {
    const zoomed = { scale: 2, x: -100, y: -100 };
    expect(panBy(zoomed, FRAME, 30, -20)).toEqual({ scale: 2, x: -70, y: -120 });
    expect(panBy(zoomed, FRAME, 500, -500)).toEqual({ scale: 2, x: 0, y: -300 });
  });
});

describe("squareAtPoint", () => {
  it("finds the square under a point, whatever the zoom", () => {
    expect(squareAtPoint(FIT, FRAME, 15, { x: 0, y: 0 })).toEqual({ row: 0, col: 0 });
    expect(squareAtPoint(FIT, FRAME, 15, { x: 299, y: 150 })).toEqual({ row: 7, col: 14 });
    const zoomed = { scale: 2, x: -150, y: 0 };
    expect(squareAtPoint(zoomed, FRAME, 15, { x: 0, y: 0 })).toEqual({ row: 0, col: 3 });
  });

  it("finds nothing outside the frame or in a frame with no size", () => {
    expect(squareAtPoint(FIT, FRAME, 15, { x: -1, y: 5 })).toBeNull();
    expect(squareAtPoint(FIT, FRAME, 15, { x: 300, y: 5 })).toBeNull();
    expect(squareAtPoint(FIT, 0, 15, { x: 0, y: 0 })).toBeNull();
  });
});

describe("nearestEmpty", () => {
  const taken = new Set(["5,5", "5,6", "4,5"]);
  const empty = (r: number, c: number): boolean => !taken.has(`${String(r)},${String(c)}`);

  it("keeps an empty square and snaps an occupied one to its nearest empty neighbour", () => {
    expect(nearestEmpty(3, 3, 15, empty)).toEqual({ row: 3, col: 3 });
    expect(nearestEmpty(5, 5, 15, empty)).toEqual({ row: 5, col: 4 });
  });

  it("prefers the earlier row, then column, on a tie", () => {
    expect(nearestEmpty(5, 6, 15, empty)).toEqual({ row: 4, col: 6 });
  });

  it("finds nothing when everything near is taken, and stays on the board", () => {
    expect(nearestEmpty(0, 0, 15, () => false)).toBeNull();
    expect(nearestEmpty(0, 0, 15, (r, c) => r === 14 && c === 14)).toBeNull();
    expect(nearestEmpty(14, 14, 15, (r, c) => r === 14 && c === 14)).toEqual({ row: 14, col: 14 });
  });
});

describe("revealSquare", () => {
  const zoomed = { scale: 3, x: 0, y: 0 };

  it("leaves a visible square alone", () => {
    expect(revealSquare(zoomed, FRAME, 15, 1, 1)).toBe(zoomed);
  });

  it("pans just far enough to show a square off either edge", () => {
    expect(revealSquare(zoomed, FRAME, 15, 10, 10)).toEqual({
      scale: 3,
      x: -(10 * 60 + 60 - 300),
      y: -(10 * 60 + 60 - 300),
    });
    const far = { scale: 3, x: -600, y: -600 };
    expect(revealSquare(far, FRAME, 15, 2, 2)).toEqual({ scale: 3, x: -120, y: -120 });
  });
});

describe("points", () => {
  it("measures distance and midpoint", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(midpoint({ x: 0, y: 2 }, { x: 4, y: 6 })).toEqual({ x: 2, y: 4 });
  });
});
