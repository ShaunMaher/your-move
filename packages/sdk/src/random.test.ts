import { describe, expect, it } from "vitest";

import {
  ReplayMismatchError,
  assertRange,
  recordRandom,
  replayRandom,
  shuffle,
  type RandomSource,
} from "./random.js";

/** Returns the given values in order. */
const fixed = (...values: number[]): RandomSource => {
  let i = 0;
  return {
    nextInt: () => {
      const value = values[i] ?? 0;
      i += 1;
      return value;
    },
  };
};

describe("assertRange", () => {
  it.each([1, 2, 52, 2 ** 32])("accepts %d", (max) => {
    expect(() => {
      assertRange(max);
    }).not.toThrow();
  });

  it.each([0, -1, 1.5, 2 ** 32 + 1, Number.NaN, Number.POSITIVE_INFINITY])("rejects %d", (max) => {
    expect(() => {
      assertRange(max);
    }).toThrow(RangeError);
  });
});

describe("recordRandom", () => {
  it("records every draw in order", () => {
    const recording = recordRandom(fixed(3, 0, 9));
    expect([4, 1, 10].map((max) => recording.rng.nextInt(max))).toEqual([3, 0, 9]);
    expect(recording.draws).toEqual([3, 0, 9]);
  });

  it("refuses an invalid range before drawing", () => {
    const recording = recordRandom(fixed(0));
    expect(() => recording.rng.nextInt(0)).toThrow(RangeError);
    expect(recording.draws).toEqual([]);
  });

  it.each([5, -1, 0.5])("refuses a wrapped source returning %d for max 5", (value) => {
    const recording = recordRandom(fixed(value));
    expect(() => recording.rng.nextInt(5)).toThrow(/out of range/u);
    expect(recording.draws).toEqual([]);
  });
});

describe("replayRandom", () => {
  it("returns the recorded draws and counts what remains", () => {
    const replay = replayRandom([2, 7]);
    expect(replay.remaining()).toBe(2);
    expect(replay.nextInt(3)).toBe(2);
    expect(replay.nextInt(8)).toBe(7);
    expect(replay.remaining()).toBe(0);
  });

  it("throws when asked for more than was recorded", () => {
    const replay = replayRandom([]);
    expect(() => replay.nextInt(2)).toThrow(ReplayMismatchError);
  });

  it("throws when a recorded draw doesn't fit the range", () => {
    const replay = replayRandom([5]);
    expect(() => replay.nextInt(5)).toThrow(/out of range/u);
  });

  it("refuses an invalid range", () => {
    expect(() => replayRandom([0]).nextInt(-3)).toThrow(RangeError);
  });

  it("names its error", () => {
    expect(new ReplayMismatchError("x").name).toBe("ReplayMismatchError");
  });
});

describe("shuffle", () => {
  it("is a Fisher–Yates shuffle of a copy", () => {
    const items = ["a", "b", "c", "d"];
    // i = 3 → j = 0, i = 2 → j = 2, i = 1 → j = 0
    const recording = recordRandom(fixed(0, 2, 0));
    expect(shuffle(items, recording.rng)).toEqual(["b", "d", "c", "a"]);
    expect(recording.draws).toEqual([0, 2, 0]);
    expect(items).toEqual(["a", "b", "c", "d"]);
  });

  it("draws nothing for fewer than two items", () => {
    const recording = recordRandom(fixed());
    expect(shuffle([1], recording.rng)).toEqual([1]);
    expect(shuffle([], recording.rng)).toEqual([]);
    expect(recording.draws).toEqual([]);
  });
});
