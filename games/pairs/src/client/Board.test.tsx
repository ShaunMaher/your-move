// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { GameEnvelope, SubmitResult } from "@your-move/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { view as viewOf } from "../engine/present.js";
import { flip, type State } from "../engine/state.js";
import { envelope, game } from "../test-support.js";
import "./dom-setup.js";
import { Board } from "./Board.js";
import { FLIP_MS } from "./styles.js";

const NAMES = ["Ann", "Sam"];
const SENT: SubmitResult = { ok: true, game: envelope(NAMES, 0), view: null };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

interface Shell {
  submit?: SubmitResult | Error | Promise<SubmitResult>;
  viewer?: number | null;
  status?: GameEnvelope["status"];
  gameVersion?: number;
  names?: (string | null)[];
}

function setup(state: State = game(), shell: Shell = {}) {
  const viewer = shell.viewer === undefined ? 0 : shell.viewer;
  const submit = vi.fn(() =>
    shell.submit instanceof Error
      ? Promise.reject(shell.submit)
      : Promise.resolve(shell.submit ?? SENT),
  );
  const base = envelope(shell.names ?? NAMES, viewer, {
    options: state.options,
    ...(shell.status === undefined ? {} : { status: shell.status }),
    ...(shell.gameVersion === undefined ? {} : { gameVersion: shell.gameVersion }),
  });
  const ui = (version: number, next: State = state) => (
    <Board
      game={{
        ...base,
        version,
        toAct: next.turn === null ? [] : [next.turn],
        yourTurn: viewer !== null && viewer === next.turn,
      }}
      view={viewOf(next)}
      submit={submit}
      preview={vi.fn(() => Promise.resolve(null))}
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

const card = (row: number, column: number): HTMLElement => {
  const rows = [...screen.getByRole("grid", { name: "Cards" }).querySelectorAll('[role="row"]')];
  const found = rows[row]?.querySelectorAll<HTMLElement>("button").item(column);
  if (found === undefined) throw new Error("no such card");
  return found;
};
const cards = (): HTMLElement[] => [
  ...screen.getByRole("grid", { name: "Cards" }).querySelectorAll<HTMLElement>("button"),
];
const status = (): string => screen.getByRole("status").textContent;
const turnLine = (): HTMLElement | null => document.querySelector<HTMLElement>(".ym-pr-turn");

/** The layout of the default table: cards 2k and 2k + 1 hold face k (0 acorn, 1 apple, 2 bell...). */
const FACE_NAMES = [
  "acorn",
  "apple",
  "bell",
  "boat",
  "cat",
  "cloud",
  "fish",
  "flower",
  "house",
  "key",
];

describe("the table", () => {
  it("shows the players with their numbers and pairs, and whose turn it is (pairs §9)", () => {
    setup(
      game({
        matched: [
          [0, 0],
          [1, 0],
          [2, 1],
          [3, 1],
        ],
        moves: 20,
        seats: 2,
      }),
    );
    expect(screen.getByRole("region", { name: "Pairs board" })).toBeTruthy();
    const players = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(players.map((li) => li.textContent)).toEqual(
      ["Player 1Ann, you· 1 pair", "Player 2Sam· 1 pair"].map((text) => text),
    );
    expect(players.map((li) => li.getAttribute("aria-current"))).toEqual(["true", "false"]);
    expect(turnLine()?.textContent).toBe("Your turn: turn over a card");
    expect(turnLine()?.getAttribute("data-yours")).toBe("true");
  });

  it("shows a player who left as out, with the pairs they keep", () => {
    setup(
      game({
        seats: 3,
        out: [null, { atMove: 4, reason: "resigned" }, null],
        matched: [
          [0, 1],
          [1, 1],
        ],
      }),
      { names: ["Ann", "Sam", "Bo"] },
    );
    const players = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(players[1]?.textContent).toContain("· out (1)");
    expect(players[1]?.getAttribute("data-out")).toBe("true");
    expect(players[0]?.getAttribute("data-out")).toBe("false");
  });

  it("is a grid labelled Cards with a row per row and a gridcell holding each card's button", () => {
    setup();
    const grid = screen.getByRole("grid", { name: "Cards" });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      const cells = within(row).getAllByRole("gridcell");
      expect(cells).toHaveLength(4);
      for (const cell of cells) expect(within(cell).getAllByRole("button")).toHaveLength(1);
    }
    expect(grid.getAttribute("data-cols")).toBe("4");
  });

  it.each([
    ["4x4", 4, 4],
    ["4x5", 4, 5],
    ["5x6", 5, 6],
    ["6x6", 6, 6],
  ] as const)("draws a %s grid as %i columns by %i rows", (id, columns, rows) => {
    setup(game({ grid: id }));
    expect(screen.getAllByRole("row")).toHaveLength(rows);
    expect(cards()).toHaveLength(columns * rows);
    expect(screen.getByRole("grid", { name: "Cards" }).getAttribute("data-cols")).toBe(
      String(columns),
    );
  });

  it("is one tab stop: the focused card, moved with the arrow keys, Home and End", () => {
    setup();
    expect(cards().filter((c) => c.tabIndex === 0)).toHaveLength(1);
    expect(card(0, 0).tabIndex).toBe(0);
    fireEvent.keyDown(card(0, 0), { key: "ArrowRight" });
    expect(document.activeElement).toBe(card(0, 1));
    expect(card(0, 1).tabIndex).toBe(0);
    expect(card(0, 0).tabIndex).toBe(-1);
    fireEvent.keyDown(card(0, 1), { key: "ArrowDown" });
    expect(document.activeElement).toBe(card(1, 1));
    fireEvent.keyDown(card(1, 1), { key: "End" });
    expect(document.activeElement).toBe(card(1, 3));
    fireEvent.keyDown(card(1, 3), { key: "Home" });
    expect(document.activeElement).toBe(card(1, 0));
    fireEvent.keyDown(card(1, 0), { key: "End", ctrlKey: true });
    expect(document.activeElement).toBe(card(4, 3));
    fireEvent.keyDown(card(4, 3), { key: "Home", ctrlKey: true });
    expect(document.activeElement).toBe(card(0, 0));
    // The edges stop; the keys do nothing more.
    fireEvent.keyDown(card(0, 0), { key: "ArrowUp" });
    fireEvent.keyDown(card(0, 0), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(card(0, 0));
    // A tap moves the one tab stop too.
    fireEvent.focus(card(2, 2));
    expect(card(2, 2).tabIndex).toBe(0);
    expect(cards().filter((c) => c.tabIndex === 0)).toHaveLength(1);
  });

  it("names the players who share a display name with their number (pairs §9)", () => {
    setup(game(), { names: ["Ann", "Ann"] });
    const players = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(players.map((li) => li.querySelector(".ym-pr-who")?.textContent)).toEqual([
      "Ann (player 1), you",
      "Ann (player 2)",
    ]);
  });
});

describe("accessible names (pairs §9)", () => {
  it("name a card face down by its place alone", () => {
    setup();
    expect(card(1, 2).getAttribute("aria-label")).toBe("Row 2, column 3, face down");
  });

  it("name the first card as yours or the other player's", () => {
    // Ann's first card, the apple at (row 1, column 0): index 4 holds face 2 (bell).
    setup(game({ turned: 4 }));
    expect(card(1, 0).getAttribute("aria-label")).toBe("Row 2, column 1, bell, your first card");
    cleanup();
    setup(game({ turned: 4, turn: 1 }));
    expect(card(1, 0).getAttribute("aria-label")).toBe("Row 2, column 1, bell, Sam's first card");
  });

  it("name the missed pair with whose turn it was and when it turns down", () => {
    setup(game({ lastMiss: { seat: 1, cards: [0, 6] } }));
    expect(card(0, 0).getAttribute("aria-label")).toBe(
      "Row 1, column 1, acorn, Sam's last turn, turns face down at the next first card",
    );
    expect(card(1, 2).getAttribute("aria-label")).toBe(
      "Row 2, column 3, boat, Sam's last turn, turns face down at the next first card",
    );
  });

  it("name a matched card with who found it", () => {
    setup(
      game({
        matched: [
          [2, 0],
          [3, 0],
          [4, 1],
          [5, 1],
        ],
      }),
    );
    expect(card(0, 2).getAttribute("aria-label")).toBe("Row 1, column 3, apple, matched by you");
    expect(card(1, 1).getAttribute("aria-label")).toBe("Row 2, column 2, bell, matched by Sam");
  });

  it("name the cards of a stopped game without the in-play hints", () => {
    setup(game({ turned: 4, turn: 1, lastMiss: null }), { status: "cancelled" });
    expect(card(1, 0).getAttribute("aria-label")).toBe(
      "Row 2, column 1, bell, Sam's first card when the game stopped",
    );
    cleanup();
    setup(game({ lastMiss: { seat: 1, cards: [0, 6] } }), { status: "cancelled" });
    expect(card(0, 0).getAttribute("aria-label")).toBe("Row 1, column 1, acorn, Sam's last turn");
    // The cards still face down stay blank, with no line saying how the game ended.
    expect(card(2, 2).getAttribute("aria-label")).toBe("Row 3, column 3, face down");
    expect(document.querySelector(".ym-pr-final")).toBeNull();
    expect(document.querySelector(".ym-pr-turn")).toBeNull();
  });
});

describe("a card the view shows face down never has a face in the page", () => {
  it("renders only the back: no face element, class, key, data attribute, title or text", () => {
    setup(game({ turned: 4 }));
    const down = card(0, 3);
    expect(card(0, 2).innerHTML).toBe(down.innerHTML);
    expect(down.querySelector(".ym-pr-face, .ym-pr-ghost, .ym-pr-badge")).toBeNull();
    expect(down.querySelectorAll("svg")).toHaveLength(1);
    expect(down.querySelector("svg")?.getAttribute("class")).toContain("ym-pr-back");
    expect(down.textContent).toBe("");
    for (const attribute of down.getAttributeNames()) {
      expect(attribute).toMatch(/^(class|type|aria-label|aria-disabled|tabindex|data-state)$/u);
    }
    expect(down.getAttribute("data-state")).toBe("down");
    expect(down.getAttribute("title")).toBeNull();
    // No face name anywhere in the down cards' markup or names.
    for (const name of FACE_NAMES) {
      for (const other of cards().filter((c) => c.getAttribute("data-state") === "down")) {
        expect(other.outerHTML).not.toContain(name);
      }
    }
  });

  it("holds an old face only for the flip, then removes the node (the missed pair, once the next first card is turned)", () => {
    vi.useFakeTimers();
    const miss = game({ lastMiss: { seat: 1, cards: [0, 6] } });
    const { rerenderAt } = setup(miss);
    expect(card(0, 0).querySelector(".ym-pr-face")).not.toBeNull();
    const pristine = card(2, 2).innerHTML;
    // Ann turns a first card: the pair goes face down.
    rerenderAt(4, flip(miss, 0, 9).state);
    expect(card(0, 0).getAttribute("data-state")).toBe("down");
    // For the flip's duration the old face is drawn, decorative and gone from the names.
    expect(card(0, 0).querySelector(".ym-pr-ghost")?.getAttribute("aria-hidden")).toBe("true");
    expect(card(0, 0).getAttribute("aria-label")).toBe("Row 1, column 1, face down");
    act(() => {
      vi.advanceTimersByTime(FLIP_MS);
    });
    for (const spot of [card(0, 0), card(1, 2)]) {
      expect(spot.querySelector(".ym-pr-ghost, .ym-pr-face")).toBeNull();
      expect(spot.innerHTML).toBe(pristine);
      expect(spot.outerHTML).not.toMatch(/acorn|boat|ym-pr-k|ym-pr-flip/u);
    }
  });

  it("draws no old face at all with prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce") }));
    const miss = game({ lastMiss: { seat: 1, cards: [0, 6] } });
    const { rerenderAt } = setup(miss);
    rerenderAt(4, flip(miss, 0, 9).state);
    expect(card(0, 0).querySelector(".ym-pr-ghost, .ym-pr-face")).toBeNull();
    // And a face that appears doesn't flip in.
    expect(card(2, 1).querySelector(".ym-pr-flip-in")).toBeNull();
  });

  it("flips a face in when the view gives one", () => {
    const { rerenderAt } = setup();
    rerenderAt(4, flip(game(), 0, 9).state);
    expect(card(2, 1).querySelector(".ym-pr-face.ym-pr-flip-in")).not.toBeNull();
    expect(card(2, 1).getAttribute("data-state")).toBe("up");
  });

  it("uses no storage", () => {
    const get = vi.spyOn(Storage.prototype, "getItem");
    const set = vi.spyOn(Storage.prototype, "setItem");
    const miss = game({ lastMiss: { seat: 1, cards: [0, 6] } });
    const { rerenderAt } = setup(miss);
    rerenderAt(4, flip(miss, 0, 9).state);
    expect(get).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("keys no element by a face: the cards are keyed by position, so a face change keeps the node", () => {
    const { rerenderAt } = setup();
    const before = card(2, 1);
    rerenderAt(4, flip(game(), 0, 9).state);
    expect(card(2, 1)).toBe(before);
  });
});

describe("the missed pair's reveal when a turn opens (pairs §9)", () => {
  const miss = (): State => game({ lastMiss: { seat: 1, cards: [0, 6] }, turn: 0 });

  it("draws each missed card face up with its own outline and the number of the player whose turn it was", () => {
    setup(miss());
    for (const spot of [card(0, 0), card(1, 2)]) {
      expect(spot.getAttribute("data-state")).toBe("missed");
      expect(spot.querySelector(".ym-pr-badge")?.textContent).toBe("2");
      expect(spot.querySelector(".ym-pr-face")).not.toBeNull();
    }
    expect(status()).toBe(
      "Sam's last turn: acorn (row 1, column 1) and boat (row 2, column 3). They turn face down when you turn your first card.",
    );
  });

  it("lets a missed card be tapped as the first card", async () => {
    const { submit } = setup(miss());
    await settle(() => fireEvent.click(card(0, 0)));
    expect(submit).toHaveBeenCalledWith({ type: "flip", row: 0, column: 0 });
  });

  it("says the same off turn, without the reminder", () => {
    setup(game({ lastMiss: { seat: 0, cards: [0, 6] }, turn: 1 }), { viewer: 0 });
    expect(status()).toBe("Your last turn: acorn (row 1, column 1) and boat (row 2, column 3).");
    cleanup();
    setup(game({ lastMiss: { seat: 1, cards: [0, 6] }, turn: 0 }), { viewer: null });
    expect(status()).toContain(
      "Sam's last turn: acorn (row 1, column 1) and boat (row 2, column 3).",
    );
    expect(status()).not.toContain("They turn face down");
  });
});

describe("turning a card (pairs §9)", () => {
  it("submits a flip for a face down card on a tap, once, with every card inactive meanwhile", async () => {
    let answer: (result: SubmitResult) => void = () => undefined;
    const pending = new Promise<SubmitResult>((resolve) => {
      answer = resolve;
    });
    const { submit } = setup(game(), { submit: pending });
    await settle(() => fireEvent.click(card(2, 1)));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ type: "flip", row: 2, column: 1 });
    // The tapped card shows a turning state; it is still a card with no face.
    expect(card(2, 1).getAttribute("data-turning")).toBe("true");
    expect(card(2, 1).querySelector(".ym-pr-face")).toBeNull();
    expect(cards().every((c) => c.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(screen.getByRole("grid").getAttribute("aria-busy")).toBe("true");
    // A second tap while it is in flight does nothing.
    await settle(() => fireEvent.click(card(0, 0)));
    expect(submit).toHaveBeenCalledTimes(1);
    await settle(() => {
      answer(SENT);
    });
    expect(card(2, 1).getAttribute("data-turning")).toBeNull();
  });

  it("shows the face only from the view the submit returns", async () => {
    const { rerenderAt, submit } = setup();
    await settle(() => fireEvent.click(card(2, 1)));
    expect(submit).toHaveBeenCalled();
    expect(card(2, 1).getAttribute("data-state")).toBe("down");
    rerenderAt(4, flip(game(), 0, 9).state);
    expect(card(2, 1).getAttribute("aria-label")).toBe("Row 3, column 2, cat, your first card");
    expect(card(2, 1).getAttribute("data-turning")).toBeNull();
    // The new view opened the board for the second card.
    expect(cards().filter((c) => c.getAttribute("aria-disabled") === "false")).toHaveLength(19);
    expect(card(2, 1).getAttribute("aria-disabled")).toBe("true");
    expect(turnLine()?.textContent).toBe("Your turn: turn over a second card");
    expect(status()).toBe("You turned over a cat (row 3, column 2).");
  });

  it("opens again for the next card when the view comes back before the submit settles", async () => {
    // The shell applies the returned view and then resolves the submit.
    const first = game();
    const second = flip(first, 0, 9).state;
    let rerender: (version: number, state: State) => void = () => undefined;
    const submit = vi.fn((): Promise<SubmitResult> => {
      rerender(4, second);
      return Promise.resolve(SENT);
    });
    const base = envelope(NAMES, 0);
    const ui = (version: number, state: State) => (
      <Board
        game={{ ...base, version, toAct: [0], yourTurn: true }}
        view={viewOf(state)}
        submit={submit}
        preview={vi.fn(() => Promise.resolve(null))}
      />
    );
    const result = render(ui(3, first));
    rerender = (version, state) => {
      result.rerender(ui(version, state));
    };
    await settle(() => fireEvent.click(card(2, 1)));
    expect(card(0, 0).getAttribute("aria-disabled")).toBe("false");
    await settle(() => fireEvent.click(card(0, 0)));
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("ignores a tap on a matched card or the first card", async () => {
    const { submit } = setup(
      game({
        matched: [
          [0, 1],
          [1, 1],
        ],
        turned: 4,
      }),
    );
    await settle(() => fireEvent.click(card(0, 0)));
    await settle(() => fireEvent.click(card(1, 0)));
    expect(submit).not.toHaveBeenCalled();
    expect(card(0, 0).getAttribute("aria-disabled")).toBe("true");
    expect(card(1, 0).getAttribute("aria-disabled")).toBe("true");
  });

  it("is inactive off turn: aria-disabled, still focusable, and a tap does nothing", async () => {
    const { submit } = setup(game({ turn: 1 }));
    expect(cards().every((c) => c.getAttribute("aria-disabled") === "true")).toBe(true);
    expect(cards().some((c) => c.hasAttribute("disabled"))).toBe(false);
    card(1, 1).focus();
    expect(document.activeElement).toBe(card(1, 1));
    await settle(() => fireEvent.click(card(1, 1)));
    expect(submit).not.toHaveBeenCalled();
    expect(turnLine()?.textContent).toBe("Sam to play");
    expect(turnLine()?.getAttribute("data-yours")).toBe("false");
    expect(status()).toBe("Sam to play.");
  });

  it("names what the other player turned over", () => {
    setup(game({ turn: 1, turned: 9 }), { viewer: 0 });
    expect(status()).toBe("Sam turned over a cat (row 3, column 2).");
  });

  it("is inactive for someone who isn't playing, and for a seat that is out", async () => {
    const { submit } = setup(game(), { viewer: null });
    await settle(() => fireEvent.click(card(0, 0)));
    expect(submit).not.toHaveBeenCalled();
    cleanup();
    setup(game({ seats: 3, turn: 2, out: [{ atMove: 2, reason: "timed_out" }, null, null] }), {
      names: ["Ann", "Sam", "Bo"],
    });
    expect(status()).toBe("Bo to play.You're out of this game. You can watch it finish.");
  });

  it("turns an answer from the server into a message, and keeps the board open", async () => {
    setup(game(), {
      submit: { ok: false, error: { code: "CARD_FACE_UP", message: "x" } },
    });
    await settle(() => fireEvent.click(card(0, 0)));
    expect(status()).toBe("That card is already face up. Pick another.");
    expect(card(0, 1).getAttribute("aria-disabled")).toBe("false");
  });

  it("tells the player when the request couldn't be sent", async () => {
    setup(game(), { submit: new Error("offline") });
    await settle(() => fireEvent.click(card(0, 0)));
    expect(status()).toBe("Couldn't send your move. Check your connection and try again.");
    expect(card(0, 1).getAttribute("aria-disabled")).toBe("false");
  });
});

describe("the second card's outcome (pairs §9)", () => {
  const first = (): State => game({ turned: 0, matched: [], turn: 0 });

  it("says a pair was found and that it is your turn again", () => {
    const before = first();
    const { rerenderAt } = setup(before);
    rerenderAt(4, flip(before, 0, 1).state);
    expect(status()).toBe("A pair of acorns! Your turn again.");
    expect(card(0, 0).getAttribute("data-state")).toBe("matched");
    expect(card(0, 0).querySelector(".ym-pr-badge")?.textContent).toBe("✓" + "1");
    expect(turnLine()?.textContent).toBe("Your turn: turn over a card");
  });

  it("says there was no match and who is to play", () => {
    const before = first();
    const { rerenderAt } = setup(before);
    rerenderAt(4, flip(before, 0, 2).state);
    expect(status()).toBe(
      "No match. Sam to play.Your last turn: acorn (row 1, column 1) and apple (row 1, column 3).",
    );
    expect(turnLine()?.textContent).toBe("Sam to play");
  });

  it("is replaced by the next change of view", () => {
    const before = first();
    const { rerenderAt } = setup(before);
    const missed = flip(before, 0, 2).state;
    rerenderAt(4, missed);
    rerenderAt(5, flip(missed, 1, 9).state);
    expect(status()).toBe("Sam turned over a cat (row 3, column 2).");
  });

  it("says nothing special about another player's turn", () => {
    const before = game({ turned: 0, turn: 1 });
    const { rerenderAt } = setup(before);
    rerenderAt(4, flip(before, 1, 2).state);
    expect(status()).not.toContain("No match");
    expect(status()).toBe(
      "Sam's last turn: acorn (row 1, column 1) and apple (row 1, column 3). They turn face down when you turn your first card.",
    );
  });
});

describe("matched cards", () => {
  it("are dimmed, with a check and their finder's number, and can't be turned", () => {
    setup(
      game({
        matched: [
          [0, 1],
          [1, 1],
        ],
      }),
    );
    const matched = card(0, 0);
    expect(matched.getAttribute("data-state")).toBe("matched");
    expect(matched.querySelector(".ym-pr-badge")?.textContent).toBe("✓" + "2");
    expect(matched.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("near the move limit (pairs §9)", () => {
  // 4x5: 10 pairs, limit 400. Two players: the line appears from fewer than 4 moves left.
  it.each([
    [396, false],
    [397, true],
    [399, true],
  ])("with %i moves played, shows the moves left: %s", (moves, shown) => {
    setup(game({ moves }));
    const text = turnLine()?.textContent ?? "";
    expect(text.includes("left")).toBe(shown);
    if (shown)
      expect(text).toBe(
        `Your turn: turn over a card · ${String(400 - moves)} move${moves === 399 ? "" : "s"} left`,
      );
  });

  it("says one move left in the singular", () => {
    setup(game({ moves: 399 }));
    expect(turnLine()?.textContent).toBe("Your turn: turn over a card · 1 move left");
  });

  it("counts only the seats still playing, so more players show it earlier", () => {
    setup(game({ seats: 3, moves: 395 }), { names: ["Ann", "Sam", "Bo"] });
    expect(turnLine()?.textContent).toContain("5 moves left");
    cleanup();
    setup(game({ seats: 3, moves: 395, out: [null, { atMove: 1, reason: "resigned" }, null] }), {
      names: ["Ann", "Sam", "Bo"],
    });
    // Two playing: the line shows from fewer than 4 moves left, and 5 is more.
    expect(turnLine()?.textContent).not.toContain("left");
  });
});

describe("a finished game (pairs §9)", () => {
  const over = (
    endReason: NonNullable<State["endReason"]>,
    fields: Partial<State> = {},
  ): State => ({
    ...game({
      matched: [
        [0, 0],
        [1, 0],
        [2, 1],
        [3, 1],
      ],
      turn: null,
    }),
    endReason,
    turn: null,
    ...fields,
  });

  it("offers no tap and no turn line, and draws every card's face", () => {
    setup(over("move-limit"), { status: "finished" });
    expect(turnLine()).toBeNull();
    expect(cards().every((c) => c.getAttribute("aria-disabled") === "true")).toBe(true);
    // A card that was never found shows its face, as not found, with a face and no badge.
    expect(card(1, 0).getAttribute("aria-label")).toBe("Row 2, column 1, bell, not found");
    expect(card(1, 0).getAttribute("data-state")).toBe("unfound");
    expect(card(1, 0).querySelector(".ym-pr-face")).not.toBeNull();
    expect(card(1, 0).querySelector(".ym-pr-badge")).toBeNull();
    expect(card(0, 0).getAttribute("aria-label")).toBe("Row 1, column 1, acorn, matched by you");
  });

  const ENDINGS: [NonNullable<State["endReason"]>, Partial<State>, string][] = [
    ["all-found", {}, "All the pairs were found."],
    [
      "last-standing",
      { out: [null, { atMove: 3, reason: "resigned" }] },
      "Only Ann was left playing.",
    ],
    ["move-limit", {}, "The move limit (400 moves) was reached with 8 pairs still face down."],
  ];

  it.each(ENDINGS)("says in its own words how it ended: %s", (reason, fields, line) => {
    setup(over(reason, fields), { status: "finished" });
    const summary = screen.getByRole("region", { name: "How it ended" });
    expect(within(summary).getByText(line)).toBeTruthy();
    expect(
      within(summary)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Ann found 1 pair.",
      reason === "last-standing" ? "Sam found 1 pair and left the game." : "Sam found 1 pair.",
    ]);
  });

  it("names the only seat left, and the one pair still down in the singular", () => {
    setup(over("last-standing", { out: [{ atMove: 3, reason: "timed_out" }, null] }), {
      status: "finished",
    });
    expect(screen.getByText("Only Sam was left playing.")).toBeTruthy();
    cleanup();
    setup(
      {
        ...over("move-limit"),
        matchedBy: game().matchedBy.map((_, i) => (i < 18 ? 0 : null)),
      },
      { status: "finished" },
    );
    expect(screen.getByText(/with 1 pair still face down\./u)).toBeTruthy();
  });
});

describe("the module's guards", () => {
  it("says to update when the browser has no constructable stylesheets", () => {
    const sheets = Object.getOwnPropertyDescriptor(document, "adoptedStyleSheets");
    vi.stubGlobal("CSSStyleSheet", undefined);
    vi.resetModules();
    return import("./Board.js").then(({ Board: Fresh }) => {
      render(
        <Fresh
          game={envelope(NAMES, 0)}
          view={viewOf(game())}
          submit={vi.fn()}
          preview={vi.fn()}
        />,
      );
      expect(screen.getByRole("alert").textContent).toBe("Please update your browser to play.");
      if (sheets !== undefined) Object.defineProperty(document, "adoptedStyleSheets", sheets);
    });
  });

  it("asks for a reload for a rules version it doesn't know", () => {
    setup(game(), { gameVersion: 2 });
    expect(screen.getByRole("alert").textContent).toContain("Reload the page");
    expect(screen.queryByRole("grid")).toBeNull();
  });
});
