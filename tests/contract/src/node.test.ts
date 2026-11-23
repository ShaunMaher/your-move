import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeApp } from "@your-move/node";
import { createJsonLogger, parseConfig } from "@your-move/server";

import { CONTRACT_SECRETS, CONTRACT_VARS } from "./env.js";
import { contractSuite } from "./suite.js";

const now = (): Date => new Date();
const app = createNodeApp({
  platform: {
    config: parseConfig(
      { ...CONTRACT_VARS, ...CONTRACT_SECRETS },
      { runtime: "node", installedGames: [] },
    ),
    log: createJsonLogger({ level: "error", now, sink: () => undefined }),
    now,
  },
  games: [],
  staticRoot: mkdtempSync(join(tmpdir(), "contract-static-")),
});

contractSuite("Node", () => ({ fetch: (request) => Promise.resolve(app.fetch(request)) }));
