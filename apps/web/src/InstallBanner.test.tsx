import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { InstallBanner } from "./InstallBanner.js";
import { CONFIG, fakeApi, json, ME } from "./test-support.js";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function setBrowser(userAgent: string, standalone?: boolean, displayModeStandalone = false) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
  Object.defineProperty(window.navigator, "standalone", { value: standalone, configurable: true });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: displayModeStandalone && query.includes("standalone"),
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window.navigator, "standalone");
  Reflect.deleteProperty(window.navigator, "maxTouchPoints");
});

describe("InstallBanner", () => {
  it("shows for iOS Safari in a tab and links to the guide", () => {
    setBrowser(IPHONE_SAFARI, false);
    render(<InstallBanner appName="Family Games" />);
    expect(screen.getByText(/Add Family Games to your Home Screen/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Show me how" }).getAttribute("href")).toBe("/install");
  });

  it.each([
    ["Chrome on iOS", IPHONE_CHROME, false, false],
    ["desktop Chrome", DESKTOP_CHROME, undefined, false],
    ["Safari launched from the Home Screen", IPHONE_SAFARI, true, false],
    ["an installed app by display mode", IPHONE_SAFARI, false, true],
  ])("is not shown for %s", (_name, ua, standalone, displayMode) => {
    setBrowser(ua, standalone, displayMode);
    const { container } = render(<InstallBanner appName="Family Games" />);
    expect(container.textContent).toBe("");
  });

  it("is recognised on iPadOS, which reports a Mac", () => {
    setBrowser(IPHONE_SAFARI.replace("iPhone; CPU iPhone OS 17_5 like", "Macintosh; Intel"), false);
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    Object.defineProperty(window.navigator, "maxTouchPoints", { value: 5, configurable: true });
    render(<InstallBanner appName="Family Games" />);
    expect(screen.getByRole("link", { name: "Show me how" })).toBeTruthy();
  });

  it("stays dismissed on this device", () => {
    setBrowser(IPHONE_SAFARI, false);
    render(<InstallBanner appName="Family Games" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("link", { name: "Show me how" })).toBeNull();
    cleanup();
    render(<InstallBanner appName="Family Games" />);
    expect(screen.queryByRole("link", { name: "Show me how" })).toBeNull();
  });

  it("renders and dismisses even when storage throws", () => {
    setBrowser(IPHONE_SAFARI, false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<InstallBanner appName="Family Games" />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("link", { name: "Show me how" })).toBeNull();
  });
});

describe("the install guide in the app", () => {
  const signedIn = {
    "GET /api/v1/config": json(CONFIG),
    "GET /api/v1/me": json(ME),
    "GET /api/v1/games": json({ games: [] }),
  };

  it("shows the steps in a tab", async () => {
    setBrowser(IPHONE_SAFARI, false);
    window.history.replaceState(null, "", "/install");
    render(<App api={fakeApi(signedIn).api} />);
    expect(
      await screen.findByRole("heading", { name: "Add to Home Screen", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: /iPhone and iPad/u })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /Android/u })).toBeTruthy();
    expect(screen.getAllByRole("list")).toHaveLength(2);
    // The guide itself carries no banner.
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("says so when the app is already installed", async () => {
    setBrowser(IPHONE_SAFARI, true);
    window.history.replaceState(null, "", "/install");
    render(<App api={fakeApi(signedIn).api} />);
    expect(
      await screen.findByText(/already using Family Games from your Home Screen/u),
    ).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("puts the banner on the home screen, and its link reaches the guide", async () => {
    setBrowser(IPHONE_SAFARI, false);
    render(<App api={fakeApi(signedIn).api} />);
    fireEvent.click(await screen.findByRole("link", { name: "Show me how" }));
    expect(
      await screen.findByRole("heading", { name: "Add to Home Screen", level: 1 }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/install");
  });

  it("does not put the banner on the sign-in screen", async () => {
    setBrowser(IPHONE_SAFARI, false);
    const api = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": json({ code: "UNAUTHENTICATED" }, 401),
    }).api;
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.queryByRole("link", { name: "Show me how" })).toBeNull();
  });
});
