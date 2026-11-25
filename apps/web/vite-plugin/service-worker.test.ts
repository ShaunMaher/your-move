// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SERVER_PATHS } from "@your-move/shared/server-paths";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildInfo, renderWorker } from "./service-worker.js";

const TEMPLATE = "// worker\n";
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sw-build-"));
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, "icons"));
  writeFileSync(join(dir, "index.html"), "<html>");
  writeFileSync(join(dir, "icon.svg"), "<svg>");
  writeFileSync(join(dir, "icons", "app-192.png"), "png");
  writeFileSync(join(dir, "assets", "index-abc.js"), "code");
  writeFileSync(join(dir, "assets", "index-abc.js.map"), "map");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildInfo", () => {
  it("precaches the shell and every emitted file but maps, the worker and _headers", () => {
    writeFileSync(join(dir, "sw.js"), "old worker");
    writeFileSync(join(dir, "_headers"), "/*");
    expect(buildInfo(dir, TEMPLATE).precache).toEqual([
      "/",
      "/assets/index-abc.js",
      "/icon.svg",
      "/icons/app-192.png",
      "/index.html",
    ]);
  });

  it("hands the worker the shared server paths", () => {
    expect(buildInfo(dir, TEMPLATE).serverPaths).toEqual(SERVER_PATHS);
  });

  it("is the same version for the same build, even with an old worker lying around", () => {
    const before = buildInfo(dir, TEMPLATE).version;
    writeFileSync(join(dir, "sw.js"), "old worker");
    expect(buildInfo(dir, TEMPLATE).version).toBe(before);
    expect(before).toMatch(/^[0-9a-f]{12}$/u);
  });

  it.each([
    ["index.html", "<html lang>"],
    ["icon.svg", "<svg v2>"],
    ["icons/app-192.png", "png2"],
    ["assets/index-abc.js", "other code"],
  ])("is a new version when %s changes content, whatever its name", (file, content) => {
    const before = buildInfo(dir, TEMPLATE).version;
    writeFileSync(join(dir, file), content);
    expect(buildInfo(dir, TEMPLATE).version).not.toBe(before);
  });

  it("is a new version when the worker's own source changes", () => {
    const before = buildInfo(dir, TEMPLATE).version;
    expect(buildInfo(dir, `${TEMPLATE}// fix\n`).version).not.toBe(before);
  });

  it("is a new version when a file is added", () => {
    const before = buildInfo(dir, TEMPLATE).version;
    writeFileSync(join(dir, "extra.txt"), "x");
    expect(buildInfo(dir, TEMPLATE).version).not.toBe(before);
  });

  it("does not move for a changed source map", () => {
    const before = buildInfo(dir, TEMPLATE).version;
    writeFileSync(join(dir, "assets", "index-abc.js.map"), "other map");
    expect(buildInfo(dir, TEMPLATE).version).toBe(before);
  });
});

describe("renderWorker", () => {
  it("puts BUILD in front of the worker's source", () => {
    const info = buildInfo(dir, TEMPLATE);
    expect(renderWorker(info, "// worker\n")).toBe(
      `const BUILD = ${JSON.stringify(info)};\n// worker\n`,
    );
  });
});
