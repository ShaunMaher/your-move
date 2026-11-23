import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkPins, type PinnedFiles } from "./check.js";

const read = (file: string): string =>
  readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8");

const COMMITTED: PinnedFiles = {
  "mise.toml": read("mise.toml"),
  "package.json": read("package.json"),
  "apps/node/Dockerfile": read("apps/node/Dockerfile"),
  ".gitlab-ci.yml": read(".gitlab-ci.yml"),
};

const GOOD: PinnedFiles = {
  "mise.toml": '[tools]\nnode = "26.1.0"\npnpm = "12.0.0"\n',
  "package.json": '{ "packageManager": "pnpm@12.0.0+sha512.abc" }',
  "apps/node/Dockerfile": "ARG NODE_IMAGE=node:26.1.0-trixie-slim@sha256:00\n",
  ".gitlab-ci.yml": "  NODE_IMAGE: node:26.1.0-trixie@sha256:00\n",
};

describe("checkPins", () => {
  it("passes the committed files", () => {
    expect(checkPins(COMMITTED)).toEqual([]);
  });

  it("passes files that agree", () => {
    expect(checkPins(GOOD)).toEqual([]);
  });

  it.each<[string, Partial<PinnedFiles>, RegExp]>([
    [
      "a Dockerfile on another Node",
      { "apps/node/Dockerfile": "FROM node:26.2.0-trixie-slim\n" },
      /apps\/node\/Dockerfile uses the node:26\.2\.0 image but mise\.toml pins node 26\.1\.0/u,
    ],
    [
      "one CI image on another Node",
      { ".gitlab-ci.yml": "A: node:26.1.0-trixie\nB: node:26.0.9-trixie\n" },
      /\.gitlab-ci\.yml uses the node:26\.0\.9 image/u,
    ],
    [
      "a file without a Node image",
      { ".gitlab-ci.yml": "A: alpine:3\n" },
      /no node:<version> image/u,
    ],
    [
      "packageManager on another pnpm",
      { "package.json": '{ "packageManager": "pnpm@12.0.1+sha512.abc" }' },
      /"packageManager" is pnpm 12\.0\.1 but mise\.toml pins pnpm 12\.0\.0/u,
    ],
    ["no packageManager", { "package.json": "{}" }, /"packageManager" is pnpm \(missing\)/u],
    [
      "no pnpm in mise.toml",
      { "mise.toml": '[tools]\nnode = "26.1.0"\n' },
      /must pin node and pnpm/u,
    ],
  ])("fails %s", (_, change, expected) => {
    expect(checkPins({ ...GOOD, ...change }).join("\n")).toMatch(expected);
  });
});
