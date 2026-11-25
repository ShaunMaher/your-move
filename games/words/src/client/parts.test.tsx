// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wordsV1 as words } from "../engine/definition.js";
import { catalogSchema, engines } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { client } from "./index.js";

afterEach(cleanup);

const { OptionsForm, RulesSheet, HistoryItem } = client;

const OPTIONS = {
  rulesetId: "classic",
  rulesetVersion: 1,
  dictionaryId: "enable",
  dictionaryVersion: 1,
};

const ALPHABET = "abcdefghijklmnopqrstuvwxyz".split("");

function catalog(uploads = false) {
  const base = words.catalog({
    config: {},
    resources: [
      {
        kind: "dictionary",
        id: "enable",
        version: 1,
        name: "ENABLE",
        language: "en",
        alphabet: ALPHABET,
        distribution: "public",
        source: "builtin",
      },
      ...(uploads
        ? [
            {
              kind: "dictionary" as const,
              id: "u_1",
              version: 1,
              name: "My list",
              language: "en",
              alphabet: ALPHABET,
              distribution: "serverOnly" as const,
              source: "upload" as const,
            },
          ]
        : []),
    ],
  });
  return catalogSchema.parse(base);
}

describe("the module", () => {
  it("is the words client for rules version 1", () => {
    expect(client.type).toBe("words");
    expect(client.versions).toEqual([engines[1].version]);
    expect(client.type).toBe(manifest.type);
  });
});

describe("OptionsForm", () => {
  it("offers each ruleset as a card with its numbers and a picture, defaulting to the catalog's", () => {
    render(<OptionsForm catalog={catalog()} value={{}} onChange={vi.fn()} />);
    const group = screen.getByRole("group", { name: "Ruleset" });
    const radios = within(group).getAllByRole<HTMLInputElement>("radio");
    expect(radios.map((r) => r.value)).toEqual(["classic", "casual"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
    expect(within(group).getByText(/100 tiles · 50 point bonus/u)).toBeTruthy();
    expect(within(group).getByText(/104 tiles · 35 point bonus/u)).toBeTruthy();
    expect(group.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Word list" }).value).toBe(
      "enable",
    );
  });

  it("edits the unresolved input, keeping the other fields", () => {
    const onChange = vi.fn();
    render(
      <OptionsForm
        catalog={catalog()}
        value={{ dictionaryId: "enable", other: 1 }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Casual/u }));
    expect(onChange).toHaveBeenCalledWith({
      dictionaryId: "enable",
      other: 1,
      rulesetId: "casual",
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Word list" }), {
      target: { value: "enable" },
    });
    expect(onChange).toHaveBeenLastCalledWith({
      dictionaryId: "enable",
      other: 1,
      dictionaryId2: undefined,
      ...{},
    });
  });

  it("drops a word list the new ruleset can't use", () => {
    const onChange = vi.fn();
    const cat = catalog();
    const narrowed = {
      ...cat,
      dictionaries: cat.dictionaries.map((d) => ({ ...d, compatibleRulesets: ["classic"] })),
    };
    render(
      <OptionsForm catalog={narrowed} value={{ dictionaryId: "enable" }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Casual/u }));
    expect(onChange).toHaveBeenCalledWith({ rulesetId: "casual" });
  });

  it("offers only the word lists the chosen ruleset can be played with, uploads in their own group", () => {
    const cat = catalog(true);
    render(<OptionsForm catalog={cat} value={{ rulesetId: "casual" }} onChange={vi.fn()} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", { name: "Word list" });
    expect([...select.options].map((o) => o.textContent)).toEqual(["ENABLE", "My list"]);
    expect(select.querySelector("optgroup")?.label).toBe("Your uploads");
  });

  it("keeps a chosen word list that is offered", () => {
    render(
      <OptionsForm catalog={catalog(true)} value={{ dictionaryId: "u_1" }} onChange={vi.fn()} />,
    );
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Word list" }).value).toBe(
      "u_1",
    );
  });

  it("treats a missing value as all defaults, and an empty catalog as nothing to choose", () => {
    render(<OptionsForm catalog={catalog()} value={undefined} onChange={vi.fn()} />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Classic/u }).checked).toBe(true);
    cleanup();
    const empty = {
      rulesets: [],
      dictionaries: [],
      defaults: { rulesetId: null, dictionaryId: null },
    };
    render(<OptionsForm catalog={empty} value={{}} onChange={vi.fn()} />);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Word list" }).options,
    ).toHaveLength(0);
  });

  it("falls back to the first ruleset when the catalog has no default", () => {
    const cat = { ...catalog(), defaults: { rulesetId: null, dictionaryId: null } };
    render(<OptionsForm catalog={cat} value={null} onChange={vi.fn()} />);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Classic/u }).checked).toBe(true);
  });

  it("says so when the catalog isn't one it understands", () => {
    render(<OptionsForm catalog={{ nope: 1 }} value={{}} onChange={vi.fn()} />);
    expect(screen.getByText("The options for this game are unavailable.")).toBeTruthy();
  });
});

describe("RulesSheet", () => {
  it("states the game's ruleset, then the manifest rules as plain text", () => {
    render(<RulesSheet options={OPTIONS} gameVersion={1} />);
    expect(
      screen.getByText(/This game: the Classic ruleset, 100 tiles in all, racks of 7/u),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Words" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Scoring" })).toBeTruthy();
    expect(screen.getByText("Pass.").tagName).toBe("STRONG");
    expect(document.body.textContent).not.toContain("**");
    expect(document.querySelector("script, img, a")).toBeNull();
  });

  it("copes with an unknown ruleset or rules version", () => {
    render(<RulesSheet options={{ ...OPTIONS, rulesetId: "gone" }} gameVersion={9} />);
    expect(screen.queryByText(/This game:/u)).toBeNull();
    expect(screen.getByText("The rules for this version are unavailable.")).toBeTruthy();
  });
});

describe("HistoryItem", () => {
  const names = ["Ann", "Bo"];
  const play = {
    seat: 1,
    type: "play",
    placements: [{ row: 7, col: 7, tile: "a", letter: "a" }],
    words: [
      { word: "quiz", score: 52 },
      { word: "qi", score: 12 },
    ],
    score: 64,
    bingo: false,
  };

  it("renders a play from its record with the words and their scores", () => {
    render(<HistoryItem record={play} describe={["stored"]} gameVersion={1} names={names} />);
    expect(screen.getByText(/Bo played QUIZ for 64/u)).toBeTruthy();
    expect(screen.getByText("(QUIZ 52, QI 12)")).toBeTruthy();
  });

  it("renders the other records from their text alone", () => {
    render(
      <HistoryItem
        record={{ seat: 0, type: "swap", swapCount: 3, score: 0, bingo: false }}
        describe={["stored"]}
        gameVersion={1}
        names={names}
      />,
    );
    expect(screen.getByText("Ann swapped 3 tiles")).toBeTruthy();
  });

  it("falls back to the stored text for a record or version it doesn't know", () => {
    render(
      <HistoryItem
        record={{ weird: true }}
        describe={[{ seat: 1 }, " did a thing"]}
        gameVersion={1}
        names={names}
      />,
    );
    expect(screen.getByText("Bo did a thing")).toBeTruthy();
    cleanup();
    render(
      <HistoryItem
        record={play}
        describe={[{ seat: 0 }, " stored"]}
        gameVersion={2}
        names={names}
      />,
    );
    expect(screen.getByText("Ann stored")).toBeTruthy();
  });
});
