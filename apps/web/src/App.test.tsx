import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "./App.js";
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
});
afterEach(cleanup);

const typeInto = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
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
    expect(document.title).toBe("Family Games");
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
    expect(window.location.pathname).toBe("/signin");
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
    expect(window.location.pathname).toBe("/");
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

  it("looks the same whatever the address: the same screens and words", async () => {
    // The API answers every address identically (06 §6.1); the app adds nothing of its own.
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
    expect(window.location.pathname).toBe("/welcome");
    expect(screen.getByText(/Don't use your full name/u)).toBeDefined();
    typeInto("Display name", "Sam");
    click("Continue");
    expect(await screen.findByRole("heading", { name: "Hi, Sam" })).toBeDefined();
    expect(window.location.pathname).toBe("/");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { displayName: "Sam" } });
  });

  it("explains a refused name", async () => {
    await toWelcome(problem(400, "BAD_REQUEST"));
    typeInto("Display name", "admin");
    click("Continue");
    expect((await screen.findByRole("alert")).textContent).toContain("can't be used");
    expect(window.location.pathname).toBe("/welcome");
  });

  it("checks the length before asking", async () => {
    const calls = await toWelcome(json(ME));
    typeInto("Display name", "   ");
    click("Continue");
    expect((await screen.findByRole("alert")).textContent).toContain("Enter a display name");
    typeInto("Display name", "x".repeat(25));
    click("Continue");
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("up to 24");
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
    expect(window.location.pathname).toBe("/welcome");
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
    expect(window.location.pathname).toBe("/");
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
    expect(window.location.pathname).toBe("/settings");
    expect(screen.getByText("sam@example.org")).toBeDefined();
    click("Sign out");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(window.location.pathname).toBe("/signin");
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/api/v1/auth/logout" });
  });

  it("stays signed in when signing out fails", async () => {
    const { api } = fakeApi({
      ...signedIn(),
      "POST /api/v1/auth/logout": new TypeError("offline"),
    });
    window.history.replaceState(null, "", "/settings");
    render(<App api={api} />);
    await screen.findByRole("heading", { name: "Settings" });
    click("Sign out");
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Settings" })).toBeDefined();
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
    expect(screen.queryByRole("checkbox")).toBeNull();
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
    expect(screen.getByRole("status").textContent).toBe("Loading…");
  });
});
