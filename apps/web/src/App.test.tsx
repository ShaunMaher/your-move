import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.js";
import { captureJoinFragment, clearJoinToken, keptJoinToken } from "./join-token.js";
import { clearReturnPath, isAppPath, peekReturnPath, rememberReturnPath } from "./return-path.js";
import { clearClientState } from "./session-sync.js";
import { CONFIG, fakeApi, json, ME, problem } from "./test-support.js";

const signedOut = {
  "GET /api/v1/config": json(CONFIG),
  "GET /api/v1/me": problem(401, "UNAUTHENTICATED"),
};
const signedIn = (me: object = ME) => ({
  "GET /api/v1/config": json(CONFIG),
  "GET /api/v1/me": json(me),
});

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  clearReturnPath();
});
afterEach(cleanup);

const typeInto = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
/** What every live alert region says now (the empty ones are always in the page). */
const alertText = () =>
  screen
    .getAllByRole("alert")
    .map((alert) => alert.textContent)
    .join(" ")
    .trim();
const click = (name: string | RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
};

/** Signs in through the email and code steps with the given verify answer. */
async function signInWith(verify: Response) {
  const { api, calls } = fakeApi({
    ...signedOut,
    "POST /api/v1/auth/otp/request": json({}, 202),
    "POST /api/v1/auth/otp/verify": verify,
  });
  render(<App api={api} />);
  await screen.findByRole("heading", { name: "Sign in" });
  typeInto("Email address", "sam@example.org");
  click("Email me a code");
  await screen.findByLabelText("Sign-in code");
  typeInto("Sign-in code", "1234 5678");
  click("Sign in");
  return calls;
}

describe("the instance's name", () => {
  it("comes from the config, never the build (03 §9)", async () => {
    render(<App api={fakeApi(signedOut).api} />);
    expect(await screen.findByText("Family Games")).toBeDefined();
    await waitFor(() => {
      expect(document.title).toBe("Family Games");
    });
    expect(
      document.head
        .querySelector('meta[name="apple-mobile-web-app-title"]')
        ?.getAttribute("content"),
    ).toBe("Games");
  });
});

describe("signed out", () => {
  it("lands on /signin whatever was asked for", async () => {
    window.history.replaceState(null, "", "/settings");
    render(<App api={fakeApi(signedOut).api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/signin");
    });
  });

  it("checks the address before asking for a code", async () => {
    const { api, calls } = fakeApi(signedOut);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "not an address");
    click("Email me a code");
    expect((await screen.findByRole("alert")).textContent).toContain("email address");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("asks for a code, then takes it pasted with a space", async () => {
    const calls = await signInWith(json({ user: ME, needsOnboarding: false }));
    expect(await screen.findByRole("heading", { name: "Hi, Sam" })).toBeDefined();
    expect(
      calls.filter((call) => call.method === "POST").map((call) => [call.path, call.body]),
    ).toEqual([
      ["/api/v1/auth/otp/request", { email: "sam@example.org" }],
      ["/api/v1/auth/otp/verify", { email: "sam@example.org", code: "12345678" }],
    ]);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("gives the code field the autofill attributes (06 §3.3)", async () => {
    const { api } = fakeApi({ ...signedOut, "POST /api/v1/auth/otp/request": json({}, 202) });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    const input = await screen.findByLabelText("Sign-in code");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("pattern")).toBe("[0-9]*");
    expect(document.activeElement).toBe(input);
  });

  it("strips everything but digits and stops at eight", async () => {
    const { api } = fakeApi({ ...signedOut, "POST /api/v1/auth/otp/request": json({}, 202) });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12-34 56 78 99");
    expect(screen.getByLabelText<HTMLInputElement>("Sign-in code").value).toBe("12345678");
  });

  it("says a short code is short without asking the server", async () => {
    const { api, calls } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "1234");
    click("Sign in");
    expect((await screen.findByRole("alert")).textContent).toContain("8-digit");
    expect(calls.filter((call) => call.path.endsWith("/verify"))).toEqual([]);
  });

  it("gives one message for a wrong, expired or used code", async () => {
    await signInWith(problem(400, "INVALID_CODE"));
    const alert = await screen.findByText(/That code didn't work/u);
    expect(alert.textContent).toContain("expired");
    // Still on the code step, with the field kept for another try.
    expect(screen.getByLabelText("Sign-in code")).toBeDefined();
  });

  it("says when verifying is rate limited", async () => {
    await signInWith(problem(429, "RATE_LIMITED"));
    expect((await screen.findByRole("alert")).textContent).toContain("Too many tries");
  });

  it("says when asking for a code is rate limited, and stays on the email step", async () => {
    const { api } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": problem(429, "RATE_LIMITED"),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    expect((await screen.findByRole("alert")).textContent).toContain("Too many attempts");
    expect(screen.queryByLabelText("Sign-in code")).toBeNull();
  });

  it("says so when offline", async () => {
    const { api } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": new TypeError("offline"),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
  });

  it("sends another code on request and says so", async () => {
    const { api, calls } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", " sam@example.org ");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    click("Send a new code");
    expect(await screen.findByText("We've sent another code.")).toBeDefined();
    expect(calls.filter((call) => call.path.endsWith("/request"))).toHaveLength(2);
    expect(calls.at(-1)?.body).toEqual({ email: "sam@example.org" });
  });

  it("goes back to change the address", async () => {
    const { api } = fakeApi({ ...signedOut, "POST /api/v1/auth/otp/request": json({}, 202) });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    click("Use a different address");
    expect(screen.getByLabelText<HTMLInputElement>("Email address").value).toBe("sam@example.org");
  });

  it("shows the server's answer identically for any address (the app adds nothing of its own)", async () => {
    // The fake answers every address identically, as the API does (06 §6.1); this checks that the
    // screens and words don't depend on the address. The API's own parity is tested server-side.
    const run = async (email: string) => {
      const { api } = fakeApi({ ...signedOut, "POST /api/v1/auth/otp/request": json({}, 202) });
      const view = render(<App api={api} />);
      await screen.findByRole("heading", { name: "Sign in" });
      typeInto("Email address", email);
      click("Email me a code");
      await screen.findByLabelText("Sign-in code");
      const text = view.container.textContent;
      view.unmount();
      return text;
    };
    expect(await run("known@example.org")).toBe(await run("stranger@example.org"));
  });
});

describe("onboarding", () => {
  async function toWelcome(save: Response) {
    const { api, calls } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({
        user: { ...ME, displayName: null, needsOnboarding: true },
        needsOnboarding: true,
      }),
      "PATCH /api/v1/me": save,
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    return calls;
  }

  it("asks for a display name with the warning, then shows the home screen", async () => {
    const calls = await toWelcome(json(ME));
    await waitFor(() => {
      expect(window.location.pathname).toBe("/welcome");
    });
    expect(screen.getByText(/Don't use your full name/u)).toBeDefined();
    typeInto("Display name", "Sam");
    click("Continue");
    expect(await screen.findByRole("heading", { name: "Hi, Sam" })).toBeDefined();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(calls.filter((call) => call.method !== "GET").at(-1)).toMatchObject({
      method: "PATCH",
      body: { displayName: "Sam" },
    });
  });

  it("explains a refused name", async () => {
    await toWelcome(problem(400, "BAD_REQUEST"));
    typeInto("Display name", "admin");
    click("Continue");
    await waitFor(() => {
      expect(alertText()).toContain("can't be used");
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/welcome");
    });
  });

  it("checks the length before asking", async () => {
    const calls = await toWelcome(json(ME));
    typeInto("Display name", "   ");
    click("Continue");
    await waitFor(() => {
      expect(alertText()).toContain("Enter a display name");
    });
    typeInto("Display name", "x".repeat(25));
    click("Continue");
    await waitFor(() => {
      expect(alertText()).toContain("up to 24");
    });
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("counts characters as people do, not code units", async () => {
    const calls = await toWelcome(json(ME));
    typeInto("Display name", "👨‍👩‍👧".repeat(24));
    click("Continue");
    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    });
  });

  it("holds a signed-in person who hasn't onboarded at /welcome, wherever they go", async () => {
    window.history.replaceState(null, "", "/settings");
    render(
      <App api={fakeApi(signedIn({ ...ME, displayName: null, needsOnboarding: true })).api} />,
    );
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/welcome");
    });
  });

  it("lets them sign out instead", async () => {
    const { api, calls } = fakeApi({
      ...signedIn({ ...ME, displayName: null, needsOnboarding: true }),
      "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    click("Sign out");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(calls.some((call) => call.path === "/api/v1/auth/logout")).toBe(true);
  });
});

describe("signed in", () => {
  it("shows the home screen with a slot for the game list", async () => {
    render(<App api={fakeApi(signedIn()).api} />);
    expect(await screen.findByRole("heading", { name: "Hi, Sam" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Your games" }).getAttribute("data-slot")).toBe(
      "game-list",
    );
  });

  it("keeps them out of the sign-in screens", async () => {
    window.history.replaceState(null, "", "/signin");
    render(<App api={fakeApi(signedIn()).api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it("says when a page doesn't exist", async () => {
    window.history.replaceState(null, "", "/nowhere");
    render(<App api={fakeApi(signedIn()).api} />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeDefined();
  });

  it("signs out", async () => {
    const { api, calls } = fakeApi({
      ...signedIn(),
      "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    await screen.findByRole("heading", { name: "Settings" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings");
    });
    expect(screen.getByText("sam@example.org")).toBeDefined();
    click("Sign out");
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/signin");
    });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/auth/logout" });
  });

  describe("when signing out fails", () => {
    it.each([
      ["the network is down", new TypeError("offline")],
      ["the server errors", problem(500, "INTERNAL")],
      ["the request is rate limited", problem(429, "RATE_LIMITED")],
    ])("says so and stays signed in when %s", async (_name, answer) => {
      const { api, calls } = fakeApi({ ...signedIn(), "POST /api/v1/auth/logout": answer });
      window.history.replaceState(null, "", "/settings");
      render(<App api={api} />);
      await screen.findByRole("heading", { name: "Settings" });
      click("Sign out");
      await waitFor(() => {
        expect(calls.some((call) => call.path === "/api/v1/auth/logout")).toBe(true);
      });
      await waitFor(() => {
        expect(alertText()).toBe("Couldn't sign out. You're still signed in. Try again.");
      });
      await waitFor(() => {
        expect(window.location.pathname).toBe("/settings");
      });
      expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined();
      expect(screen.queryByRole("heading", { name: "Sign in" })).toBeNull();
      // The button is usable again, and trying again works.
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Sign out" }).disabled).toBe(
        false,
      );
    });

    it("shows it is working while it waits", async () => {
      const fake = fakeApi({
        ...signedIn(),
        "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
      });
      window.history.replaceState(null, "", "/settings");
      render(<App api={fake.api} />);
      await screen.findByRole("heading", { name: "Settings" });
      click("Sign out");
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Signing out…" }).disabled).toBe(
        true,
      );
      await screen.findByRole("heading", { name: "Sign in" });
    });

    it("says so on the welcome screen too", async () => {
      const { api } = fakeApi({
        ...signedIn({ ...ME, displayName: null, needsOnboarding: true }),
        "POST /api/v1/auth/logout": problem(500, "INTERNAL"),
      });
      render(<App api={api} />);
      await screen.findByRole("heading", { name: "Welcome to Family Games" });
      click("Sign out");
      await waitFor(() => {
        expect(alertText()).toContain("Couldn't sign out. You're still signed in.");
      });
      await waitFor(() => {
        expect(window.location.pathname).toBe("/welcome");
      });
    });
  });

  async function openEverywhere() {
    const fake = fakeApi({
      ...signedIn(),
      "POST /api/v1/auth/logout-all": new Response(null, { status: 204 }),
    });
    window.history.replaceState(null, "", "/settings");
    render(<App api={fake.api} />);
    await screen.findByRole("heading", { name: "Settings" });
    click(/Sign out everywhere/u);
    return fake.calls;
  }

  it("signs out everywhere, revoking API tokens unless unchecked", async () => {
    const calls = await openEverywhere();
    const box = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Also revoke all my API tokens",
    });
    expect(box.checked).toBe(true);
    click("Sign out everywhere");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(calls.at(-1)).toMatchObject({
      path: "/api/v1/auth/logout-all",
      body: { revokeTokens: true },
    });
  });

  it("can leave API tokens alone", async () => {
    const calls = await openEverywhere();
    fireEvent.click(screen.getByRole("checkbox", { name: "Also revoke all my API tokens" }));
    click("Sign out everywhere");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(calls.at(-1)?.body).toEqual({ revokeTokens: false });
  });

  it("can change its mind", async () => {
    const calls = await openEverywhere();
    click("Cancel");
    expect(screen.queryByRole("checkbox", { name: "Also revoke all my API tokens" })).toBeNull();
    expect(calls.some((call) => call.path.endsWith("logout-all"))).toBe(false);
  });
});

describe("when the server can't be reached", () => {
  it("says it's offline and tries again on request", async () => {
    let up = false;
    const { api } = fakeApi({
      "GET /api/v1/config": () => (up ? json(CONFIG) : new TypeError("offline")),
      "GET /api/v1/me": () => (up ? json(ME) : new TypeError("offline")),
    });
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "You're offline" })).toBeDefined();
    up = true;
    click("Try again");
    expect(await screen.findByRole("heading", { name: "Hi, Sam" })).toBeDefined();
  });

  it("tells a server error from being offline", async () => {
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": problem(500, "INTERNAL"),
    });
    render(<App api={api} />);
    expect(await screen.findByRole("heading", { name: "Can't reach the server" })).toBeDefined();
  });

  it("shows loading first", () => {
    render(<App api={fakeApi({}).api} />);
    expect(screen.getByText("Loading…").getAttribute("role")).toBe("status");
  });
});

describe("returning to where a signed-out visit was headed", () => {
  it("lands on the page that was asked for once signed in", async () => {
    window.history.replaceState(null, "", "/settings");
    const { api } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({ user: ME, needsOnboarding: false }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/signin");
    });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeDefined();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings");
    });
  });

  it("keeps it through onboarding, so a new person lands where they were headed", async () => {
    window.history.replaceState(null, "", "/settings");
    const { api } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({
        user: { ...ME, displayName: null, needsOnboarding: true },
        needsOnboarding: true,
      }),
      "PATCH /api/v1/me": json(ME),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/welcome");
    });
    typeInto("Display name", "Sam");
    click("Continue");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeDefined();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings");
    });
    expect(peekReturnPath()).toBeNull();
  });

  it("keeps it through a reload during Welcome", async () => {
    window.history.replaceState(null, "", "/settings");
    const newUser = { ...ME, displayName: null, needsOnboarding: true };
    const first = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({ user: newUser, needsOnboarding: true }),
    });
    const view = render(<App api={first.api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    view.unmount();
    expect(peekReturnPath()).toBe("/settings");
    // The reload: a fresh app, the session now exists, the page is /welcome.
    window.history.replaceState(null, "", "/welcome");
    const second = fakeApi({ ...signedIn(newUser), "PATCH /api/v1/me": json(ME) });
    render(<App api={second.api} />);
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    expect(peekReturnPath()).toBe("/settings");
    typeInto("Display name", "Sam");
    click("Continue");
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeDefined();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings");
    });
    expect(peekReturnPath()).toBeNull();
  });

  it("goes home after an explicit sign-out, not back to where the person was", async () => {
    const { api } = fakeApi({
      ...signedIn(),
      "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({ user: ME, needsOnboarding: false }),
    });
    window.history.replaceState(null, "", "/settings");
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    rememberReturnPath("/settings");
    click("Sign out");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(peekReturnPath()).toBeNull();
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    expect(await screen.findByRole("heading", { name: "Hi, Sam" })).toBeDefined();
    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
  });

  it.each([
    "//evil.example/x",
    "https://evil.example/",
    "/\\evil.example",
    "/a b",
    "/signin",
    "x",
    "/api/v1/email/unsubscribe",
    "/api/v1/email/unsubscribe?token=x",
    "/api",
    "/__dev/mail",
    "/manifest.webmanifest",
    "/manifest.webmanifest#x",
    "/%2e%2e/api/v1/x",
    "/a%2Fb",
    "/a/../b",
    "/a/./b",
    "/..",
    "/a/..?x=1",
  ])("never remembers %s", (value) => {
    expect(isAppPath(value)).toBe(false);
  });

  it("ignores a tampered stored value", () => {
    window.sessionStorage.setItem("ym.return-path", "//evil.example");
    expect(peekReturnPath()).toBeNull();
    clearReturnPath();
  });

  it.each(["/apiary", "/g/abc", "/manifest.webmanifest.html", "/settings?x=/api/"])(
    "accepts %s, which only looks like a server path",
    (value) => {
      expect(isAppPath(value)).toBe(true);
    },
  );

  it("accepts an ordinary app path", () => {
    rememberReturnPath("/settings");
    expect(peekReturnPath()).toBe("/settings");
    clearReturnPath();
    expect(peekReturnPath()).toBeNull();
  });
});

describe("a join link through sign-in and onboarding (06 §6.8, 07 §1)", () => {
  const TOKEN = "AbCdEfGhIjKlMnOpQrSt_-";
  const PREVIEW = {
    id: "g7",
    gameType: "words",
    options: {},
    resources: [],
    turnTimeoutDays: 3,
    seatOrder: "join",
    aiAssistance: "off",
    creatorName: "Ada",
    players: [{ displayName: "Ada", kind: "human" }],
    openSeats: 1,
    expiresAt: 1,
  };
  /** Every address the tab shows on the way: the token must never be in one. */
  const seen: string[] = [];
  const watch = () => {
    seen.push(window.location.href);
  };

  beforeEach(() => {
    seen.length = 0;
    clearJoinToken();
    // What main.tsx does before the app renders.
    window.history.replaceState(null, "", `/join#${TOKEN}`);
    captureJoinFragment();
    window.addEventListener("popstate", watch);
  });
  afterEach(() => {
    window.removeEventListener("popstate", watch);
    clearJoinToken();
  });

  it("returns a signed-out visitor to the link after signing in, and never joins by itself", async () => {
    const { api, calls } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({ user: ME, needsOnboarding: false }),
      "POST /api/v1/join/lookup": json({ game: PREVIEW }),
      "GET /api/v1/catalog": json({ games: [] }),
    });
    expect(window.location.href).not.toContain(TOKEN);
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    seen.push(window.location.href);
    expect(peekReturnPath()).toBe("/join");
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    expect(await screen.findByRole("button", { name: "Join" })).toBeDefined();
    seen.push(window.location.href);
    expect(window.location.pathname).toBe("/join");
    expect(calls.filter((call) => call.path === "/api/v1/join/lookup")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/api/v1/join")).toHaveLength(0);
    expect(keptJoinToken()).toBe(TOKEN);
    expect(seen.join(" ")).not.toContain(TOKEN);
  });

  it("keeps the link through onboarding", async () => {
    const { api } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": json({}, 202),
      "POST /api/v1/auth/otp/verify": json({
        user: { ...ME, displayName: null, needsOnboarding: true },
        needsOnboarding: true,
      }),
      "PATCH /api/v1/me": json(ME),
      "POST /api/v1/join/lookup": json({ game: PREVIEW }),
      "GET /api/v1/catalog": json({ games: [] }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    typeInto("Sign-in code", "12345678");
    click("Sign in");
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    expect(window.location.href).not.toContain(TOKEN);
    typeInto("Display name", "Sam");
    click("Continue");
    expect(await screen.findByRole("button", { name: "Join" })).toBeDefined();
    expect(window.location.pathname).toBe("/join");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("brings someone signed in but not yet onboarded back to the link after onboarding", async () => {
    const { api } = fakeApi({
      ...signedIn({ ...ME, displayName: null, needsOnboarding: true }),
      "PATCH /api/v1/me": json(ME),
      "POST /api/v1/join/lookup": json({ game: PREVIEW }),
      "GET /api/v1/catalog": json({ games: [] }),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    expect(window.location.pathname).toBe("/welcome");
    typeInto("Display name", "Sam");
    click("Continue");
    expect(await screen.findByRole("button", { name: "Join" })).toBeDefined();
    expect(window.location.pathname).toBe("/join");
    expect(window.location.href).not.toContain(TOKEN);
  });

  it("forgets the link when the session ends, so the next person isn't offered it", () => {
    expect(keptJoinToken()).toBe(TOKEN);
    clearClientState();
    expect(keptJoinToken()).toBeNull();
  });
});

describe("moving focus", () => {
  it("goes to the new screen's heading after navigating", async () => {
    render(<App api={fakeApi(signedIn()).api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    const heading = await screen.findByRole("heading", { name: "Settings" });
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });
});

describe("ending the session in every tab", () => {
  it("clears this tab when another tab signs out", async () => {
    render(<App api={fakeApi(signedIn()).api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    window.localStorage.setItem("ym.game.words.u1.g1", "rack");
    // The tab starts listening just after it first shows the screen, so say it until heard.
    await waitFor(() => {
      const other = new BroadcastChannel("session");
      other.postMessage("signed-out");
      other.close();
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/signin");
    });
    expect(window.localStorage.getItem("ym.game.words.u1.g1")).toBeNull();
  });

  it("tells the other tabs when this one signs out", async () => {
    const heard = new Promise<unknown>((resolve) => {
      const channel = new BroadcastChannel("session");
      channel.onmessage = (event: MessageEvent) => {
        channel.close();
        resolve(event.data);
      };
    });
    const { api } = fakeApi({
      ...signedIn(),
      "POST /api/v1/auth/logout": new Response(null, { status: 204 }),
    });
    window.history.replaceState(null, "", "/settings");
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    click("Sign out");
    expect(await heard).toBe("signed-out");
  });

  it("checks the session again when the tab becomes visible", async () => {
    let signedInStill = true;
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": () => (signedInStill ? json(ME) : problem(401, "UNAUTHENTICATED")),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    signedInStill = false;
    // The tab starts listening just after it first shows the screen, so say it until heard.
    await waitFor(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeDefined();
    });
  });

  it("stays signed in when the check can't reach the server", async () => {
    let up = true;
    const { api, calls } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": () => (up ? json(ME) : new TypeError("offline")),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    up = false;
    await waitFor(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(calls.filter((call) => call.path === "/api/v1/me").length).toBeGreaterThan(1);
    });
    expect(screen.getByRole("heading", { name: "Hi, Sam" })).toBeDefined();
  });
});

describe("when the session is another person's", () => {
  const OTHER = { ...ME, id: "u2", displayName: "Alex", email: "alex@example.org" };

  it("starts over as them, with nothing of the first person's kept, when the tab is shown again", async () => {
    let current: object = ME;
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": () => json(current),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    window.localStorage.setItem("ym.game.words.u1.g1", "rack");
    current = OTHER;
    await waitFor(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(screen.getByRole("heading", { name: "Hi, Alex" })).toBeDefined();
    });
    expect(window.localStorage.getItem("ym.game.words.u1.g1")).toBeNull();
    expect(screen.queryByText("sam@example.org")).toBeNull();
  });

  it("ignores a late reply for the first person once another has taken over", async () => {
    let current: object = { ...ME, displayName: null, needsOnboarding: true };
    let release: (response: Response) => void = () => undefined;
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { api, calls } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": () => json(current),
      "PATCH /api/v1/me": held,
    });
    window.history.replaceState(null, "", "/welcome");
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Welcome to Family Games" });
    typeInto("Display name", "Sam");
    click("Continue");
    await waitFor(() => {
      expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    });
    current = OTHER;
    await waitFor(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(screen.getByRole("heading", { name: "Hi, Alex" })).toBeDefined();
    });
    release(json(ME));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("heading", { name: "Hi, Alex" })).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Hi, Sam" })).toBeNull();
  });

  it("checks who the session is when another tab signs in", async () => {
    let current: object = ME;
    const { api } = fakeApi({
      "GET /api/v1/config": json(CONFIG),
      "GET /api/v1/me": () => json(current),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    window.localStorage.setItem("ym.game.words.u1.g1", "rack");
    current = OTHER;
    await waitFor(() => {
      const other = new BroadcastChannel("session");
      other.postMessage("signed-in");
      other.close();
      expect(screen.getByRole("heading", { name: "Hi, Alex" })).toBeDefined();
    });
    expect(window.localStorage.getItem("ym.game.words.u1.g1")).toBeNull();
  });

  it("tells the other tabs when this one signs in", async () => {
    const heard = new Promise<unknown>((resolve) => {
      const channel = new BroadcastChannel("session");
      channel.onmessage = (event: MessageEvent) => {
        channel.close();
        resolve(event.data);
      };
    });
    await signInWith(json({ user: ME, needsOnboarding: false }));
    expect(await heard).toBe("signed-in");
  });

  it("changes nothing when it is the same person", async () => {
    const { api, calls } = fakeApi(signedIn());
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Hi, Sam" });
    window.localStorage.setItem("ym.game.words.u1.g1", "rack");
    await waitFor(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      expect(calls.filter((call) => call.path === "/api/v1/me").length).toBeGreaterThan(1);
    });
    expect(screen.getByRole("heading", { name: "Hi, Sam" })).toBeDefined();
    expect(window.localStorage.getItem("ym.game.words.u1.g1")).toBe("rack");
    window.localStorage.clear();
  });
});

describe("launching with no session", () => {
  it("removes per-game state left behind, but keeps where the visit was headed", async () => {
    window.localStorage.setItem("ym.game.words.u1.g1", "rack");
    window.localStorage.setItem("theme", "dark");
    window.history.replaceState(null, "", "/settings");
    render(<App api={fakeApi(signedOut).api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    await waitFor(() => {
      expect(window.location.pathname).toBe("/signin");
    });
    expect(window.localStorage.getItem("ym.game.words.u1.g1")).toBeNull();
    expect(window.localStorage.getItem("theme")).toBe("dark");
    expect(peekReturnPath()).toBe("/settings");
    window.localStorage.clear();
  });
});

describe("clearClientState", () => {
  it("removes per-game local state and nothing else", () => {
    window.localStorage.setItem("ym.game.words.u1.g1", "a");
    window.localStorage.setItem("ym.game.paths.u1.g2", "b");
    window.localStorage.setItem("ym.gamer", "keep");
    window.localStorage.setItem("theme", "dark");
    clearClientState();
    expect(window.localStorage.length).toBe(2);
    expect(window.localStorage.getItem("theme")).toBe("dark");
    window.localStorage.clear();
  });

  it("copes with storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
      throw new Error("blocked");
    });
    window.localStorage.setItem("ym.game.words.u1.g1", "a");
    expect(() => {
      clearClientState();
    }).not.toThrow();
    spy.mockRestore();
    window.localStorage.clear();
  });
});

describe("the sign-in request refused as malformed", () => {
  it("says the same neutral thing whatever the address", async () => {
    const { api } = fakeApi({
      ...signedOut,
      "POST /api/v1/auth/otp/request": problem(400, "BAD_REQUEST"),
    });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await waitFor(() => {
      expect(alertText()).toBe(
        "Check your email address. If it looks right, please try again later.",
      );
    });
  });
});

describe("live regions", () => {
  it("are in the page before they have anything to say", async () => {
    const { api } = fakeApi({ ...signedOut, "POST /api/v1/auth/otp/request": json({}, 202) });
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Sign in" });
    expect(screen.getAllByRole("status")).toHaveLength(1); // the update toast's
    typeInto("Email address", "sam@example.org");
    click("Email me a code");
    await screen.findByLabelText("Sign-in code");
    expect(screen.getAllByRole("status")).toHaveLength(2); // and the "sent another code" notice
  });
});
