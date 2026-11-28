// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { catalogSchema, engines } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { envelope } from "../test-support.js";
import "./dom-setup.js";
import { client } from "./index.js";
import { seatNames } from "./text.js";

afterEach(cleanup);

const { OptionsForm, RulesSheet, HistoryItem } = client;
const CATALOG = catalogSchema.parse(engines[1].catalog({ config: {}, resources: [] }));

describe("the module", () => {
  it("is the pairs client for every rules version the engine exports", () => {
    expect(client.type).toBe(manifest.type);
    // Pinned: adding a rules version means adding it here, and a client for it.
    expect(client.versions).toEqual([1]);
    expect(client.versions).toEqual(Object.keys(engines).map(Number));
  });
});

describe("seat names", () => {
  it("add the player number where two seats share a display name, and number a missing name", () => {
    expect(seatNames(envelope(["Ann", "Bo", "Ann"], 0), 3)).toEqual([
      "Ann (player 1)",
      "Bo",
      "Ann (player 3)",
    ]);
    expect(seatNames(envelope(["Ann", null], 0), 2)).toEqual(["Ann", "Seat 2"]);
  });
});

describe("OptionsForm", () => {
  it("offers the four grids as radios, defaulting to the catalog's", () => {
    render(<OptionsForm catalog={CATALOG} value={undefined} onChange={vi.fn()} />);
    const grids = within(
      screen.getByRole("group", { name: "Grid" }),
    ).getAllByRole<HTMLInputElement>("radio");
    expect(grids.map((r) => [r.value, r.checked])).toEqual([
      ["4x4", false],
      ["4x5", true],
      ["5x6", false],
      ["6x6", false],
    ]);
    expect(screen.getByRole("radio", { name: "4 × 4: 8 pairs, quickest" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "4 × 5: 10 pairs (usual)" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "5 × 6: 15 pairs" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "6 × 6: 18 pairs, longest" })).toBeTruthy();
  });

  it("edits the unresolved input, keeping other fields", () => {
    const onChange = vi.fn();
    render(<OptionsForm catalog={CATALOG} value={{ grid: "4x4", extra: 1 }} onChange={onChange} />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^4 × 4/u }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /^6 × 6/u }));
    expect(onChange).toHaveBeenCalledWith({ grid: "6x6", extra: 1 });
  });

  it("falls back to the default for a value it doesn't know, and says when the catalog is unusable", () => {
    render(<OptionsForm catalog={CATALOG} value={{ grid: "9x9" }} onChange={vi.fn()} />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /^4 × 5/u }).checked).toBe(true);
    cleanup();
    render(<OptionsForm catalog={{ nonsense: true }} value={null} onChange={vi.fn()} />);
    expect(screen.getByText("The options for this game are unavailable.")).toBeTruthy();
  });
});

describe("RulesSheet", () => {
  it("states this game's grid, pairs and move limit, then the manifest's rules for the version", () => {
    render(<RulesSheet options={{ grid: "6x6" }} gameVersion={1} />);
    const sheet = screen.getByRole("article", { name: "Rules" });
    expect(sheet.textContent).toContain(
      "This game: a 6 × 6 grid of cards, 18 pairs to find, and a limit of 1,296 moves.",
    );
    // Headings, a numbered list with sub-items, bulleted lists: plain React text.
    expect(within(sheet).getByRole("heading", { name: "Your turn" })).toBeTruthy();
    const steps = sheet.querySelector("ol");
    expect(steps?.querySelectorAll(":scope > li")).toHaveLength(3);
    expect(steps?.querySelectorAll(":scope > li > ul > li")).toHaveLength(2);
    expect(sheet.querySelectorAll("ul")).toHaveLength(3);
    expect(sheet.textContent).toContain("Writing down where the pictures are");
    expect(sheet.innerHTML).not.toContain("**");
  });

  it("says the rules are unavailable for a version it doesn't have", () => {
    render(<RulesSheet options={{ grid: "4x5" }} gameVersion={9} />);
    expect(screen.getByText("The rules for this version are unavailable.")).toBeTruthy();
  });
});

describe("HistoryItem", () => {
  const props = (record: unknown, names: readonly string[], gameVersion = 1) => ({
    record,
    describe: ["stored text"],
    gameVersion,
    names,
  });

  it("renders the engine's describe text with names and draws no card", () => {
    const { container } = render(
      <HistoryItem {...props({ type: "flip", seat: 1, step: 2 }, ["Ann", "Sam"])} />,
    );
    expect(container.textContent).toBe("Sam turned over a second card");
    expect(container.querySelector("svg, button")).toBeNull();
    cleanup();
    expect(
      render(<HistoryItem {...props({ type: "decline", seat: 0 }, ["Ann", "Sam"])} />).container
        .textContent,
    ).toBe("Ann declined the game");
  });

  it("numbers players who share a display name", () => {
    const { container } = render(
      <HistoryItem {...props({ type: "flip", seat: 1, step: 1 }, ["Ann", "Ann"])} />,
    );
    expect(container.textContent).toBe("Ann (player 2) turned over a card");
  });

  it("falls back to the stored text for a record or version it doesn't know", () => {
    expect(
      render(<HistoryItem {...props({ type: "teleport" }, ["Ann", "Sam"])} />).container
        .textContent,
    ).toBe("stored text");
    cleanup();
    expect(
      render(<HistoryItem {...props({ type: "flip", seat: 0, step: 1 }, ["Ann", "Sam"], 2)} />)
        .container.textContent,
    ).toBe("stored text");
  });
});
