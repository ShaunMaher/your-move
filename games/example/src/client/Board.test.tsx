// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GameError, SubmitResult } from "@your-move/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exampleV1 as game } from "../engine/definition.js";
import type { PreviewResult } from "../engine/index.js";
import type { State } from "../engine/state.js";
import { envelope, noRandom, state } from "../test-support.js";
import { Board } from "./Board.js";

afterEach(cleanup);

const NAMES = ["Ann", "Bo", null];

function renderBoard(
  s: State,
  viewer: number | null,
  answers: {
    submit?: SubmitResult;
    preview?: PreviewResult | GameError;
  } = {},
) {
  const refused: SubmitResult = { ok: false, error: { code: "STALE_GAME", message: "" } };
  const submit = vi.fn(() => Promise.resolve(answers.submit ?? refused));
  const preview = vi.fn(() => Promise.resolve(answers.preview ?? { handAfter: [] }));
  render(
    <Board
      game={envelope(NAMES, viewer)}
      view={game.view(s, viewer)}
      submit={submit}
      preview={preview}
    />,
  );
  return { submit, preview };
}

const fresh = state({
  hands: [
    [1, 5, 9],
    [2, 6, 10],
    [3, 7, 11],
  ],
});

describe("Board", () => {
  it("lists every player with lives, points and whether they have played", () => {
    renderBoard(game.apply(fresh, 1, { card: 6 }, noRandom).state, 0);
    expect(screen.getByRole("heading", { name: "Round 1" })).toBeTruthy();
    const players = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(players).toEqual([
      "Ann (you): 2 lives, 0 points, choosing a card",
      "Bo: 2 lives, 0 points, has played",
      "Seat 3: 2 lives, 0 points, choosing a card",
    ]);
    expect(screen.getByText("11 cards left in the deck")).toBeTruthy();
  });

  it("selects a card, previews what stays in hand and plays it", async () => {
    const { submit, preview } = renderBoard(fresh, 0, {
      preview: { handAfter: [1, 9] },
      submit: { ok: true, game: envelope(NAMES, 0), view: null },
    });
    const hand = screen.getByRole("group", { name: "Your hand" });
    const five = screen.getByRole("button", { name: "5" });
    expect(hand.contains(five)).toBe(true);
    expect(five.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(five);
    expect(five.getAttribute("aria-pressed")).toBe("true");
    expect(preview).toHaveBeenCalledWith({ card: 5 });
    expect(await screen.findByText("You will keep 1, 9.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Play 5" }));
    expect(submit).toHaveBeenCalledWith({ card: 5 });
    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "Play 5" })).toBeNull();
    });
  });

  it("shows only the latest choice's preview, and none for an error", async () => {
    let resolveFirst: (answer: PreviewResult) => void = () => undefined;
    const preview = vi
      .fn<(action: { card: number }) => Promise<PreviewResult | GameError>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ code: "NOT_IN_HAND" });
    render(
      <Board
        game={envelope(NAMES, 0)}
        view={game.view(fresh, 0)}
        submit={vi.fn()}
        preview={preview}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "1" }));
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    resolveFirst({ handAfter: [5, 9] });
    await vi.waitFor(() => {
      expect(preview).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByText(/You will keep/u)).toBeNull();
  });

  it("says when the last card would leave an empty hand", async () => {
    renderBoard(state({ hands: [[4], [5]] }), 0, { preview: { handAfter: [] } });
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(await screen.findByText("You will keep no cards.")).toBeTruthy();
  });

  it("shows why a play was refused", async () => {
    renderBoard(fresh, 0);
    fireEvent.click(screen.getByRole("button", { name: "9" }));
    fireEvent.click(screen.getByRole("button", { name: "Play 9" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "That card couldn't be played (STALE_GAME).",
    );
  });

  it("waits for the others once the viewer has played", () => {
    renderBoard(game.apply(fresh, 0, { card: 5 }, noRandom).state, 0);
    expect(screen.getByText("You played 5. Waiting for the others to play.")).toBeTruthy();
    for (const card of ["1", "9"]) {
      expect(screen.getByRole("button", { name: card }).hasAttribute("disabled")).toBe(true);
    }
  });

  it("shows the public viewer no hand", () => {
    renderBoard(fresh, null);
    expect(screen.queryByRole("group", { name: "Your hand" })).toBeNull();
  });

  it("reveals the last round's cards and its outcome", () => {
    const lives = [2, 1, 2];
    let s = state({
      hands: [
        [1, 5],
        [2, 6],
        [3, 7],
      ],
      lives,
    });
    s = game.apply(s, 0, { card: 5 }, noRandom).state;
    s = game.apply(s, 1, { card: 2 }, noRandom).state;
    s = game.apply(s, 2, { card: 7 }, noRandom).state;
    renderBoard(s, 0);
    expect(
      screen.getByText(
        "Round 1: Ann 5, Bo 2, Seat 3 7. Seat 3 scores a point; Bo loses a life and is out.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Bo: 0 lives, 0 points, out$/u)).toBeTruthy();
  });

  it("shows a round outcome without an elimination", () => {
    let s = state({
      hands: [
        [1, 5],
        [2, 6],
      ],
    });
    s = game.apply(s, 0, { card: 5 }, noRandom).state;
    s = game.apply(s, 1, { card: 2 }, noRandom).state;
    renderBoard(s, 0);
    expect(screen.getByText(/Ann scores a point; Bo loses a life\.$/u)).toBeTruthy();
  });

  it("shows the end and every hand once the game is over", () => {
    const over = state({
      hands: [[4], [], [8]],
      status: ["playing", "out", "playing"],
      endReason: "cards-exhausted",
      deck: [],
    });
    renderBoard(over, 0);
    expect(screen.getByRole("heading", { name: "Game over: the cards ran out." })).toBeTruthy();
    expect(screen.getByText("Ann (you): 2 lives, 0 points, still in; held 4")).toBeTruthy();
    expect(screen.getByText("Bo: 2 lives, 0 points, out")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Your hand" })).toBeNull();
  });

  it("names a last-standing end", () => {
    const won = state({ hands: [[], [1]], status: ["out", "playing"], endReason: "last-standing" });
    renderBoard(won, 1);
    expect(
      screen.getByRole("heading", { name: "Game over: one player left standing." }),
    ).toBeTruthy();
  });
});
