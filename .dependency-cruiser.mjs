// Architecture rules (docs/spec/11-engineering.md §5), run by `pnpm lint:arch`.
// The game-package rules come from @your-move/testkit, so third-party game repositories and
// `pnpm games:verify` apply exactly the same ones (02 §7.5).
import { fileURLToPath } from "node:url";

import { gamePackageRules } from "@your-move/testkit/depcruise";

const NOT_A_TEST = "(?<!\\.test\\.tsx?)$";
const CORE = { dependencyTypes: ["core"] };

/** @type {import("dependency-cruiser").IConfiguration} */
export default {
  forbidden: [
    {
      name: "no-circular",
      comment: "No circular dependencies anywhere (11 §5).",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "No orphaned modules (11 §5): a file nothing imports and that imports nothing.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|json)$",
          "[.]d[.]ts$",
          "(^|/)tsconfig[.]json$",
          "(^|/)(?:vite|vitest|playwright)[.]config[.]ts$",
        ],
      },
      to: {},
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import must resolve (run `pnpm games:generate` first for generated/).",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },

    // Game packages: the testkit's ruleset, one rule set for every games/<id>.
    ...gamePackageRules({
      engineEntry: "^games/([^/]+)/src/engine/index[.]ts$",
      clientEntry: "^games/([^/]+)/src/client/index[.]tsx?$",
      manifestEntry: "^games/([^/]+)/src/manifest[.]ts$",
      ownFiles: "^games/$1/src/",
      sdk: "^packages/sdk/",
    }),

    // The framework core: Web-standard APIs only, and no game, app or generated code.
    {
      name: "server-web-standard-only",
      comment:
        "packages/server uses Web-standard APIs only; Node and Cloudflare code lives in apps/* (03 §1).",
      severity: "error",
      from: { path: `^packages/(server|shared)/src/.*${NOT_A_TEST}` },
      to: CORE,
    },
    {
      name: "server-no-runtime-packages",
      comment: "No Cloudflare- or Node-specific packages in the core (03 §1).",
      severity: "error",
      from: { path: "^packages/(server|shared)/src/" },
      to: { path: "(^|/)node_modules/(@cloudflare/|wrangler/|@hono/node-server/|better-sqlite3/)" },
    },
    {
      name: "server-no-games-apps-generated",
      comment:
        "packages/server knows games only through the registry injected into createApp (02 §7.3).",
      severity: "error",
      from: { path: "^packages/server/" },
      to: { path: "^(games/|apps/|generated/)|(^|/)node_modules/@[^/]+/game-" },
    },
    {
      name: "generated-only-from-apps",
      comment: "Only apps/worker, apps/node and apps/web import generated/ (11 §5).",
      severity: "error",
      from: { pathNot: "^(apps/(worker|node|web)/|generated/)" },
      to: { path: "^generated/" },
    },
    {
      name: "packages-not-to-apps",
      comment: "Libraries never import applications.",
      severity: "error",
      from: { path: "^(packages|games)/" },
      to: { path: "^apps/" },
    },
    {
      name: "sdk-no-dependencies",
      comment:
        "The SDK has no dependencies; Zod (for /schema) and React (for /client) are peers (02 §7.4).",
      severity: "error",
      from: { path: `^packages/sdk/src/.*${NOT_A_TEST}` },
      to: { pathNot: ["^packages/sdk/src/", "(^|/)node_modules/(zod|react)/"] },
    },
    {
      name: "sdk-react-only-in-client",
      comment: "Only the @your-move/sdk/client entry point may import React (11 §5).",
      severity: "error",
      from: { path: "^packages/sdk/src/", pathNot: "^packages/sdk/src/client" },
      to: { path: "(^|/)node_modules/react(-dom)?/" },
    },
    {
      name: "web-only-through-api-client",
      comment: "The web app reaches the server only through @your-move/api-client (03 §1).",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^packages/(server|shared)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: {
      path: [
        "(^|/)dist/",
        "(^|/)dist-types/",
        "(^|/)coverage/",
        "^scripts/test-fixtures/",
        "(^|/)[.]wrangler/",
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: fileURLToPath(new URL("tsconfig.base.json", import.meta.url)) },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".json"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
