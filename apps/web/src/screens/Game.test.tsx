import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetCatalog } from "../catalog.js";
import { fakeClient, submitted } from "../test-client.js";
import {
  CATALOG,
  envelope,
  fakeApi,
  fakePush,
  json,
  player,
  problem,
  PUSH_KEY,
  removeFakePush,
} from "../test-support.js";
import { Game } from "./Game.js";

const VIEW = { board: "empty" };
const alex = (over = {}) =>
  player({ seat: 1, userId: "u2", displayName: "Alex", isYou: false, isCreator: false, ...over });
const withView = (game = envelope(), view: unknown = VIEW) => json({ game, view });
const lobby = (over = {}) =>
  envelope({
    status: "lobby",
    toAct: [],
    yourTurn: false,
    yourSeat: null,
    players: [
      player({ seat: null, state: "joined" }),
      alex({
        seat: null,
        state: "invited",
        displayName: null,
        userId: null,
        invitedAs: "alex@example.org",
      }),
    ],
    ...over,
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/g/g1");
  submitted.length = 0;
});
afterEach(() => {
  cleanup();
  forgetCatalog();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Renders the game screen over a fake API; later routes win over the defaults. */
function open(
  routes: Record<
    string,
    Response | Error | ((call: never) => Response | Error | Promise<Response | Error>)
  > = {},
  options: { client?: typeof fakeClient | null; pushKey?: string } = {},
) {
  const fake = fakeApi({
    "GET /api/v1/catalog": json(CATALOG),
    "POST /api/v1/games/g1/seen": new Response(null, { status: 204 }),
    "GET /api/v1/games/g1": withView(),
    ...routes,
  });
  const lost = vi.fn();
  const client = options.client === undefined ? fakeClient : options.client;
  render(
    <Game
      api={fake.api}
      appName="Family Games"
      pushKey={options.pushKey}
      id="g1"
      onSessionLost={lost}
      loadClient={() => Promise.resolve(client)}
    />,
  );
  return { ...fake, lost };
}
const click = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
};
const posts = (calls: { method: string; path: string; body: unknown }[], suffix: string) =>
  calls.filter((call) => call.method === "POST" && call.path === `/api/v1/games/g1/${suffix}`);

describe("the lobby", () => {
  it("shows the players with their states, the address the creator typed, and what they can do", async () => {
    open({ "GET /api/v1/games/g1": json({ game: lobby(), view: null }) });
    expect(await screen.findByRole("heading", { level: 1, name: "Words lobby" })).toBeDefined();
    const seats = within(screen.getByRole("region", { name: "Players" })).getAllByRole("listitem");
    expect(seats[0]?.textContent).toContain("You");
    expect(seats[0]?.textContent).toContain("Joined");
    expect(seats[1]?.textContent).toContain("alex@example.org");
    expect(seats[1]?.textContent).toContain("Invited");
    expect(screen.getByRole("button", { name: "Start game" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("starts the game with the version it saw and shows the board", async () => {
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: lobby({ version: 2 }), view: null }),
      "POST /api/v1/games/g1/start": withView(envelope({ version: 3 })),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Start game" }));
    expect(await screen.findByRole("region", { name: "Fake board" })).toBeDefined();
    expect(posts(calls, "start")[0]?.body).toEqual({ expectedVersion: 2 });
  });

  it("explains a start that is too early, and refetches when the game moved on", async () => {
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: lobby(), view: null }),
      "POST /api/v1/games/g1/start": problem(409, "NOT_ENOUGH_PLAYERS"),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Start game" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Wait for the other players");
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/games/g1"),
    ).toHaveLength(1);
  });

  it("asks before cancelling, then shows the cancelled game", async () => {
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: lobby(), view: null }),
      "POST /api/v1/games/g1/cancel": withView(
        envelope({ status: "cancelled", yourTurn: false, toAct: [], version: 4 }),
        null,
      ),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel game" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel this game?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(calls, "cancel")).toHaveLength(0);
    click("Cancel game");
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel game" }),
    );
    expect(await screen.findByRole("heading", { level: 2, name: "Cancelled" })).toBeDefined();
    expect(posts(calls, "cancel")).toHaveLength(1);
  });

  it("can't be dismissed while the cancel request is pending", async () => {
    let release: (answer: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: lobby(), view: null }),
      "POST /api/v1/games/g1/cancel": () => held,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel game" }));
    const dialog = screen.getByRole("dialog", { name: "Cancel this game?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel game" }));
    const keep = await within(dialog).findByRole("button", { name: "Keep it" });
    expect((keep as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(keep);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.pointerDown(dialog.parentElement!);
    fireEvent.click(dialog.parentElement!);
    expect(screen.getByRole("dialog", { name: "Cancel this game?" })).toBeDefined();
    release(problem(409, "GAME_UNAVAILABLE"));
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(calls, "cancel")).toHaveLength(1);
  });

  const invited = () =>
    lobby({
      yourInvitation: "normal",
      players: [
        player({ seat: null, state: "joined", isYou: false, displayName: "Robin" }),
        player({ seat: null, state: "invited", isCreator: false }),
      ],
    });

  it("lets an invitee accept or decline, and offers no Start", async () => {
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: invited(), view: null }),
      "POST /api/v1/games/g1/accept": json({
        game: { ...invited(), yourInvitation: null, version: 4 },
        view: null,
      }),
    });
    expect(await screen.findByText("Robin invited you to play.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    click("Accept");
    expect(await screen.findByText(/Waiting for the creator to start/u)).toBeDefined();
    expect(posts(calls, "accept")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("goes home after declining: a lobby decline answers 204, leaving nothing to show", async () => {
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: invited(), view: null }),
      "POST /api/v1/games/g1/decline": new Response(null, { status: 204 }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Decline" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(posts(calls, "decline")).toHaveLength(1);
  });

  it("lets a player who was added (joined, not the creator) decline, and goes home (A12-P-4)", async () => {
    const added = lobby({
      players: [
        player({ seat: null, state: "joined", isYou: false, displayName: "Robin" }),
        player({ seat: null, state: "joined", isCreator: false }),
      ],
    });
    const { calls } = open({
      "GET /api/v1/games/g1": json({ game: added, view: null }),
      "POST /api/v1/games/g1/decline": new Response(null, { status: 204 }),
    });
    expect(await screen.findByText(/You can still decline/u)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start game" })).toBeNull();
    click("Decline");
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(posts(calls, "decline")).toHaveLength(1);
  });

  it("polls while in the lobby, so the creator sees the game start by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answer = json({ game: lobby(), view: null });
    open({ "GET /api/v1/games/g1": () => answer });
    await screen.findByRole("button", { name: "Start game" });
    answer = withView();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByRole("region", { name: "Fake board" })).toBeDefined();
  });
});

describe("the game frame", () => {
  it("gives the module's board the view and leaves the scores and the turn to it", async () => {
    open();
    expect(await screen.findByRole("region", { name: "Fake board" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Words game");
    expect(screen.getByText(`Board v3: ${JSON.stringify(VIEW)}`)).toBeDefined();
    // One owner for each thing: with a board on screen the frame draws no player chips, no turn
    // line and no status of its own.
    expect(screen.queryByRole("list", { name: "Players" })).toBeNull();
    expect(document.querySelector(".turn")).toBeNull();
    expect(screen.queryByText("Your turn")).toBeNull();
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual([""]);
  });

  it("stands in with the players and the turn, said once and not live, while there is no board", async () => {
    open({}, { client: null });
    expect(await screen.findByText(/can't be shown by this version of the app/u)).toBeDefined();
    const chips = within(screen.getByRole("list", { name: "Players" })).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual(["You", "Alex"]);
    expect(chips[0]?.getAttribute("aria-current")).toBe("true");
    const turn = screen.getByText("Your turn");
    expect(turn.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each([
    [[1], "Sam's turn"],
    [[0, 1], "Waiting for You and Sam"],
  ])("words the stand-in's turn line as the board does (to act: %j)", async (toAct, text) => {
    const game = envelope({
      yourTurn: false,
      toAct,
      players: [
        player({ isYou: true }),
        player({ seat: 1, userId: "u2", displayName: "Sam", isYou: false }),
      ],
    });
    open({ "GET /api/v1/games/g1": withView(game) }, { client: null });
    expect(await screen.findByText(text)).toBeDefined();
  });

  it("names a seat without a display name by why it has none: New player, or Deleted player", async () => {
    const game = envelope({
      players: [
        player(),
        player({ seat: 1, userId: "u2", displayName: null, isYou: false, isCreator: false }),
        player({ seat: 2, userId: null, displayName: null, isYou: false, isCreator: false }),
      ],
    });
    open({ "GET /api/v1/games/g1": withView(game) }, { client: null });
    const chips = within(await screen.findByRole("list", { name: "Players" })).getAllByRole(
      "listitem",
    );
    expect(chips.map((chip) => chip.textContent)).toEqual(["You", "New player", "Deleted player"]);
  });

  it("marks what it has shown as seen, once per version", async () => {
    const { calls } = open();
    await screen.findByRole("region", { name: "Fake board" });
    await waitFor(() => {
      expect(posts(calls, "seen")).toHaveLength(1);
    });
    expect(posts(calls, "seen")[0]?.body).toEqual({ version: 3 });
  });

  it("sends a move with the version it saw and shows the answer", async () => {
    const { calls } = open({
      "POST /api/v1/games/g1/actions": json({
        game: envelope({ version: 4, yourTurn: false, toAct: [1] }),
        view: { board: "moved" },
        describe: ["You played"],
      }),
    });
    await screen.findByRole("region", { name: "Fake board" });
    click("Play");
    expect(
      await screen.findByText("Board v4: " + JSON.stringify({ board: "moved" })),
    ).toBeDefined();
    expect(posts(calls, "actions")[0]?.body).toEqual({
      expectedVersion: 3,
      action: { type: "play" },
    });
    expect(screen.getByText("sent")).toBeDefined();
  });

  it.each(["STALE_GAME", "NOT_YOUR_TURN"])(
    "refetches on %s and hands the board the refusal",
    async (code) => {
      let game = envelope();
      const { calls } = open({
        "GET /api/v1/games/g1": () => withView(game),
        "POST /api/v1/games/g1/actions": problem(409, code),
      });
      await screen.findByRole("region", { name: "Fake board" });
      game = envelope({ version: 5, yourTurn: false, toAct: [1] });
      click("Play");
      expect(await screen.findByText(`refused ${code}`)).toBeDefined();
      expect(await screen.findByText(/Board v5/u)).toBeDefined();
      expect(
        calls.filter((call) => call.method === "GET" && call.path === "/api/v1/games/g1"),
      ).toHaveLength(2);
    },
  );

  it("passes a module's own refusal through, without a refetch", async () => {
    const { calls } = open({
      "POST /api/v1/games/g1/actions": json(
        { error: { code: "INVALID_WORDS", message: "no", detail: { words: ["zz"] } } },
        400,
      ),
    });
    await screen.findByRole("region", { name: "Fake board" });
    click("Play");
    expect(await screen.findByText("refused INVALID_WORDS")).toBeDefined();
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/games/g1"),
    ).toHaveLength(1);
  });

  it("lets the board see a lost connection as a rejection", async () => {
    open({ "POST /api/v1/games/g1/actions": new Error("offline") });
    await screen.findByRole("region", { name: "Fake board" });
    click("Play");
    expect(await screen.findByText("lost")).toBeDefined();
  });

  it("answers previews from the API: the result, or the refusal as an error value", async () => {
    let answer: Response | Error = json({ preview: { score: 12 } });
    const { calls } = open({ "POST /api/v1/games/g1/preview": () => answer });
    await screen.findByRole("region", { name: "Fake board" });
    click("Check");
    expect(await screen.findByText('preview {"score":12}')).toBeDefined();
    expect(posts(calls, "preview")[0]?.body).toEqual({ action: { type: "play" } });
    answer = json({ error: { code: "INVALID_WORDS", message: "no", detail: 1 } }, 400);
    click("Check");
    expect(await screen.findByText('preview {"code":"INVALID_WORDS","detail":1}')).toBeDefined();
    answer = problem(429, "RATE_LIMITED");
    click("Check");
    expect(await screen.findByText('preview {"code":"RATE_LIMITED"}')).toBeDefined();
    answer = new Error("offline");
    click("Check");
    expect(await screen.findByText("preview lost")).toBeDefined();
  });

  it("polls while it is someone else's turn, and shows their move", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let game = envelope({ yourTurn: false, toAct: [1] });
    open({ "GET /api/v1/games/g1": () => withView(game) });
    await screen.findByText(/Board v3/u);
    game = envelope({ version: 4 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await screen.findByText(/Board v4/u)).toBeDefined();
  });

  it("keeps the last state and says so when a refresh can't reach the server", async () => {
    let answer: Response | Error = withView(envelope({ yourTurn: false, toAct: [1] }));
    open({ "GET /api/v1/games/g1": () => answer });
    await screen.findByRole("region", { name: "Fake board" });
    answer = new Error("offline");
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/You seem to be offline/u)).toBeDefined();
    expect(screen.getByRole("region", { name: "Fake board" })).toBeDefined();
    answer = withView(envelope({ yourTurn: false, toAct: [1] }));
    window.dispatchEvent(new Event("focus"));
    await waitFor(
      () => {
        expect(screen.queryByText(/You seem to be offline/u)).toBeNull();
      },
      { timeout: 1000 },
    );
  });

  it("runs one more refetch when the game moves on under a refetch already in flight", async () => {
    let gets = 0;
    const releases: ((answer: Response) => void)[] = [];
    open({
      "GET /api/v1/games/g1": () => {
        gets += 1;
        if (gets === 2) return new Promise<Response>((resolve) => releases.push(resolve));
        return withView(
          gets === 1 ? envelope() : envelope({ version: 5, yourTurn: false, toAct: [1] }),
        );
      },
      "POST /api/v1/games/g1/actions": problem(409, "STALE_GAME"),
    });
    await screen.findByText(/Board v3/u);
    // A focus refetch is in flight (its answer predates the other player's move) ...
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    // ... when a move is refused as stale: that must not be swallowed by the one in flight.
    click("Play");
    expect(await screen.findByText("refused STALE_GAME")).toBeDefined();
    releases[0]?.(withView(envelope()));
    expect(await screen.findByText(/Board v5/u)).toBeDefined();
    expect(gets).toBe(3);
  });

  it("never lets an older answer arriving late replace a newer one", async () => {
    let gets = 0;
    const releases: ((answer: Response) => void)[] = [];
    open({
      "GET /api/v1/games/g1": () => {
        gets += 1;
        if (gets === 2) return new Promise<Response>((resolve) => releases.push(resolve));
        return withView();
      },
      "POST /api/v1/games/g1/actions": json({
        game: envelope({ version: 4, yourTurn: false, toAct: [1] }),
        view: { board: "moved" },
        describe: [],
      }),
    });
    await screen.findByText(/Board v3/u);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(releases).toHaveLength(1);
    });
    click("Play");
    await screen.findByText(/Board v4/u);
    releases[0]?.(withView(envelope()));
    await waitFor(() => {
      expect(gets).toBe(2);
    });
    await Promise.resolve();
    expect(screen.getByText(/Board v4/u)).toBeDefined();
    expect(screen.queryByText(/Board v3/u)).toBeNull();
  });

  it("does not poll, or mark the game seen, while the tab is hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { calls } = open({
      "GET /api/v1/games/g1": withView(envelope({ yourTurn: false, toAct: [1] })),
    });
    await screen.findByText(/Board v3/u);
    const gets = () => calls.filter((c) => c.method === "GET" && c.path === "/api/v1/games/g1");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(gets()).toHaveLength(1);
    expect(posts(calls, "seen")).toHaveLength(0);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(posts(calls, "seen")).toHaveLength(1);
    });
    expect(gets()).toHaveLength(2);
    visibility.mockRestore();
  });

  it("does not mark a lobby seen", async () => {
    const { calls } = open({ "GET /api/v1/games/g1": json({ game: lobby(), view: null }) });
    await screen.findByRole("button", { name: "Start game" });
    await Promise.resolve();
    expect(posts(calls, "seen")).toHaveLength(0);
  });

  it("keeps the board and says so when a refresh gets a server error, then stops saying it", async () => {
    let answer: Response = withView();
    open({ "GET /api/v1/games/g1": () => answer });
    await screen.findByText(/Board v3/u);
    answer = problem(500, "INTERNAL");
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/server isn't answering/u)).toBeDefined();
    expect(screen.getByRole("region", { name: "Fake board" })).toBeDefined();
    answer = withView();
    window.dispatchEvent(new Event("focus"));
    await waitFor(
      () => {
        expect(screen.queryByText(/server isn't answering/u)).toBeNull();
      },
      { timeout: 1000 },
    );
  });

  it("downloads the public word lists the game uses, and none that only the server holds", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response("x", { status: 404 })));
    vi.stubGlobal("fetch", fetcher);
    const store = {
      match: () => Promise.resolve(undefined),
      put: vi.fn(),
      keys: () => Promise.resolve([]),
      delete: vi.fn(),
    };
    vi.stubGlobal("caches", { open: () => Promise.resolve(store) });
    const url = "/assets/dictionaries/enable-v1.0123456789abcdef.txt";
    open({
      "GET /api/v1/games/g1": withView(
        envelope({
          resources: [
            {
              kind: "dictionary",
              id: "enable",
              name: "ENABLE",
              distribution: "public",
              downloadUrl: url,
            },
            { kind: "dictionary", id: "mine", name: "Mine", distribution: "serverOnly" },
          ],
        }),
      ),
    });
    await screen.findByRole("region", { name: "Fake board" });
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(url, { credentials: "omit", redirect: "error" });
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("the menu", () => {
  it("shows the game, its word list and the players, and the rules from the module", async () => {
    open({
      "GET /api/v1/games/g1": withView(
        envelope({ resources: [{ kind: "dictionary", id: "e", name: "ENABLE" }] }),
      ),
    });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(within(menu).getByText("ENABLE")).toBeDefined();
    expect(within(menu).getByText("You, Alex")).toBeDefined();
    fireEvent.click(within(menu).getByRole("button", { name: "Rules" }));
    expect(screen.getByRole("dialog", { name: "Rules" }).textContent).toContain(
      'Rules for v1 {"rulesetId":"standard"}',
    );
  });

  it("closes with Escape and gives focus back to the menu button", async () => {
    open();
    await screen.findByRole("region", { name: "Fake board" });
    const button = screen.getByRole("button", { name: "Menu" });
    button.focus();
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("offers resign only to a seated player of a game in progress", async () => {
    open({
      "GET /api/v1/games/g1": withView(
        envelope({ status: "finished", yourTurn: false, toAct: [] }),
      ),
    });
    await screen.findByRole("heading", { level: 2, name: "Final result" });
    click("Menu");
    expect(screen.queryByRole("button", { name: "Resign…" })).toBeNull();
  });
});

describe("resigning", () => {
  const ended = () =>
    envelope({
      status: "finished",
      version: 4,
      yourTurn: false,
      toAct: [],
      endReason: "resign",
      players: [
        player({ rank: 2, score: 40, outReason: "resigned", state: "out" }),
        alex({ rank: 1, score: 55, state: "playing" }),
      ],
    });

  it("asks first, then calls the API's resign and shows the finished screen", async () => {
    const { calls } = open({ "POST /api/v1/games/g1/resign": withView(ended()) });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("Resign…");
    const dialog = screen.getByRole("dialog", { name: "Resign this game?" });
    expect(dialog.textContent).toContain("counts as a loss");
    expect(posts(calls, "resign")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Resign" }));
    expect(await screen.findByRole("heading", { level: 2, name: "Final result" })).toBeDefined();
    expect(posts(calls, "resign")[0]?.body).toEqual({ expectedVersion: 3 });
    expect(screen.queryByRole("dialog")).toBeNull();
    const rows = within(screen.getByRole("list", { name: "" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["1Alex", "2Youresigned"]);
  });

  it("does nothing if you keep playing", async () => {
    const { calls } = open();
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("Resign…");
    click("Keep playing");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(calls, "resign")).toHaveLength(0);
  });

  it("can't be dismissed while the request is pending, and shows a failure when it ends", async () => {
    let release: (answer: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { calls } = open({ "POST /api/v1/games/g1/resign": () => held });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("Resign…");
    click("Resign");
    const dialog = await screen.findByRole("dialog", { name: "Resign this game?" });
    const keep = within(dialog).getByRole("button", { name: "Keep playing" });
    expect((keep as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(keep);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.pointerDown(dialog.parentElement!);
    fireEvent.click(dialog.parentElement!);
    expect(screen.getByRole("dialog", { name: "Resign this game?" })).toBeDefined();
    release(problem(409, "GAME_UNAVAILABLE"));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
    expect(posts(calls, "resign")).toHaveLength(1);
    // Settled, it can be dismissed again.
    await waitFor(
      () => {
        fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
        expect(screen.queryByRole("dialog")).toBeNull();
      },
      { timeout: 1000 },
    );
  });

  it("says so when the game's engine has gone", async () => {
    open({ "POST /api/v1/games/g1/resign": problem(409, "GAME_UNAVAILABLE") });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("Resign…");
    click("Resign");
    expect((await screen.findByRole("alert")).textContent).toContain("no longer available");
  });

  it("says when the game changed under it, and when it can't reach the server", async () => {
    let answer: Response | Error = problem(409, "STALE_GAME");
    open({ "POST /api/v1/games/g1/resign": () => answer });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("Resign…");
    click("Resign");
    expect((await screen.findByRole("alert")).textContent).toContain("The game changed");
    answer = new Error("offline");
    click("Resign");
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("offline");
    });
  });
});

describe("the history drawer", () => {
  const item = (seq: number, over = {}) => ({
    seq,
    seat: seq % 2,
    kind: "action",
    record: { n: seq },
    describe: [{ seat: 1 }, " played"],
    via: "app",
    createdAt: seq,
    ...over,
  });

  it("lists every page, oldest first, drawn by the module with the names filled in", async () => {
    let page = 0;
    const { calls } = open({
      "GET /api/v1/games/g1/history": () => {
        page += 1;
        return page === 1
          ? json({ items: [item(1)], nextCursor: "1" })
          : json({ items: [item(2, { via: "token" })], nextCursor: null });
      },
    });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("History");
    const list = await screen.findByRole("list", { name: "Moves, oldest first" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe('{"n":1} / Alex played');
    expect(within(rows[1]!).getByText("AI")).toBeDefined();
    expect(calls.filter((call) => call.path.endsWith("/history"))).toHaveLength(2);
  });

  it("says when nothing has happened, and can try again after a failure", async () => {
    let answer: Response | Error = new Error("offline");
    open({ "GET /api/v1/games/g1/history": () => answer });
    await screen.findByRole("region", { name: "Fake board" });
    click("Menu");
    click("History");
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
    answer = json({ items: [], nextCursor: null });
    click("Try again");
    expect(await screen.findByText("Nothing has happened yet.")).toBeDefined();
  });
});

describe("a finished game", () => {
  it("shows how it ended and the ranking, and keeps the final board", async () => {
    open({
      "GET /api/v1/games/g1": withView(
        envelope({
          status: "finished",
          endReason: "out",
          yourTurn: false,
          toAct: [],
          players: [player({ rank: 1, score: 212 }), alex({ rank: 2, score: 187 })],
        }),
        { board: "final" },
      ),
    });
    expect(await screen.findByRole("heading", { level: 2, name: "Final result" })).toBeDefined();
    // The scores wait for the board (the card shows them only while none is drawn).
    expect(await screen.findByText(/Board v3: .*final/u)).toBeDefined();
    const results = screen.getByRole("region", { name: "Final result" });
    expect(
      within(results)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["1You", "2Alex"]);
    expect(within(results).getByRole("link", { name: "Back to games" }).getAttribute("href")).toBe(
      "/",
    );
    expect(await screen.findByText(/Board v3: .*final/u)).toBeDefined();
    // "Game over" is the results card's business alone: no player list or turn line beside it.
    expect(screen.queryByText("Game over")).toBeNull();
    expect(screen.queryByRole("list", { name: "Players" })).toBeNull();
    expect(document.querySelector(".turn")).toBeNull();
  });

  it("lists the scores in the card only when no board is drawn", async () => {
    open({
      "GET /api/v1/games/g1": withView(
        envelope({
          status: "finished",
          endReason: "out",
          yourTurn: false,
          toAct: [],
          players: [player({ rank: 1, score: 212 }), alex({ rank: 2, score: 187 })],
        }),
        null,
      ),
    });
    const results = await screen.findByRole("region", { name: "Final result" });
    expect(
      within(results)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual(["1You212", "2Alex187"]);
  });

  it("says 'Declined, no result' for a declined game, which has no ranks", async () => {
    open({
      "GET /api/v1/games/g1": withView(
        envelope({ status: "declined", endReason: "declined", yourTurn: false, toAct: [] }),
        null,
      ),
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Declined, no result" }),
    ).toBeDefined();
    expect(screen.queryByRole("list", { name: "" })).toBeNull();
  });
});

describe("the rematch button (07 §1, alpha A15)", () => {
  const finished = (over = {}) =>
    withView(
      envelope({
        status: "finished",
        endReason: "out",
        yourTurn: false,
        toAct: [],
        players: [player({ rank: 1 }), alex({ rank: 2 })],
        rematch: null,
        ...over,
      }),
      null,
    );
  const results = () => screen.findByRole("region", { name: "Final result" });

  it.each([
    [null, "Rematch"],
    [{ gameId: "g2", you: "invited" }, "Accept rematch"],
    [{ gameId: "g2", you: "joined" }, "Go to rematch"],
  ] as const)(
    "for %j reads %s, calls the endpoint and opens the rematch",
    async (rematch, label) => {
      const { calls } = open({
        "GET /api/v1/games/g1": finished({ rematch }),
        "POST /api/v1/games/g1/rematch": json(
          { game: envelope({ id: "g2", status: "active" }) },
          rematch === null ? 201 : 200,
        ),
      });
      const card = await results();
      // Beside "Back to games", which steps back to a secondary button.
      expect(within(card).getByRole("link", { name: "Back to games" }).className).toBe(
        "button secondary",
      );
      fireEvent.click(within(card).getByRole("button", { name: label }));
      await waitFor(() => {
        expect(window.location.pathname).toBe("/g/g2");
      });
      expect(posts(calls, "rematch")).toEqual([expect.objectContaining({ body: {} })]);
    },
  );

  it("isn't offered when you're no longer in the rematch, or for any ending but finished", async () => {
    open({ "GET /api/v1/games/g1": finished({ rematch: { gameId: "g2", you: "none" } }) });
    const card = await results();
    expect(within(card).queryByRole("button")).toBeNull();
    expect(within(card).getByRole("link", { name: "Back to games" }).className).toBe("button");
    cleanup();
    open({
      "GET /api/v1/games/g1": withView(
        envelope({ status: "declined", endReason: "declined", yourTurn: false, toAct: [] }),
        null,
      ),
    });
    await screen.findByRole("heading", { level: 2, name: "Declined, no result" });
    expect(screen.queryByRole("button", { name: /rematch/iu })).toBeNull();
  });

  it.each([
    [null, "Rematch", "Starting rematch…"],
    [{ gameId: "g2", you: "invited" }, "Accept rematch", "Joining rematch…"],
    [{ gameId: "g2", you: "joined" }, "Go to rematch", "Opening rematch…"],
  ] as const)(
    "for %j, says what it is doing while busy (A15-P-9)",
    async (rematch, label, busy) => {
      open({
        "GET /api/v1/games/g1": finished({ rematch }),
        "POST /api/v1/games/g1/rematch": () => new Promise<Response>(() => undefined),
      });
      const card = await results();
      fireEvent.click(within(card).getByRole("button", { name: label }));
      const button = await within(card).findByRole("button", { name: busy });
      expect(button.hasAttribute("disabled")).toBe(true);
    },
  );

  it("refetches the finished game after a 404 or 409, so the button follows the server (A15-P-8)", async () => {
    let shown: unknown = null;
    const { calls } = open({
      "GET /api/v1/games/g1": () => finished({ rematch: shown }),
      "POST /api/v1/games/g1/rematch": () => {
        // Meanwhile another player made a rematch, and this player left it.
        shown = { gameId: "g2", you: "none" };
        return problem(404, "NOT_FOUND");
      },
    });
    const card = await results();
    fireEvent.click(within(card).getByRole("button", { name: "Rematch" }));
    await waitFor(() => {
      expect(within(card).queryByRole("button")).toBeNull();
    });
    // The refusal stays in view after the button goes.
    expect(within(card).getByRole("alert").textContent).toBe("You're no longer in this rematch.");
    expect(
      calls.filter((call) => call.method === "GET" && call.path === "/api/v1/games/g1"),
    ).toHaveLength(2);
  });

  it("is busy while the call runs, and shows a refusal under it", async () => {
    let answer: (response: Response) => void = () => undefined;
    open({
      "GET /api/v1/games/g1": finished(),
      "POST /api/v1/games/g1/rematch": () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const card = await results();
    fireEvent.click(within(card).getByRole("button", { name: "Rematch" }));
    const busy = await within(card).findByRole("button", { name: "Starting rematch…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
    answer(problem(409, "TOO_MANY_GAMES"));
    expect((await within(card).findByRole("alert")).textContent).toBe(
      "You have too many games waiting or in progress. Finish or cancel one first.",
    );
    const again = within(card).getByRole("button", { name: "Rematch" });
    expect(again.hasAttribute("disabled")).toBe(false);
    expect(again.getAttribute("aria-describedby")).toBe("rematch-problem");
    expect(window.location.pathname).toBe("/g/g1");
  });

  it.each([
    [400, "INVALID_INVITEES", "Someone from this game can't be added any more"],
    [
      400,
      "INVALID_OPTIONS",
      "This game's options aren't available to you. Start a new game instead.",
    ],
    [409, "REMATCH_UNAVAILABLE", "Too few players from this game are left to play it again."],
    [404, "NOT_FOUND", "You're no longer in this rematch."],
    [429, "RATE_LIMITED", "Too many attempts."],
  ])("explains a %i %s", async (status, code, text) => {
    open({
      "GET /api/v1/games/g1": finished(),
      "POST /api/v1/games/g1/rematch": problem(status, code),
    });
    fireEvent.click(within(await results()).getByRole("button", { name: "Rematch" }));
    expect((await screen.findByRole("alert")).textContent).toContain(text);
  });

  it("hands a lost session back", async () => {
    const { lost } = open({
      "GET /api/v1/games/g1": finished(),
      "POST /api/v1/games/g1/rematch": problem(401, "UNAUTHENTICATED"),
    });
    fireEvent.click(within(await results()).getByRole("button", { name: "Rematch" }));
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });
});

describe("a game that can't be shown", () => {
  it("says it isn't available to you on 404", async () => {
    open({ "GET /api/v1/games/g1": problem(404, "NOT_FOUND") });
    expect(await screen.findByRole("heading", { level: 1, name: "Game not found" })).toBeDefined();
  });

  it("offers a retry when offline, and one when the server fails", async () => {
    let answer: Response | Error = new Error("offline");
    open({ "GET /api/v1/games/g1": () => answer });
    expect(await screen.findByRole("heading", { level: 1, name: "You're offline" })).toBeDefined();
    answer = problem(500, "INTERNAL");
    click("Try again");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Can't load this game" }),
    ).toBeDefined();
    answer = withView();
    click("Try again");
    expect(await screen.findByRole("region", { name: "Fake board" })).toBeDefined();
  });

  it("ends the session on a 401", async () => {
    const { lost } = open({ "GET /api/v1/games/g1": problem(401, "UNAUTHENTICATED") });
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });

  it("explains a game whose engine is gone", async () => {
    open({ "GET /api/v1/games/g1": withView(envelope({ available: false }), null) });
    expect(await screen.findByText("This game is no longer available.")).toBeDefined();
  });

  it("explains a game type this app has no client for, and a rules version it doesn't know", async () => {
    cleanup();
    open({}, { client: null });
    expect(await screen.findByText(/can't be shown by this version of the app/u)).toBeDefined();
    cleanup();
    open({ "GET /api/v1/games/g1": withView(envelope({ gameVersion: 7 })) });
    expect(await screen.findByText(/version of the rules this app doesn't know/u)).toBeDefined();
  });
});

describe("the notifications offer after accepting an invitation (A8-P-2)", () => {
  const invitation = () =>
    lobby({
      yourInvitation: "normal",
      players: [
        player({ seat: null, state: "joined", isYou: false, displayName: "Robin" }),
        player({ seat: null, state: "invited", isCreator: false }),
      ],
    });

  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(removeFakePush);

  it("is offered once the accept succeeds, and turns notifications on from the tap", async () => {
    const device = fakePush();
    const { calls } = open(
      {
        "GET /api/v1/games/g1": json({ game: invitation(), view: null }),
        // The accept fills the last seat: the game starts.
        "POST /api/v1/games/g1/accept": withView(envelope({ version: 4 })),
        "POST /api/v1/push/subscriptions": new Response(null, { status: 204 }),
      },
      { pushKey: PUSH_KEY },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByRole("dialog", { name: "Know when it's your turn?" });
    click("Turn on notifications");
    expect(device.requestPermission).toHaveBeenCalledOnce();
    await waitFor(
      () => {
        expect(screen.queryByRole("dialog")).toBeNull();
      },
      { timeout: 1000 },
    );
    expect(calls.some((call) => call.path === "/api/v1/push/subscriptions")).toBe(true);
    // Focus lands on the screen's heading, not the page (A8-R2-4).
    await waitFor(() => {
      expect(document.activeElement?.tagName).toBe("H1");
    });
  });

  it("isn't offered again on this device, nor without a key, nor for a failed accept", async () => {
    fakePush();
    window.localStorage.setItem("ym.push-offered", "1");
    open(
      {
        "GET /api/v1/games/g1": json({ game: invitation(), view: null }),
        "POST /api/v1/games/g1/accept": json({
          game: { ...invitation(), yourInvitation: null, version: 4 },
          view: null,
        }),
      },
      { pushKey: PUSH_KEY },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByText(/Waiting for the creator to start/u);
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    window.localStorage.clear();
    open(
      {
        "GET /api/v1/games/g1": json({ game: invitation(), view: null }),
        "POST /api/v1/games/g1/accept": problem(409, "STALE_GAME"),
      },
      { pushKey: PUSH_KEY },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).toBeNull();
    cleanup();
    open({
      "GET /api/v1/games/g1": json({ game: invitation(), view: null }),
      "POST /api/v1/games/g1/accept": json({
        game: { ...invitation(), yourInvitation: null, version: 4 },
        view: null,
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await screen.findByText(/Waiting for the creator to start/u);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
