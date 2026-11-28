import { describe, expect, it } from "vitest";

import { engines } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { client } from "./index.js";

describe("words client module (02 §3)", () => {
  it("has a client module for the manifest's type that renders every engine version", () => {
    expect(client.type).toBe(manifest.type);
    // Pinned: adding a rules version means adding it here, and a client for it.
    expect(client.versions).toEqual([1]);
    expect([...client.versions].sort((a, b) => a - b)).toEqual(
      Object.keys(engines)
        .map(Number)
        .sort((a, b) => a - b),
    );
  });
});
