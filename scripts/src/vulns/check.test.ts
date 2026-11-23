import { describe, expect, it } from "vitest";

import { classifyFindings } from "./check.js";

const osv = (packages: { name: string; version: string; ids: string[] }[]) =>
  JSON.stringify({
    results: [
      {
        source: { path: "pnpm-lock.yaml", type: "lockfile" },
        packages: packages.map(({ name, version, ids }) => ({
          package: { name, version, ecosystem: "npm" },
          vulnerabilities: ids.map((id) => ({ id })),
          groups: [],
        })),
      },
    ],
  });

const PROD = JSON.stringify({
  MIT: [
    { name: "hono", versions: ["4.13.19"], paths: [], license: "MIT" },
    { name: "zod", versions: ["4.6.7"], paths: [], license: "MIT" },
  ],
});

describe("classifyFindings", () => {
  it("marks a vulnerable production package (the gate's deliberate violation)", () => {
    expect(
      classifyFindings(osv([{ name: "hono", version: "4.13.19", ids: ["GHSA-1"] }]), PROD),
    ).toEqual([{ name: "hono", version: "4.13.19", ids: ["GHSA-1"], production: true }]);
  });

  it("marks a development-only package as such", () => {
    expect(
      classifyFindings(osv([{ name: "minimatch", version: "10.2.3", ids: ["GHSA-2"] }]), PROD),
    ).toEqual([{ name: "minimatch", version: "10.2.3", ids: ["GHSA-2"], production: false }]);
  });

  it("matches the exact version", () => {
    expect(
      classifyFindings(osv([{ name: "zod", version: "3.0.0", ids: ["GHSA-3"] }]), PROD)[0]
        ?.production,
    ).toBe(false);
  });

  it("reports nothing for a clean scan", () => {
    expect(classifyFindings(JSON.stringify({ results: [] }), PROD)).toEqual([]);
    expect(classifyFindings(JSON.stringify({ results: null }), PROD)).toEqual([]);
  });
});
