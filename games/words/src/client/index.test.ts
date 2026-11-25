import { describe, expect, it } from "vitest";

import { engines } from "../engine/index.js";
import { manifest } from "../manifest.js";
import { client } from "./index.js";

describe("words client module (02 §3)", () => {
  it("has a client module for the manifest's type that renders every engine version", () => {
    expect(client.type).toBe(manifest.type);
    expect(new Set(client.versions)).toEqual(new Set(Object.keys(engines).map(Number)));
  });
});
