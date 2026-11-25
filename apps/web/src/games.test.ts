import { afterEach, describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  words: vi.fn(),
  broken: vi.fn(),
  wrong: vi.fn(),
  bare: vi.fn(),
}));

vi.mock("../../../generated/client-games.js", () => ({ gameClients: loaders }));

import { loadGameClient } from "./games.js";
import { fakeClient } from "./test-client.js";

afterEach(() => {
  vi.clearAllMocks();
});

describe("loading a game's client module", () => {
  it("returns the entry point's `client` once, however often it is asked", async () => {
    loaders.words.mockResolvedValue({ client: fakeClient });
    expect(await loadGameClient("words")).toBe(fakeClient);
    expect(await loadGameClient("words")).toBe(fakeClient);
    expect(loaders.words).toHaveBeenCalledOnce();
  });

  it("is null for a type that isn't installed, including names on the object prototype", async () => {
    expect(await loadGameClient("nope")).toBeNull();
    expect(await loadGameClient("constructor")).toBeNull();
    expect(await loadGameClient("__proto__")).toBeNull();
  });

  it("refuses an entry point that isn't a client module for the type, and tries again next time", async () => {
    loaders.wrong.mockResolvedValue({ client: { ...fakeClient, type: "other" } });
    expect(await loadGameClient("wrong")).toBeNull();
    loaders.bare.mockResolvedValue({ client: { ...fakeClient, Board: undefined } });
    expect(await loadGameClient("bare")).toBeNull();
    loaders.bare.mockResolvedValue({});
    expect(await loadGameClient("bare")).toBeNull();
    expect(loaders.bare).toHaveBeenCalledTimes(2);
  });

  it("forgets a failed load, so a later ask can succeed", async () => {
    loaders.broken.mockRejectedValueOnce(new Error("chunk failed"));
    expect(await loadGameClient("broken")).toBeNull();
    loaders.broken.mockResolvedValue({ client: { ...fakeClient, type: "broken" } });
    expect((await loadGameClient("broken"))?.type).toBe("broken");
  });
});
