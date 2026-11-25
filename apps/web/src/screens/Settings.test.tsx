/** The email nudges toggle on the Settings screen (07 §1, 03 §7; alpha A6). */
import { cleanup, configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { App } from "../App.js";
import { CONFIG, fakeApi, json, ME, problem } from "../test-support.js";

configure({ asyncUtilTimeout: 10_000 });

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
