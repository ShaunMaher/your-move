import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { GameClientModule } from "@your-move/sdk/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetCatalog } from "../catalog.js";
import { loadGameClient } from "../games.js";
import { forgetJoinLink, peekJoinLink } from "../join-link-handoff.js";
import { fakeClient } from "../test-client.js";
import {
  CATALOG,
  CATALOG_GAME,
  fakeApi,
  fakePush,
  json,
  problem,
  PUSH_KEY,
  removeFakePush,
} from "../test-support.js";
import { lastPlayed } from "../text.js";
import { NewGame } from "./NewGame.js";

vi.mock("../games.js", () => ({ loadGameClient: vi.fn(() => Promise.resolve(fakeClient)) }));

beforeEach(() => {
  window.history.replaceState(null, "", "/new");
  window.localStorage.clear();
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
      pushKey={undefined}
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

  it("says what an address gets without saying whether it has an account, shows it back, and creates the game with the options", async () => {
    const { calls } = view();
    await toPlayers();
    click("Back");
    click("Next");
    expect(
      screen.getByText(
        "We'll email them an invitation from you, showing your name and email address. If they already play on Family Games, it waits in their list of games instead. Either way, you'll see them as invited until they accept.",
      ),
    ).toBeDefined();
    typeEmail("  Alex@Example.org ");
    click("Review");
    expect((await screen.findByRole("listitem")).textContent).toBe(
      "Check the address: alex@example.org",
    );
    expect(screen.getByText(/a typo would send your invitation to someone else\./u)).toBeDefined();
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
    ["INVALID_INVITEES", 400, /Check the players/u],
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
      <NewGame
        api={offline.api}
        appName="A"
        pushKey={undefined}
        ownEmail="sam@example.org"
        onSessionLost={vi.fn()}
      />,
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

describe("people you've played (alpha A12, 07 §1.1)", () => {
  const RECENT = {
    players: [
      { userId: "u-bob", displayName: "Bob", lastPlayedAt: 2 },
      { userId: "u-cy", displayName: "Cy", lastPlayedAt: 1 },
    ],
  };

  function withRecent(recent: Response, catalog: Response = json(CATALOG)) {
    const fake = fakeApi({
      "GET /api/v1/catalog": catalog,
      "GET /api/v1/players/recent": recent,
      "POST /api/v1/games": json(created, 201),
    });
    const lost = vi.fn();
    render(
      <NewGame
        api={fake.api}
        appName="Family Games"
        pushKey={undefined}
        ownEmail="sam@example.org"
        onSessionLost={lost}
      />,
    );
    return { ...fake, lost };
  }

  it("offers them by name as a group with a legend; picking one fills the seat and creates by userId", async () => {
    const { calls } = withRecent(json(RECENT));
    await toPlayers();
    const group = screen.getByRole("group", { name: "People you've played" });
    const boxes = within(group).getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")?.textContent)).toEqual([
      `Bob, ${lastPlayed(2)}`,
      `Cy, ${lastPlayed(1)}`,
    ]);
    // The name and the date read as two parts, not "Boblast played …" (A12-R2-2).
    expect(screen.getByRole("checkbox", { name: /^Bob, last played/u })).toBeDefined();
    expect(lastPlayed(Date.UTC(2026, 10, 26, 12))).toMatch(/^last played .*2026/u);
    expect(screen.getByText(/joins the game at once/u)).toBeDefined();
    expect(group.contains(boxes[0] ?? null)).toBe(true);
    expect(screen.getByLabelText("Their email address")).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Bob/u }));
    // The one seat is filled: no address to type, and nobody else can be picked.
    expect(screen.queryByLabelText("Their email address")).toBeNull();
    expect(screen.getByRole("checkbox", { name: /^Cy/u })).toHaveProperty("disabled", true);
    expect(
      screen.getByText("Every seat is filled; unpick someone to choose another."),
    ).toBeDefined();
    click("Review");
    expect(screen.getByText(/starts as soon as you create it/u)).toBeDefined();
    expect((await screen.findByRole("listitem")).textContent).toBe("Playing with Bob");
    click("Create game");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      gameType: "words",
      options: CATALOG_GAME.defaults,
      seats: 2,
      invitees: [{ userId: "u-bob" }],
    });
  });

  it("gives the seat back to an address when unpicked", async () => {
    withRecent(json(RECENT));
    await toPlayers();
    fireEvent.click(screen.getByRole("checkbox", { name: /^Cy/u }));
    fireEvent.click(screen.getByRole("checkbox", { name: /^Cy/u }));
    expect(screen.getByRole("checkbox", { name: /^Bob/u })).toHaveProperty("disabled", false);
    typeEmail("alex@example.org");
    click("Review");
    expect((await screen.findByRole("listitem")).textContent).toBe(
      "Check the address: alex@example.org",
    );
  });

  it("mixes picked people and typed addresses in a bigger game", async () => {
    const bigger = { ...CATALOG_GAME, players: { min: 2, max: 3 } };
    const { calls } = withRecent(json(RECENT), json({ games: [bigger] }));
    await toPlayers();
    fireEvent.change(screen.getByLabelText("Number of players"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /^Cy/u }));
    fireEvent.change(screen.getByLabelText("Player 3's email address"), {
      target: { value: "dee@example.org" },
    });
    click("Review");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Playing with Cy",
      "Check the address: dee@example.org",
    ]);
    click("Back");
    // Two fewer seats than picks can't happen: fewer seats drop the latest picks.
    fireEvent.click(screen.getByRole("checkbox", { name: /^Bob/u }));
    expect(screen.queryByLabelText(/email address/u)).toBeNull();
    fireEvent.change(screen.getByLabelText("Number of players"), { target: { value: "2" } });
    expect(screen.getByRole("checkbox", { name: /^Cy/u })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: /^Bob/u })).toHaveProperty("checked", false);
    click("Review");
    click("Create game");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      seats: 2,
      invitees: [{ userId: "u-cy" }],
    });
  });

  it("drops an empty address field first when a pick takes a seat (A12-P-10)", async () => {
    const bigger = { ...CATALOG_GAME, players: { min: 2, max: 3 } };
    withRecent(json(RECENT), json({ games: [bigger] }));
    await toPlayers();
    fireEvent.change(screen.getByLabelText("Number of players"), { target: { value: "3" } });
    // The first field empty, the second typed: picking someone keeps the typed one.
    fireEvent.change(screen.getByLabelText("Player 3's email address"), {
      target: { value: "dee@example.org" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /^Bob/u }));
    expect(screen.getByLabelText("Player 3's email address")).toHaveProperty(
      "value",
      "dee@example.org",
    );
  });

  it("shows no list without past opponents, or when it couldn't be loaded", async () => {
    withRecent(json({ players: [] }));
    await toPlayers();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByLabelText("Their email address")).toBeDefined();
    cleanup();
    forgetCatalog();
    withRecent(problem(500, "INTERNAL"));
    await toPlayers();
    expect(screen.queryByRole("checkbox", { name: /last played/u })).toBeNull();
    expect(screen.getByLabelText("Their email address")).toBeDefined();
  });

  it("ends the session when the list answers 401", async () => {
    const { lost } = withRecent(problem(401, "UNAUTHENTICATED"));
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });
});

describe("the notifications offer after creating a game (03 §7, alpha A8)", () => {
  afterEach(removeFakePush);

  function create(pushKey: string | undefined) {
    const fake = fakeApi({
      "GET /api/v1/catalog": json(CATALOG),
      "POST /api/v1/games": json(created, 201),
      "POST /api/v1/push/subscriptions": new Response(null, { status: 204 }),
    });
    render(
      <NewGame
        api={fake.api}
        appName="Family Games"
        pushKey={pushKey}
        ownEmail="sam@example.org"
        onSessionLost={vi.fn()}
      />,
    );
    return fake;
  }

  async function createGame() {
    await toPlayers();
    typeEmail("alex@example.org");
    click("Review");
    click("Create game");
  }

  it("asks once, turns notifications on from the tap, then goes to the game", async () => {
    const device = fakePush();
    const { calls } = create(PUSH_KEY);
    await createGame();
    await screen.findByRole("dialog", { name: "Know when it's your turn?" });
    expect(window.location.pathname).toBe("/new");
    click("Turn on notifications");
    expect(device.requestPermission).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.some((call) => call.path === "/api/v1/push/subscriptions")).toBe(true);
    expect(device.state.subscription).not.toBeNull();
  });

  it("goes to the game on 'Not now' and doesn't ask again on this device", async () => {
    const device = fakePush();
    create(PUSH_KEY);
    await createGame();
    await screen.findByRole("dialog", { name: "Know when it's your turn?" });
    click("Not now");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(device.requestPermission).not.toHaveBeenCalled();
    cleanup();
    forgetCatalog();
    window.history.replaceState(null, "", "/new");
    create(PUSH_KEY);
    await createGame();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("isn't made without a server key or where push can't work", async () => {
    create(undefined);
    await createGame();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a join link for the open seats (alpha A18, 07 §1.1)", () => {
  const URL_MADE = "https://play.example.org/join#AbCdEfGhIjKlMnOpQrSt_-";

  it("warns what a link does, lets the address stay empty, and hands the URL to the lobby only", async () => {
    const { calls } = view(json({ ...created, joinLinkUrl: URL_MADE }, 201));
    await toPlayers();
    click("Review");
    expect(screen.getByRole("alert").textContent).toContain("Enter an email address");
    const toggle = screen.getByRole("checkbox", { name: "Add a join link for the open seats" });
    expect(screen.getByText(/Anyone with the link can see the game and join it/u)).toBeDefined();
    expect(screen.getByText(/waits for you to press Start/u)).toBeDefined();
    fireEvent.click(toggle);
    click("Review");
    expect(await screen.findByText(/You'll get a join link for the open seats/u)).toBeDefined();
    expect(screen.queryByText(/starts as soon as you create it/u)).toBeNull();
    click("Create game");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      gameType: "words",
      options: CATALOG_GAME.defaults,
      seats: 2,
      invitees: [],
      joinLink: true,
    });
    expect(peekJoinLink("g9")).toBe(URL_MADE);
    expect(window.location.href).not.toContain("AbCdEf");
    expect(JSON.stringify(window.sessionStorage)).not.toContain("AbCdEf");
    expect(JSON.stringify(window.localStorage)).not.toContain("AbCdEf");
    forgetJoinLink("g9");
  });

  it("still invites an address typed alongside the link, and checks it", async () => {
    const { calls } = view(json({ ...created, joinLinkUrl: URL_MADE }, 201));
    await toPlayers();
    fireEvent.click(screen.getByRole("checkbox", { name: "Add a join link for the open seats" }));
    typeEmail("not an address");
    click("Review");
    expect(screen.getByRole("alert").textContent).toContain("leave a field empty");
    typeEmail("alex@example.org");
    click("Review");
    click("Create game");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      invitees: [{ email: "alex@example.org" }],
      joinLink: true,
    });
    forgetJoinLink("g9");
  });

  it("sends no joinLink unless asked", async () => {
    const { calls } = view();
    await toPlayers();
    typeEmail("alex@example.org");
    click("Review");
    click("Create game");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g9");
    });
    expect(calls.find((call) => call.method === "POST")?.body).not.toHaveProperty("joinLink");
    expect(peekJoinLink("g9")).toBeNull();
  });
});
