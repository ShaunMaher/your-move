import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { SourceMap, type SourceMapPayload } from "node:module";
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

  it("keeps the entry chunk's source map accurate after the banner", () => {
    // A string only main.ts has (other modules bundled into the entry chunk refuse to start too).
    const marker = '"Refusing to start: run node with';
    const code = readFileSync(join(outdir, "main.js"), "utf8").split("\n");
    const line = code.findIndex((text) => text.includes(marker));
    const column = code[line]?.indexOf(marker) ?? -1;
    expect(line).toBeGreaterThan(0);
    const map = new SourceMap(
      JSON.parse(readFileSync(join(outdir, "main.js.map"), "utf8")) as SourceMapPayload,
    );
    const entry = map.findEntry(line, column);
    const source = readFileSync(new URL("main.ts", import.meta.url), "utf8").split("\n");
    expect(entry).toMatchObject({
      originalSource: expect.stringMatching(/src\/main\.ts$/u) as unknown,
      originalLine: source.findIndex((text) => text.includes(marker)),
    });
  });
});
