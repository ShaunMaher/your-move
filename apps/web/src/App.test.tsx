import { cleanup, render, screen } from "@testing-library/react";
import { createApiClient } from "@your-move/api-client";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.js";

const CONFIG = {
  appName: "Family Games",
  appShortName: "Games",
  operatorContact: "ops@example.org",
  minAge: 13,
  uploadsEnabled: true,
};

/** A client whose fetch answers from a table; nothing touches the network. */
function client(routes: Record<string, Response | Error>) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: (request: Request) => {
      const answer = routes[new URL(request.url).pathname];
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer ?? new Response(null, { status: 404 }));
    },
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(cleanup);

describe("App shell", () => {
  it("shows the instance name from /api/v1/config and a healthy server", async () => {
    render(
      <App
        api={client({ "/api/v1/config": json(CONFIG), "/api/v1/health": json({ ok: true }) })}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Family Games" })).toBeDefined();
    expect((await screen.findByRole("status")).textContent).toBe("The server is up.");
    expect(document.title).toBe("Family Games");
  });

  it("says so when the server can't be reached", async () => {
    render(
      <App
        api={client({
          "/api/v1/config": new TypeError("offline"),
          "/api/v1/health": new TypeError("offline"),
        })}
      />,
    );
    expect(await screen.findByText("The server can't be reached right now.")).toBeDefined();
  });

  it("treats an error response as unreachable", async () => {
    render(
      <App
        api={client({
          "/api/v1/config": json(CONFIG),
          "/api/v1/health": json({ error: { code: "INTERNAL", message: "x" } }, 500),
        })}
      />,
    );
    expect(await screen.findByText("The server can't be reached right now.")).toBeDefined();
  });

  it("shows that it is checking first", () => {
    render(<App api={client({})} />);
    expect(screen.getByRole("status").textContent).toBe("Checking the server…");
  });
});
