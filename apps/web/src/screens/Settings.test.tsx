/** The Settings toggles: email nudges (03 §7; alpha A6) and notifications (07 §4; alpha A8). */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../App.js";
import {
  CONFIG,
  fakeApi,
  fakePush,
  json,
  ME,
  problem,
  PUSH_KEY,
  removeFakePush,
} from "../test-support.js";

beforeEach(() => {
  window.history.replaceState(null, "", "/settings");
});
afterEach(cleanup);

const LABEL = "Email me when it's my turn";

function routes(patch: Parameters<typeof fakeApi>[0][string]) {
  return fakeApi({
    "GET /api/v1/config": json(CONFIG),
    "GET /api/v1/me": json(ME),
    "PATCH /api/v1/me": patch,
  });
}

const toggle = () => screen.getByRole<HTMLInputElement>("checkbox", { name: LABEL });

describe("the email nudges toggle", () => {
  it("is off by default and turns on through PATCH /api/v1/me", async () => {
    const { api, calls } = routes((call) =>
      json({
        ...ME,
        settings: { ...ME.settings, ...(call.body as { settings: object }).settings },
      }),
    );
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    expect(toggle().checked).toBe(false);
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(toggle().checked).toBe(true);
    });
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/api/v1/me",
      body: { settings: { emailNudges: true } },
    });
    fireEvent.click(toggle());
    await waitFor(() => {
      expect(toggle().checked).toBe(false);
    });
    expect(calls.at(-1)?.body).toEqual({ settings: { emailNudges: false } });
  });

  it.each([
    ["the server errors", problem(500, "INTERNAL"), "Your setting wasn't saved. Please try again."],
    [
      "the network is down",
      new TypeError("offline"),
      "You seem to be offline. Your setting wasn't saved. Try again.",
    ],
  ])("says so and stays off when %s", async (_name, answer, message) => {
    const { api } = routes(answer);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(toggle());
    await screen.findByText(message);
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
  });

  it("goes to sign-in when the session is gone", async () => {
    const { api } = routes(problem(401, "UNAUTHENTICATED"));
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(toggle());
    await screen.findByRole("heading", { name: "Sign in" });
  });
});

describe("the theme choice (07 §5, alpha A9)", () => {
  const radio = (name: string) => screen.getByRole<HTMLInputElement>("radio", { name });
  const themed = (call: { body?: unknown }) =>
    json({
      ...ME,
      settings: { ...ME.settings, ...(call.body as { settings: object }).settings },
    });

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
  });

  it("shows the saved theme, saves a change at once, and applies and remembers it", async () => {
    const { api, calls } = routes(themed);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    expect(radio("System").checked).toBe(true);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    fireEvent.click(radio("Dark"));
    await screen.findByText("Theme saved");
    expect(radio("Dark").checked).toBe(true);
    expect(calls.at(-1)).toMatchObject({
      method: "PATCH",
      path: "/api/v1/me",
      body: { settings: { theme: "dark" } },
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("ym.theme")).toBe("dark");
    fireEvent.click(radio("System"));
    await screen.findByText("Theme saved");
    expect(radio("System").checked).toBe(true);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("ym.theme")).toBe("system");
  });

  it("starts from the theme the server has for the person", async () => {
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": json({ ...ME, settings: { ...ME.settings, theme: "light" } }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    expect(radio("Light").checked).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("works when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { api } = routes(themed);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(radio("Dark"));
    await screen.findByText("Theme saved");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    vi.restoreAllMocks();
  });

  it("shows and applies a choice at once, and keeps focus on the radio (A9-P-1)", async () => {
    let answer!: (response: Response) => void;
    const { api } = routes(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    radio("Dark").focus();
    fireEvent.click(radio("Dark"));
    // Before the server has answered.
    expect(radio("Dark").checked).toBe(true);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(radio("Dark").disabled).toBe(false);
    await waitFor(() => {
      expect(answer).toBeTypeOf("function");
    });
    expect(document.activeElement).toBe(radio("Dark"));
    answer(json({ ...ME, settings: { ...ME.settings, theme: "dark" } }));
    await screen.findByText("Theme saved");
    expect(document.activeElement).toBe(radio("Dark"));
    expect(screen.getByRole("group", { name: "Appearance" })).toBeTruthy();
  });

  it.each([
    ["the server errors", problem(500, "INTERNAL"), "Your setting wasn't saved. Please try again."],
    [
      "the network is down",
      new TypeError("offline"),
      "You seem to be offline. Your setting wasn't saved. Try again.",
    ],
  ])("rolls back and says so when %s (A9-P-1)", async (_name, failure, message) => {
    const { api } = routes(failure);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(radio("Light"));
    await screen.findByText(message);
    expect(radio("System").checked).toBe(true);
    expect(radio("Light").checked).toBe(false);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem("ym.theme")).toBe("system");
  });

  it("keeps the device's theme after sign-out", async () => {
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": json({ ...ME, settings: { ...ME.settings, theme: "dark" } }),
      "POST /api/v1/auth/logout": json({}),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("ym.theme")).toBe("dark");
  });
});

describe("notifications on this device (07 §4, alpha A8)", () => {
  const PUSH_LABEL = "Notify me on this device";
  const SAVED = new Response(null, { status: 204 });

  function withKey(extra: Parameters<typeof fakeApi>[0] = {}) {
    return fakeApi({
      "GET /api/v1/config": json({ ...CONFIG, vapidPublicKey: PUSH_KEY }),
      "GET /api/v1/me": json(ME),
      ...extra,
    });
  }

  afterEach(removeFakePush);

  it("turns on from the tap and saves the subscription, then off again", async () => {
    const device = fakePush();
    const { api, calls } = withKey({
      "POST /api/v1/push/subscriptions": SAVED,
      "DELETE /api/v1/push/subscriptions": SAVED,
    });
    render(<App api={api} />);
    const box = await screen.findByRole<HTMLInputElement>("checkbox", { name: PUSH_LABEL });
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(device.requestPermission).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(box.checked).toBe(true);
    });
    expect(
      calls.some((call) => call.method === "POST" && call.path === "/api/v1/push/subscriptions"),
    ).toBe(true);
    fireEvent.click(box);
    await waitFor(() => {
      expect(box.checked).toBe(false);
    });
    expect(calls.at(-1)?.method).toBe("DELETE");
    expect(device.state.subscription).toBeNull();
  });

  it("says when notifications are blocked after the prompt", async () => {
    fakePush({ answer: "denied" });
    const { api } = withKey();
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: PUSH_LABEL }));
    await screen.findByText(/Notifications from Family Games are blocked on this device/u);
    expect(screen.queryByRole("checkbox", { name: PUSH_LABEL })).toBeNull();
    // The toggle is gone, so focus goes to the section's heading, not the page (A8-P-4).
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Notifications" }));
    });
  });

  it("says so when saving fails, and stays off", async () => {
    fakePush();
    const { api } = withKey({ "POST /api/v1/push/subscriptions": problem(500, "INTERNAL") });
    render(<App api={api} />);
    const box = await screen.findByRole<HTMLInputElement>("checkbox", { name: PUSH_LABEL });
    fireEvent.click(box);
    await screen.findByText("Notifications couldn't be changed on this device. Please try again.");
    expect(box.checked).toBe(false);
  });

  it("points iOS Safari in a tab to the Home Screen guide", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 " +
        "(KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    );
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const { api } = withKey();
    render(<App api={api} />);
    await screen.findByText(/notifications work once Family Games is on your Home Screen/u);
    const links = screen.getAllByRole("link", { name: /Home Screen/u });
    expect(links.some((link) => link.getAttribute("href") === "/install")).toBe(true);
    expect(screen.queryByRole("checkbox", { name: PUSH_LABEL })).toBeNull();
    vi.restoreAllMocks();
  });

  it("says nothing can be sent when the server has no VAPID key", async () => {
    fakePush();
    const { api } = routes(json(ME));
    render(<App api={api} />);
    await screen.findByText("Family Games doesn't send notifications.");
  });
});

describe("signing out on this device (06 §4)", () => {
  afterEach(removeFakePush);

  it("drops this device's push subscription", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: PUSH_KEY });
    const { api } = fakeApi({
      "GET /api/v1/config": json({ ...CONFIG, vapidPublicKey: PUSH_KEY }),
      "GET /api/v1/me": json(ME),
      "POST /api/v1/push/subscriptions": new Response(null, { status: 204 }),
      "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
    });
    render(<App api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => {
      expect(device.state.subscription).toBeNull();
    });
  });
});

describe("a launch without a session (06 §4, A8-P-1)", () => {
  afterEach(removeFakePush);

  it("drops the device's push subscription and saves nothing", async () => {
    const device = fakePush({ permission: "granted", subscribedWith: PUSH_KEY });
    const subscription = device.state.subscription;
    const { api, calls } = fakeApi({
      "GET /api/v1/config": json({ ...CONFIG, vapidPublicKey: PUSH_KEY }),
      "GET /api/v1/me": problem(401, "UNAUTHENTICATED"),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => {
      expect(subscription?.unsubscribe).toHaveBeenCalled();
    });
    expect(device.state.subscription).toBeNull();
    expect(calls.filter((call) => call.path.startsWith("/api/v1/push"))).toEqual([]);
  });
});
