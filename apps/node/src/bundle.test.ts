import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { bundleServer, REQUIRE_BANNER } from "../scripts/bundle.js";

const outdir = mkdtempSync(join(tmpdir(), "node-bundle-"));

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("the Node bundle", () => {
  it("gives only the entry chunk a require(); the game registry chunk has none", async () => {
    const files = (await bundleServer(outdir)).filter((file) => file.endsWith(".js"));
    const main = files.find((file) => basename(file) === "main.js");
    const registry = files.find((file) => basename(file).startsWith("server-registry-"));
    expect(main).toBeDefined();
    expect(registry).toBeDefined();
    expect(readFileSync(main ?? "", "utf8").startsWith(REQUIRE_BANNER)).toBe(true);
    for (const file of files.filter((candidate) => candidate !== main)) {
      expect(readFileSync(file, "utf8"), file).not.toContain("createRequire");
    }
  }, 30_000);
});
