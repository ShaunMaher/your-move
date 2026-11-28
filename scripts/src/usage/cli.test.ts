import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

import { linesFrom, parseUsageArgs } from "./cli.js";
import { aggregate } from "./report.js";

describe("parseUsageArgs", () => {
  it("defaults to stdin, no players, text output", () => {
    expect(parseUsageArgs([])).toEqual({ file: null, players: null, json: false });
  });

  it("takes a file, --players and --json", () => {
    expect(parseUsageArgs(["app.log", "--players", "4", "--json"])).toEqual({
      file: "app.log",
      players: 4,
      json: true,
    });
  });

  it.each(["abc", "0", "2.5", "-1", ""])("refuses --players %j", (value) => {
    expect(() => parseUsageArgs([`--players=${value}`])).toThrow(
      "--players must be a positive integer",
    );
  });

  it("refuses two files", () => {
    expect(() => parseUsageArgs(["a.log", "b.log"])).toThrow("at most one");
  });
});

describe("linesFrom", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const request = JSON.stringify({
    msg: "request",
    method: "GET",
    route: "/api/v1/me",
    status: 200,
  });

  it("reads stdin with LF and CRLF lines", async () => {
    const stdin = Readable.from([`${request}\r\n${request}\n`]);
    expect((await aggregate(linesFrom(null, stdin))).report().totalRequests).toBe(2);
  });

  it("reads a file instead of stdin", async () => {
    const file = join(dir, "app.log");
    writeFileSync(file, `${request}\r\n${request}\r\n${request}\r\n`);
    const unused = Readable.from([]);
    expect((await aggregate(linesFrom(file, unused))).report().totalRequests).toBe(3);
  });
});
