import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forgetCatalog } from "../catalog.js";
import { CATALOG, fakeApi, json, player, problem, summary } from "../test-support.js";
import { GameList } from "./GameList.js";

afterEach(() => {
  cleanup();
  forgetCatalog();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

const alex = player({ seat: 1, userId: "u2", displayName: "Alex", isYou: false, isCreator: false });
const list = (...games: object[]) => json({ games, nextCursor: null });
const routes = (games: object[]) => ({
  "GET /api/v1/games": list(...games),
  "GET /api/v1/catalog": json(CATALOG),
});

describe("the game list", () => {
  it("sorts games into your turn, invitations, waiting and finished, with a badge for each", async () => {
    const { api } = fakeApi(
      routes([
        summary({
          id: "a",
          yourTurn: true,
          unread: true,
          lastAction: { describe: ["Alex played CAT"], byYou: false },
        }),
        summary({
          id: "b",
          status: "lobby",
          yourTurn: false,
          yourInvitation: "normal",
          players: [
            player({ isYou: false, displayName: "Robin", state: "joined" }),
            player({ seat: null, state: "invited" }),
          ],
          summary: { headline: ["Waiting for 1 player"] },
        }),
        summary({
          id: "c",
          yourTurn: false,
          players: [player(), alex],
          summary: { headline: ["Alex to play"] },
        }),
        summary({
          id: "d",
          status: "lobby",
          yourTurn: false,
          summary: { headline: ["Waiting for 1 player"] },
        }),
        summary({
          id: "e",
          status: "finished",
          yourTurn: false,
          summary: { headline: ["You won, 212 to 187"] },
        }),
      ]),
    );
    render(<GameList api={api} onSessionLost={vi.fn()} />);

    const yours = await screen.findByRole("region", { name: /Your turn/u });
    expect(within(yours).getByText("Your turn", { selector: ".badge" })).toBeDefined();
    expect(within(yours).getByText("New")).toBeDefined();
    expect(within(yours).getByText("Alex played CAT")).toBeDefined();
    const invitations = screen.getByRole("region", { name: /Invitations/u });
    expect(within(invitations).getByText("Robin invited you")).toBeDefined();
    expect(within(invitations).getByText("Invitation")).toBeDefined();
    const waiting = screen.getByRole("region", { name: /Waiting/u });
    expect(within(waiting).getAllByRole("listitem")).toHaveLength(2);
    // Finished games are collapsed until opened.
    const finished = screen.getByText(/^Finished/u).closest("details");
    expect(finished?.open).toBe(false);
    expect(within(finished as HTMLElement).getByText("You won, 212 to 187")).toBeDefined();
  });

  it("links each game to its screen, and shows the catalog's name and icon as an image", async () => {
    const { api } = fakeApi(routes([summary({ id: "a/b" })]));
    render(<GameList api={api} onSessionLost={vi.fn()} />);
    const link = await screen.findByRole("link", { name: /Words with Alex/u });
    expect(link.getAttribute("href")).toBe("/g/a%2Fb");
    // The icon is an <img> from a data: URL, never inline SVG (08, 02 §7.2).
    await waitFor(() => {
      expect(link.querySelector("img")?.getAttribute("src")).toMatch(
        /^data:image\/svg\+xml,%3Csvg/u,
      );
    });
    expect(document.querySelector("svg")).toBeNull();
    fireEvent.click(link);
    expect(window.location.pathname).toBe("/g/a%2Fb");
  });

  it("says so when there are no games", async () => {
    render(<GameList api={fakeApi(routes([])).api} onSessionLost={vi.fn()} />);
    expect(await screen.findByText(/No games yet/u)).toBeDefined();
  });

  it("still lists games when the catalog fails, naming them by type", async () => {
    const { api } = fakeApi({
      "GET /api/v1/games": list(summary()),
      "GET /api/v1/catalog": problem(500, "INTERNAL"),
    });
    render(<GameList api={api} onSessionLost={vi.fn()} />);
    expect(await screen.findByRole("link", { name: /words with Alex/u })).toBeDefined();
  });

  it("reports a failure without losing the games already shown, and ends the session on a 401", async () => {
    let answer: Response | Error = list(summary());
    const { api } = fakeApi({
      "GET /api/v1/games": () => answer,
      "GET /api/v1/catalog": json(CATALOG),
    });
    const lost = vi.fn();
    render(<GameList api={api} onSessionLost={lost} />);
    await screen.findByRole("link", { name: /Alex/u });
    answer = new Error("offline");
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByText(/offline/u)).toBeDefined();
    expect(screen.getByRole("link", { name: /Alex/u })).toBeDefined();
    answer = problem(401, "UNAUTHENTICATED");
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });

  it("refetches on focus and polls every 15 s, whether or not a game is waiting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let games = [summary({ yourTurn: true })];
    const { api, calls } = fakeApi({
      "GET /api/v1/games": () => list(...games),
      "GET /api/v1/catalog": json(CATALOG),
    });
    render(<GameList api={api} onSessionLost={vi.fn()} />);
    await screen.findByRole("link", { name: /Alex/u });
    const fetched = () => calls.filter((call) => call.path === "/api/v1/games").length;
    expect(fetched()).toBe(1);
    // Nothing is waiting on anyone else, and a new invitation still turns up by itself.
    games = [
      summary({ yourTurn: true }),
      summary({ id: "inv", yourInvitation: "normal", status: "lobby", yourTurn: false }),
    ];
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => {
      expect(screen.getAllByRole("link")).toHaveLength(2);
    });
    expect(fetched()).toBe(2);
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(fetched()).toBe(3);
    });
  });

  it("does not poll while the tab is hidden, and refetches when it is shown again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { api, calls } = fakeApi({
      "GET /api/v1/games": list(summary()),
      "GET /api/v1/catalog": json(CATALOG),
    });
    render(<GameList api={api} onSessionLost={vi.fn()} />);
    await screen.findByRole("link", { name: /Alex/u });
    const fetched = () => calls.filter((call) => call.path === "/api/v1/games").length;
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetched()).toBe(1);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => {
      expect(fetched()).toBe(2);
    });
    visibility.mockRestore();
  });

  it("loads more when there are more pages", async () => {
    const { api, calls } = fakeApi({
      "GET /api/v1/games": (call) =>
        call.path === "/api/v1/games"
          ? json({ games: [summary({ id: "a" })], nextCursor: "next" })
          : json({}),
      "GET /api/v1/catalog": json(CATALOG),
    });
    render(<GameList api={api} onSessionLost={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show more games" }));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/games")).toHaveLength(2);
    });
  });
});
