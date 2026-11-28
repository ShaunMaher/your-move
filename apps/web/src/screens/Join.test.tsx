/** The join-link landing page (07 §1 `/join`, 06 §6.8): what the link is for, and Join on a tap. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetCatalog } from "../catalog.js";
import { captureJoinFragment, clearJoinToken, keptJoinToken } from "../join-token.js";
import { CATALOG, envelope, fakeApi, json, problem } from "../test-support.js";
import { Join } from "./Join.js";

const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";

const PREVIEW = {
  id: "g7",
  gameType: "words",
  options: { rulesetId: "standard" },
  resources: [{ kind: "dictionary", id: "enable", name: "ENABLE" }],
  turnTimeoutDays: 3,
  seatOrder: "join",
  aiAssistance: "off",
  creatorName: "Ada",
  players: [
    { displayName: "Ada", kind: "human" },
    { displayName: "Bo", kind: "human" },
  ],
  openSeats: 2,
  expiresAt: Date.UTC(2026, 11, 5, 18),
};

beforeEach(() => {
  window.history.replaceState(null, "", `/join#${TOKEN}`);
  captureJoinFragment();
});
afterEach(() => {
  cleanup();
  forgetCatalog();
  clearJoinToken();
});

function open(routes: Parameters<typeof fakeApi>[0] = {}) {
  const fake = fakeApi({
    "GET /api/v1/catalog": json(CATALOG),
    "POST /api/v1/join/lookup": json({ game: PREVIEW }),
    ...routes,
  });
  const lost = vi.fn();
  render(<Join api={fake.api} appName="Family Games" onSessionLost={lost} />);
  return { ...fake, lost };
}

const posts = (calls: readonly { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((call) => call.method === "POST" && call.path === path);

describe("the landing page", () => {
  it("shows the game, its creator and players, and joins nothing by itself", async () => {
    const { calls } = open();
    expect(await screen.findByRole("heading", { level: 1, name: "Join Words" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Ada's Words game");
    expect(screen.getByText("Ada, Bo")).toBeDefined();
    expect(screen.getByText("3 days a move")).toBeDefined();
    expect(screen.getByText("ENABLE")).toBeDefined();
    expect(screen.getByText(/starts when Ada starts it/u)).toBeDefined();
    expect(posts(calls, "/api/v1/join/lookup").map((call) => call.body)).toEqual([
      { token: TOKEN },
    ]);
    expect(posts(calls, "/api/v1/join")).toHaveLength(0);
  });

  it("joins on the tap, forgets the token and opens the game", async () => {
    const { calls } = open({ "POST /api/v1/join": json({ game: envelope({ id: "g7" }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g7");
    });
    expect(posts(calls, "/api/v1/join")).toHaveLength(1);
    expect(keptJoinToken()).toBeNull();
  });

  it("opens the game for someone already in it", async () => {
    open({ "POST /api/v1/join": problem(409, "ALREADY_JOINED") });
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g7");
    });
    expect(keptJoinToken()).toBeNull();
  });

  it("says a link that doesn't work doesn't, and forgets it", async () => {
    open({ "POST /api/v1/join/lookup": problem(404, "NOT_FOUND") });
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeDefined();
    expect(keptJoinToken()).toBeNull();
  });

  it("forgets a link that stopped working before the tap", async () => {
    open({ "POST /api/v1/join": problem(404, "NOT_FOUND") });
    fireEvent.click(await screen.findByRole("button", { name: "Join" }));
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeDefined();
    expect(keptJoinToken()).toBeNull();
  });

  it("asks nothing of the server without a token", async () => {
    clearJoinToken();
    const { calls } = open();
    expect(await screen.findByRole("heading", { name: "This link doesn't work" })).toBeDefined();
    expect(posts(calls, "/api/v1/join/lookup")).toHaveLength(0);
  });

  it("keeps the link when the limits or the network refuse, and says so", async () => {
    open({ "POST /api/v1/join/lookup": problem(429, "RATE_LIMITED") });
    expect(await screen.findByText(/too many join links/u)).toBeDefined();
    expect(keptJoinToken()).toBe(TOKEN);
    cleanup();
    open({ "POST /api/v1/join/lookup": new Error("offline") });
    expect(await screen.findByRole("button", { name: "Try again" })).toBeDefined();
    expect(keptJoinToken()).toBe(TOKEN);
  });

  it("hands a 401 to the app", async () => {
    const { lost } = open({ "POST /api/v1/join/lookup": problem(401, "UNAUTHENTICATED") });
    await waitFor(() => {
      expect(lost).toHaveBeenCalled();
    });
  });

  it("takes a new link opened over the page", async () => {
    const { calls } = open();
    await screen.findByRole("button", { name: "Join" });
    const other = "ZyXwVuTsRqPoNmLkJiHgFe";
    window.history.replaceState(null, "", `/join#${other}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await waitFor(() => {
      expect(posts(calls, "/api/v1/join/lookup")).toHaveLength(2);
    });
    expect(window.location.hash).toBe("");
    expect(posts(calls, "/api/v1/join/lookup")[1]?.body).toEqual({
      token: other,
    });
  });
});
