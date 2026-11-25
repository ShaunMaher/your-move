/** A fake API for the component tests: a handler table over the typed client; nothing touches the network. */
import { createApiClient } from "@your-move/api-client";

export const CONFIG = {
  appName: "Family Games",
  appShortName: "Games",
  operatorContact: "ops@example.org",
  minAge: 13,
  uploadsEnabled: false,
};

export const ME = {
  id: "u1",
  kind: "human" as const,
  email: "sam@example.org",
  displayName: "Sam",
  settings: { whoCanAddMe: "pastOpponents" as const },
  ageAttested: true,
  needsOnboarding: false,
  isAdmin: false,
};

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export type Handler = (call: Call) => Response | Error;
type Routes = Record<string, Handler | Response | Error>;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const problem = (status: number, code: string): Response =>
  json({ error: { code, message: "x" } }, status);

/**
 * Routes are keyed `"METHOD /path"`; unlisted ones answer 404. `calls` records every request,
 * body included.
 */
export function fakeApi(routes: Routes) {
  const calls: Call[] = [];
  const api = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request: Request) => {
      const method = request.method;
      const path = new URL(request.url).pathname;
      const text = await request.clone().text();
      const call = { method, path, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
      calls.push(call);
      const route: Handler | Response | Error | undefined = routes[`${method} ${path}`];
      const answer = typeof route === "function" ? route(call) : route;
      // A body can be read once; the same route may be asked again.
      if (answer instanceof Response) return answer.clone();
      if (answer instanceof Error) throw answer;
      return new Response(null, { status: 404 });
    },
  });
  return { api, calls };
}
