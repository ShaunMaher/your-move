// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GameEnvelope, GameError, SubmitResult } from "@your-move/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PreviewResult } from "../engine/index.js";
import { view } from "../engine/present.js";
import type { State } from "../engine/state.js";
import { board, envelope, rack, ruleset, state } from "../test-support.js";
import "./dom-setup.js";
import { Board } from "./Board.js";

const CLASSIC = ruleset("classic");
const [SR, SC] = CLASSIC.start;
const NAMES = ["Ann", "Bo"];

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** CAT through the start square; Ann holds S, X, E, a blank, A, B and C. */
function fresh(fields: Partial<State> = {}): State {
  return state({
    racks: [rack("sxe?abc"), rack("eeeeeee")],
    board: board(CLASSIC, [{ row: SR, col: SC - 1, word: "cat" }]),
    scores: [12, 7],
    ...fields,
  });
}

const OK_PREVIEW: PreviewResult = { score: 6, words: [{ word: "cats", score: 6 }], bingo: false };
const SENT: SubmitResult = { ok: true, game: envelope(NAMES, 0), view: null };

interface Shell {
  submit?: SubmitResult | Error;
  preview?: PreviewResult | GameError | Error;
  viewer?: number | null;
  yourTurn?: boolean;
  status?: "active" | "finished";
  resources?: GameEnvelope["resources"];
  gameVersion?: number;
}

function setup(s: State = fresh(), shell: Shell = {}) {
  const viewer = shell.viewer === undefined ? 0 : shell.viewer;
  const submit = vi.fn(() =>
    shell.submit instanceof Error
      ? Promise.reject(shell.submit)
      : Promise.resolve(shell.submit ?? SENT),
  );
  const preview = vi.fn(() =>
    shell.preview instanceof Error
      ? Promise.reject(shell.preview)
      : Promise.resolve(shell.preview ?? OK_PREVIEW),
  );
  const game = envelope(NAMES, viewer, {
    yourTurn: shell.yourTurn ?? viewer === s.turn,
    toAct: s.finished === null ? [s.turn] : [],
    ...(shell.status === undefined ? {} : { status: shell.status }),
    ...(shell.resources === undefined ? {} : { resources: shell.resources }),
    ...(shell.gameVersion === undefined ? {} : { gameVersion: shell.gameVersion }),
  });
  const ui = (version: number, v = view(s, viewer)) => (
    <Board game={{ ...game, version }} view={v} submit={submit} preview={preview} />
  );
  const result = render(ui(3));
  return {
    submit,
    preview,
    ...result,
    rerenderAt: (version: number, v = view(s, viewer)) => {
      result.rerender(ui(version, v));
    },
  };
}

const square = (row: number, col: number): HTMLElement => {
  const found = document.querySelector<HTMLElement>(
    `[data-square="${String(row)},${String(col)}"]`,
  );
  if (found === null) throw new Error("no such square");
  return found;
};
const rackTile = (name: string): HTMLElement => screen.getByRole("button", { name });
const button = (name: string | RegExp): HTMLElement => screen.getByRole("button", { name });

/** Taps a rack tile, then a square. */
function place(tile: string, row: number, col: number): void {
  fireEvent.click(rackTile(tile));
  fireEvent.click(square(row, col));
}

describe("the table", () => {
  it("shows the scores, whose turn it is, the bag and the last play", () => {
    setup(
      fresh({
        lastMove: {
          seat: 1,
          type: "play",
          placements: [{ row: SR, col: SC, tile: "a", letter: "a" }],
          words: [{ word: "cat", score: 5 }],
          score: 5,
          bingo: false,
        },
      }),
    );
    const scores = screen.getByRole("list", { name: "Scores" });
    expect(
      within(scores)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Ann (you) 12", "Bo 7"]);
    expect(within(scores).getAllByRole("listitem")[0]?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByText(/in the bag · Bo played CAT for 5/u)).toBeTruthy();
    expect(screen.getByText("Your turn. Place tiles to make a word.")).toBeTruthy();
  });

  it("labels every square: position, premium (its face text first), start, tile and last play", () => {
    setup();
    expect(square(SR + 1, SC).getAttribute("aria-label")).toBe("Row 9, column 8, empty");
    const tw = CLASSIC.premiums.flatMap((line, row) =>
      Array.from(line).flatMap((code, col) => (code === "T" ? [[row, col] as const] : [])),
    )[0] ?? [0, 0];
    expect(square(tw[0], tw[1]).getAttribute("aria-label")).toBe(
      `Row ${String(tw[0] + 1)}, column ${String(tw[1] + 1)}, 3W, triple word, empty`,
    );
    expect(square(SR, SC - 1).getAttribute("aria-label")).toBe("Row 8, column 7, C, 3 points");
    expect(rackTile("S, 1 point")).toBeTruthy();
    expect(rackTile("Blank tile")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Row \d+, column \d+/u })).toHaveLength(225);
  });

  it("puts every square's visible text in its accessible name (WCAG 2.5.3)", () => {
    setup();
    const squares = screen.getAllByRole("button", { name: /^Row \d+, column \d+/u });
    const faces = squares.flatMap((el) => {
      const face = el.querySelector(".ym-w-face")?.textContent ?? "";
      return face === "" ? [] : [{ face, name: el.getAttribute("aria-label") ?? "" }];
    });
    expect(faces.length).toBeGreaterThan(40);
    for (const { face, name } of faces) expect(name).toContain(face);
    // A tile's face reads "A 1" (letter, space, points), inside its name "A, 1 point".
    const tiles = screen.getAllByRole("button", { name: /, \d+ points?/u });
    for (const el of tiles.filter((t) => t.querySelector("small") !== null)) {
      const face = (el.textContent ?? "").replace(/\s+/gu, " ").trim();
      const spoken = (el.getAttribute("aria-label") ?? "").replace(/[^\p{L}\p{N}]+/gu, " ");
      expect(spoken.toLowerCase()).toContain(face.toLowerCase());
    }
  });

  it("names the start square when it is empty and has no premium", () => {
    setup(state({ racks: [rack("abcdefg"), rack("hijklmn")], rulesetId: "casual" }));
    expect(square(SR, SC).getAttribute("aria-label")).toBe("Row 8, column 8, start square, empty");
  });

  it("marks the last play's tiles", () => {
    const last = {
      seat: 1,
      type: "play" as const,
      placements: [{ row: SR, col: SC, tile: "a", letter: "a" }],
      words: [{ word: "cat", score: 5 }],
      score: 5,
      bingo: false,
    };
    setup(
      fresh({
        lastMove: last,
      }),
    );
    expect(screen.getAllByRole("button", { name: /A, 1 point, last play/u })).toHaveLength(1);
  });

  it("says so when it doesn't know the rules version", () => {
    const v = { ...view(fresh(), 0), ruleset: { id: "classic", version: 99 } };
    render(<Board game={envelope(NAMES, 0)} view={v} submit={vi.fn()} preview={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toContain("version of the rules");
  });
});

describe("placing tiles by tap", () => {
  it("selects a rack tile, places it on a square and returns it to the rack", () => {
    setup();
    const s = rackTile("S, 1 point");
    fireEvent.click(s);
    expect(s.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(s);
    expect(s.getAttribute("aria-pressed")).toBe("false");
    place("S, 1 point", SR + 1, SC);
    expect(screen.queryByRole("button", { name: "S, 1 point" })).toBeNull();
    expect(square(SR + 1, SC).getAttribute("aria-label")).toBe(
      "Row 9, column 8, S, 1 point, your tile, not played yet",
    );
    // Pick the placed tile up, then tap the rack to take it back.
    fireEvent.click(square(SR + 1, SC));
    expect(square(SR + 1, SC).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button("Return tile to rack"));
    expect(rackTile("S, 1 point")).toBeTruthy();
    expect(square(SR + 1, SC).getAttribute("aria-label")).toContain("empty");
  });

  it("moves a placed tile to another square", () => {
    setup();
    place("S, 1 point", SR + 1, SC);
    fireEvent.click(square(SR + 1, SC));
    fireEvent.click(square(SR + 2, SC));
    expect(square(SR + 1, SC).getAttribute("aria-label")).toContain("empty");
    expect(square(SR + 2, SC).getAttribute("aria-label")).toContain("S, 1 point");
  });

  it("puts a selected placed tile back in front of a rack tile", () => {
    setup();
    place("S, 1 point", SR + 1, SC);
    fireEvent.click(square(SR + 1, SC));
    fireEvent.click(rackTile("A, 1 point"));
    const names = within(screen.getByRole("group", { name: "Your rack" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names.indexOf("S, 1 point")).toBe(names.indexOf("A, 1 point") - 1);
  });

  it("ignores taps on played tiles and on squares with nothing selected", () => {
    setup();
    fireEvent.click(square(SR, SC - 1));
    fireEvent.click(square(SR + 1, SC));
    expect(screen.getByText("Your turn. Place tiles to make a word.")).toBeTruthy();
  });

  it("returns a placed tile with Backspace on its square", () => {
    setup();
    place("S, 1 point", SR + 1, SC);
    fireEvent.keyDown(square(SR + 1, SC), { key: "Backspace" });
    expect(rackTile("S, 1 point")).toBeTruthy();
    fireEvent.keyDown(square(SR + 1, SC), { key: "Delete" });
    fireEvent.keyDown(square(SR + 1, SC), { key: "a" });
  });

  it("recalls every placed tile", () => {
    setup();
    expect(button("Recall").hasAttribute("disabled")).toBe(true);
    place("S, 1 point", SR, SC + 2);
    place("X, 8 points", SR, SC + 3);
    fireEvent.click(button("Recall"));
    expect(rackTile("S, 1 point")).toBeTruthy();
    expect(rackTile("X, 8 points")).toBeTruthy();
  });

  it("shuffles the rack without losing a tile", () => {
    setup();
    fireEvent.click(button("Shuffle"));
    expect(
      within(screen.getByRole("group", { name: "Your rack" })).getAllByRole("button"),
    ).toHaveLength(7);
    const saved: unknown = JSON.parse(localStorage.getItem("ym.game.words.u0.g1") ?? "null");
    expect([...(saved as number[])].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("writes nothing to storage until the player reorders the rack", () => {
    setup();
    expect(localStorage.length).toBe(0);
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Recall"));
    expect(localStorage.length).toBe(0);
    fireEvent.click(button("Shuffle"));
    expect(Object.keys(localStorage)).toEqual(["ym.game.words.u0.g1"]);
  });

  it("stores only positions, under the per-user, per-game key the shell wipes", () => {
    setup();
    fireEvent.click(button("Shuffle"));
    expect(Object.keys(localStorage)).toEqual(["ym.game.words.u0.g1"]);
    expect(localStorage.getItem("ym.game.words.u0.g1")).toMatch(/^\[[\d,]+\]$/u);
  });

  it("keeps nothing for a game that is over, and clears what was kept", () => {
    localStorage.setItem("ym.game.words.u0.g1", "[2,1,0,6,3,5,4]");
    setup(fresh(), { status: "finished" });
    expect(localStorage.getItem("ym.game.words.u0.g1")).toBeNull();
  });

  it("ignores an order that doesn't fit the rack, or one saved by another account", () => {
    localStorage.setItem("ym.game.words.u0.g1", "[0,1,2]");
    localStorage.setItem("ym.game.words.u1.g1", "[2,1,0,6,3,5,4]");
    setup();
    const names = within(screen.getByRole("group", { name: "Your rack" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names[0]).toBe("A, 1 point");
  });

  it("restores the rack order saved for the game", () => {
    localStorage.setItem("ym.game.words.u0.g1", "[2,1,0,6,3,5,4]");
    setup();
    const names = within(screen.getByRole("group", { name: "Your rack" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names[0]).toBe("C, 3 points");
    expect(names.at(-1)).toBe("S, 1 point");
  });

  it("works without storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setup();
    fireEvent.click(button("Shuffle"));
    expect(rackTile("S, 1 point")).toBeTruthy();
  });
});

describe("the blank", () => {
  it("asks for a letter and shows the tile as that letter", () => {
    setup();
    place("Blank tile", SR, SC + 2);
    const dialog = screen.getByRole("dialog", { name: "Choose a letter for the blank" });
    expect(within(dialog).getAllByRole("button")).toHaveLength(27);
    fireEvent.click(within(dialog).getByRole("button", { name: "S" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(square(SR, SC + 2).getAttribute("aria-label")).toBe(
      "Row 8, column 10, Blank tile standing for S, your tile, not played yet",
    );
  });

  it("takes the blank back to the rack when the picker is dismissed", () => {
    setup();
    place("Blank tile", SR, SC + 2);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rackTile("Blank tile")).toBeTruthy();
  });

  it("closes with the Cancel button too", () => {
    setup();
    place("Blank tile", SR, SC + 2);
    fireEvent.click(button("Cancel"));
    expect(rackTile("Blank tile")).toBeTruthy();
  });

  it("keeps focus inside the dialog and returns it afterwards", () => {
    setup();
    const opener = rackTile("Blank tile");
    opener.focus();
    place("Blank tile", SR, SC + 2);
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    expect(document.activeElement).toBe(buttons[0]);
    buttons.at(-1)?.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(buttons.at(-1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(document.activeElement).not.toBe(dialog);
  });

  it("answers Escape only inside the dialog", () => {
    setup();
    place("Blank tile", SR, SC + 2);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("puts focus on the board when what opened the dialog is gone", () => {
    setup();
    rackTile("Blank tile").focus();
    place("Blank tile", SR, SC + 2);
    // The blank's rack button is unmounted while it sits on the board; cancelling brings back a
    // new one, so focus can't go back to the old element.
    fireEvent.click(button("Cancel"));
    const target = document.activeElement;
    expect(target?.getAttribute("data-square")).not.toBeNull();
    expect(target?.getAttribute("tabindex")).toBe("0");
  });
});

const PREVIEW_MS = 250;
const SERVER_MS = 600;

/** Moves fake time on and lets the promises it settles run. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("the live preview", () => {
  it("shows the local score at once, then the shell's answer", async () => {
    const { preview } = setup();
    place("S, 1 point", SR, SC + 2);
    expect(screen.getByText("+6")).toBeTruthy();
    expect(screen.getByText(/CATS 6/u)).toBeTruthy();
    expect(screen.getByText("Checking the words…")).toBeTruthy();
    expect(await screen.findByText("All words are in the word list.")).toBeTruthy();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith({
      type: "play",
      placements: [{ row: SR, col: SC + 2, tile: "s" }],
    });
  });

  it("shows the words the shell refuses and disables Play", async () => {
    setup(fresh(), { preview: { code: "INVALID_WORDS", detail: { words: ["cats"] } } });
    place("S, 1 point", SR, SC + 2);
    expect(await screen.findByText("Not in the word list: CATS.")).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(true);
  });

  it("shows the engine's reason when the tiles can't be played there", () => {
    const { preview } = setup();
    place("S, 1 point", SR + 3, SC + 3);
    expect(screen.getByText("Your play must touch a tile already on the board.")).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(true);
    expect(preview).not.toHaveBeenCalled();
  });

  it("explains each placement rule in words", () => {
    setup();
    place("S, 1 point", SR + 1, SC);
    place("X, 8 points", SR + 2, SC + 1);
    expect(screen.getByText("Tiles must all be in one row or one column.")).toBeTruthy();
    place("E, 1 point", SR + 4, SC);
    fireEvent.click(button("Recall"));
    place("S, 1 point", SR + 1, SC - 1);
    place("E, 1 point", SR + 3, SC - 1);
    expect(screen.getByText("There is a gap between your tiles.")).toBeTruthy();
  });

  it.each([
    ["a rate limit", { code: "RATE_LIMITED" }],
    ["a stale game", { code: "STALE_GAME" }],
    ["any other error", { code: "INTERNAL" }],
  ])("treats %s as not having checked, and still allows the play", async (_what, error) => {
    setup(fresh(), { preview: error });
    place("S, 1 point", SR, SC + 2);
    expect(await screen.findByText(/the server will when you play/u)).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(false);
  });

  it("disables Play for a refused placement the shell reports", async () => {
    setup(fresh(), { preview: { code: "INVALID_PLACEMENT", detail: "GAP" } });
    place("S, 1 point", SR, SC + 2);
    expect(await screen.findByText("There is a gap between your tiles.")).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(true);
  });

  it("asks once for the same tiles, even when they are taken back and put down again", async () => {
    vi.useFakeTimers();
    const { preview } = setup();
    place("S, 1 point", SR, SC + 2);
    await advance(PREVIEW_MS);
    expect(preview).toHaveBeenCalledTimes(1);
    expect(screen.getByText("All words are in the word list.")).toBeTruthy();
    fireEvent.click(button("Recall"));
    place("S, 1 point", SR, SC + 2);
    expect(screen.getByText("All words are in the word list.")).toBeTruthy();
    await advance(5000);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("waits the whole debounce (249 ms: nothing, 250 ms: one question)", async () => {
    vi.useFakeTimers();
    const { preview } = setup();
    place("S, 1 point", SR, SC + 2);
    await advance(PREVIEW_MS - 1);
    expect(preview).not.toHaveBeenCalled();
    await advance(1);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("starts the wait again when the tiles change", async () => {
    vi.useFakeTimers();
    const { preview } = setup();
    place("S, 1 point", SR, SC + 2);
    await advance(PREVIEW_MS - 1);
    place("E, 1 point", SR, SC + 3);
    await advance(PREVIEW_MS - 1);
    expect(preview).not.toHaveBeenCalled();
    await advance(1);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("doesn't show a valid answer cached for an earlier version once the shell now refuses", async () => {
    vi.useFakeTimers();
    const { preview, rerenderAt } = setup();
    place("S, 1 point", SR, SC + 2);
    await advance(PREVIEW_MS);
    expect(screen.getByText("All words are in the word list.")).toBeTruthy();
    preview.mockImplementation(() =>
      Promise.resolve({ code: "INVALID_WORDS", detail: { words: ["cats"] } } as GameError),
    );
    rerenderAt(4);
    // At once the old answer is gone and Play waits for the new one.
    expect(screen.queryByText("All words are in the word list.")).toBeNull();
    await advance(PREVIEW_MS);
    expect(screen.getByText("Not in the word list: CATS.")).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(true);
  });

  it("retries a check that couldn't be made when the tiles come back", async () => {
    const preview = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(OK_PREVIEW);
    const s = fresh();
    const game = envelope(NAMES, 0, { toAct: [0], yourTurn: true });
    render(<Board game={game} view={view(s, 0)} submit={vi.fn()} preview={preview} />);
    place("S, 1 point", SR, SC + 2);
    await screen.findByText(/the server will when you play/u);
    fireEvent.click(button("Recall"));
    place("S, 1 point", SR, SC + 2);
    expect(await screen.findByText("All words are in the word list.")).toBeTruthy();
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("waits longer before asking the server about a list only the server holds (599 ms, 600 ms)", async () => {
    vi.useFakeTimers();
    const { preview } = setup(fresh(), {
      resources: [{ kind: "dictionary", id: "x", name: "X", distribution: "serverOnly" }],
    });
    place("S, 1 point", SR, SC + 2);
    await advance(SERVER_MS - 1);
    expect(preview).not.toHaveBeenCalled();
    await advance(1);
    expect(preview).toHaveBeenCalledTimes(1);
  });

  it("keeps the score alone when the shell can't answer, and still allows the play", async () => {
    setup(fresh(), { preview: new Error("offline") });
    place("S, 1 point", SR, SC + 2);
    expect(await screen.findByText(/the server will when you play/u)).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(false);
  });

  it("uses the shell's score once it answers, bingo and all", async () => {
    setup(fresh(), { preview: { score: 99, words: [{ word: "cats", score: 99 }], bingo: false } });
    place("S, 1 point", SR, SC + 2);
    expect(await screen.findByText("+99")).toBeTruthy();
  });

  it("only previews what is still on the board", async () => {
    vi.useFakeTimers();
    const { preview } = setup();
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Recall"));
    await advance(5000);
    expect(preview).not.toHaveBeenCalled();
    expect(screen.getByText("Your turn. Place tiles to make a word.")).toBeTruthy();
  });

  it("says when a play uses every tile", () => {
    const full = state({ racks: [rack("jostled"), rack("eeeeeee")] });
    setup(full);
    const word = "jostled";
    word.split("").forEach((letter, i) => {
      place(
        `${letter.toUpperCase()}, ${letter === "j" ? "8" : "1"} point${letter === "j" ? "s" : ""}`.replace(
          "D, 1 point",
          "D, 2 points",
        ),
        SR,
        SC + i,
      );
    });
    expect(screen.getByText(/uses every tile/u)).toBeTruthy();
  });
});

describe("the status line", () => {
  it("says which tile is selected and what to do next, for the keyboard path too", () => {
    setup();
    fireEvent.click(rackTile("S, 1 point"));
    expect(screen.getByText("Tile S selected. Choose a square.")).toBeTruthy();
    fireEvent.click(rackTile("S, 1 point"));
    expect(screen.getByText("Your turn. Place tiles to make a word.")).toBeTruthy();
    fireEvent.click(rackTile("Blank tile"));
    expect(screen.getByText("Blank tile selected. Choose a square.")).toBeTruthy();
  });
});

describe("a browser that can't style the board", () => {
  it("asks the player to update instead of showing an unstyled board", () => {
    vi.stubGlobal("CSSStyleSheet", undefined);
    try {
      setup();
      expect(screen.getByRole("alert").textContent).toBe("Please update your browser to play.");
      expect(screen.queryByRole("group", { name: /^Board/u })).toBeNull();
      expect(document.head.querySelector("style")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("rules versions", () => {
  it("shows a game of a rules version this app doesn't know as an update notice", () => {
    setup(fresh(), { gameVersion: 99 });
    expect(screen.getByRole("alert").textContent).toContain("Reload the page to update");
  });
});

describe("playing", () => {
  it("submits the placed tiles and waits for the board to update", async () => {
    const { submit } = setup();
    place("S, 1 point", SR, SC + 2);
    await screen.findByText("All words are in the word list.");
    fireEvent.click(button("Play"));
    expect(submit).toHaveBeenCalledWith({
      type: "play",
      placements: [{ row: SR, col: SC + 2, tile: "s" }],
    });
    expect(await screen.findByText("Sent. Waiting for the board to update.")).toBeTruthy();
    expect(button("Play").hasAttribute("disabled")).toBe(true);
  });

  it("submits a blank with its letter", () => {
    const { submit } = setup();
    place("Blank tile", SR, SC + 2);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "S" }));
    fireEvent.click(button("Play"));
    expect(submit).toHaveBeenCalledWith({
      type: "play",
      placements: [{ row: SR, col: SC + 2, tile: "?", letter: "s" }],
    });
  });

  it("keeps the tentative tiles and says why when the server refuses", async () => {
    setup(fresh(), { submit: { ok: false, error: { code: "STALE_GAME", message: "stale" } } });
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Play"));
    expect((await screen.findByRole("alert")).textContent).toContain("The game moved on");
    expect(square(SR, SC + 2).getAttribute("aria-label")).toContain("S, 1 point");
    expect(button("Play").hasAttribute("disabled")).toBe(false);
  });

  it.each([
    [
      { code: "INVALID_WORDS", message: "", detail: { words: ["cats", "zz"] } },
      "Not in the word list: CATS, ZZ.",
    ],
    [{ code: "INVALID_WORDS", message: "" }, "Not in the word list."],
    [{ code: "NOT_YOUR_TURN", message: "" }, "It isn't your turn."],
    [{ code: "GAME_NOT_ACTIVE", message: "" }, "This game is over."],
    [{ code: "RATE_LIMITED" }, "Too many requests. Wait a moment and try again."],
    [
      { code: "SWAP_NOT_ALLOWED", message: "", detail: "BAG_TOO_SMALL" },
      "There are too few tiles in the bag to swap.",
    ],
    [
      { code: "SWAP_NOT_ALLOWED", message: "", detail: "TILE_NOT_IN_RACK" },
      "Those tiles can't be swapped.",
    ],
    [
      { code: "INVALID_PLACEMENT", message: "", detail: "ELSEWHERE" },
      "Those tiles can't be played there.",
    ],
    [{ code: "INTERNAL", message: "" }, "That couldn't be done (INTERNAL)."],
  ])("explains %j", async (error, text) => {
    setup(fresh(), { submit: { ok: false, error } });
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Play"));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
  });

  it("says so when the request itself fails", async () => {
    setup(fresh(), { submit: new Error("offline") });
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Play"));
    expect((await screen.findByRole("alert")).textContent).toContain("Check your connection");
    expect(button("Play").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the tentative tiles, the rack order and the zoom when the opponent plays", () => {
    const { rerenderAt } = setup();
    place("E, 1 point", SR - 1, SC);
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Zoom in"));
    const grid = document.querySelector<HTMLElement>(".ym-w-grid");
    const root = document.querySelector(".ym-w");
    const zoomed = grid?.style.transform;
    // The opponent plays CATS: the square under my S is now taken.
    const next = fresh({ board: board(CLASSIC, [{ row: SR, col: SC - 1, word: "cats" }]) });
    rerenderAt(4, view(next, 0));
    expect(document.querySelector(".ym-w")).toBe(root);
    expect(document.querySelector<HTMLElement>(".ym-w-grid")?.style.transform).toBe(zoomed);
    expect(square(SR - 1, SC).getAttribute("aria-label")).toContain("your tile, not played yet");
    expect(square(SR, SC + 2).getAttribute("aria-label")).toContain("S, 1 point");
    expect(square(SR, SC + 2).getAttribute("aria-label")).not.toContain("your tile");
    expect(rackTile("S, 1 point")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "E, 1 point" })).toBeNull();
  });

  it("keeps the tiles of a play that is still valid, and asks again about the new board", async () => {
    const { rerenderAt, preview } = setup();
    place("S, 1 point", SR, SC + 2);
    await vi.waitFor(() => {
      expect(preview).toHaveBeenCalledTimes(1);
    });
    rerenderAt(4);
    await vi.waitFor(() => {
      expect(preview).toHaveBeenCalledTimes(2);
    });
    expect(square(SR, SC + 2).getAttribute("aria-label")).toContain("your tile");
  });

  it("forgets that a play was sent when a new version arrives", async () => {
    const { rerenderAt } = setup();
    place("S, 1 point", SR, SC + 2);
    fireEvent.click(button("Play"));
    await screen.findByText("Sent. Waiting for the board to update.");
    rerenderAt(4);
    expect(screen.queryByText("Sent. Waiting for the board to update.")).toBeNull();
  });

  it("returns a placed tile the new rack no longer holds", () => {
    const { rerenderAt } = setup();
    place("S, 1 point", SR, SC + 2);
    const next = fresh({ racks: [rack("xe?abcz"), rack("eeeeeee")] });
    rerenderAt(4, view(next, 0));
    expect(square(SR, SC + 2).getAttribute("aria-label")).toContain("empty");
    expect(rackTile("Z, 10 points")).toBeTruthy();
  });
});

describe("swapping and passing", () => {
  it("swaps the chosen tiles", async () => {
    const { submit } = setup();
    fireEvent.click(button("Swap"));
    const dialog = screen.getByRole("dialog", { name: "Swap tiles" });
    expect(within(dialog).getByRole("button", { name: "Swap" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "X, 8 points" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Blank tile" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Blank tile" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Swap 1 tile" }));
    expect(submit).toHaveBeenCalledWith({ type: "swap", tiles: ["x"] });
    expect(await screen.findByText("Sent. Waiting for the board to update.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no swap while the bag is too small", () => {
    const small = fresh({ bag: ["e", "e", "e"] });
    const { submit } = setup(small);
    fireEvent.click(button("Swap"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("at least 7 tiles; it holds 3");
    expect(
      within(dialog).getByRole("button", { name: "X, 8 points" }).hasAttribute("disabled"),
    ).toBe(true);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says the bag is empty", () => {
    setup(fresh({ bag: [] }));
    fireEvent.click(button("Swap"));
    expect(screen.getByRole("dialog").textContent).toContain("it is empty");
  });

  it("passes after confirming, and not before", async () => {
    const { submit } = setup();
    fireEvent.click(button("Pass"));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Pass your turn?" })).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button("Pass"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Pass" }));
    expect(submit).toHaveBeenCalledWith({ type: "pass" });
    expect(await screen.findByText("Sent. Waiting for the board to update.")).toBeTruthy();
  });

  it("closes the dialog and shows the error when the server refuses", async () => {
    setup(fresh(), { submit: { ok: false, error: { code: "NOT_YOUR_TURN", message: "" } } });
    fireEvent.click(button("Pass"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Pass" }));
    expect((await screen.findByRole("alert")).textContent).toBe("It isn't your turn.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("when it isn't your turn", () => {
  it("lets you plan but not play, swap or pass, and never asks the shell", () => {
    const { preview } = setup(fresh({ turn: 1 }), { yourTurn: false });
    expect(screen.getByText("Waiting for Bo. You can plan your next play.")).toBeTruthy();
    place("S, 1 point", SR, SC + 2);
    expect(screen.getByText("+6")).toBeTruthy();
    for (const name of ["Play", "Swap", "Pass"]) {
      expect(button(name).hasAttribute("disabled")).toBe(true);
    }
    expect(preview).not.toHaveBeenCalled();
  });

  it("says to plan when nobody is to act", () => {
    const s = fresh({ turn: 1 });
    render(
      <Board
        game={envelope(NAMES, 0, { yourTurn: false, toAct: [] })}
        view={view(s, 0)}
        submit={vi.fn()}
        preview={vi.fn()}
      />,
    );
    expect(screen.getByText("Plan your next play.")).toBeTruthy();
  });

  it("shows a spectator the board and no rack", () => {
    setup(fresh(), { viewer: null });
    expect(screen.queryByRole("group", { name: "Your rack" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Row/u })).toHaveLength(225);
  });
});

describe("a finished game", () => {
  const over = (reason: "out" | "scoreless" | "resign" | "timeout" | "decline") =>
    fresh({
      finished: {
        reason,
        adjustments: [6, -6],
        leaver: reason === "out" || reason === "scoreless" ? null : 1,
      },
      scores: [18, 1],
      racks: [rack(""), rack("qzeeeee")],
      lastMove:
        reason === "out"
          ? {
              seat: 0,
              type: "play",
              placements: [{ row: 0, col: 0, tile: "a", letter: "a" }],
              words: [{ word: "aa", score: 2 }],
              score: 2,
              bingo: false,
            }
          : {
              seat: 1,
              type: reason === "decline" ? "decline" : reason === "timeout" ? "timeout" : "resign",
              score: 0,
              bingo: false,
            },
    });

  it.each([
    ["out", "Ann used their last tile. The game is over."],
    ["scoreless", "Too many turns in a row scored nothing. The game is over."],
    ["resign", "Bo resigned. The game is over."],
    ["timeout", "Bo ran out of time. The game is over."],
    ["decline", "Bo declined the game."],
  ] as const)("says how it ended (%s)", (reason, text) => {
    setup(over(reason), { status: "finished" });
    const summary = screen.getByRole("region", { name: "Game over" });
    expect(within(summary).getByRole("heading").textContent).toBe(text);
    expect(screen.queryByRole("group", { name: "Your rack" })).toBeNull();
  });

  it("shows the final scoring and the racks that were left", () => {
    setup(over("out"), { status: "finished" });
    const summary = screen.getByRole("region", { name: "Game over" });
    const rows = within(summary)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows[0]).toBe("Ann: 18 (tiles left: +6 points)");
    expect(rows[1]).toContain("Bo: 1 (tiles left: −6 points)");
    expect(within(summary).getByRole("img").getAttribute("aria-label")).toContain(
      "Q, 10 points; Z, 10 points",
    );
  });

  it("shows a resignation's scores as they were, with no adjustment", () => {
    setup(over("resign"), { status: "finished" });
    const rows = within(screen.getByRole("region", { name: "Game over" }))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows[0]).toBe("Ann: 18");
  });

  it("shows no change for a zero adjustment", () => {
    const s = over("scoreless");
    setup(
      { ...s, finished: { reason: "scoreless", adjustments: [0, -6], leaver: null } },
      { status: "finished" },
    );
    expect(screen.getByText(/tiles left: no change/u)).toBeTruthy();
  });

  it("falls back to 'a player' when there is no last move", () => {
    setup({ ...over("resign"), lastMove: null }, { status: "finished" });
    expect(screen.getByText("A player resigned. The game is over.")).toBeTruthy();
  });
});
