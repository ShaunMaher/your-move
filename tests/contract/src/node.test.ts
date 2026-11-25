/**
 * The contract suite against the Node build (`node apps/node/dist/main.js`), started by the
 * global setup on a free port.
 */
import { nodeRepositories, openSqlite } from "@your-move/node/db";
import type { Repositories } from "@your-move/server";
import { afterAll, inject } from "vitest";

import { contractSuite } from "./suite.js";

let database: ReturnType<typeof openSqlite> | undefined;
afterAll(() => {
  database?.close();
});

contractSuite("Node", () => ({
  fetch: (request) => {
    const url = new URL(request.url);
    return fetch(new Request(`${inject("nodeUrl")}${url.pathname}${url.search}`, request));
  },
  // The running build's own database file, opened alongside it (WAL).
  repos: (): Promise<Repositories> => {
    database ??= openSqlite(inject("nodeDb"));
    return Promise.resolve(nodeRepositories(database));
  },
}));
