/**
 * The contract suite against the Node build (`node apps/node/dist/main.js`), started by the
 * global setup on a free port.
 */
import { inject } from "vitest";

import { contractSuite } from "./suite.js";

contractSuite("Node", () => ({
  fetch: (request) => {
    const url = new URL(request.url);
    return fetch(new Request(`${inject("nodeUrl")}${url.pathname}${url.search}`, request));
  },
}));
