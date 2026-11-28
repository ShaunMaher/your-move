// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { engines, catalogSchema } from "../engine/index.js";
import { manifest } from "../manifest.js";
import "./dom-setup.js";
import { client } from "./index.js";

afterEach(cleanup);

const { OptionsForm, RulesSheet, HistoryItem } = client;
const CATALOG = catalogSchema.parse(engines[1].catalog({ config: {}, resources: [] }));

describe("the module", () => {
  it("is the paths client for every rules version the engine exports", () => {
    expect(client.type).toBe(manifest.type);
    // Pinned: adding a rules version means adding it here, and a client for it.
    expect(client.versions).toEqual([1]);
    expect(client.versions).toEqual(Object.keys(engines).map(Number));
  });
});

describe("OptionsForm", () => {
  it("offers the hand size and the self-elimination rule, defaulting to the catalog's", () => {
    render(<OptionsForm catalog={CATALOG} value={undefined} onChange={vi.fn()} />);
    const hands = within(
      screen.getByRole("group", { name: "Tiles in each hand" }),
    ).getAllByRole<HTMLInputElement>("radio");
    expect(hands.map((r) => [r.value, r.checked])).toEqual([
      ["1", false],
      ["2", false],
      ["3", true],
    ]);
    const rules = within(
      screen.getByRole("group", { name: "Running your own marker off the board" }),
    ).getAllByRole<HTMLInputElement>("radio");
    expect(rules.map((r) => [r.value, r.checked])).toEqual([
      ["avoidIfPossible", true],
      ["allowed", false],
    ]);
  });

  it("edits the unresolved input, keeping the other fields", () => {
    const onChange = vi.fn();
    render(<OptionsForm catalog={CATALOG} value={{ handSize: 2 }} onChange={onChange} />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^2 tiles/u }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Anything goes/u }));
    expect(onChange).toHaveBeenLastCalledWith({ handSize: 2, selfElimination: "allowed" });
    fireEvent.click(screen.getByRole("radio", { name: /^1 tile/u }));
    expect(onChange).toHaveBeenLastCalledWith({ handSize: 1 });
  });

  it("shows a value it doesn't know as the default, and says when the catalog is unusable", () => {
    render(
      <OptionsForm catalog={CATALOG} value={{ selfElimination: "bogus" }} onChange={vi.fn()} />,
    );
    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: /Protect your marker/u }).checked,
    ).toBe(true);
    cleanup();
    render(<OptionsForm catalog={{ nope: true }} value={{}} onChange={vi.fn()} />);
    expect(screen.getByText("The options for this game are unavailable.")).toBeTruthy();
  });
});

describe("RulesSheet", () => {
  const options = { boardSize: 6, handSize: 2, selfElimination: "allowed" } as const;

  it("states this game's options, then the manifest's rules for its version", () => {
    render(<RulesSheet options={options} gameVersion={1} />);
    const sheet = screen.getByRole("article", { name: "Rules" });
    expect(sheet.textContent).toContain("6 × 6 board, 2 tiles in each hand");
    expect(sheet.textContent).toContain("you may place any tile");
    expect(within(sheet).getByRole("heading", { name: "Your turn" })).toBeTruthy();
    expect(sheet.querySelectorAll("li").length).toBeGreaterThan(8);
    expect(sheet.querySelector("script, img, a")).toBeNull();
  });

  it("says the other variant in words, and what it can't show", () => {
    render(
      <RulesSheet
        options={{ ...options, handSize: 1, selfElimination: "avoidIfPossible" }}
        gameVersion={1}
      />,
    );
    expect(screen.getByRole("article").textContent).toContain("1 tile in each hand");
    expect(screen.getByRole("article").textContent).toContain("you can't run your own marker");
    cleanup();
    render(<RulesSheet options={options} gameVersion={9} />);
    expect(screen.getByText("The rules for this version are unavailable.")).toBeTruthy();
  });
});

describe("HistoryItem", () => {
  const names = ["Ann", "Bo", "Cy"];
  const base = { moves: [], eliminated: [], collided: [], skipped: [] };

  it("writes the record the way the engine describes it", () => {
    const record = {
      type: "place-tile",
      seat: 0,
      ...base,
      tileId: 3,
      rotation: 1,
      square: { r: 0, c: 0 },
      eliminated: [1],
    };
    render(<HistoryItem record={record} describe={["stored"]} gameVersion={1} names={names} />);
    expect(screen.getByText("Ann placed a tile — Bo ran off the board")).toBeTruthy();
  });

  it("falls back to the stored text for a record or version it doesn't know", () => {
    render(
      <HistoryItem
        record={{ type: "teleport" }}
        describe={[{ seat: 2 }, " vanished"]}
        gameVersion={1}
        names={names}
      />,
    );
    expect(screen.getByText("Cy vanished")).toBeTruthy();
    cleanup();
    render(
      <HistoryItem
        record={{ type: "resign", seat: 1, ...base }}
        describe={["old text"]}
        gameVersion={9}
        names={names}
      />,
    );
    expect(screen.getByText("old text")).toBeTruthy();
  });
});
