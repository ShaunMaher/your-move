import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GameClientModule } from "@your-move/sdk/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetCatalog } from "../catalog.js";
import { loadGameClient } from "../games.js";
import { fakeClient } from "../test-client.js";
import { CATALOG, CATALOG_GAME, fakeApi, json, problem } from "../test-support.js";
import { NewGame } from "./NewGame.js";

vi.mock("../games.js", () => ({ loadGameClient: vi.fn(() => Promise.resolve(fakeClient)) }));

beforeEach(() => {
  window.history.replaceState(null, "", "/new");
});
afterEach(() => {
  cleanup();
  forgetCatalog();
});

const created = { game: { id: "g9" } };
const click = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
};
const view = (create: Response = json(created, 201), catalog: Response = json(CATALOG)) => {
  const fake = fakeApi({ "GET /api/v1/catalog": catalog, "POST /api/v1/games": create });
  const lost = vi.fn();
  render(
    <NewGame
      api={fake.api}
      appName="Family Games"
      ownEmail="sam@example.org"
      onSessionLost={lost}
    />,
  );
  return { ...fake, lost };
};
const typeEmail = (value: string) => {
  fireEvent.change(screen.getByLabelText("Their email address"), { target: { value } });
};
async function toPlayers() {
  fireEvent.click(await screen.findByRole("button", { name: /Words/u }));
  await screen.findByText(/Options form/u);
  click("Next");
}

describe("the new-game flow", () => {
  it("ignores a game's module that finishes loading after another game was chosen", async () => {
    const loader = vi.mocked(loadGameClient);
    let finishFirst: (module: GameClientModule) => void = () => undefined;
    loader.mockImplementationOnce(
      () =>
        new Promise<GameClientModule>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const other = { ...CATALOG_GAME, type: "path", name: "Paths" };
    const otherClient: GameClientModule = {
      ...fakeClient,
      type: "path",
      OptionsForm: () => <p>Paths form</p>,
    };
    loader.mockImplementationOnce(() => Promise.resolve(otherClient));
    view(json(created, 201), json({ games: [CATALOG_GAME, other] }));
    fireEvent.click(await screen.findByRole("button", { name: /Words/u }));
    click("Back");
    fireEvent.click(await screen.findByRole("button", { name: /Paths/u }));
    expect(await screen.findByText("Paths form")).toBeDefined();
    await act(async () => {
      finishFirst(fakeClient);
      await Promise.resolve();
    });
    expect(screen.getByText("Paths form")).toBeDefined();
    expect(screen.queryByText(/Options form/u)).toBeNull();
  });

  it("offers a card per game type with its icon as an image, and the module's options form with the defaults", async () => {
    view();
    const card = await screen.findByRole("button", { name: /Words/u });
    expect(card.textContent).toContain("A crossword-tile word game.");
    expect(card.textContent).toContain("2 players");
    expect(card.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml,/u);
    fireEvent.click(card);
    expect(await screen.findByText(/Options form: .*the module's own part/u)).toBeDefined();
    expect(screen.getByText(`Value: ${JSON.stringify(CATALOG_GAME.defaults)}`)).toBeDefined();
    click("Pick casual");
    expect(screen.getByText('Value: {"rulesetId":"casual"}')).toBeDefined();
  });

  it("says the other person must have signed in first, shows the address back, and creates the game with the options", async () => {
    const { calls } = view();
    await toPlayers();
    click("Back");
    click("Next");
    expect(screen.getByText(/must have signed in to Family Games at least once/u)).toBeDefined();
    typeEmail("  Alex@Example.org ");
    click("Review");
    expect((await screen.findByRole("listitem")).textContent).toBe(
      "Check the address: alex@example.org",
    );
    click("Create game");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      gameType: "words",
      options: CATALOG_GAME.defaults,
      seats: 2,
      invitees: [{ email: "alex@example.org" }],
    });
  });

  it("checks the addresses before going on", async () => {
    view();
    await toPlayers();
    click("Review");
    expect(screen.getByRole("alert").textContent).toContain("Enter an email address");
    typeEmail("sam@example.org");
    click("Review");
    expect(screen.getByRole("alert").textContent).toContain("your own address");
    typeEmail("not an address");
    click("Review");
    expect(screen.getByRole("alert").textContent).toContain("Enter an email address");
  });

  it.each([
    ["INVALID_INVITEES", 400, /Check the email addresses/u],
    ["CANNOT_PLAY_SELF", 400, /invite yourself/u],
    ["TOO_MANY_GAMES", 409, /too many games/u],
    ["INVALID_OPTIONS", 400, /options can't be used/u],
    ["RATE_LIMITED", 429, /Too many attempts/u],
    ["SOMETHING_ELSE", 500, /Something went wrong/u],
  ])("explains a %s answer and lets the creator try again", async (code, status, text) => {
    view(problem(status, code));
    await toPlayers();
    typeEmail("alex@example.org");
    click("Review");
    click("Create game");
    expect((await screen.findByRole("alert")).textContent).toMatch(text);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/new");
    });
    expect(screen.getByRole("button", { name: "Create game" })).toHaveProperty("disabled", false);
  });

  it("says when it is offline, and ends the session on a 401", async () => {
    const offline = fakeApi({
      "GET /api/v1/catalog": json(CATALOG),
      "POST /api/v1/games": new Error("offline"),
    });
    const { unmount } = render(
      <NewGame api={offline.api} appName="A" ownEmail="sam@example.org" onSessionLost={vi.fn()} />,
    );
    await toPlayers();
    typeEmail("alex@example.org");
    click("Review");
    click("Create game");
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    unmount();
    cleanup();
    forgetCatalog();
    const { lost } = view(problem(401, "UNAUTHENTICATED"));
    await toPlayers();
    typeEmail("alex@example.org");
    click("Review");
    click("Create game");
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });

  it("can retry a failed catalog", async () => {
    view(json(created, 201), problem(500, "INTERNAL"));
    expect(await screen.findByText(/Couldn't load the games/u)).toBeDefined();
    click("Try again");
    expect(await screen.findByText(/Couldn't load the games/u)).toBeDefined();
  });
});
