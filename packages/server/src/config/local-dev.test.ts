import { describe, expect, it } from "vitest";

import { isLocalDev, isLocalDevUrl } from "./local-dev.js";

describe("isLocalDevUrl", () => {
  it.each([
    ["http://localhost", true],
    ["http://localhost:8080", true],
    ["http://127.0.0.1:8787", true],
    ["http://[::1]:8080", true],
    ["https://localhost", false],
    ["http://localhost.example.org", false],
    ["http://127.0.0.2", false],
    ["http://example.org", false],
    ["http://0.0.0.0:8080", false],
    ["http://[::ffff:127.0.0.1]", false],
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(isLocalDevUrl(url)).toBe(expected);
  });

  it("reads the parsed configuration's PUBLIC_URL", () => {
    expect(isLocalDev({ publicUrl: "http://localhost:8080" })).toBe(true);
    expect(isLocalDev({ publicUrl: "https://play.example.org" })).toBe(false);
  });
});
