// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { exampleV1 as game } from "../engine/definition.js";
import { client } from "./index.js";

afterEach(cleanup);

const { OptionsForm, RulesSheet, HistoryItem } = client;
const catalog = game.catalog({ config: {}, resources: [] });

describe("OptionsForm", () => {
  it("offers each option's range with the default selected", () => {
    render(<OptionsForm catalog={catalog} value={{}} onChange={vi.fn()} />);
    const hand = screen.getByRole<HTMLSelectElement>("combobox", { name: "Cards in hand" });
    expect([...hand.options].map((option) => option.value)).toEqual(["3", "4", "5", "6"]);
    expect(hand.value).toBe("3");
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Lives" }).value).toBe("2");
  });

  it("edits the unresolved input, keeping the other fields", () => {
    const onChange = vi.fn();
    render(<OptionsForm catalog={catalog} value={{ lives: 3 }} onChange={onChange} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Lives" }).value).toBe("3");
    fireEvent.change(screen.getByRole("combobox", { name: "Cards in hand" }), {
      target: { value: "5" },
    });
    expect(onChange).toHaveBeenCalledWith({ lives: 3, handSize: 5 });
  });

  it("treats a missing value as all defaults", () => {
    render(<OptionsForm catalog={catalog} value={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Lives" }).value).toBe("2");
  });

  it("says so when the catalog isn't one it understands", () => {
    render(<OptionsForm catalog={{ decks: 2 }} value={{}} onChange={vi.fn()} />);
    expect(screen.getByText("The options for this game are unavailable.")).toBeTruthy();
  });
});

describe("RulesSheet", () => {
  it("renders the manifest rules as headings, lists and paragraphs of plain text", () => {
    render(<RulesSheet options={{ handSize: 4, lives: 1 }} gameVersion={1} />);
    expect(screen.getByText("This game: 4 cards in hand, 1 life.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Example" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Rounds" })).toBeTruthy();
    expect(screen.getByText(/^A small card game for 2 to 4 players/u)).toBeTruthy();
    expect(screen.getByText("A player with no lives left is out.").tagName).toBe("LI");
  });

  it("says so for a rules version it doesn't know", () => {
    render(<RulesSheet options={{ handSize: 3, lives: 2 }} gameVersion={9} />);
    expect(screen.getByText("The rules for this version are unavailable.")).toBeTruthy();
  });
});

describe("HistoryItem", () => {
  it("renders a record with the shell's names", () => {
    render(
      <HistoryItem
        record={{ kind: "played", seat: 1, round: 2 }}
        describe={["stored text"]}
        gameVersion={1}
        names={["Ann", "Bo"]}
      />,
    );
    expect(screen.getByText("Bo played a card in round 2")).toBeTruthy();
  });

  it("falls back to the stored describe text for a record or version it can't read", () => {
    const { container } = render(
      <>
        <HistoryItem
          record={{ kind: "drew", seat: 0 }}
          describe={[{ seat: 0 }, " drew."]}
          gameVersion={1}
          names={["Ann"]}
        />
        <HistoryItem
          record={{ kind: "resigned", seat: 0 }}
          describe={[" Later."]}
          gameVersion={2}
          names={[]}
        />
      </>,
    );
    expect(container.textContent).toBe("Ann drew. Later.");
  });
});
