import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { InstallBanner } from "./InstallBanner.js";
import { CONFIG, fakeApi, json, ME, problem } from "./test-support.js";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function setBrowser(userAgent: string, standalone?: boolean, displayModeStandalone = false) {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
  Object.defineProperty(window.navigator, "standalone", { value: standalone, configurable: true });
  vi.stubGlobal("matchMedia", (query: string) => ({
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
  vi.unstubAllGlobals();
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
    [
      "an iPhone user agent without Safari/",
      IPHONE_SAFARI.replace(" Safari/604.1", ""),
      false,
      false,
    ],
    [
      "an iPhone user agent without Version/",
      IPHONE_SAFARI.replace("Version/17.5 ", ""),
      false,
      false,
    ],
    ["desktop Chrome", DESKTOP_CHROME, undefined, false],
    ["Safari launched from the Home Screen", IPHONE_SAFARI, true, false],
    ["an installed app by display mode", IPHONE_SAFARI, false, true],
  ])("is not shown for %s", (_name, ua, standalone, displayMode) => {
    setBrowser(ua, standalone, displayMode);
    const { container } = render(<InstallBanner appName="Family Games" />);
    expect(container.textContent).toBe("");
  });

  // Each keeps Safari's own `Version/` and `Safari/`, so only the added token tells it apart.
  it.each([
    "FxiOS/127.0",
    "EdgiOS/126.0",
    "OPiOS/16.0",
    "GSA/300.0",
    "DuckDuckGo/7",
    "Instagram 330.0",
    "[FBAN/FBIOS;FBAV/450.0]",
    "Twitter for iPhone",
    "LinkedInApp",
    "Snapchat/12.0",
    "Pinterest/12.0",
    "MicroMessenger/8.0",
    "musical_ly_32.0",
    "BytedanceWebview/d8a21c6",
    "Reddit/Version 2024.20",
    "Line/14.0",
  ])("is not shown in a browser whose user agent adds %s", (token) => {
    setBrowser(`${IPHONE_SAFARI} ${token}`, false);
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

  it("is not shown on a Mac with no touch screen", () => {
    setBrowser(IPHONE_SAFARI.replace("iPhone; CPU iPhone OS 17_5 like", "Macintosh; Intel"), false);
    vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
    Object.defineProperty(window.navigator, "maxTouchPoints", { value: 0, configurable: true });
    const { container } = render(<InstallBanner appName="Family Games" />);
    expect(container.textContent).toBe("");
  });

  it("moves focus to the screen's heading when dismissed", () => {
    setBrowser(IPHONE_SAFARI, false);
    render(
      <>
        <h1 tabIndex={-1}>Home</h1>
        <InstallBanner appName="Family Games" />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Home" }));
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

  it.each(["/new", "/settings"])("puts the banner on %s", async (path) => {
    setBrowser(IPHONE_SAFARI, false);
    window.history.replaceState(null, "", path);
    render(<App api={fakeApi(signedIn).api} />);
    expect(await screen.findByRole("link", { name: "Show me how" })).toBeTruthy();
  });

  it("keeps the banner off a game's address, whether or not the game loads", async () => {
    setBrowser(IPHONE_SAFARI, false);
    window.history.replaceState(null, "", "/g/g1");
    render(
      <App api={fakeApi({ ...signedIn, "GET /api/v1/games/g1": problem(404, "NOT_FOUND") }).api} />,
    );
    await waitFor(() => {
      expect(window.location.pathname).toBe("/g/g1");
    });
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("link", { name: "Show me how" })).toBeNull();
  });

  it("keeps the banner off the welcome screen", async () => {
    setBrowser(IPHONE_SAFARI, false);
    const api = fakeApi({
      ...signedIn,
      "GET /api/v1/me": json({ ...ME, displayName: null, needsOnboarding: true }),
    }).api;
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    expect(screen.queryByRole("link", { name: "Show me how" })).toBeNull();
  });

  it("links to the guide from Settings", async () => {
    setBrowser(IPHONE_SAFARI, true);
    window.history.replaceState(null, "", "/settings");
    render(<App api={fakeApi(signedIn).api} />);
    const link = await screen.findByRole("link", { name: /How to add Family Games/u });
    expect(link.getAttribute("href")).toBe("/install");
  });

  it("sends a signed-out visit to the guide through sign-in and back", async () => {
    setBrowser(IPHONE_SAFARI, false);
    window.history.replaceState(null, "", "/install");
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": problem(401, "UNAUTHENTICATED"),
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({ user: ME, needsOnboarding: false }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "sam@example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    fireEvent.change(await screen.findByLabelText("Sign-in code"), {
      target: { value: "12345678" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(
      await screen.findByRole("heading", { name: "Add to Home Screen", level: 1 }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe("/install");
  });

  it("keeps the dismissal across a real sign-out while the game keys go", async () => {
    setBrowser(IPHONE_SAFARI, true);
    window.localStorage.setItem("ym.install-dismissed", "1");
    window.localStorage.setItem("ym.game.words.u1.g1", "{}");
    window.history.replaceState(null, "", "/settings");
    const { api } = fakeApi({
      ...signedIn,
      "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(window.localStorage.getItem("ym.install-dismissed")).toBe("1");
    expect(window.localStorage.getItem("ym.game.words.u1.g1")).toBeNull();
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
